// CafeBot: the complete order summary shown before checkout.
//
// buildCheckoutSummary() returns one structured object with everything the customer
// needs to check before placing the order:
//   items        each line with quantity, customizations, unit price, line total, any problem
//   fulfillment  dine-in, pickup (with pickup time) or delivery (with all delivery details)
//   promotion    the applied promotion (re-checked against promotions.json) and any other
//                promotions the order qualifies for right now, with their discount
//   totals       subtotal, discount, tax, delivery fee and total
//   ready        true only when nothing is missing; otherwise "blockers" says what is
//
// Every amount was calculated by orderState.js. Nothing here works out a price.
//
// The summary has a "summaryId": a fingerprint of everything the customer is agreeing to
// (items, fulfillment, promotion, totals). Any change to any of these gives a new summaryId.
//
// The action sent to /api/chat is:  { "type": "review_order" }
// This is the start of the confirmation gate: when the order is complete, reviewing it
// sets it to "awaiting_confirmation" and records the summaryId the customer was shown.
// Only confirm_order (confirmOrder.js) can then place it, with that same summaryId.

const crypto = require("node:crypto");
const {
  getOrderSummary, checkoutBlockers, evaluatePromotion, formatDeliveryAddress, requestConfirmation, STATUS,
} = require("./orderState");

const FULFILLMENT_TYPES = { "dine-in": "dine-in", takeaway: "pickup", delivery: "delivery" };

function validateReviewOrderAction(action) {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "\"action\" must be an object.";
  }
  if (action.type !== "review_order") {
    return "\"action.type\" must be \"review_order\".";
  }
  if (Object.keys(action).some((key) => key !== "type")) {
    return "\"action\" for review_order only has a \"type\".";
  }
  return null;
}

// Other promotions this order qualifies for right now (only one can be applied).
// The discount is the one evaluatePromotion() calculates. Biggest saving first.
function otherEligiblePromotions(order, promotionsData) {
  if (!promotionsData || order.items.length === 0) return [];
  const appliedId = order.promotion ? order.promotion.id : null;
  return promotionsData.promotions
    .filter((promo) => promo.id !== appliedId)
    .map((promo) => ({ promo, result: evaluatePromotion(order, promo) }))
    .filter(({ result }) => result.eligible && result.discount > 0)
    .map(({ promo, result }) => ({ id: promo.id, name: promo.name, description: promo.description, discount: result.discount }))
    .sort((a, b) => b.discount - a.discount);
}

