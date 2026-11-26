// CafeBot: removing an item from the current order, or reducing its quantity.
//
// Uses orderState.removeItem() and orderState.updateItemQuantity(), which re-check
// totals and promotions after every change. Checkout is NOT handled here.
//
// The action sent to /api/chat looks like:
//   { "type": "remove_item", "lineId": 2 }                  removes the whole line
//   { "type": "remove_item", "lineId": 2, "quantity": 1 }   removes 1, keeps the rest
//   - "lineId": the line, from order.items[].lineId in the last response.
//   - or "item": an item ID or name, e.g. "Cappuccino", optionally with "size": "Large".
//     If that matches more than one line, the reply asks which one (send it again with "lineId").
//   - "quantity": optional, how many to take off. Leave it out to remove the item completely.
//
// Removing doesn't need the item to still be on the menu or available: a customer can
// always take something out of their order.

const { removeItem, updateItemQuantity } = require("./orderState");
const { normalise, price } = require("./addToOrder");

const MAX_TEXT_LENGTH = 100;
const KNOWN_FIELDS = ["type", "lineId", "item", "size", "quantity"];

// Checks the shape of the action. Returns an error message, or null if it is fine.
function validateRemoveItemAction(action) {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "\"action\" must be an object.";
  }
  if (action.type !== "remove_item") {
    return "\"action.type\" must be \"remove_item\".";
  }
  const unknown = Object.keys(action).find((key) => !KNOWN_FIELDS.includes(key));
  if (unknown !== undefined) {
    return `"action" can only have: ${KNOWN_FIELDS.join(", ")}.`;
  }
  if (action.lineId !== undefined && (!Number.isInteger(action.lineId) || action.lineId < 1)) {
    return "\"action.lineId\" must be a whole number from 1.";
  }
  for (const field of ["item", "size"]) {
    const value = action[field];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_LENGTH)) {
      return `"action.${field}" must be a non-empty string of ${MAX_TEXT_LENGTH} characters or fewer.`;
    }
  }
  if (action.quantity !== undefined && !Number.isInteger(action.quantity)) {
    return "\"action.quantity\" must be a whole number.";
  }
  if (action.lineId === undefined && action.item === undefined) {
    return "\"action\" needs a \"lineId\" or an \"item\" to say which item to remove.";
  }
  if (action.lineId !== undefined && action.size !== undefined) {
    return "\"action.size\" is only used with \"item\", to pick which line.";
  }
  return null;
}

function rejected(reply) {
  return { status: "rejected", reply };
}

function lineLabel(line) {
  return line.options.size ? `${line.options.size} ${line.name}` : line.name;
}

// Handles one remove_item action for a session.
// Returns { status: "removed" | "reduced" | "needs_option" | "rejected", reply, needsOption? }.
function handleRemoveItem(session, menu, action) {
  const order = session.order;

  // 1. Find the line. Lines are matched by what is stored in the order, so an item
  //    that has since left the menu can still be removed.
  let line;
  if (action.lineId !== undefined) {
    line = order.items.find((l) => l.lineId === action.lineId);
    if (!line) return rejected("I couldn't find that item in your order.");
  } else {
    const wanted = normalise(action.item);
    let lines = order.items.filter((l) => normalise(l.itemId) === wanted || normalise(l.name) === wanted);
    if (lines.length === 0) return rejected("That item isn't in your order.");
    if (action.size !== undefined) {
      lines = lines.filter((l) => l.options.size !== null && normalise(l.options.size) === normalise(action.size));
      if (lines.length === 0) return rejected("You don't have that size in your order.");
    }
    if (lines.length > 1) {
      const choices = lines.map((l) => ({ lineId: l.lineId, size: l.options.size, quantity: l.quantity }));
      const listed = choices.map((c) => `${c.size} (${c.quantity})`);
      return {
        status: "needs_option",
        reply: `You have more than one ${lines[0].name} in your order: `
          + `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]}. Which one would you like to remove?`,
        needsOption: { option: "line", itemId: lines[0].itemId, name: lines[0].name, choices },
      };
    }
    line = lines[0];
  }

  // 2. Work out how many to take off. No quantity means the whole line.
  const removeCount = action.quantity === undefined ? line.quantity : action.quantity;
  if (removeCount < 1) {
    return rejected("Please say how many to remove (1 or more).");
  }
  if (removeCount > line.quantity) {
    return rejected(`You only have ${line.quantity} × ${lineLabel(line)} in your order.`);
  }

  // 3. Make the change.
  const label = lineLabel(line);
  const remaining = line.quantity - removeCount;
  const result = remaining === 0
    ? removeItem(order, line.lineId)
    : updateItemQuantity(order, line.lineId, remaining);
  if (!result.ok) return rejected(result.error); // e.g. the order is already confirmed

  let reply;
  if (remaining === 0) {
    reply = `Removed ${label} from your order.`;
    reply += order.items.length === 0
      ? " Your order is now empty. What would you like?"
      : ` Your order total is now ${price(menu, order.total)}.`;
  } else {
    reply = `Removed ${removeCount} × ${label}. You now have ${remaining}. `
      + `Your order total is now ${price(menu, order.total)}.`;
  }
  if (order.lastNote) reply += ` Note: ${order.lastNote}`;

  return { status: remaining === 0 ? "removed" : "reduced", reply };
}

module.exports = { validateRemoveItemAction, handleRemoveItem };
