// CafeBot: collecting the details needed before checkout.
//
// The details are:
//   1. dine-in, pickup or delivery  (stored as orderType "dine-in", "takeaway" or "delivery")
//   2. the customer's name
//   3. for pickup only: an optional pickup time, "asap" or a time later today
//   4. for delivery only: phone number, full delivery address, apartment/unit and
//      delivery instructions. Unit and instructions may be "none", but they are always
//      asked: the code never assumes there isn't one.
//   5. for delivery only, last: the full address (address + unit) is read back to the
//      customer, who must say it is correct ("addressConfirmed": true) or correct it.
//      Changing the address or unit later means it is read back and confirmed again.
//
// The customer can give any of these at any time, in any order. After saving what was
// given, the reply asks for the next detail that is still missing, one question at a time.
// Nothing that is already known is asked again. The pickup time is optional: it is asked
// once, and "as soon as possible" is a fine answer.
// Checkout itself (confirming the order) is NOT handled here.
//
// The action sent to /api/chat looks like:
//   { "type": "set_order_details", "orderType": "pickup", "name": "Sara", "pickupTime": "14:30" }
//   - every field is optional; send { "type": "set_order_details" } to just get the next question
//   - "orderType": "dine-in", "pickup", "takeaway" or "delivery" ("pickup" and "takeaway" mean the same)
//   - delivery orders: "phone", "address", "unit", "instructions" (see setDeliveryDetails in orderState.js).
//     These are refused until the order type is delivery, so an address alone never makes
//     an order a delivery order.
//   - "addressConfirmed": true only after the customer clearly said the address read back to
//     them is correct; false when they say it is wrong (the reply then asks for the correction).
//     It only counts for the exact address this file last read back (session.addressReadBack).
//     It must be a real true/false, so a vague answer can't count as a yes. A confirmation sent
//     together with a new address or unit doesn't count: the new address is read back first.
//   - "pickupTime": "asap" or "HH:MM" (24-hour, café time). Giving a pickup time on an order
//     with no order type yet makes it a pickup order.

const {
  setOrderType, setCustomerName, setPickupTime, setDeliveryDetails, confirmDeliveryAddress, formatDeliveryAddress, STATUS,
} = require("./orderState");

const DELIVERY_FIELDS = ["phone", "address", "unit", "instructions"];
const FIELDS = ["type", "orderType", "name", "pickupTime", ...DELIVERY_FIELDS, "addressConfirmed"];
const MAX_TEXT_LENGTH = 100;
const MAX_LONG_TEXT_LENGTH = 200; // addresses and delivery instructions can be longer
const LONG_FIELDS = ["address", "instructions"];
const ORDER_TYPE_WORDS = { "dine-in": "dine-in", pickup: "takeaway", takeaway: "takeaway", delivery: "delivery" };

function validateOrderDetailsAction(action) {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return "\"action\" must be an object.";
  }
  if (action.type !== "set_order_details") {
    return "\"action.type\" must be \"set_order_details\".";
  }
  if (Object.keys(action).some((key) => !FIELDS.includes(key))) {
    return `"action" for set_order_details can only have: ${FIELDS.join(", ")}.`;
  }
  for (const field of ["orderType", "name", "pickupTime", ...DELIVERY_FIELDS]) {
    const value = action[field];
    const max = LONG_FIELDS.includes(field) ? MAX_LONG_TEXT_LENGTH : MAX_TEXT_LENGTH;
    if (value !== undefined && (typeof value !== "string" || value.length > max)) {
      return `"action.${field}" must be a string of ${max} characters or fewer.`;
    }
  }
  if (action.addressConfirmed !== undefined && typeof action.addressConfirmed !== "boolean") {
    return "\"action.addressConfirmed\" must be true or false.";
  }
  return null;
}

// The next detail still missing, or null when everything needed is known.
function nextMissing(order) {
  if (!order.orderType) {
    return {
      field: "orderType",
      optional: false,
      choices: ["dine-in", "pickup", "delivery"],
      question: "Will you be eating here, picking your order up, or would you like it delivered?",
    };
  }
  if (!order.customer.name) {
    return { field: "name", optional: false, question: "What name should I put the order under?" };
  }
  if (order.orderType === "delivery") {
    const d = order.delivery;
    if (d.phone === null) {
      return { field: "phone", optional: false, question: "What phone number can we reach you on about the delivery?" };
    }
    if (d.address === null) {
      return {
        field: "address",
        optional: false,
        question: "What's the full delivery address? Please include the house or building number, street and area.",
      };
    }
    if (d.unit === null) {
      return { field: "unit", optional: true, question: "Is there an apartment, flat or unit number? If not, just say none." };
    }
    if (d.instructions === null) {
      return {
        field: "instructions",
        optional: true,
        question: "Any delivery instructions, such as a landmark or which gate to use? If not, just say none.",
      };
    }
    if (!d.addressConfirmed) {
      const address = formatDeliveryAddress(d);
      return {
        field: "addressConfirmation",
        optional: false,
        address,
        question: `Please check your delivery address: ${address}. Is that correct? Reply yes, or tell me what needs changing.`,
      };
    }
  }
  if (order.orderType === "takeaway" && order.pickupTime === null) {
    return {
      field: "pickupTime",
      optional: true,
      choices: ["asap"],
      question: "When would you like to pick it up? As soon as possible is fine, or give a time today, like 14:30.",
    };
  }
  return null;
}

