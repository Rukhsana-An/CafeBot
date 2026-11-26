// CafeBot: a short, readable summary of the current order.
//
// formatOrderSummary() turns the order into text the customer can read, e.g.
//
//   Your order:
//   - 2 × Large Cappuccino: PKR 1700
//   - 1 × Butter Croissant: PKR 450
//   Subtotal: PKR 2150
//   Morning Coffee & Croissant: -PKR 195
//   Total: PKR 1955
//   Pickup at 14:30 · Name: Sara
//
// Delivery orders also show "Deliver to:", "Phone:" and "Instructions:" lines once given.
//
// It only reads the order (from getOrderSummary), so it can't change anything.
// Prices and totals are the ones orderState.js already worked out from the menu.
//
// The action sent to /api/chat is simply:  { "type": "view_order" }

const { getOrderSummary, STATUS } = require("./orderState");

const ORDER_TYPE_LABELS = { "dine-in": "Dine-in", takeaway: "Pickup", delivery: "Delivery" };

function validateViewOrderAction(action) {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "\"action\" must be an object.";
  }
  if (action.type !== "view_order") {
    return "\"action.type\" must be \"view_order\".";
  }
  if (Object.keys(action).some((key) => key !== "type")) {
    return "\"action\" for view_order only has a \"type\".";
  }
  return null;
}

// summary: the object returned by getOrderSummary(). currency: e.g. "PKR".
function formatOrderSummary(summary, currency) {
  const money = (amount) => `${currency} ${amount}`;

  if (summary.items.length === 0) {
    if (summary.status === STATUS.CANCELLED) return "This order was cancelled.";
    return "Your order is empty. What would you like?";
  }

  const lines = ["Your order:"];
  for (const item of summary.items) {
    // Size is the only customization on the menu, so it is shown before the name.
    const label = item.options.size ? `${item.options.size} ${item.name}` : item.name;
    lines.push(`- ${item.quantity} × ${label}: ${money(item.lineTotal)}`);
    if (item.problem) lines.push(`  (${item.problem} Please change or remove it.)`);
  }

  // Every amount here was calculated by orderState.js. Nothing is worked out in this file.
  // Charges of 0 aren't shown, so "PKR 0" is never read as a promise of something free.
  if (summary.promotion || summary.tax > 0 || summary.deliveryFee > 0) {
    lines.push(`Subtotal: ${money(summary.subtotal)}`);
  }
  if (summary.promotion) lines.push(`${summary.promotion.name}: -${money(summary.discount)}`);
  if (summary.tax > 0) lines.push(`Tax (${summary.taxPercent}%): ${money(summary.tax)}`);
  if (summary.deliveryFee > 0) lines.push(`Delivery fee: ${money(summary.deliveryFee)}`);
  lines.push(`Total: ${money(summary.total)}`);

  // Order type, pickup time and name, only once they are known.
  const details = [];
  if (summary.orderType) {
    let type = ORDER_TYPE_LABELS[summary.orderType];
    if (summary.pickupTime === "asap") type += " as soon as possible";
    else if (summary.pickupTime) type += ` at ${summary.pickupTime}`;
    details.push(type);
  }
  if (summary.customer.name) details.push(`Name: ${summary.customer.name}`);
  if (details.length > 0) lines.push(details.join(" · "));

  // Delivery details, so the customer can check them. Only the ones given so far are shown.
  if (summary.orderType === "delivery") {
    const d = summary.delivery;
    if (d.address) lines.push(`Deliver to: ${d.address}${d.unit ? `, ${d.unit}` : ""}`);
    if (d.phone) lines.push(`Phone: ${d.phone}`);
    if (d.instructions) lines.push(`Instructions: ${d.instructions}`);
  }

  if (summary.status === STATUS.AWAITING_CONFIRMATION) lines.push("Waiting for you to confirm.");
  if (summary.status === STATUS.CONFIRMED) {
    // The data says nothing about paying for deliveries, so no payment method is promised.
    lines.push(summary.orderType === "delivery" ? "This order is confirmed." : "This order is confirmed. Please pay at the counter.");
  }
  if (summary.status === STATUS.CANCELLED) lines.push("This order was cancelled.");

  return lines.join("\n");
}

// Handles one view_order action. Returns { status: "shown", reply }.
function handleViewOrder(session, menu) {
  return { status: "shown", reply: formatOrderSummary(getOrderSummary(session.order), menu.currency) };
}

module.exports = { validateViewOrderAction, handleViewOrder, formatOrderSummary };
