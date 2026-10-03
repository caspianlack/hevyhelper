# hevyhelper

Local viewer + MCP server for the user's Hevy workout data (https://api.hevyapp.com/docs/).

- `lib/hevy.mjs` — API client and sync into `data/cache.json` (full pull first time, then incremental via `/v1/workouts/events`). API key: `HEVY_API_KEY` in `.env`.
- `lib/analytics.mjs` — derived stats (e1RM via Epley, PRs, weekly hard sets per muscle, progression report). Weights are kg internally; convert with `toUnit` for display.
- `server.mjs` + `public/index.html` — dashboard at http://localhost:4321 (`npm start`).
- `lib/tools.mjs` — the training-data tools (zod schemas + handlers), shared by the MCP server and the in-app chat. Add new tools here.
- `mcp.mjs` — MCP server `hevy` (registered in `.mcp.json`). Prefer these tools over reading `data/cache.json` directly when analysing training.
- `lib/chat.mjs` — "Ask AI" panel backend: Claude (Anthropic SDK, manual streaming tool loop) or ChatGPT (OpenAI SDK), keys `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `.env`. Streams NDJSON from `POST /api/chat`.
- `/review-training` skill does a full coach-style review.

When analysing workouts: set notation is `80x8 @8 (W)` = weight × reps, RPE, set type (W warmup, D drop, F failure). Warmups are excluded from volume and set counts.
