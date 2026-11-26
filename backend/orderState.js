// CafeBot order state: one order per chat session, kept in memory.
//
// Safety rules built into this file:
// - Names, categories and prices are ALWAYS looked up in menu.json by item ID.
//   They are never taken from the customer, the frontend or the AI.
// - Only available items and sizes listed on the menu can be added.
// - Promotions are checked against promotions.json rules before they are applied,
//   and checked again whenever the order changes.
// - A confirmed or cancelled order can't be changed.
//
// Every function that changes an order returns { ok: true } or { ok: false, error: "..." }.

// Promotion days and times are in the café's local time.
const CAFE_TIME_ZONE = "Asia/Karachi";

const ORDER_TYPES = ["dine-in", "takeaway", "delivery"];
const MAX_LINES = 20;
const MAX_QUANTITY_PER_LINE = 20;
const MAX_NAME_LENGTH = 50;
const MAX_ADDRESS_LENGTH = 200;
const MAX_UNIT_LENGTH = 50;
const MAX_INSTRUCTIONS_LENGTH = 200;
// Answers that mean "there isn't one", for the optional unit and instructions.
const NONE_ANSWERS = ["none", "no", "n/a", "na", "nothing", "no instructions"];

// Order status flow:
//   building -> awaiting_confirmation -> confirmed
//   building or awaiting_confirmation -> cancelled
// Changing the order while awaiting confirmation sends it back to "building".
// The clock used for promotion times. Tests can replace it with setClockForTests().
let clock = () => new Date();

function setClockForTests(fn) {
  clock = fn;
}

const STATUS = {
  BUILDING: "building",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
};

function ok() {
  return { ok: true };
}

function fail(error) {
  return { ok: false, error };
}

function createOrder() {
  return {
    items: [], // { lineId, itemId, name, category, options: { size }, unitPrice, quantity, lineTotal, priceProblem }
    orderType: null, // "dine-in" or "takeaway" (takeaway = the customer picks it up)
    customer: { name: null },
    pickupTime: null, // takeaway only: null (not chosen yet), "asap", or a time today such as "14:30"
    // Delivery only. null = not given yet. For unit and instructions, "" means the
    // customer said there isn't one. Nothing here is ever filled in by guessing.
    delivery: emptyDelivery(),
    promotion: null, // { id, name, discount, definition }
    // Tax and delivery fee settings from data/pricing.json (see refreshPricing).
    charges: { taxPercent: 0, deliveryFee: 0 },
    subtotal: 0, // items at menu prices
    discount: 0, // promotion
    tax: 0, // on (subtotal - discount)
    deliveryFee: 0, // delivery orders only
    total: 0, // subtotal - discount + tax + deliveryFee
    confirmed: false,
    status: STATUS.BUILDING,
    confirmedAt: null,
    // The fingerprint of the final summary the customer was shown (see checkoutSummary.js).
    // Set when the order starts waiting for a yes; cleared by any change.
    reviewedSummaryId: null,
    orderNumber: null, // given when the confirmed order is saved
    nextLineId: 1,
    lastNote: null, // e.g. "Promotion X no longer applies: ..."
  };
}

// addressConfirmed: the customer has heard the full address read back and said it is correct.
// It goes back to false whenever the address or unit changes.
function emptyDelivery() {
  return { phone: null, address: null, unit: null, instructions: null, addressConfirmed: false };
}

// The full delivery address as it is read back: the address, then the unit if there is one.
function formatDeliveryAddress(delivery) {
  if (!delivery.address) return null;
  return delivery.unit ? `${delivery.address}, ${delivery.unit}` : delivery.address;
}

// Only orders that are still being built (or waiting for a yes) can change.
function checkEditable(order) {
  if (order.status === STATUS.CONFIRMED) {
    return fail("This order is already confirmed. Please speak to café staff to change it.");
  }
  if (order.status === STATUS.CANCELLED) {
    return fail("This order was cancelled.");
  }
  return null;
}

// Any change after a confirmation request needs a fresh "yes".
function markChanged(order) {
  if (order.status === STATUS.AWAITING_CONFIRMATION) {
    order.status = STATUS.BUILDING;
  }
  order.reviewedSummaryId = null; // the summary the customer saw no longer matches
}

