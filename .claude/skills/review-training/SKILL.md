---
name: review-training
description: Sync Hevy and give a coach-style review of recent training — frequency, muscle volume balance, progression/stalls, and concrete next steps. Use when the user asks to assess, review or analyse their workouts.
---

Review the user's recent training using the `hevy` MCP tools.

1. Call `sync_hevy` so the data is current.
2. Call `get_training_overview` (default 12 weeks, or the window the user asked for).
3. Call `get_progression_report` and `get_weekly_muscle_volume` (8 weeks).
4. Call `list_workouts` for the last 2–3 weeks to see actual session structure, rep ranges, RPE and notes.
5. For any lift flagged stalled/regressing that matters (compounds, frequently trained), call `get_exercise_progress` for it.
6. If the user has routines, call `get_routines` to compare plan vs what was done.

Then write the review:
- **Snapshot** — frequency, consistency, session length, in 2–3 lines.
- **What's working** — lifts progressing, with numbers.
- **Concerns** — stalls/regressions with likely causes visible in the data (rep range stuck, no load increase, low frequency, too many sets to failure, missed sessions); muscle groups clearly under- or over-trained (rough guide: ~10–20 hard sets/week per muscle for hypertrophy) and push/pull or quad/hamstring imbalances.
- **Next 2–4 weeks** — 3–5 specific, actionable changes (exercise, sets × reps, load target).

Cite numbers from the data, use the user's weight unit, and say so when data is thin rather than guessing. Do not invent workouts.
