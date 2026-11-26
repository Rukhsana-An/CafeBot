# CafeBot

A beginner-friendly chatbot backend for a café. It takes orders from the menu, collects
dine-in, pickup or delivery details, shows a final summary, and only places an order after
the customer clearly replies yes. Staff see placed orders on a dashboard at `/staff`.

It uses only Node.js built-in modules, so there is nothing to install.

## Current status

- **Working:** the order API (`POST /api/chat`), saving confirmed orders to
  `data/orders.json`, and the staff dashboard (`/staff`).
- **Not connected yet:** the AI model. `callAi()` in `backend/server.js` returns a
  placeholder reply.
- **Preview only:** the customer chat page (`frontend/index.html`). It shows sample
  messages and doesn't talk to the backend, and the server doesn't serve it.

## Requirements

- Node.js 20.6 or newer (check with `node --version`)

## Run it on your computer

1. Copy `.env.example` to a new file called `.env` in the same folder.
2. In `.env`, replace the placeholders you need:
   - `STAFF_TOKEN`: a long, random password (at least 16 characters) for the staff
     dashboard. The dashboard stays switched off until this is set.
   - `PORT`: optional. Delete the line to use port 3000.
   - `AI_API_KEY`, `AI_MODEL`, `AI_MAX_TOKENS`: not used until the AI is connected.
3. Start the server:

   ```
   npm run dev
   ```

   `npm run dev` loads your `.env` file. `npm start` does not: use it where the
   hosting service sets the environment variables for you.
4. Open the staff dashboard at http://localhost:3000/staff and sign in with your
   `STAFF_TOKEN`.

## Settings to check before going live

- `data/pricing.json`: `taxPercent` and `deliveryFee` are set to 0 as placeholders.
  Set the café's real values.
- `data/menu.json` and `data/promotions.json`: the menu, prices and offers the bot uses.

## Deploying

- Set the environment variables (`STAFF_TOKEN`, and `PORT` if your host needs it) in
  your hosting service's settings. Never upload `.env`.
- The start command is `npm start`.
- The server must run as a long-running Node.js process. It keeps chat sessions in
  memory, so they are lost when it restarts.
- **Order storage is for development and demos only.** Orders are saved to
  `data/orders.json`, which needs a disk that keeps its files. Serverless hosts such as
  Vercel don't guarantee that file writes persist, so orders could fail to save or be
  lost. Use a host with a persistent disk for a demo, and a real database before going live.
- Serve the site over HTTPS. The staff password and customers' details travel with
  every request.

## Keeping secrets and customer data out of git

- `.env` is listed in `.gitignore`. Only `.env.example`, with placeholder values, is
  committed.
- `data/orders.json` is committed as an empty list (`[]`) because the server needs the
  file to exist. Once real orders are saved, it holds customers' names, phone numbers
  and addresses, so never commit it with orders in it. Check `git status` before each
  commit.

## Project layout

```
backend/    the server, order logic and staff API (start: backend/server.js)
frontend/   staff dashboard (staff.html) and the customer chat page preview
prompts/    system-prompt.md: how the bot should behave
data/       menu, promotions, pricing settings and saved orders
```

See `CLAUDE.md` for the project's coding rules.
