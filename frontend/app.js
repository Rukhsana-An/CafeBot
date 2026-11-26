// CafeBot chat interface: MOCK ONLY.
// This file does not call the backend or any AI API yet.
// Replies come from the MOCK_REPLY text below.

const MOCK_MESSAGES = [
  { sender: "bot", text: "Hi there! 👋 I'm CafeBot. I can tell you about our menu, share today's offers, or help you place an order." },
  { sender: "user", text: "How much is a café latte?" },
  { sender: "bot", text: "Our Café Latte is PKR 650 for a Small, PKR 750 for a Medium and PKR 850 for a Large. Would you like to order one?" }
];

const MOCK_REPLY =
  "Thanks for your message! This is a preview, so I'm not connected yet. Soon I'll be able to answer for real.";

const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Adds one message bubble to the chat.
// textContent is used (not innerHTML) so typed text is never treated as HTML.
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

// Enable the send button only when there is text to send.
inputEl.addEventListener("input", () => {
  sendButton.disabled = inputEl.value.trim() === "";
});

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  addMessage("user", text);
  inputEl.value = "";
  sendButton.disabled = true;
  inputEl.focus();

  // Mock bot reply after a short pause.
  setTimeout(() => addMessage("bot", MOCK_REPLY), 600);
});

MOCK_MESSAGES.forEach((message) => addMessage(message.sender, message.text));