// A short fingerprint of what the customer agrees to. Status and readiness are left out,
// so the same order gives the same summaryId before and after it starts waiting for a yes.
function summaryFingerprint({ items, fulfillment, promotion, totals }) {
  const content = JSON.stringify({ items, fulfillment, promotion: promotion.applied, totals });
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function buildCheckoutSummary(order, menu, promotionsData = null) {
  const summary = getOrderSummary(order);
  const finished = order.status === STATUS.CONFIRMED || order.status === STATUS.CANCELLED;
  const { missing, itemProblems, timeProblem } = checkoutBlockers(order);

  const fulfillment = { type: FULFILLMENT_TYPES[order.orderType] || null, customerName: summary.customer.name };
  if (order.orderType === "takeaway") fulfillment.pickupTime = summary.pickupTime; // null, "asap" or "HH:MM"
  if (order.orderType === "delivery") {
    fulfillment.delivery = { ...summary.delivery, fullAddress: formatDeliveryAddress(summary.delivery) };
  }

  const applied = summary.promotion && promotionsData
    ? promotionsData.promotions.find((p) => p.id === summary.promotion.id)
    : null;

  const checkout = {
    summaryId: null,
    status: summary.status,
    ready: !finished && missing.length === 0 && itemProblems.length === 0 && !timeProblem,
    blockers: { missing, itemProblems, timeProblem },
    items: summary.items.map((line) => ({
      lineId: line.lineId,
      itemId: line.itemId,
      name: line.name,
      quantity: line.quantity,
      customizations: line.options.size ? { size: line.options.size } : {},
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      problem: line.problem,
    })),
    fulfillment,
    promotion: {
      applied: summary.promotion
        ? { ...summary.promotion, description: applied ? applied.description : null }
        : null,
      otherEligible: finished ? [] : otherEligiblePromotions(order, promotionsData),
    },
    totals: {
      currency: menu.currency,
      subtotal: summary.subtotal,
      discount: summary.discount,
      taxPercent: summary.taxPercent,
      tax: summary.tax,
      deliveryFee: summary.deliveryFee,
      total: summary.total,
    },
    note: summary.note,
  };
  checkout.summaryId = summaryFingerprint(checkout);
  return checkout;
}

// The same summary as text for the customer. Every line comes from the structured summary.
function formatCheckoutSummary(checkout) {
  const money = (amount) => `${checkout.totals.currency} ${amount}`;
  const lines = [];

  if (checkout.items.length === 0) {
    lines.push("Your order is empty, so there's nothing to check out yet. What would you like?");
    return lines.join("\n");
  }

  lines.push("Here's your order summary. Please check it:");
  for (const item of checkout.items) {
    const label = item.customizations.size ? `${item.customizations.size} ${item.name}` : item.name;
    lines.push(`- ${item.quantity} × ${label} (${money(item.unitPrice)} each): ${money(item.lineTotal)}`);
    if (item.problem) lines.push(`  (${item.problem} Please change or remove it.)`);
  }

  const f = checkout.fulfillment;
  if (f.type === "dine-in") lines.push("Dine-in");
  if (f.type === "pickup") {
    lines.push(f.pickupTime === "asap" ? "Pickup as soon as possible"
      : f.pickupTime ? `Pickup at ${f.pickupTime}` : "Pickup");
  }
  if (f.type === "delivery") {
    lines.push(`Delivery to: ${f.delivery.fullAddress || "(address still needed)"}`);
    if (f.delivery.phone) lines.push(`Phone: ${f.delivery.phone}`);
    if (f.delivery.instructions) lines.push(`Instructions: ${f.delivery.instructions}`);
  }
  if (f.customerName) lines.push(`Name: ${f.customerName}`);

  const t = checkout.totals;
  const p = checkout.promotion;
  lines.push(`Subtotal: ${money(t.subtotal)}`);
  if (p.applied) lines.push(`${p.applied.name}: -${money(t.discount)}`);
  if (t.tax > 0) lines.push(`Tax (${t.taxPercent}%): ${money(t.tax)}`);
  if (t.deliveryFee > 0) lines.push(`Delivery fee: ${money(t.deliveryFee)}`);
  lines.push(`Total: ${money(t.total)}`);

  if (p.otherEligible.length > 0) {
    const list = p.otherEligible.map((o) => `${o.name} (saves ${money(o.discount)})`).join(", ");
    lines.push(p.applied
      ? `Your order also qualifies for: ${list}. Only one promotion can be used per order.`
      : `Your order qualifies for: ${list}. It isn't applied yet.`);
  }

  if (checkout.status === STATUS.CONFIRMED) {
    lines.push("This order is already confirmed.");
  } else if (checkout.status === STATUS.CANCELLED) {
    lines.push("This order was cancelled.");
  } else if (checkout.ready) {
    lines.push("Shall I place this order? Please reply yes to place it, or tell me what you'd like to change.");
  } else {
    const b = checkout.blockers;
    const missing = b.missing.filter((m) => m !== "at least one item"); // the order has items here
    if (missing.length > 0) lines.push(`Before checkout, I still need: ${missing.join("; ")}.`);
    const fixes = [...b.itemProblems, ...(b.timeProblem ? [b.timeProblem] : [])];
    if (fixes.length > 0) lines.push(`Before checkout, please sort this out: ${fixes.join(" ")}`);
  }
  return lines.join("\n");
}

// Handles one review_order action. context holds promotions (see server.js).
// A complete order is set to wait for the customer's yes, tied to this exact summary.
// An incomplete order is never left waiting for a yes.
// Returns { status: "awaiting_confirmation" | "incomplete" | "finished", reply, checkoutSummary }.
function handleReviewOrder(session, menu, action, context = {}) {
  const order = session.order;
  let checkout = buildCheckoutSummary(order, menu, context.promotions || null);
  const finished = checkout.status === STATUS.CONFIRMED || checkout.status === STATUS.CANCELLED;

  if (!finished) {
    if (checkout.ready) {
      if (order.status !== STATUS.AWAITING_CONFIRMATION) {
        const result = requestConfirmation(order);
        if (!result.ok) throw new Error(`Review said ready but confirmation was refused: ${result.error}`);
        checkout = buildCheckoutSummary(order, menu, context.promotions || null);
      }
      order.reviewedSummaryId = checkout.summaryId;
    } else {
      if (order.status === STATUS.AWAITING_CONFIRMATION) order.status = STATUS.BUILDING;
      order.reviewedSummaryId = null;
      checkout = buildCheckoutSummary(order, menu, context.promotions || null);
    }
  }

  return {
    status: finished ? "finished" : checkout.ready ? "awaiting_confirmation" : "incomplete",
    reply: formatCheckoutSummary(checkout),
    checkoutSummary: checkout,
  };
}

module.exports = { validateReviewOrderAction, handleReviewOrder, buildCheckoutSummary, formatCheckoutSummary };
