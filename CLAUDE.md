# hevyhelper

Local viewer + MCP server for the user's Hevy workout data (https://api.hevyapp.com/docs/).

- `lib/hevy.mjs` — API client and sync into `data/cache.json` (full pull first time, then incremental via `/v1/workouts/events`). API key: `HEVY_API_KEY` in `.env`.
- `lib/analytics.mjs` — derived stats (e1RM via Epley, PRs, weekly hard sets per muscle, progression report). Weights are kg internally; convert with `toUnit` for display.
- `server.mjs` + `public/index.html` — dashboard at http://localhost:4321 (`npm start`).
- `mcp.mjs` — MCP server `hevy` (registered in `.mcp.json`). Prefer these tools over reading `data/cache.json` directly when analysing training.
- `/review-training` skill does a full coach-style review.

When analysing workouts: set notation is `80x8 @8 (W)` = weight × reps, RPE, set type (W warmup, D drop, F failure). Warmups are excluded from volume and set counts.
