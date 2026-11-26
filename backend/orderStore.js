// IMPORTANT: DEVELOPMENT / DEMO STORAGE ONLY
// Saving orders to a JSON file is meant for local development and demos, not production.
// On serverless hosting such as Vercel, functions don't guarantee persistent file writes:
// the file system is read-only or temporary, so saved orders can fail to save or be lost
// between requests and deployments. Before going live, store orders in a real database.
//
// CafeBot order store: saves confirmed orders to data/orders.json.
//
// This is the only code that writes orders.json, and it only ever adds confirmed orders.
// Every record is checked before it is written (validateConfirmedRecord). Anything that
// isn't a complete, explicitly confirmed, internally consistent order is refused, so a
// draft can never be saved as a confirmed order, even if other code has a bug.
//
// Each saved record looks like:
//   {
//     "schemaVersion": 1,
//     "orderId": "CB-20261125-4F2A9C",     unique: checked against every saved order
//     "status": "confirmed",
//     "confirmedAt": "2026-11-25T04:31:07.120Z",  when the customer said yes
//     "savedAt": "2026-11-25T04:31:07.135Z",      when it was written
//     "items": [...], "fulfillment": {...}, "promotion": {...} | null, "totals": {...},
//     "confirmation": { "summaryId": "...", "customerReply": "yes please" }
//   }
//
// After saving, staff can move an order through these statuses (see STATUS_TRANSITIONS):
//   confirmed -> preparing -> ready -> completed, and cancelled from any of the first three.
// Each change is added to "statusHistory" with the time, and "updatedAt" is set.
//
// Saving is safe:
// - one save at a time, so orders confirmed together can't overwrite each other
// - written to a temporary file, then renamed into place, so orders.json is never half-written
// - if orders.json isn't a valid JSON array, it is left untouched and the save fails

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { cafeLocalTime, getClock } = require("./orderState");
const { classifyConfirmationReply } = require("./confirmOrder");

const SCHEMA_VERSION = 1;
const FULFILLMENT_TYPES = ["dine-in", "pickup", "delivery"];
const MAX_QUANTITY = 20;

// Which status each status can move to. completed and cancelled are final.
const STATUS_TRANSITIONS = {
  confirmed: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const isWholeAmount = (n) => Number.isInteger(n) && n >= 0;
const isIsoTime = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

// Throws an Error saying what is wrong, or returns nothing if the record may be saved.
function validateConfirmedRecord(record) {
  const problem = (why) => { throw new Error(`Refusing to save order: ${why}`); };

  if (typeof record !== "object" || record === null || Array.isArray(record)) problem("not an object");
  if (record.orderId !== undefined) problem("orderId is assigned by the store, not given");
  if (record.status !== "confirmed") problem(`status is "${record.status}", not "confirmed"`);
  if (!isIsoTime(record.confirmedAt)) problem("confirmedAt is missing or not a timestamp");

  const c = record.confirmation;
  if (!c || typeof c.summaryId !== "string" || c.summaryId === "") problem("no reviewed summary");
  if (classifyConfirmationReply(c.customerReply) !== "yes") problem("the customer's reply is not a clear yes");

  if (!Array.isArray(record.items) || record.items.length === 0) problem("no items");
  for (const item of record.items) {
    if (typeof item.itemId !== "string" || typeof item.name !== "string") problem("an item has no ID or name");
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) problem(`bad quantity for ${item.name}`);
    if (!isWholeAmount(item.unitPrice) || item.lineTotal !== item.unitPrice * item.quantity) problem(`bad price for ${item.name}`);
    if (item.problem) problem(`${item.name} has a problem: ${item.problem}`);
  }

  const t = record.totals;
  if (!t || typeof t.currency !== "string") problem("no totals");
  for (const key of ["subtotal", "discount", "tax", "deliveryFee", "total"]) {
    if (!isWholeAmount(t[key])) problem(`totals.${key} is not a whole amount`);
  }
  if (t.subtotal !== record.items.reduce((sum, item) => sum + item.lineTotal, 0)) problem("subtotal doesn't match the items");
  if (t.discount > t.subtotal) problem("discount is bigger than the subtotal");
  if (t.total !== t.subtotal - t.discount + t.tax + t.deliveryFee) problem("total doesn't add up");
  if ((record.promotion ? record.promotion.discount : 0) !== t.discount) problem("discount doesn't match the promotion");

  const f = record.fulfillment;
  if (!f || !FULFILLMENT_TYPES.includes(f.type)) problem("no dine-in, pickup or delivery choice");
  if (typeof f.customerName !== "string" || f.customerName.trim() === "") problem("no customer name");
  if (f.type !== "delivery" && t.deliveryFee !== 0) problem("delivery fee on a non-delivery order");
  if (f.type === "delivery") {
    const d = f.delivery;
    if (!d || !d.phone || !d.address || d.unit === null || d.instructions === null) problem("delivery details are incomplete");
    if (d.addressConfirmed !== true) problem("the delivery address wasn't confirmed");
  }
}