function isValidQuantity(quantity) {
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY_PER_LINE;
}

// ---------- Items ----------

// Adds an item from the menu. If the same item and size is already in the order,
// the quantity is added to that line instead.
function addItem(order, menu, { itemId, size = null, quantity = 1 } = {}) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;

  const menuItem = menu.items.find((item) => item.id === itemId);
  if (!menuItem) return fail(`"${itemId}" is not on the menu.`);
  if (!menuItem.available) return fail(`${menuItem.name} is not available right now.`);
  if (!isValidQuantity(quantity)) {
    return fail(`Quantity must be a whole number from 1 to ${MAX_QUANTITY_PER_LINE}.`);
  }

  // Work out the size and price from the menu only.
  let unitPrice = menuItem.price;
  let sizeName = null;
  if (menuItem.sizes.length > 0) {
    if (size === null) {
      return fail(`Please choose a size for ${menuItem.name}: ${menuItem.sizes.map((s) => s.name).join(", ")}.`);
    }
    const menuSize = menuItem.sizes.find((s) => s.name.toLowerCase() === String(size).toLowerCase());
    if (!menuSize) {
      return fail(`${menuItem.name} comes in: ${menuItem.sizes.map((s) => s.name).join(", ")}.`);
    }
    sizeName = menuSize.name;
    unitPrice = menuItem.price + menuSize.extraCost;
  } else if (size !== null) {
    return fail(`${menuItem.name} doesn't come in different sizes.`);
  }

  const existing = order.items.find((line) => line.itemId === itemId && line.options.size === sizeName);
  if (existing) {
    if (!isValidQuantity(existing.quantity + quantity)) {
      return fail(`You can order up to ${MAX_QUANTITY_PER_LINE} of one item.`);
    }
    existing.quantity += quantity;
  } else {
    if (order.items.length >= MAX_LINES) {
      return fail(`An order can have up to ${MAX_LINES} different items.`);
    }
    order.items.push({
      lineId: order.nextLineId++,
      itemId,
      name: menuItem.name,
      category: menuItem.category,
      options: { size: sizeName },
      unitPrice,
      quantity,
      lineTotal: 0,
      priceProblem: null, // set by refreshPricing() if the menu can no longer price this line
    });
  }

  markChanged(order);
  recalculate(order);
  return ok();
}

// Sets a line's quantity. A quantity of 0 removes the line.
function updateItemQuantity(order, lineId, quantity) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;

  const line = order.items.find((l) => l.lineId === lineId);
  if (!line) return fail("That item isn't in the order.");

  if (quantity === 0) return removeItem(order, lineId);
  if (!isValidQuantity(quantity)) {
    return fail(`Quantity must be a whole number from 0 to ${MAX_QUANTITY_PER_LINE}.`);
  }

  line.quantity = quantity;
  markChanged(order);
  recalculate(order);
  return ok();
}

function removeItem(order, lineId) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;

  const index = order.items.findIndex((l) => l.lineId === lineId);
  if (index === -1) return fail("That item isn't in the order.");

  order.items.splice(index, 1);
  markChanged(order);
  recalculate(order);
  return ok();
}

