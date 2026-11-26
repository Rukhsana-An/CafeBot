// CafeBot staff dashboard: the page and its API.
//
//   GET  /staff                                   the dashboard page (frontend/staff.html)
//   GET  /api/staff/orders                        all saved orders, with the statuses each can move to
//   POST /api/staff/orders/<orderId>/status       body { "from": "confirmed", "to": "preparing" }
//
// Orders hold customers' names, phone numbers and addresses, so the API needs the staff
// password: the STAFF_TOKEN environment variable, sent as "Authorization: Bearer <token>".
// If STAFF_TOKEN isn't set, is shorter than 16 characters or is still the .env.example
// placeholder, the staff API is switched off.
// The page itself holds no order data, so it loads without the password and then asks for it.

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { STATUS_TRANSITIONS, StatusChangeError } = require("./orderStore");

const STAFF_PAGE_PATH = path.join(__dirname, "..", "frontend", "staff.html");
const MIN_TOKEN_LENGTH = 16;
const MAX_BODY_BYTES = 1024;
const ORDER_ID_PATTERN = /^CB-\d{8}-[0-9A-F]{6}$/;
const STATUS_URL_PATTERN = /^\/api\/staff\/orders\/([^/]+)\/status$/;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(data));
}

// The placeholder from .env.example (or any "your_..._here") never switches the dashboard on.
function configuredToken() {
  const token = process.env.STAFF_TOKEN;
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) return null;
  if (/^your_.*_here$/i.test(token)) return null;
  return token;
}

// Compares in constant time, so the password can't be guessed from response times.
function tokenMatches(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Returns true if the request may use the staff API; otherwise sends the error and returns false.
function checkAccess(req, res) {
  const expected = configuredToken();
  if (!expected) {
    sendJson(res, 503, { error: `The staff dashboard is switched off. Set STAFF_TOKEN (at least ${MIN_TOKEN_LENGTH} characters) to turn it on.` });
    return false;
  }
  const header = req.headers.authorization || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!given || !tokenMatches(given, expected)) {
    sendJson(res, 401, { error: "Wrong or missing staff password." });
    return false;
  }
  return true;
}

function readSmallJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (tooLarge) return; // keep reading, so the error reply can still be sent
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) tooLarge = true;
    });
    req.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error("Request body is too large."), { code: 413 }));
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { code: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// An order as the dashboard needs it, plus the statuses it can move to next.
function forDashboard(order) {
  return { ...order, nextStatuses: STATUS_TRANSITIONS[order.status] || [] };
}

// Handles a staff request. Returns true if the URL was a staff URL (handled here), false otherwise.
async function handleStaffRequest(req, res, { store }) {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/staff") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { error: "Use GET for /staff." });
      return true;
    }
    try {
      const html = await fs.readFile(STAFF_PAGE_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        ...SECURITY_HEADERS,
        // The page may only talk to this server; no outside scripts, styles or frames.
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(html);
    } catch (err) {
      console.error("Could not load the staff page:", err.message);
      sendJson(res, 500, { error: "The staff page isn't available." });
    }
    return true;
  }

  if (pathname === "/api/staff/orders") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { error: "Use GET for /api/staff/orders." });
      return true;
    }
    if (!checkAccess(req, res)) return true;
    try {
      const orders = await store.list();
      sendJson(res, 200, { orders: orders.map(forDashboard) });
    } catch (err) {
      console.error("Could not read orders:", err.message);
      sendJson(res, 500, { error: "Couldn't read the orders file. Please check data/orders.json." });
    }
    return true;
  }

  const match = STATUS_URL_PATTERN.exec(pathname);
  if (match) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "Use POST to change an order's status." });
      return true;
    }
    if (!checkAccess(req, res)) return true;
    const orderId = decodeURIComponent(match[1]);
    if (!ORDER_ID_PATTERN.test(orderId)) {
      sendJson(res, 404, { error: "Order not found." });
      return true;
    }
    let body;
    try {
      body = await readSmallJsonBody(req);
    } catch (err) {
      sendJson(res, err.code || 400, { error: err.message });
      return true;
    }
    const known = Object.keys(STATUS_TRANSITIONS);
    if (typeof body !== "object" || body === null || !known.includes(body.from) || !known.includes(body.to)) {
      sendJson(res, 400, { error: `"from" and "to" must each be one of: ${known.join(", ")}.` });
      return true;
    }
    try {
      const order = await store.updateStatus(orderId, body.from, body.to);
      sendJson(res, 200, { order: forDashboard(order) });
    } catch (err) {
      if (err instanceof StatusChangeError) {
        sendJson(res, err.code, { error: err.message });
      } else {
        console.error("Could not change order status:", err.message);
        sendJson(res, 500, { error: "Couldn't save the change. Please try again." });
      }
    }
    return true;
  }

  if (pathname.startsWith("/api/staff/")) {
    sendJson(res, 404, { error: "Not found." });
    return true;
  }
  return false;
}

module.exports = { handleStaffRequest, MIN_TOKEN_LENGTH };
