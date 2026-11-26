// CafeBot chat page.
//
// Talks only to this site's backend:
//   GET  /api/menu  the menu to show (names, sizes, prices worked out by the server)
//   POST /api/chat  every order step, sent as an "action" (see backend/server.js)
//
// The AI isn't connected yet, so ordering is guided with buttons. When CafeBot asks for
// a detail (name, phone, address...), what the customer types is sent as that detail.
// Every price, total and decision comes from the server: this page never works one out,
// and an order is only placed when the server's confirmation gate accepts the customer's
// own "yes" to the summary they were shown.
//
// All text is shown with textContent, never as HTML. No secrets are kept here.

"use strict";

const messagesEl = document.getElementById("messages");
const choicesEl = document.getElementById("quick-replies");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");

let sessionId = sessionStorage.getItem("cafebotSessionId") || null;
let menu = null;
let busy = false;
// What a typed message answers: null (a question for CafeBot), a detail being asked for,
// or the final "Shall I place this order?".
let expecting = null; // { kind: "field", field } | { kind: "confirm", summaryId }

const FIELD_HINTS = {
  orderType: "Type dine-in, pickup or delivery…",
  name: "Type your name…",
  phone: "Type your phone number…",
  address: "Type your full address…",
  unit: "Type your flat or unit number…",
  instructions: "Type delivery instructions…",
  pickupTime: "Type a time like 14:30…",
};