// Changes a line's quantity and/or size. Everything is checked before anything changes,
// so a refused change leaves the order exactly as it was.
// The price is looked up again in the menu. If the new size matches another line of the
// same item, the two lines are combined into that other line.
// Returns { ok: true, lineId, merged } or { ok: false, error }.
function modifyItem(order, menu, lineId, { quantity, size } = {}) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;

  const line = order.items.find((l) => l.lineId === lineId);
  if (!line) return fail("That item isn't in the order.");
  if (quantity === undefined && size === undefined) return fail("Please say what you'd like to change.");

  const menuItem = menu.items.find((item) => item.id === line.itemId);
  if (!menuItem) return fail(`${line.name} is no longer on the menu.`);
  if (!menuItem.available) return fail(`${menuItem.name} isn't available right now, so it can't be changed.`);

  const newQuantity = quantity === undefined ? line.quantity : quantity;
  if (!isValidQuantity(newQuantity)) {
    return fail(`Quantity must be a whole number from 1 to ${MAX_QUANTITY_PER_LINE}.`);
  }

  // Work out the size and price from the menu only.
  const sizeList = menuItem.sizes.map((s) => s.name).join(", ");
  let sizeName = line.options.size;
  if (size !== undefined) {
    if (menuItem.sizes.length === 0) return fail(`${menuItem.name} doesn't come in different sizes.`);
    const menuSize = menuItem.sizes.find((s) => s.name.toLowerCase() === String(size).toLowerCase());
    if (!menuSize) return fail(`${menuItem.name} comes in: ${sizeList}.`);
    sizeName = menuSize.name;
  }
  let unitPrice = menuItem.price;
  if (menuItem.sizes.length > 0) {
    const menuSize = menuItem.sizes.find((s) => s.name === sizeName);
    if (!menuSize) return fail(`Please choose a size for ${menuItem.name}: ${sizeList}.`);
    unitPrice += menuSize.extraCost;
  }

  const other = order.items.find((l) => l !== line && l.itemId === line.itemId && l.options.size === sizeName);
  if (other) {
    if (!isValidQuantity(other.quantity + newQuantity)) {
      return fail(`You can order up to ${MAX_QUANTITY_PER_LINE} of one item.`);
    }
    other.quantity += newQuantity;
    other.unitPrice = unitPrice;
    other.priceProblem = null;
    order.items.splice(order.items.indexOf(line), 1);
  } else {
    line.quantity = newQuantity;
    line.options.size = sizeName;
    line.unitPrice = unitPrice;
    line.priceProblem = null;
  }

  markChanged(order);
  recalculate(order);
  return { ok: true, lineId: other ? other.lineId : line.lineId, merged: Boolean(other) };
}

// ---------- Order type and customer ----------

function setOrderType(order, orderType) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;
  if (!ORDER_TYPES.includes(orderType)) {
    return fail(`Order type must be one of: ${ORDER_TYPES.join(", ")}.`);
  }

  order.orderType = orderType;
  if (orderType !== "takeaway") order.pickupTime = null; // a pickup time only makes sense for takeaway
  if (orderType !== "delivery") order.delivery = emptyDelivery(); // don't keep personal details that aren't needed
  markChanged(order);
  recalculate(order); // the delivery fee depends on the order type
  return ok();
}

// Sets when a takeaway order will be picked up: "asap", or a time later today in
// the café's local time ("HH:MM", 24-hour, e.g. "14:30" or "9:05").
// The data files have no opening hours, so the time is only checked to be later today.
function setPickupTime(order, pickupTime) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;
  if (order.orderType !== "takeaway") {
    return fail("A pickup time is only for takeaway orders.");
  }

  const text = typeof pickupTime === "string" ? pickupTime.trim().toLowerCase() : "";
  let value;
  if (text === "asap") {
    value = "asap";
  } else {
    const match = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
      return fail("Please give the pickup time like 14:30, or say as soon as possible.");
    }
    value = `${match[1].padStart(2, "0")}:${match[2]}`;
    if (value <= cafeLocalTime(clock()).time) {
      return fail("That time has already passed today. Please choose a later time, or as soon as possible.");
    }
  }

  order.pickupTime = value;
  markChanged(order);
  return ok();
}

// The system prompt says never to accept or repeat card numbers or bank details.
// Looks for a card or account number (13 to 19 digits, spaces or dashes allowed between them)
// or an IBAN (e.g. PK36SCBL0000001123456702). Phone numbers are shorter, so they don't match.
function containsPaymentDetails(text) {
  const digitRuns = text.match(/\d[\d -]*\d/g) || [];
  if (digitRuns.some((run) => { const n = run.replace(/\D/g, "").length; return n >= 13 && n <= 19; })) return true;
  // An IBAN: 2 letters, 2 digits, then 11-30 letters/digits (often in groups of 4), mostly digits.
  const ibans = text.match(/\b[a-z]{2}\d{2}(?:[ -]?[a-z0-9]){11,30}\b/gi) || [];
  return ibans.some((candidate) => candidate.replace(/\D/g, "").length >= 10);
}

// The refusal never repeats what was typed, and nothing from that request is stored.
function paymentDetailsRefusal(order) {
  return fail("Please don't share card or bank details with me. I haven't saved them. "
    + (order.orderType === "delivery" ? "Please ask café staff about payment." : "Payment is made at the counter."));
}

