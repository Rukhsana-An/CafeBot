// CafeBot: the confirmation gate. The ONLY place an order is finalized and saved.
//
// An order is placed only when ALL of these are true:
//   1. It is waiting for a yes: review_order showed the customer the complete final summary.
//   2. The request carries that summary's "summaryId", and the order still matches it
//      exactly (same items, fulfillment, promotion and totals). If anything changed, even
//      a price, the customer is shown the new summary instead.
//   3. The customer's own reply is a clear, explicit yes. The reply is checked here by code,
//      not by the AI. Anything that isn't clearly yes or clearly no is "unclear" and does
//      NOT count: the customer is asked again, and nothing is placed.
//   4. Nothing still blocks checkout (e.g. a pickup time that has just passed).
// Then the order is saved to data/orders.json by orderStore.js, which checks the record
// again and gives it a unique order ID. Only if saving works is the order marked confirmed.
// If saving fails, the order stays exactly as it was, waiting for a yes.
//
// The action sent to /api/chat looks like:
//   { "type": "confirm_order", "summaryId": "3f9a…", "reply": "yes please" }
//   - "reply": the customer's exact words, unchanged. A true/false flag is not accepted,
//     so a confirmation can't be invented or guessed by whatever sends the request.

const { confirmOrder, STATUS } = require("./orderState");
const { buildCheckoutSummary, handleReviewOrder } = require("./checkoutSummary");

const MAX_REPLY_LENGTH = 200;
const MAX_SUMMARY_ID_LENGTH = 64;

// Whole replies that clearly mean yes. The reply must be exactly one of these
// (after lower-casing, trimming and removing final full stops / exclamation marks).
const CLEAR_YES = new Set([
  "yes", "yes please", "yes thanks", "yes thank you", "yeah", "yep", "yup",
  "yes place it", "yes place the order", "yes place my order", "yes please place it",
  "yes please place the order", "yes please place my order", "place it", "place the order",
  "place my order", "please place the order", "please place my order", "confirm",
  "i confirm", "yes confirm", "yes i confirm", "confirm the order", "confirm my order",
  "yes that's correct", "yes thats correct", "yes that's right", "yes thats right",
  "yes go ahead", "go ahead", "go ahead and place it",
  "haan", "haan ji", "ji haan", "jee haan",
]);

// Whole replies that clearly mean no / not yet.
const CLEAR_NO = new Set([
  "no", "no thanks", "no thank you", "nope", "not yet", "wait", "hold on", "stop",
  "don't place it", "dont place it", "do not place it", "don't", "dont",
  "i want to change something", "change something", "nahi", "nahin", "nahi abhi nahi",
]);

// Classifies the customer's reply: "yes", "no" or "unclear".
// Deliberately strict: "ok", "sure", "fine", "yes?", "yes but…", "I think so", emoji and
// anything else not on the lists above are "unclear", and never count as a yes.
function classifyConfirmationReply(reply) {
  if (typeof reply !== "string") return "unclear";
  if (reply.includes("?")) return "unclear"; // a question is never a confirmation
  const text = reply
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/,/g, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (CLEAR_YES.has(text)) return "yes";
  if (CLEAR_NO.has(text)) return "no";
  return "unclear";
}

function validateConfirmOrderAction(action) {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "\"action\" must be an object.";
  }
  if (action.type !== "confirm_order") {
    return "\"action.type\" must be \"confirm_order\".";
  }
  if (Object.keys(action).some((key) => !["type", "summaryId", "reply"].includes(key))) {
    return "\"action\" for confirm_order can only have: type, summaryId, reply.";
  }
  if (typeof action.summaryId !== "string" || action.summaryId === "" || action.summaryId.length > MAX_SUMMARY_ID_LENGTH) {
    return "\"action.summaryId\" must be the summaryId from the summary the customer reviewed.";
  }
  if (typeof action.reply !== "string" || action.reply.trim() === "" || action.reply.length > MAX_REPLY_LENGTH) {
    return `"action.reply" must be the customer's own reply, up to ${MAX_REPLY_LENGTH} characters.`;
  }
  return null;
}

// Shows the (new) final summary and asks for a fresh yes.
function reviewAgain(session, menu, context, intro, status) {
  const review = handleReviewOrder(session, menu, { type: "review_order" }, context);
  return { status, reply: `${intro}\n\n${review.reply}`, checkoutSummary: review.checkoutSummary };
}