function savedText(order, action) {
  const saved = [];
  if (action.pickupTime !== undefined) {
    // "pickup at 14:30" already says it is a pickup order.
    saved.push(order.pickupTime === "asap" ? "pickup as soon as possible" : `pickup at ${order.pickupTime}`);
  } else if (action.orderType !== undefined) {
    saved.push({ takeaway: "pickup", "dine-in": "dine-in", delivery: "delivery" }[order.orderType]);
  }
  if (action.name !== undefined) saved.push(`the name ${order.customer.name}`);
  // Delivery details are listed by what they are, not repeated in full: "view_order" shows them.
  if (action.phone !== undefined) saved.push("your phone number");
  if (action.address !== undefined) saved.push("the delivery address");
  if (action.unit !== undefined) saved.push(order.delivery.unit === "" ? "no unit number" : "the unit number");
  if (action.instructions !== undefined) {
    saved.push(order.delivery.instructions === "" ? "no delivery instructions" : "the delivery instructions");
  }
  if (action.addressConfirmed === true && order.delivery.addressConfirmed) saved.push("the delivery address is confirmed");
  return saved.length > 0 ? `Got it: ${saved.join(", ")}. ` : "";
}

// Handles one set_order_details action.
// Returns { status: "needs_info" | "complete" | "rejected", reply, needsInfo? }.
function handleOrderDetails(session, menu, action) {
  // Work on a copy, so the order only changes if every detail given is valid.
  const draft = structuredClone(session.order);

  if (action.orderType !== undefined) {
    const orderType = ORDER_TYPE_WORDS[action.orderType.trim().toLowerCase()];
    if (!orderType) return { status: "rejected", reply: "Please choose dine-in, pickup or delivery." };
    const result = setOrderType(draft, orderType);
    if (!result.ok) return { status: "rejected", reply: result.error };
  }

  if (action.name !== undefined) {
    const result = setCustomerName(draft, action.name);
    if (!result.ok) return { status: "rejected", reply: result.error };
  }

  if (action.pickupTime !== undefined) {
    // A pickup time on an order with no type yet means the customer is picking it up.
    if (draft.orderType === null) {
      const result = setOrderType(draft, "takeaway");
      if (!result.ok) return { status: "rejected", reply: result.error };
    }
    const value = action.pickupTime.trim().toLowerCase().replace(/[\s_-]+/g, " ") === "as soon as possible"
      ? "asap"
      : action.pickupTime;
    const result = setPickupTime(draft, value);
    if (!result.ok) return { status: "rejected", reply: result.error };
  }

  const deliveryGiven = DELIVERY_FIELDS.filter((field) => action[field] !== undefined);
  if (deliveryGiven.length > 0) {
    if (draft.orderType === null) {
      // Never guess: an address on its own doesn't decide that the order is for delivery.
      return { status: "rejected", reply: "Is this order for delivery? Please choose dine-in, pickup or delivery first." };
    }
    const details = {};
    for (const field of deliveryGiven) details[field] = action[field];
    const result = setDeliveryDetails(draft, details);
    if (!result.ok) return { status: "rejected", reply: result.error };
  }

  let correctionRequested = false;
  if (action.addressConfirmed !== undefined) {
    if (draft.orderType !== "delivery") {
      return { status: "rejected", reply: "Only delivery orders have an address to confirm." };
    }
    const addressChanged = action.address !== undefined || action.unit !== undefined;
    // A yes only counts for the exact address that was read back to the customer.
    const readBack = session.addressReadBack !== undefined && session.addressReadBack === formatDeliveryAddress(draft.delivery);
    if (action.addressConfirmed === true && !addressChanged) {
      const result = confirmDeliveryAddress(draft);
      if (!result.ok) return { status: "rejected", reply: result.error };
      if (!readBack) draft.delivery.addressConfirmed = false; // not read back yet: asked later instead
    } else if (action.addressConfirmed === false && !addressChanged) {
      correctionRequested = true; // the customer says it's wrong: ask what the right address is
    }
    // A confirmation sent with a new address or unit, or before the address was read back,
    // is not counted: the address is read back (once the other details are in) and asked again.
  }

  // Confirmed or cancelled orders can't change. The setters refuse that, but a request
  // with no fields should also not ask questions about a finished order.
  if (draft.status === STATUS.CONFIRMED || draft.status === STATUS.CANCELLED) {
    return { status: "rejected", reply: "This order can't be changed now. Please speak to café staff." };
  }

  session.order = draft;
  if (correctionRequested) {
    return {
      status: "needs_info",
      reply: "No problem. Please send the correct delivery address, or just the correct apartment or unit number.",
      needsInfo: { field: "address", optional: false, correction: true },
    };
  }
  const prefix = savedText(draft, action);
  const missing = nextMissing(draft);
  if (missing) {
    // Remember exactly which address the customer is being asked to confirm.
    if (missing.field === "addressConfirmation") session.addressReadBack = missing.address;
    const { question, ...needsInfo } = missing;
    return { status: "needs_info", reply: `${prefix}${question}`, needsInfo };
  }

  const ready = draft.items.length > 0
    ? "That's everything I need. When you're ready, I'll go over your order so you can confirm it."
    : "That's everything I need. What would you like to order?";
  return { status: "complete", reply: `${prefix}${ready}` };
}

module.exports = { validateOrderDetailsAction, handleOrderDetails, nextMissing };