// Only the customer's name is stored, as the system prompt says.
function setCustomerName(order, name) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;

  const cleanName = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (cleanName === "") return fail("Please give a name for the order.");
  if (containsPaymentDetails(cleanName)) return paymentDetailsRefusal(order);
  if (cleanName.length > MAX_NAME_LENGTH) {
    return fail(`The name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }

  order.customer.name = cleanName;
  markChanged(order);
  return ok();
}

// Text from the customer, on one line: control characters removed, spaces collapsed.
function cleanText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ") : "";
}

// Sets delivery details: any of { phone, address, unit, instructions }.
// Every value given is checked first; if one is invalid, nothing changes.
// - phone: 7 to 15 digits, optionally starting with +; spaces, dashes, dots and brackets are allowed.
//   Stored as + and digits only. No country code is added or assumed.
// - address: the full address as the customer gives it. It can't be checked against a map,
//   so it only has to look like a full address: at least two words, 8 characters or more,
//   with letters and a house or building number.
// - unit, instructions: optional, but must be answered; "none" (or "no", "n/a") is stored as "".
function setDeliveryDetails(order, details = {}) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;
  if (order.orderType !== "delivery") {
    return fail("Delivery details are only for delivery orders.");
  }

  // Card or bank details anywhere in the request: refuse all of it before anything is checked.
  for (const field of ["address", "unit", "instructions"]) {
    if (details[field] !== undefined && containsPaymentDetails(cleanText(details[field]))) return paymentDetailsRefusal(order);
  }

  const updates = {};
  if (details.phone !== undefined) {
    const text = cleanText(details.phone);
    const digits = text.replace(/\D/g, "");
    if (!/^\+?[\d\s().-]+$/.test(text) || digits.length < 7 || digits.length > 15) {
      return fail("Please give a phone number using digits only, for example 0300 1234567.");
    }
    updates.phone = (text.startsWith("+") ? "+" : "") + digits;
  }
  if (details.address !== undefined) {
    const text = cleanText(details.address);
    if (text.length < 8 || text.split(" ").length < 2 || !/[a-z]/i.test(text) || !/\d/.test(text)) {
      return fail("Please give the full delivery address, including the house or building number, street and area.");
    }
    if (text.length > MAX_ADDRESS_LENGTH) {
      return fail(`The address must be ${MAX_ADDRESS_LENGTH} characters or fewer.`);
    }
    updates.address = text;
  }
  for (const [field, max, label] of [["unit", MAX_UNIT_LENGTH, "apartment or unit"], ["instructions", MAX_INSTRUCTIONS_LENGTH, "delivery instructions"]]) {
    if (details[field] === undefined) continue;
    const text = cleanText(details[field]);
    if (text === "") return fail(`Please give the ${label}, or say none.`);
    if (text.length > max) return fail(`The ${label} must be ${max} characters or fewer.`);
    updates[field] = NONE_ANSWERS.includes(text.toLowerCase().replace(/\.$/, "")) ? "" : text;
  }

  Object.assign(order.delivery, updates);
  if (updates.address !== undefined || updates.unit !== undefined) {
    order.delivery.addressConfirmed = false; // a changed address must be read back and confirmed again
  }
  markChanged(order);
  return ok();
}

// Records the customer's explicit "yes, that address is correct".
// Only possible once the whole address (address and unit, or "none") is known.
function confirmDeliveryAddress(order) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;
  if (order.orderType !== "delivery") return fail("Only delivery orders have an address to confirm.");
  if (order.delivery.address === null || order.delivery.unit === null) {
    return fail("There isn't a full delivery address to confirm yet.");
  }
  order.delivery.addressConfirmed = true;
  return ok();
}

// ---------- Promotions ----------

// Returns the café's local date, weekday and time, e.g. { date: "2026-11-24", day: "Tue", time: "08:45" }.
function cafeLocalTime(now) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CAFE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const { type, value } of formatter.formatToParts(now)) parts[type] = value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day: parts.weekday,
    time: `${parts.hour}:${parts.minute}`,
  };
}

// Turns order lines into single units, e.g. 2 lattes -> 2 units.
function orderUnits(order) {
  const units = [];
  for (const line of order.items) {
    for (let i = 0; i < line.quantity; i++) {
      units.push({ itemId: line.itemId, category: line.category, unitPrice: line.unitPrice });
    }
  }
  return units;
}

// Checks a promotion against the order.
// Returns { eligible: true, discount } or { eligible: false, reason }.
function evaluatePromotion(order, promo) {
  if (!promo.active) return { eligible: false, reason: "This promotion isn't active." };

  const local = cafeLocalTime(clock());
  if (local.date < promo.startDate || local.date > promo.endDate) {
    return { eligible: false, reason: `This promotion runs from ${promo.startDate} to ${promo.endDate}.` };
  }
  if (!promo.days.includes(local.day)) {
    return { eligible: false, reason: `This promotion is only on ${promo.days.join(", ")}.` };
  }
  if (local.time < promo.startTime || local.time > promo.endTime) {
    return { eligible: false, reason: `This promotion is only from ${promo.startTime} to ${promo.endTime}.` };
  }

  const subtotal = order.items.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  if (subtotal < promo.eligibility.minOrderTotal) {
    return { eligible: false, reason: `This promotion needs an order of at least ${promo.eligibility.minOrderTotal}.` };
  }

  // Match each required item to units in the order. The cheapest matching units are
  // used, so a discount never comes out bigger than it should.
  const available = orderUnits(order).sort((a, b) => a.unitPrice - b.unitPrice);
  const usedUnits = [];
  for (const requirement of promo.eligibility.requiredItems) {
    const matches = (unit) =>
      requirement.itemId ? unit.itemId === requirement.itemId : unit.category === requirement.category;
    for (let i = 0; i < requirement.quantity; i++) {
      const index = available.findIndex(matches);
      if (index === -1) {
        return { eligible: false, reason: "The order doesn't have the items this promotion needs." };
      }
      usedUnits.push(available.splice(index, 1)[0]);
    }
  }

  // Work out the discount.
  let discount = 0;
  const { type, value } = promo.discount;
  if (type === "percent") {
    const base = promo.eligibility.requiredItems.length > 0
      ? usedUnits.reduce((sum, unit) => sum + unit.unitPrice, 0) // only the promotion's items
      : subtotal; // the whole order
    discount = Math.round((base * value) / 100);
  } else if (type === "free_item") {
    discount = usedUnits
      .sort((a, b) => a.unitPrice - b.unitPrice)
      .slice(0, value)
      .reduce((sum, unit) => sum + unit.unitPrice, 0);
  } else {
    return { eligible: false, reason: "This promotion type isn't supported." };
  }

  return { eligible: true, discount: Math.min(discount, subtotal) };
}

// Applies one promotion by ID. Replaces any promotion already applied,
// because only one promotion is allowed per order.
function applyPromotion(order, promotionsData, promotionId) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;

  const promo = promotionsData.promotions.find((p) => p.id === promotionId);
  if (!promo) return fail(`"${promotionId}" is not a current promotion.`);

  const result = evaluatePromotion(order, promo);
  if (!result.eligible) return fail(result.reason);

  order.promotion = { id: promo.id, name: promo.name, discount: result.discount, definition: promo };
  markChanged(order);
  recalculate(order);
  return ok();
}

function removePromotion(order) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;

  order.promotion = null;
  markChanged(order);
  recalculate(order);
  return ok();
}

// ---------- Totals ----------

// Tax on a whole-rupee amount, rounded to the nearest rupee (halves round up).
// Uses whole numbers only (percent x 100), so the result is exact and always the same.
function calculateTax(amount, taxPercent) {
  const basisPoints = Math.round(taxPercent * 100); // 16% -> 1600, 7.5% -> 750
  return Math.floor((amount * basisPoints + 5000) / 10000);
}

// Recalculates every total from the stored menu prices, in this order:
//   line totals = unit price x quantity
//   subtotal    = sum of line totals
//   discount    = the promotion, re-checked (removed if the order no longer qualifies)
//   tax         = taxPercent of (subtotal - discount)
//   deliveryFee = the fee, for delivery orders with at least one item
//   total       = subtotal - discount + tax + deliveryFee
// All amounts are whole rupees. Returns a note if a promotion was removed, so the bot can tell the customer.
function recalculate(order) {
  for (const line of order.items) {
    line.lineTotal = line.unitPrice * line.quantity;
  }
  order.subtotal = order.items.reduce((sum, line) => sum + line.lineTotal, 0);

  let note = null;
  if (order.promotion) {
    const result = evaluatePromotion(order, order.promotion.definition);
    if (result.eligible) {
      order.promotion.discount = result.discount;
    } else {
      note = `${order.promotion.name} no longer applies: ${result.reason}`;
      order.promotion = null;
    }
  }

  order.discount = order.promotion ? order.promotion.discount : 0;
  order.tax = calculateTax(order.subtotal - order.discount, order.charges.taxPercent);
  order.deliveryFee = order.orderType === "delivery" && order.items.length > 0 ? order.charges.deliveryFee : 0;
  order.total = order.subtotal - order.discount + order.tax + order.deliveryFee;
  order.lastNote = note;
  return note;
}

// Brings an order's prices up to date with the current menu and data/pricing.json.
// Called by the server at the start of every request, before anything else.
// - Confirmed and cancelled orders are left exactly as they were: their prices are final.
// - Each line's unit price is looked up again in the menu. A line the menu can no longer
//   price (item removed, unavailable, or size gone) keeps its last price but gets a
//   priceProblem, and the order can't be confirmed until it is changed or removed.
// - If anything changes while the customer is being asked to confirm, the order goes
//   back to "building", so they confirm the new total, not the old one.
// - With promotionsData (data/promotions.json), the applied promotion is checked against the
//   current file: its latest rules are used, and it is removed if it is no longer in the file.
// Returns a note for the customer if a price, charge or promotion changed, otherwise null.
function refreshPricing(order, menu, pricing, promotionsData = null) {
  if (order.status === STATUS.CONFIRMED || order.status === STATUS.CANCELLED) return null;

  const before = JSON.stringify([order.items.map((l) => [l.unitPrice, l.priceProblem]), order.total, order.promotion && order.promotion.id]);

  let removedPromotionNote = null;
  if (promotionsData && order.promotion) {
    const current = promotionsData.promotions.find((p) => p.id === order.promotion.id);
    if (current) {
      order.promotion.definition = current; // recalculate() below re-checks it with the latest rules
      order.promotion.name = current.name;
    } else {
      removedPromotionNote = `${order.promotion.name} is no longer available.`;
      order.promotion = null;
    }
  }

  order.charges = { taxPercent: pricing.taxPercent, deliveryFee: pricing.deliveryFee };
  for (const line of order.items) {
    const menuItem = menu.items.find((item) => item.id === line.itemId);
    if (!menuItem) {
      line.priceProblem = `${line.name} is no longer on the menu.`;
      continue;
    }
    if (!menuItem.available) {
      line.priceProblem = `${menuItem.name} isn't available right now.`;
      continue;
    }
    let unitPrice = menuItem.price;
    if (menuItem.sizes.length > 0) {
      const menuSize = menuItem.sizes.find((s) => s.name === line.options.size);
      if (!menuSize) {
        line.priceProblem = `${menuItem.name} no longer comes in ${line.options.size || "that size"}.`;
        continue;
      }
      unitPrice += menuSize.extraCost;
    } else if (line.options.size !== null) {
      line.priceProblem = `${menuItem.name} no longer comes in different sizes.`;
      continue;
    }
    line.unitPrice = unitPrice;
    line.priceProblem = null;
  }

  const promotionNote = recalculate(order);
  const after = JSON.stringify([order.items.map((l) => [l.unitPrice, l.priceProblem]), order.total, order.promotion && order.promotion.id]);
  if (before === after) return null;

  if (order.status === STATUS.AWAITING_CONFIRMATION) order.status = STATUS.BUILDING;
  order.reviewedSummaryId = null; // prices changed, so the summary must be reviewed again
  const notes = [];
  if (removedPromotionNote) notes.push(removedPromotionNote);
  if (promotionNote) notes.push(promotionNote);
  for (const line of order.items) if (line.priceProblem) notes.push(line.priceProblem);
  if (notes.length === 0) notes.push("Some prices have changed since you added your items.");
  return `Note: ${notes.join(" ")} Your order total is now ${pricing.currency} ${order.total}.`;
}

