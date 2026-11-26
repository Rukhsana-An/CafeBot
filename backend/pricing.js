// CafeBot pricing configuration and price list.
//
// data/pricing.json holds the only two charges besides menu prices:
//   { "currency": "PKR", "taxPercent": 16, "deliveryFee": 150 }
// All order totals are worked out by code in orderState.js (recalculate). The AI is only
// ever given amounts that code has already calculated, so it never does price maths.

// Checks data/pricing.json. Throws if it is invalid, so a broken file can't produce wrong totals.
function validatePricingConfig(pricing, menu) {
  if (typeof pricing !== "object" || pricing === null || Array.isArray(pricing)) {
    throw new Error("data/pricing.json must be a JSON object.");
  }
  if (pricing.currency !== menu.currency) {
    throw new Error(`data/pricing.json currency must match the menu (${menu.currency}).`);
  }
  const { taxPercent, deliveryFee } = pricing;
  if (typeof taxPercent !== "number" || !Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100
      || Math.round(taxPercent * 100) !== taxPercent * 100) {
    throw new Error("data/pricing.json taxPercent must be a number from 0 to 100, with at most 2 decimal places.");
  }
  if (!Number.isInteger(deliveryFee) || deliveryFee < 0) {
    throw new Error("data/pricing.json deliveryFee must be a whole number, 0 or more.");
  }
  return { currency: pricing.currency, taxPercent, deliveryFee };
}

// Every item and size with its full price, worked out by code (price + extraCost),
// so the AI can quote a price without adding anything up.
function buildPriceList(menu) {
  const list = [];
  for (const item of menu.items) {
    const sizes = Array.isArray(item.sizes) ? item.sizes : [];
    if (sizes.length === 0) {
      list.push({ itemId: item.id, name: item.name, size: null, price: item.price, available: item.available });
    } else {
      for (const size of sizes) {
        list.push({ itemId: item.id, name: item.name, size: size.name, price: item.price + size.extraCost, available: item.available });
      }
    }
  }
  return list;
}

module.exports = { validatePricingConfig, buildPriceList };
