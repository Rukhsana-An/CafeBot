// CafeBot: adding menu items to the current order.
//
// This is the only way items get into an order from /api/chat. It:
//   1. finds the item in data/menu.json by its ID or its exact name
//   2. refuses items that aren't on the menu or aren't available, and suggests up to 2
//      similar available menu items instead (a shared name word, or the same category)
//   3. asks for a size when the item has sizes and none (or an unknown one) was given,
//      and remembers the item so the next request only needs to send the size
//   4. adds the item with orderState.addItem(), which takes the price from the menu
//
// Removing items and checkout are NOT handled here yet.
//
// The action sent to /api/chat looks like:
//   { "type": "add_item", "item": "Cappuccino", "size": "Large", "quantity": 2 }
//   - "item": a menu item ID ("HOT-002") or its exact name ("Cappuccino"). Case and accents
//     don't matter, so "cafe latte" finds "Café Latte".
//   - "size": needed only for items with sizes.
//   - "quantity": optional, 1 by default.
// To answer a size question, send only the size: { "type": "add_item", "size": "Large" }

const { addItem } = require("./orderState");

const MAX_TEXT_LENGTH = 100;
const MAX_QUANTITY = 20; // the same limit as orderState.js

// "Café  Latte" -> "cafe latte", so small differences in typing still match.
function normalise(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function findMenuItem(menu, itemText) {
  const wanted = normalise(itemText);
  return menu.items.find((item) => normalise(item.id) === wanted || normalise(item.name) === wanted) || null;
}

// Up to 2 available menu items similar to what was asked for (system prompt, ordering step 3).
// Only menu names are used in the reply: the customer's own text is never repeated.
const MAX_SUGGESTIONS = 2;
const IGNORED_WORDS = new Set(["a", "an", "the", "and", "with", "of", "one", "some", "please"]);

function words(text) {
  // "Lattes" and "latte" count as the same word.
  return normalise(text).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !IGNORED_WORDS.has(w)).map((w) => w.replace(/s$/, ""));
}

// For an item that isn't on the menu: available items sharing a word with the request,
// those sharing the most words first, then in menu order.
function similarByName(menu, itemText) {
  const wanted = new Set(words(itemText));
  return menu.items
    .filter((item) => item.available)
    .map((item) => ({ item, score: words(item.name).filter((w) => wanted.has(w)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score) // stable: ties keep menu order
    .slice(0, MAX_SUGGESTIONS)
    .map(({ item }) => item.name);
}

// For an unavailable item: other available items in the same menu category, in menu order.
function similarByCategory(menu, menuItem) {
  return menu.items
    .filter((item) => item.available && item.id !== menuItem.id && item.category === menuItem.category)
    .slice(0, MAX_SUGGESTIONS)
    .map((item) => item.name);
}

// "Café Latte" or "Café Latte or Iced Latte"
function orList(names) {
  return names.join(" or ");
}

function price(menu, amount) {
  return `${menu.currency} ${amount}`;
}

// The sizes a customer can choose from, with each size's full price from the menu.
function sizeChoices(menuItem) {
  return menuItem.sizes.map((s) => ({ name: s.name, price: menuItem.price + s.extraCost }));
}

// "Small (PKR 650), Medium (PKR 750) or Large (PKR 850)"
function listChoices(menu, choices) {
  const parts = choices.map((c) => `${c.name} (${price(menu, c.price)})`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}` : parts[0];
}

// Checks the shape of the action. Returns an error message, or null if it is fine.
// Whether the item exists, is available, etc. is checked later against the menu.
function validateAddItemAction(action) {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "\"action\" must be an object.";
  }
  if (action.type !== "add_item") {
    return "\"action.type\" must be \"add_item\".";
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
  if (action.item === undefined && action.size === undefined) {
    return "\"action\" needs an \"item\", or a \"size\" to answer a size question.";
  }
  return null;
}

function rejected(reply) {
  return { status: "rejected", reply };
}

// Handles one add_item action for a session.
// The session holds { order, pendingItem }. pendingItem is the item waiting for a size answer.
// Returns { status: "added" | "needs_option" | "rejected", reply, needsOption? }.
function handleAddItem(session, menu, action) {
  let menuItem;
  let quantity;

  if (action.item !== undefined) {
    menuItem = findMenuItem(menu, action.item);
    if (!menuItem) {
      // The customer's text is not repeated back, so nothing they type ends up in the reply.
      const similar = similarByName(menu, action.item);
      return rejected(similar.length > 0
        ? `Sorry, I couldn't find that on our menu. Would you like ${orList(similar)} instead?`
        : "Sorry, I couldn't find that on our menu. Would you like to hear what we have?");
    }
    quantity = action.quantity === undefined ? 1 : action.quantity;
  } else {
    // Only a size was sent: it answers the last size question.
    if (!session.pendingItem) {
      return rejected("Which item would you like to add?");
    }
    // Looked up again, in case the menu changed since the question was asked.
    menuItem = menu.items.find((item) => item.id === session.pendingItem.itemId) || null;
    if (!menuItem) {
      session.pendingItem = null;
      return rejected("Sorry, that item is no longer on our menu.");
    }
    quantity = action.quantity === undefined ? session.pendingItem.quantity : action.quantity;
  }

  if (!menuItem.available) {
    session.pendingItem = null;
    const similar = similarByCategory(menu, menuItem);
    return rejected(similar.length > 0
      ? `Sorry, ${menuItem.name} isn't available right now. Would you like ${orList(similar)} instead?`
      : `Sorry, ${menuItem.name} isn't available right now. Can I get you something else?`);
  }
  if (quantity < 1 || quantity > MAX_QUANTITY) {
    return rejected(`Please choose a quantity from 1 to ${MAX_QUANTITY}.`);
  }

  // Work out the size. Items with sizes must have one chosen from the menu.
  let size = null;
  if (menuItem.sizes.length > 0) {
    const menuSize = action.size === undefined
      ? null
      : menuItem.sizes.find((s) => normalise(s.name) === normalise(action.size));

    if (!menuSize) {
      const choices = sizeChoices(menuItem);
      session.pendingItem = { itemId: menuItem.id, quantity };
      const question = action.size === undefined
        ? `What size would you like for your ${menuItem.name}?`
        : `Sorry, ${menuItem.name} doesn't come in that size.`;
      return {
        status: "needs_option",
        reply: `${question} We have ${listChoices(menu, choices)}.`,
        needsOption: { option: "size", itemId: menuItem.id, name: menuItem.name, quantity, choices },
      };
    }
    size = menuSize.name;
  } else if (action.size !== undefined) {
    return rejected(`${menuItem.name} doesn't come in different sizes. Would you like it as it is?`);
  }

  const result = addItem(session.order, menu, { itemId: menuItem.id, size, quantity });
  if (!result.ok) {
    return rejected(result.error); // e.g. the order is confirmed, or a limit was reached
  }
  session.pendingItem = null;

  const label = size ? `${size} ${menuItem.name}` : menuItem.name;
  const unitPrice = session.order.items.find((l) => l.itemId === menuItem.id && l.options.size === size).unitPrice;
  let reply = `Added ${quantity} × ${label} (${price(menu, unitPrice)} each). `
    + `Your order total is now ${price(menu, session.order.total)}. Anything else?`;
  if (session.order.lastNote) reply += ` Note: ${session.order.lastNote}`;

  return { status: "added", reply };
}

module.exports = { validateAddItemAction, handleAddItem, findMenuItem, normalise, price, sizeChoices, listChoices };