// ---------- Confirmation ----------

// Everything that stops an order going to checkout, without changing anything:
//   missing:      details still needed, e.g. "a name for the order"
//   itemProblems: lines the menu can no longer price (see refreshPricing)
//   timeProblem:  a chosen pickup time that has already passed, or null
function checkoutBlockers(order) {
  const missing = [];
  if (order.items.length === 0) missing.push("at least one item");
  if (!order.orderType) missing.push("dine-in, pickup or delivery");
  if (!order.customer.name) missing.push("a name for the order");
  if (order.orderType === "delivery") {
    const d = order.delivery;
    if (d.phone === null) missing.push("a phone number");
    if (d.address === null) missing.push("the delivery address");
    if (d.unit === null) missing.push("the apartment or unit (or none)");
    if (d.instructions === null) missing.push("delivery instructions (or none)");
    if (!d.addressConfirmed) missing.push("confirmation of the delivery address");
  }
  const itemProblems = order.items.filter((l) => l.priceProblem).map((l) => l.priceProblem);
  const timeProblem = order.pickupTime && order.pickupTime !== "asap" && order.pickupTime <= cafeLocalTime(clock()).time
    ? "The pickup time has already passed. Please choose a later time, or as soon as possible."
    : null;
  return { missing, itemProblems, timeProblem };
}