// "CB-20261125-4F2A9C": the café date the order was confirmed, plus a random part.
function newOrderId(confirmedAt, takenIds) {
  const date = cafeLocalTime(new Date(confirmedAt)).date.replace(/-/g, "");
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `CB-${date}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    if (!takenIds.has(id)) return id;
  }
  throw new Error("Could not create a unique order ID.");
}

// A status change that isn't allowed. Carries an HTTP-style code for the staff API.
class StatusChangeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 404 not found, 409 changed by someone else, 422 not allowed
  }
}

// Returns { save(record), list(), updateStatus(orderId, from, to) } for one orders.json file.
// save() checks the record, gives it a unique orderId and savedAt, appends it,
// and resolves to { orderId, savedAt }. It throws (and writes nothing) if anything is wrong.
function createOrderStore(filePath) {
  let queue = Promise.resolve();

  // Runs one read-change-write at a time.
  function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(() => {}); // one failed task doesn't block the next
    return result;
  }

  async function readAll() {
    const existing = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!Array.isArray(existing)) throw new Error("data/orders.json is not a JSON array.");
    return existing;
  }

  // Writes the whole list through a temporary file, so orders.json is never half-written.
  async function writeAll(orders) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(orders, null, 2)}\n`, "utf8");
      await fs.rename(tempPath, filePath);
    } catch (err) {
      await fs.rm(tempPath, { force: true });
      throw err;
    }
  }

  async function writeOne(record) {
    validateConfirmedRecord(record);

    const existing = await readAll();

    const takenIds = new Set(existing.map((saved) => saved && saved.orderId).filter(Boolean));
    const orderId = newOrderId(record.confirmedAt, takenIds);
    const savedAt = getClock().toISOString();
    const { status, confirmedAt, items, fulfillment, promotion, totals, confirmation } = record;
    existing.push({ schemaVersion: SCHEMA_VERSION, orderId, status, confirmedAt, savedAt, items, fulfillment, promotion: promotion || null, totals, confirmation });
    await writeAll(existing);
    return { orderId, savedAt };
  }

  // Moves one order from "from" to "to". "from" must be the status the staff member saw:
  // if someone else has changed it since, nothing is written (409).
  async function changeStatus(orderId, from, to) {
    const orders = await readAll();
    const order = orders.find((o) => o && o.orderId === orderId);
    if (!order) throw new StatusChangeError("Order not found.", 404);
    if (order.status !== from) {
      throw new StatusChangeError(`This order is now "${order.status}". Someone may have just changed it.`, 409);
    }
    const allowed = STATUS_TRANSITIONS[order.status] || [];
    if (!allowed.includes(to)) {
      throw new StatusChangeError(`An order that is "${order.status}" can't be changed to "${to}".`, 422);
    }
    const at = getClock().toISOString();
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [{ status: order.status, at: order.confirmedAt }];
    order.statusHistory.push({ status: to, at });
    order.status = to;
    order.updatedAt = at;
    await writeAll(orders);
    return order;
  }

  return {
    save(record) {
      return enqueue(() => writeOne(record));
    },
    // All saved orders, as stored. Waits for any save or change in progress.
    list() {
      return enqueue(() => readAll());
    },
    updateStatus(orderId, from, to) {
      return enqueue(() => changeStatus(orderId, from, to));
    },
  };
}

module.exports = { createOrderStore, validateConfirmedRecord, SCHEMA_VERSION, STATUS_TRANSITIONS, StatusChangeError };
