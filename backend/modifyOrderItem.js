// CafeBot: changing items that are already in the current order.
//
// A customer can change an item's quantity and its customizations. The only
// customization data/menu.json defines is "sizes", so size is the only option that
// can be changed. Any other option (e.g. "milk") is refused, because it isn't on the menu.
//
// Every change is checked by orderState.modifyItem() against the menu, and the price
// is looked up again there. Removing items and checkout are NOT handled here.
//
// The action sent to /api/chat looks like:
//   { "type": "modify_item", "lineId": 2, "quantity": 3, "size": "Large" }
//   - "lineId": the line to change, from order.items[].lineId in the last response.
//   - or "item": a menu item ID or name, e.g. "Cappuccino". If the order has that item
//     in more than one size, the reply asks which one (send it again with "lineId").
//   - "quantity" and/or "size": what to change. At least one is needed.

const { modifyItem } = require("./orderState");
const { findMenuItem, normalise, price, sizeChoices, listChoices } = require("./addToOrder");

const MAX_TEXT_LENGTH = 100;
const KNOWN_FIELDS = ["type", "lineId", "item", "quantity", "size"];

// Checks the shape of the action. Returns an error message, or null if it is fine.
// Whether the line exists and the change is allowed is checked later against the order and menu.
function validateModifyItemAction(action) {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "\"action\" must be an object.";
  }
  if (action.type !== "modify_item") {
    return "\"action.type\" must be \"modify_item\".";
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
    return "\"action\" needs a \"lineId\" or an \"item\" to say which item to change.";
  }
  if (Object.keys(action).every((key) => key === "type" || key === "lineId" || key === "item")) {
    return "\"action\" needs a change, such as \"quantity\" or \"size\".";
  }
  return null;
}

function rejected(reply) {
  return { status: "rejected", reply };
}

function lineLabel(line) {
  return line.options.size ? `${line.options.size} ${line.name}` : line.name;
}

// Handles one modify_item action for a session.
// Returns { status: "updated" | "needs_option" | "rejected", reply, needsOption?, lineId? }.
function handleModifyItem(session, menu, action) {
  const order = session.order;

  // 1. Find the line to change.
  let line;
  if (action.lineId !== undefined) {
    line = order.items.find((l) => l.lineId === action.lineId);
    if (!line) return rejected("I couldn't find that item in your order.");
  } else {
    const menuItem = findMenuItem(menu, action.item);
    const lines = menuItem ? order.items.filter((l) => l.itemId === menuItem.id) : [];
    if (lines.length === 0) {
      return rejected("That item isn't in your order yet. Would you like to add it?");
    }
    if (lines.length > 1) {
      const choices = lines.map((l) => ({ lineId: l.lineId, size: l.options.size, quantity: l.quantity }));
      const listed = choices.map((c) => `${c.size} (${c.quantity})`);
      return {
        status: "needs_option",
        reply: `You have more than one ${menuItem.name} in your order: `
          + `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]}. Which one would you like to change?`,
        needsOption: { option: "line", itemId: menuItem.id, name: menuItem.name, choices },
      };
    }
    line = lines[0];
  }

  const menuItem = menu.items.find((item) => item.id === line.itemId);

  // 2. Only customizations the menu defines can be changed. Right now that is size only.
  if (Object.keys(action).some((key) => !KNOWN_FIELDS.includes(key))) {
    const canChange = menuItem && menuItem.sizes.length > 0 ? "the quantity or size" : "the quantity";
    return rejected(`Sorry, for ${line.name} I can only change ${canChange}. Our menu doesn't list any other options for it.`);
  }

  // 3. A size the item doesn't come in: list the sizes it does come in.
  if (action.size !== undefined && menuItem && menuItem.available && menuItem.sizes.length > 0
      && !menuItem.sizes.some((s) => normalise(s.name) === normalise(action.size))) {
    const choices = sizeChoices(menuItem);
    return {
      status: "needs_option",
      reply: `Sorry, ${menuItem.name} doesn't come in that size. We have ${listChoices(menu, choices)}.`,
      needsOption: { option: "size", lineId: line.lineId, itemId: menuItem.id, name: menuItem.name, choices },
    };
  }

  // 4. Make the change. modifyItem() checks everything against the menu first.
  const result = modifyItem(order, menu, line.lineId, { quantity: action.quantity, size: action.size });
  if (!result.ok) return rejected(result.error);

  const updated = order.items.find((l) => l.lineId === result.lineId);
  const summary = `${updated.quantity} × ${lineLabel(updated)} (${price(menu, updated.unitPrice)} each)`;
  let reply = result.merged
    ? `Done. I've combined it with the ${lineLabel(updated)} already in your order: ${summary}.`
    : `Updated: ${summary}.`;
  reply += ` Your order total is now ${price(menu, order.total)}.`;
  if (order.lastNote) reply += ` Note: ${order.lastNote}`;

  return { status: "updated", reply, lineId: result.lineId };
}

module.exports = { validateModifyItemAction, handleModifyItem };