// Handles one confirm_order action. context.saveOrder(record) must save the order and
// resolve to { orderId }, or throw if it can't (see orderStore.js and server.js).
// The orderId it returns is the order number shown to the customer.
// Returns { status, reply, checkoutSummary?, orderNumber? } with status one of:
//   "confirmed" | "unclear" | "declined" | "needs_review" | "summary_changed" | "already_confirmed" | "rejected" | "save_failed"
async function handleConfirmOrder(session, menu, action, context = {}) {
  const order = session.order;

  if (order.status === STATUS.CONFIRMED) {
    const which = order.orderNumber ? `Your order ${order.orderNumber}` : "Your order";
    return { status: "already_confirmed", reply: `${which} is already placed. Please speak to café staff if you need to change it.` };
  }
  if (order.status === STATUS.CANCELLED) {
    return { status: "rejected", reply: "This order was cancelled, so it can't be placed." };
  }

  // 1. Was the customer shown the complete final summary and asked for a yes?
  if (order.status !== STATUS.AWAITING_CONFIRMATION || !order.reviewedSummaryId) {
    return reviewAgain(session, menu, context, "Before I can place your order, please check the final summary.", "needs_review");
  }

  // 2. Is it still exactly the summary they saw?
  const current = buildCheckoutSummary(order, menu, context.promotions || null);
  if (action.summaryId !== order.reviewedSummaryId || current.summaryId !== order.reviewedSummaryId) {
    order.status = STATUS.BUILDING;
    order.reviewedSummaryId = null;
    return reviewAgain(session, menu, context, "Your order has changed since that summary, so I haven't placed it. Here's the updated summary.", "summary_changed");
  }

  // 3. Is the reply a clear yes?
  const answer = classifyConfirmationReply(action.reply);
  if (answer === "unclear") {
    return {
      status: "unclear",
      reply: "I need a clear yes before I place your order, so I haven't placed it. Please reply yes to place it, or tell me what you'd like to change.",
    };
  }
  if (answer === "no") {
    order.status = STATUS.BUILDING;
    order.reviewedSummaryId = null;
    return { status: "declined", reply: "No problem, I haven't placed your order. What would you like to change?" };
  }

  // 4. Nothing may still block checkout (time can pass while waiting).
  if (!current.ready) {
    return reviewAgain(session, menu, context, "I can't place your order just yet.", "needs_review");
  }

  // 5. Save first, on a copy. The real order is only confirmed if saving works.
  //    The record is built from the confirmed copy, never from the unconfirmed order.
  const draft = structuredClone(order);
  const result = confirmOrder(draft);
  if (!result.ok) return { status: "rejected", reply: result.error };

  const placed = buildCheckoutSummary(draft, menu, context.promotions || null);
  const record = {
    confirmedAt: draft.confirmedAt,
    status: draft.status,
    items: placed.items,
    fulfillment: placed.fulfillment,
    promotion: placed.promotion.applied,
    totals: placed.totals,
    confirmation: { summaryId: order.reviewedSummaryId, customerReply: action.reply },
  };

  let saved;
  try {
    if (typeof context.saveOrder !== "function") throw new Error("No order store configured.");
    saved = await context.saveOrder(record);
    if (!saved || typeof saved.orderId !== "string" || saved.orderId === "") {
      throw new Error("The order store didn't return an order ID.");
    }
  } catch (err) {
    console.error("Could not save confirmed order:", err.message);
    return {
      status: "save_failed",
      reply: "Sorry, I couldn't place your order just now, so it hasn't been placed. Please reply yes to try again, or ask café staff.",
    };
  }

  draft.orderNumber = saved.orderId;
  session.order = draft;
  const t = placed.totals;
  const name = placed.fulfillment.customerName;
  let reply = `Thank you, ${name}! Your order is placed. Order number: ${draft.orderNumber}. Total: ${t.currency} ${t.total}.`;
  if (placed.fulfillment.type !== "delivery") reply += " Payment is made at the counter.";
  return { status: "confirmed", reply, orderNumber: draft.orderNumber, checkoutSummary: placed };
}

module.exports = { validateConfirmOrderAction, handleConfirmOrder, classifyConfirmationReply, CLEAR_YES, CLEAR_NO };
