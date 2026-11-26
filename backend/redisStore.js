// CafeBot: orders and chat sessions stored in Upstash Redis (see redis.js).
//
// Used instead of data/orders.json and in-memory sessions when Redis is configured,
// for example on Vercel, where files can't be written and each request may be handled
// by a different copy of the server.
//
// Orders: one Redis hash, "cafebot:orders", with one field per order:
//   orderId -> the saved order record as JSON (the same record orderStore.js saves)
// The same safety rules apply as in orderStore.js:
// - every record is checked by validateConfirmedRecord before it is saved
// - order IDs are unique: HSETNX only adds a field that doesn't exist yet
// - a status change only happens if the order is still exactly as the staff member
//   saw it (an atomic compare-and-swap), otherwise it is refused with 409
//
// Sessions: one key per chat, "cafebot:session:<sessionId>", holding the session as JSON.
// A session ends 2 hours after its last message (Redis removes the key by itself).

const crypto = require("node:crypto");
const { createOrder, getClock } = require("./orderState");
const {
  validateConfirmedRecord, applyStatusChange, buildSavedRecord, newOrderId, StatusChangeError,
} = require("./orderStore");

const ORDERS_KEY = "cafebot:orders";
const SESSION_PREFIX = "cafebot:session:";
const SESSION_TTL_SECONDS = 2 * 60 * 60; // the same 2 hours as in-memory sessions
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Replaces an order only if it still holds exactly the JSON that was read.
// Returns 1 if it was replaced, 0 if someone else changed it first.
const COMPARE_AND_SWAP = `
if redis.call("HGET", KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[3])
  return 1
end
return 0
`.trim();

// The same { save, list, updateStatus } as createOrderStore() in orderStore.js.
function createRedisOrderStore(command) {
  return {
    // Checks the record, gives it a unique orderId and savedAt, and saves it.
    // Resolves to { orderId, savedAt }, or throws and saves nothing.
    async save(record) {
      validateConfirmedRecord(record);
      const savedAt = getClock().toISOString();
      for (let attempt = 0; attempt < 10; attempt++) {
        const orderId = newOrderId(record.confirmedAt, new Set());
        const added = await command("HSETNX", ORDERS_KEY, orderId, JSON.stringify(buildSavedRecord(record, orderId, savedAt)));
        if (Number(added) === 1) return { orderId, savedAt };
      }
      throw new Error("Could not create a unique order ID.");
    },

    // All saved orders, oldest first.
    async list() {
      const values = (await command("HVALS", ORDERS_KEY)) || [];
      return values
        .map((value) => JSON.parse(value))
        .sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt));
    },

    // Moves one order from "from" to "to" (see applyStatusChange in orderStore.js).
    async updateStatus(orderId, from, to) {
      const before = await command("HGET", ORDERS_KEY, orderId);
      if (before === null || before === undefined) throw new StatusChangeError("Order not found.", 404);
      const order = applyStatusChange(JSON.parse(before), from, to); // throws 409 / 422
      const swapped = await command("EVAL", COMPARE_AND_SWAP, 1, ORDERS_KEY, orderId, before, JSON.stringify(order));
      if (Number(swapped) !== 1) {
        throw new StatusChangeError("This order was just changed by someone else. Please refresh.", 409);
      }
      return order;
    },
  };
}

// Sessions with load(sessionId) and save(session), like createMemorySessionStore() in server.js.
function createRedisSessionStore(command) {
  return {
    // The saved session for this ID, or a new one if the ID is missing, unknown or expired.
    async load(sessionId) {
      if (typeof sessionId === "string" && UUID_PATTERN.test(sessionId)) {
        const saved = await command("GET", SESSION_PREFIX + sessionId);
        if (saved) return JSON.parse(saved);
      }
      return { id: crypto.randomUUID(), order: createOrder(), pendingItem: null };
    },

    // Saves the session and restarts its 2-hour timer.
    async save(session) {
      await command("SET", SESSION_PREFIX + session.id, JSON.stringify(session), "EX", SESSION_TTL_SECONDS);
    },
  };
}

module.exports = { createRedisOrderStore, createRedisSessionStore, ORDERS_KEY, SESSION_PREFIX, SESSION_TTL_SECONDS };
