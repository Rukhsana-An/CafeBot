// CafeBot: serves the customer chat page.
//
//   GET /            the chat page (frontend/index.html)
//   GET /styles.css  its styles
//   GET /app.js      its script, which talks to POST /api/chat and GET /api/menu
//
// Only these three files can be served: each path is fixed here, never built from the
// request, so a request can't read any other file. (Fixed paths also let Vercel see
// which files to include when it deploys the server.)

const fs = require("node:fs/promises");
const path = require("node:path");

const PAGES = {
  "/": { file: path.join(__dirname, "..", "frontend", "index.html"), type: "text/html; charset=utf-8" },
  "/index.html": { file: path.join(__dirname, "..", "frontend", "index.html"), type: "text/html; charset=utf-8" },
  "/styles.css": { file: path.join(__dirname, "..", "frontend", "styles.css"), type: "text/css; charset=utf-8" },
  "/app.js": { file: path.join(__dirname, "..", "frontend", "app.js"), type: "text/javascript; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  // The page may only load its own script and styles and only talk to this server.
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

// Serves the page if the request is for one of the files above.
// Returns true if it handled the request, false if it isn't a customer page.
async function handleCustomerPage(req, res) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const page = PAGES[pathname];
  if (!page) return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: `Use GET for ${pathname}.` }));
    return true;
  }
  try {
    const body = await fs.readFile(page.file);
    res.writeHead(200, { "Content-Type": page.type, ...SECURITY_HEADERS });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (err) {
    console.error("Could not load a customer page:", err.message);
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "CafeBot isn't available right now. Please ask café staff." }));
  }
  return true;
}

module.exports = { handleCustomerPage };
