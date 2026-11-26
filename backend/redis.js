// CafeBot: a tiny client for Upstash Redis, using its REST API and Node's built-in fetch.
// No library is needed: each command is one HTTPS request.
//
// Used only when these environment variables are set (Vercel adds them when an Upstash
// Redis database is connected to the project):
//   KV_REST_API_URL and KV_REST_API_TOKEN
//   (or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)
// When they aren't set, CafeBot keeps using data/orders.json and in-memory sessions,
// so running it on your own computer needs no database.

const REQUEST_TIMEOUT_MS = 5000;

// A value copied unchanged from .env.example, such as "your_upstash_redis_rest_url_here".
const isPlaceholder = (value) => /^your_.*_here$/.test(value);

// Returns { url, token } from the environment, or null if Redis isn't configured.
// Placeholder values from .env.example count as not configured.
function redisSettingsFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || isPlaceholder(url) || isPlaceholder(token)) return null;
  return { url, token };
}

// Returns command(...args), which runs one Redis command and resolves to its result.
// Example: await command("SET", "greeting", "hello")  ->  "OK"
// Throws if Redis can't be reached or answers with an error. The token is never logged.
function createRedisClient({ url, token }) {
  return async function command(...args) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args.map(String)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Redis request failed: ${err.message}`);
    }
    let data = {};
    try {
      data = await response.json();
    } catch {
      // no JSON body
    }
    if (!response.ok || data.error) {
      throw new Error(`Redis error (${response.status}): ${data.error || "no details"}`);
    }
    return data.result;
  };
}

module.exports = { redisSettingsFromEnv, createRedisClient };