// ---------- Showing messages and buttons ----------

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function addMessage(sender, text) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${sender}`;
  const bubbleEl = document.createElement("div");
  bubbleEl.className = "bubble";
  bubbleEl.textContent = text;
  const timeEl = document.createElement("span");
  timeEl.className = "time";
  timeEl.textContent = formatTime(new Date());
  messageEl.append(bubbleEl, timeEl);
  messagesEl.append(messageEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// The buttons currently shown, so they can be shown again after a refused answer.
let currentChoices = [];

// choices: [{ label, onClick, disabled?, primary? }]
function showChoices(choices) {
  currentChoices = choices;
  choicesEl.replaceChildren();
  for (const choice of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = choice.primary ? "choice primary" : "choice";
    button.textContent = choice.label;
    button.disabled = Boolean(choice.disabled);
    button.addEventListener("click", () => {
      if (!busy) choice.onClick();
    });
    choicesEl.append(button);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setExpecting(value) {
  expecting = value;
  inputEl.placeholder = value && value.kind === "field"
    ? FIELD_HINTS[value.field] || "Type your answer…"
    : value && value.kind === "confirm"
      ? "Reply yes, or say what to change…"
      : "Type your message…";
}

function money(amount) {
  return `${menu ? menu.currency : "PKR"} ${amount}`;
}

// ---------- Talking to the server ----------

async function postChat(body) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionId ? { sessionId, ...body } : body),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // no JSON body
  }
  if (!response.ok) throw new Error(data.error || "Sorry, something went wrong. Please try again.");
  if (data.sessionId && data.sessionId !== sessionId) {
    sessionId = data.sessionId;
    sessionStorage.setItem("cafebotSessionId", sessionId);
  }
  return data;
}

// Shows what the customer chose, sends it, shows CafeBot's reply, then the next buttons.
async function send(body, userText) {
  if (busy) return;
  busy = true;
  sendButton.disabled = true;
  choicesEl.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  if (userText) addMessage("user", userText);
  try {
    const data = await postChat(body);
    if (data.reply) addMessage("bot", data.reply);
    nextStep(data);
  } catch (err) {
    addMessage("bot", err.message);
    showMainChoices();
  } finally {
    busy = false;
    sendButton.disabled = inputEl.value.trim() === "";
  }
}

const act = (action, userText) => send({ action }, userText);

// ---------- What happens after each reply ----------

function nextStep(data) {
  const type = data.action ? data.action.type : null;
  const status = data.action ? data.action.status : null;

  // A detail was refused (for example a phone number that isn't valid): CafeBot's reply
  // says why, and the same question stays open with the same buttons.
  if (type === "set_order_details" && status === "rejected" && expecting && expecting.kind === "field") {
    return showChoices(currentChoices);
  }

  // CafeBot needs a choice, such as a size.
  if (data.needsOption && data.needsOption.option === "size" && type === "add_item") {
    setExpecting(null);
    return showChoices([
      ...data.needsOption.choices.map((c) => ({
        label: `${c.name} · ${money(c.price)}`,
        onClick: () => act({ type: "add_item", size: c.name }, c.name),
      })),
      { label: "Cancel", onClick: () => { addMessage("bot", "No problem."); showMainChoices(); } },
    ]);
  }

  // Suggestions: tap one to add it.
  if (type === "recommend" && Array.isArray(data.recommendations)) {
    setExpecting(null);
    return showChoices([
      ...data.recommendations.map((r) => ({ label: `Add ${r.name}`, onClick: () => addItem(r.itemId, r.name) })),
      ...mainChoices(),
    ]);
  }

  // A detail is still needed for checkout.
  if (data.needsInfo) return askForDetail(data.needsInfo);

  if (type === "set_order_details" && status === "complete") {
    setExpecting(null);
    return showChoices([
      { label: "Review my order", primary: true, onClick: () => act({ type: "review_order" }, "Review my order") },
      ...mainChoices(),
    ]);
  }

  // The final summary: wait for the customer's own yes.
  if (data.checkoutSummary && data.order && data.order.status === "awaiting_confirmation") {
    setExpecting({ kind: "confirm", summaryId: data.checkoutSummary.summaryId });
    return showChoices([
      { label: "Yes, place my order", primary: true, onClick: () => confirmOrder("Yes, place my order") },
      { label: "Change something", onClick: () => { setExpecting(null); showOrder(); } },
    ]);
  }
  if (type === "review_order" && status === "incomplete") {
    setExpecting(null);
    return showChoices([
      { label: "Continue checkout", primary: true, onClick: () => act({ type: "set_order_details" }, "Continue checkout") },
      ...mainChoices(),
    ]);
  }

  if (type === "confirm_order") {
    if (status === "confirmed" || status === "already_confirmed") {
      setExpecting(null);
      return showChoices([{ label: "Start a new order", primary: true, onClick: startNewOrder }]);
    }
    if (status === "unclear" || status === "save_failed") {
      return showChoices([
        { label: "Yes, place my order", primary: true, onClick: () => confirmOrder("Yes, place my order") },
        { label: "Change something", onClick: () => { setExpecting(null); showOrder(); } },
      ]);
    }
  }

  // After seeing or changing the order, keep the buttons for changing it.
  if (type === "view_order" || type === "modify_item" || type === "remove_item") {
    setExpecting(null);
    return showChoices(orderChoices(data.order));
  }

  setExpecting(null);
  showMainChoices();
}

function askForDetail(info) {
  setExpecting({ kind: "field", field: info.field === "addressConfirmation" ? null : info.field });
  const field = info.field;

  if (field === "orderType") {
    return showChoices([
      { label: "Eat here", onClick: () => act({ type: "set_order_details", orderType: "dine-in" }, "Eat here") },
      { label: "Pickup", onClick: () => act({ type: "set_order_details", orderType: "pickup" }, "Pickup") },
      { label: "Delivery", onClick: () => act({ type: "set_order_details", orderType: "delivery" }, "Delivery") },
    ]);
  }
  if (field === "addressConfirmation") {
    setExpecting(null);
    return showChoices([
      { label: "Yes, that's correct", primary: true, onClick: () => act({ type: "set_order_details", addressConfirmed: true }, "Yes, that's correct") },
      { label: "No, change it", onClick: () => act({ type: "set_order_details", addressConfirmed: false }, "No, change it") },
    ]);
  }
  if (field === "address" && info.correction) {
    // The customer said the address was wrong: what they type replaces the address,
    // unless they choose to change only the flat or unit number.
    return showChoices([
      { label: "Change only the flat / unit", onClick: () => { setExpecting({ kind: "field", field: "unit" }); inputEl.focus(); } },
    ]);
  }
  if (field === "pickupTime") {
    return showChoices([
      { label: "As soon as possible", primary: true, onClick: () => act({ type: "set_order_details", pickupTime: "asap" }, "As soon as possible") },
    ]);
  }
  if (field === "unit" || field === "instructions") {
    const label = field === "unit" ? "No flat / unit" : "No instructions";
    showChoices([{ label, onClick: () => act({ type: "set_order_details", [field]: "none" }, label) }]);
  } else {
    showChoices([]);
  }
  inputEl.focus();
}

function confirmOrder(replyText) {
  if (!expecting || expecting.kind !== "confirm") return;
  // The customer's own words go to the server, which decides if they are a clear yes.
  send({ action: { type: "confirm_order", summaryId: expecting.summaryId, reply: replyText } }, replyText);
}

// ---------- Main choices, menu and order ----------

function mainChoices() {
  return [
    { label: "Menu", onClick: showCategories },
    { label: "Recommend something", onClick: () => act({ type: "recommend" }, "Recommend something") },
    { label: "My order", onClick: showOrder },
    { label: "Checkout", onClick: () => act({ type: "set_order_details" }, "Checkout") },
  ];
}

function showMainChoices() {
  showChoices(mainChoices());
}

function showOrder() {
  act({ type: "view_order" }, "My order");
}

async function loadMenu() {
  const response = await fetch("/api/menu");
  if (!response.ok) throw new Error("menu not available");
  menu = await response.json();
}

async function showCategories() {
  if (!menu) {
    try {
      await loadMenu();
    } catch {
      addMessage("bot", "Sorry, I can't load the menu right now. Please ask café staff.");
      return showMainChoices();
    }
  }
  const categories = [...new Set(menu.items.map((item) => item.category))];
  addMessage("bot", "Which part of the menu would you like to see?");
  showChoices([
    ...categories.map((category) => ({ label: category, onClick: () => showCategory(category) })),
    { label: "Back", onClick: showMainChoices },
  ]);
}

function showCategory(category) {
  const items = menu.items.filter((item) => item.category === category);
  const lines = items.map((item) => {
    const price = item.sizes.length > 1 ? `from ${money(item.price)}` : money(item.price);
    const notes = [];
    if (!item.available) notes.push("not available right now");
    if (item.allergens.length) notes.push(`contains ${item.allergens.join(", ")}`);
    return `• ${item.name}: ${price}${notes.length ? ` (${notes.join("; ")})` : ""}\n  ${item.description}`;
  });
  addMessage("bot", `${category}\n\n${lines.join("\n")}\n\nAllergy? Please check with café staff before ordering. Tap an item to add it.`);
  showChoices([
    ...items.map((item) => ({
      label: item.available ? `Add ${item.name}` : `${item.name} (not available)`,
      disabled: !item.available,
      onClick: () => addItem(item.id, item.name),
    })),
    { label: "Other categories", onClick: showCategories },
    { label: "My order", onClick: showOrder },
  ]);
}

function addItem(itemId, name) {
  act({ type: "add_item", item: itemId, quantity: 1 }, `Add ${name}`);
}

// Buttons to change each line of the order, plus the main choices.
function orderChoices(order) {
  if (!order || order.status === "confirmed") return [{ label: "Start a new order", onClick: startNewOrder }];
  const choices = [];
  for (const line of order.items) {
    const label = line.options && line.options.size ? `${line.options.size} ${line.name}` : line.name;
    choices.push({ label: `＋ ${label}`, onClick: () => act({ type: "modify_item", lineId: line.lineId, quantity: line.quantity + 1 }, `One more ${label}`) });
    choices.push({ label: `－ ${label}`, onClick: () => act({ type: "remove_item", lineId: line.lineId, quantity: 1 }, `One less ${label}`) });
    const menuItem = menu && menu.items.find((item) => item.id === line.itemId);
    if (menuItem && menuItem.sizes.length > 1) {
      choices.push({ label: `Change size: ${line.name}`, onClick: () => chooseNewSize(line, menuItem) });
    }
  }
  return [...choices, ...mainChoices().filter((c) => c.label !== "My order")];
}

function chooseNewSize(line, menuItem) {
  addMessage("bot", `Which size would you like for your ${line.name}?`);
  showChoices([
    ...menuItem.sizes.filter((s) => s.name !== line.options.size).map((s) => ({
      label: `${s.name} · ${money(s.price)}`,
      onClick: () => act({ type: "modify_item", lineId: line.lineId, size: s.name }, `Make it ${s.name}`),
    })),
    { label: "Back", onClick: showOrder },
  ]);
}

function startNewOrder() {
  sessionId = null;
  sessionStorage.removeItem("cafebotSessionId");
  setExpecting(null);
  addMessage("bot", "Your new order is ready to start. What would you like?");
  showMainChoices();
}

// ---------- Typing ----------

inputEl.addEventListener("input", () => {
  sendButton.disabled = busy || inputEl.value.trim() === "";
});

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = "";
  sendButton.disabled = true;

  if (expecting && expecting.kind === "confirm") {
    confirmOrder(text); // the server decides whether this is a clear yes
  } else if (expecting && expecting.kind === "field" && expecting.field) {
    act({ type: "set_order_details", [expecting.field]: text }, text);
  } else {
    send({ message: text }, text);
  }
  inputEl.focus();
});

// ---------- Start ----------

addMessage("bot", "Hi there! 👋 I'm CafeBot. I can show you the menu, suggest something, and take your order for dine-in, pickup or delivery.");
showMainChoices();
loadMenu().catch(() => {
  // Shown again when the customer opens the menu.
});
