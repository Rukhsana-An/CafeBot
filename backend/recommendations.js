// CafeBot: gentle recommendations, taken only from data/menu.json.
//
// Rules:
// - Only items that are on the menu, marked "available", and not already in the order.
// - At most 2 items, never more.
// - Only when asked (the "recommend" action). Nothing is added to the order.
// - The wording is easy to decline, with no pressure.
// - Choices use only what the menu records: category and dietary tags. The menu has no
//   data on taste, caffeine, popularity or allergens, so the code never guesses those.
//   Allergy questions are always sent to café staff.
//
// What is recommended:
// - With "category" and/or "dietary": matching items.
// - Otherwise, based on the order:
//     empty order           -> one drink and one bakery item
//     drinks but no food    -> something to eat
//     food but no drink     -> something to drink
//     drinks and food       -> nothing (the order already looks complete)
// Items are picked from different categories where possible, in the menu's own order.
//
// The action sent to /api/chat looks like:
//   { "type": "recommend" }
//   { "type": "recommend", "category": "Bakery" }
//   { "type": "recommend", "dietary": "vegan" }

const { normalise, price } = require("./addToOrder");

const MAX_RECOMMENDATIONS = 2;
const MAX_TEXT_LENGTH = 50;
const DRINK_CATEGORIES = ["Hot Coffee", "Tea", "Cold Drinks"];
const FOOD_CATEGORIES = ["Bakery", "Food"];

function validateRecommendAction(action) {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "\"action\" must be an object.";
  }
  if (action.type !== "recommend") {
    return "\"action.type\" must be \"recommend\".";
  }
  if (Object.keys(action).some((key) => !["type", "category", "dietary"].includes(key))) {
    return "\"action\" for recommend can only have: type, category, dietary.";
  }
  for (const field of ["category", "dietary"]) {
    const value = action[field];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_LENGTH)) {
      return `"action.${field}" must be a non-empty string of ${MAX_TEXT_LENGTH} characters or fewer.`;
    }
  }
  return null;
}

// Does the item carry this dietary tag? A vegan item also counts as vegetarian,
// because every vegan item is vegetarian by definition.
function hasDietaryTag(item, tag) {
  const tags = item.dietary.map(normalise);
  return tags.includes(tag) || (tag === "vegetarian" && tags.includes("vegan"));
}

// Picks up to MAX_RECOMMENDATIONS items, one per category first, then any others, in menu order.
function pickVaried(items) {
  const picked = [];
  const usedCategories = new Set();
  for (const item of items) {
    if (picked.length < MAX_RECOMMENDATIONS && !usedCategories.has(item.category)) {
      picked.push(item);
      usedCategories.add(item.category);
    }
  }
  for (const item of items) {
    if (picked.length < MAX_RECOMMENDATIONS && !picked.includes(item)) picked.push(item);
  }
  return picked;
}

// "Butter Croissant (PKR 450)", or "Cappuccino (from PKR 650)" when sizes cost different amounts.
function describe(menu, item) {
  const varies = item.sizes.some((s) => s.extraCost > 0);
  return `${item.name} (${varies ? "from " : ""}${price(menu, item.price)})`;
}

function joinNames(parts) {
  return parts.length === 2 ? `${parts[0]} or the ${parts[1]}` : parts[0];
}

// Handles one recommend action. Returns
// { status: "recommended" | "none" | "rejected", reply, recommendations? }.
function handleRecommend(session, menu, action) {
  const inOrder = new Set(session.order.items.map((line) => line.itemId));
  const candidates = menu.items.filter((item) => item.available && !inOrder.has(item.id));

  let chosen;
  let intro;
  const hasPreference = action.category !== undefined || action.dietary !== undefined;

  if (hasPreference) {
    let matches = candidates;
    if (action.category !== undefined) {
      const wanted = normalise(action.category);
      const categories = [...new Set(menu.items.map((item) => item.category))];
      if (!categories.some((c) => normalise(c) === wanted)) {
        return { status: "rejected", reply: `We don't have that section on our menu. We have ${categories.join(", ")}.` };
      }
      matches = matches.filter((item) => normalise(item.category) === wanted);
    }
    if (action.dietary !== undefined) {
      const tag = normalise(action.dietary);
      matches = matches.filter((item) => hasDietaryTag(item, tag));
    }
    chosen = pickVaried(matches);
    intro = "You might like";
  } else {
    const lines = session.order.items;
    const hasDrink = lines.some((line) => DRINK_CATEGORIES.includes(line.category));
    const hasFood = lines.some((line) => FOOD_CATEGORIES.includes(line.category));

    if (hasDrink && hasFood) {
      return { status: "none", reply: "Your order already has something to drink and something to eat, so I don't have anything to add. Just ask if you'd like ideas." };
    }
    if (lines.length === 0) {
      const drink = candidates.find((item) => DRINK_CATEGORIES.includes(item.category));
      const bake = candidates.find((item) => item.category === "Bakery");
      chosen = [drink, bake].filter(Boolean);
      intro = "If you're not sure where to start, you might like";
    } else if (hasDrink) {
      chosen = pickVaried(candidates.filter((item) => FOOD_CATEGORIES.includes(item.category)));
      intro = "If you'd like something to eat with that, you might like";
    } else {
      chosen = pickVaried(candidates.filter((item) => DRINK_CATEGORIES.includes(item.category)));
      intro = "If you'd like a drink with that, you might like";
    }
  }

  if (chosen.length === 0) {
    return { status: "none", reply: "Sorry, I don't have anything available to suggest for that right now. Café staff may be able to help." };
  }

  let reply = `${intro} the ${joinNames(chosen.map((item) => describe(menu, item)))}. `
    + `No pressure. Just let me know if you'd like ${chosen.length === 2 ? "either" : "it"}.`;
  if (action.dietary !== undefined) {
    reply += " This is based on our menu's dietary labels. If you have an allergy, please check with café staff.";
  }

  return {
    status: "recommended",
    reply,
    recommendations: chosen.map((item) => ({ itemId: item.id, name: item.name, category: item.category, price: item.price })),
  };
}

module.exports = { validateRecommendAction, handleRecommend, MAX_RECOMMENDATIONS };
