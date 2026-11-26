// Entry point for hosting services that look for a server.js file in the project root,
// such as Vercel. It just starts the CafeBot backend (see backend/server.js).
// Locally you can still use: npm start  (or: node backend/server.js)
const { startServer } = require("./backend/server");

startServer();