// Checks the order is complete, then waits for the customer's "yes".
function requestConfirmation(order) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;

  const { missing, itemProblems, timeProblem } = checkoutBlockers(order);
  if (missing.length > 0) return fail(`The order still needs: ${missing.join(", ")}.`);
  if (itemProblems.length > 0) {
    return fail(`Please change or remove these items first: ${itemProblems.join(" ")}`);
  }
  if (timeProblem) return fail(timeProblem);

  // Re-check the promotion at the moment of asking (time windows can close).
  recalculate(order);
  order.status = STATUS.AWAITING_CONFIRMATION;
  return ok();
}

// Only works straight after requestConfirmation(), with no changes in between.
function confirmOrder(order) {
  if (order.status !== STATUS.AWAITING_CONFIRMATION) {
    return fail("Please review the order summary before confirming.");
  }

  order.confirmed = true;
  order.status = STATUS.CONFIRMED;
  order.confirmedAt = clock().toISOString();
  return ok();
}

function cancelOrder(order) {
  const blocked = checkEditable(order);
  if (blocked) return blocked;

  order.status = STATUS.CANCELLED;
  return ok();
}

// ---------- Reading the order ----------

// A clean copy of the order, safe to send to the frontend or the AI.
// Internal fields (promotion rules, line counter) are left out.
function getOrderSummary(order) {
  return {
    items: order.items.map(({ lineId, itemId, name, options, unitPrice, quantity, lineTotal, priceProblem }) => ({
      lineId,
      itemId,
      name,
      options: { ...options },
      unitPrice,
      quantity,
      lineTotal,
      problem: priceProblem || null,
    })),
    orderType: order.orderType,
    customer: { ...order.customer },
    pickupTime: order.pickupTime,
    delivery: { ...order.delivery },
    promotion: order.promotion
      ? { id: order.promotion.id, name: order.promotion.name, discount: order.promotion.discount }
      : null,
    subtotal: order.subtotal,
    discount: order.discount,
    taxPercent: order.charges.taxPercent,
    tax: order.tax,
    deliveryFee: order.deliveryFee,
    total: order.total,
    confirmed: order.confirmed,
    status: order.status,
    confirmedAt: order.confirmedAt,
    orderNumber: order.orderNumber,
    note: order.lastNote,
  };
}

module.exports = {
  STATUS,
  ORDER_TYPES,
  createOrder,
  addItem,
  updateItemQuantity,
  modifyItem,
  removeItem,
  setOrderType,
  setCustomerName,
  setPickupTime,
  setDeliveryDetails,
  confirmDeliveryAddress,
  formatDeliveryAddress,
  refreshPricing,
  calculateTax,
  checkoutBlockers,
  evaluatePromotion,
  cafeLocalTime,
  getClock: () => clock(),
  applyPromotion,
  removePromotion,
  requestConfirmation,
  confirmOrder,
  cancelOrder,
  getOrderSummary,
  setClockForTests,
};
