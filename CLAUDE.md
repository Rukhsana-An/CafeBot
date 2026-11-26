# CLAUDE.md — CafeBot

This file tells Claude how to work on this project. Read it before every task.

## Project purpose

CafeBot is a beginner-friendly chatbot for a café. It helps customers:

- browse the menu and ask questions about items (ingredients, prices, sizes)
- hear about current promotions
- place simple orders

The project is meant to stay small, readable and easy to learn from. Prefer clear, simple code over clever code.

## Simple architecture

```
Customer ──> frontend/ ──> backend/ ──> AI model API
                              │
                              ├── prompts/system-prompt.md  (how the bot behaves)
                              └── data/                     (what the bot knows)
                                  ├── menu.json
                                  ├── promotions.json
                                  └── orders.json
```

| Part | Role |
|---|---|
| `frontend/` | The chat screen the customer sees. Sends messages to the backend and shows replies. Holds no secrets. |
| `backend/` | Receives chat messages, loads the system prompt and café data, calls the AI model, and returns the reply. Saves new orders to `data/orders.json`. |
| `prompts/system-prompt.md` | The bot's instructions: tone, rules, what it may and may not do. |
| `data/menu.json` | Menu items, prices and details. The single source of truth for the menu. |
| `data/promotions.json` | Current offers and their dates. |
| `data/orders.json` | Orders placed through the bot. |
| `.env` | Real secrets (API keys). Never committed. |
| `.env.example` | A copy of `.env` with placeholder values, so others know what to set. |

Data flows one way: the frontend only talks to the backend, and only the backend talks to the AI model.

## Strict coding rules

These rules apply to every task. Follow them all.

### 1. Read files first
- Before changing anything, read the files involved and any files they depend on.
- Don't guess how existing code works. Check it.
- Read `data/*.json` before writing code that uses it, so field names match.

### 2. Change only the files you need to
- Touch only the files the task requires.
- Don't rename, move, reformat or "clean up" unrelated code.
- Don't add new libraries, frameworks or tools unless the task asks for them.
- If another file seems to need a change, say so and ask first.

### 3. Never hard-code API keys
- Never put API keys, passwords or tokens in code, prompts, JSON data or comments.
- Read secrets from environment variables loaded from `.env`.
- When you add a new secret, add its name with a placeholder to `.env.example` (for example `AI_API_KEY=your-key-here`).
- Make sure `.env` is listed in `.gitignore`.
- The frontend must never contain or receive an API key.

### 4. Test before saying you're done
- Run the code, or a test, and confirm the change works before reporting it complete.
- Check that changed JSON files are still valid JSON.
- If you can't test something, say exactly what wasn't tested and why.
- Never report a task as complete when it is untested or broken.

### 5. Keep tasks tightly bounded
- Do exactly what was asked. No more, no less.
- Break large requests into small steps, and finish one step at a time.
- If the request is unclear, ask one short question before starting.
- Don't add extra features, pages or "nice to have" improvements.

### 6. Stop after the requested task
- When the task is finished, stop.
- Give a short summary: which files changed, what was tested, and anything left open.
- You may suggest one next step, but don't start it until asked.
