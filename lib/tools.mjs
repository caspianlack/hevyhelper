// Training-data tools shared by the MCP server (mcp.mjs) and the in-app chat (lib/chat.mjs).
// Each tool: { name, description, schema (zod shape), run(args) -> string }.
import { z } from 'zod';
import { sync, ensureCache, loadCache } from './hevy.mjs';
import * as A from './analytics.mjs';

const log = m => console.error(`[hevy] ${m}`);
const r1 = n => (n == null ? null : Math.round(n * 10) / 10);
const json = v => JSON.stringify(v, null, 1);

async function cache() {
  const c = await ensureCache(log);
  // auto-refresh if the cache is more than an hour old
  if (Date.now() - new Date(c.last_sync) > 3600e3) {
    try { await sync({ log }); return loadCache(); } catch (e) { log(`auto-sync failed: ${e.message}`); }
  }
  return c;
}

export const INSTRUCTIONS =
  'Hevy workout data for the user. Start with get_training_overview for context, then drill into ' +
  'list_workouts / get_exercise_progress / get_progression_report. Weights are shown in the user\'s ' +
  'preferred unit. Set notation: 80x8 = 80 weight for 8 reps; @8 = RPE; (W) warmup, (D) dropset, (F) failure. ' +
  'Weekly muscle sets count primary muscle as 1 set and each secondary muscle as 0.5.';

export const tools = [
  {
    name: 'sync_hevy',
    description: 'Pull the latest workouts, routines and measurements from Hevy into the local cache. Use full=true to rebuild from scratch.',
    schema: { full: z.boolean().optional() },
    run: async ({ full }) => json(await sync({ full, log })),
  },
  {
    name: 'get_training_overview',
    description: 'High-level summary: frequency, session length, weekly totals, streak, and average weekly hard sets per muscle group over the last N weeks.',
    schema: { weeks: z.number().int().min(2).max(104).default(12) },
    run: async ({ weeks }) => {
      const o = A.overview(await cache(), weeks);
      o.weekly = o.weekly.map(({ volume_kg, ...r }) => r);
      return json(o);
    },
  },
  {
    name: 'list_workouts',
    description: 'Full set-by-set detail of workouts, newest first, in compact text. Filter by date range (YYYY-MM-DD) and/or a title substring.',
    schema: {
      since: z.string().optional().describe('YYYY-MM-DD inclusive'),
      until: z.string().optional().describe('YYYY-MM-DD inclusive'),
      title: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(10),
      include_notes: z.boolean().default(true),
    },
    run: async ({ since, until, title, limit, include_notes }) => {
      const c = await cache();
      let ws = A.workouts(c, { since, until: until && `${until}T23:59:59Z` });
      if (title) ws = ws.filter(w => w.title.toLowerCase().includes(title.toLowerCase()));
      const shown = ws.slice(0, limit);
      return `${ws.length} matching workouts, showing ${shown.length}. Unit: ${A.unitOf(c)}\n\n` +
        shown.map(w => A.formatWorkout(w, c, { notes: include_notes })).join('\n\n');
    },
  },
  {
    name: 'get_workout',
    description: 'One workout by id, set by set.',
    schema: { id: z.string() },
    run: async ({ id }) => {
      const c = await cache();
      const w = c.workouts[id];
      return w ? A.formatWorkout(w, c) : `No workout ${id}`;
    },
  },
  {
    name: 'list_exercises',
    description: 'Every exercise the user has logged, with session count, last date and primary muscle. Optional name filter.',
    schema: { query: z.string().optional() },
    run: async ({ query }) => {
      let ex = A.usedExercises(await cache());
      if (query) ex = ex.filter(e => e.title.toLowerCase().includes(query.toLowerCase()));
      return ex.map(e => `${e.title} — ${e.sessions} sessions, last ${e.last}, ${e.muscle ?? '?'} [${e.id}]`).join('\n') || 'No matching exercises.';
    },
  },
  {
    name: 'get_exercise_progress',
    description: 'Session-by-session history for one exercise: top set, estimated 1RM (Epley), working sets, volume, and all sets. Accepts a name (fuzzy) or template id.',
    schema: {
      exercise: z.string(),
      weeks: z.number().int().min(1).max(520).optional().describe('Only the last N weeks; omit for all time'),
    },
    run: async ({ exercise, weeks }) => {
      const c = await cache();
      const ex = A.findExercise(c, exercise);
      if (!ex) return `No logged exercise matches "${exercise}". Try list_exercises.`;
      const unit = A.unitOf(c);
      const u = kg => r1(A.toUnit(kg, unit));
      let sessions = A.exerciseSessions(c, ex.id);
      if (weeks) sessions = sessions.filter(s => new Date(s.date) >= Date.now() - weeks * 7 * 864e5);
      const lines = sessions.map(s =>
        `${s.date}: top ${u(s.top_weight_kg) ?? '-'}x${s.top_reps ?? '-'}, e1RM ${u(s.e1rm_kg) ?? '-'}, ${s.working_sets} sets, vol ${Math.round(u(s.volume_kg))} | ${s.sets.map(x => A.formatSet(x, unit)).join(', ')}`);
      return `${ex.title} (${ex.muscle ?? '?'}), unit ${unit}, ${sessions.length} sessions\n${lines.join('\n')}`;
    },
  },
  {
    name: 'get_personal_records',
    description: 'Per-exercise records: heaviest weight, best estimated 1RM, most reps in a set — with dates.',
    schema: { query: z.string().optional().describe('Filter by exercise name substring') },
    run: async ({ query }) => {
      const c = await cache();
      const unit = A.unitOf(c);
      let prs = A.personalRecords(c);
      if (query) prs = prs.filter(p => p.title.toLowerCase().includes(query.toLowerCase()));
      return prs.map(p => [
        `${p.title} (${p.sessions} sessions)`,
        p.heaviest && `heaviest ${r1(A.toUnit(p.heaviest.weight_kg, unit))}${unit}x${p.heaviest.reps} on ${p.heaviest.date}`,
        p.best_e1rm && `e1RM ${r1(A.toUnit(p.best_e1rm.kg, unit))}${unit} on ${p.best_e1rm.date}`,
        p.most_reps && `max reps ${p.most_reps.reps} on ${p.most_reps.date}`,
      ].filter(Boolean).join(' — ')).join('\n') || 'No records.';
    },
  },
  {
    name: 'get_progression_report',
    description: 'For every lift trained 3+ times in the window, compares best e1RM in the recent half vs the earlier half and labels it progressing / stalled / regressing.',
    schema: { weeks: z.number().int().min(4).max(52).default(8) },
    run: async ({ weeks }) => {
      const c = await cache();
      const unit = A.unitOf(c);
      return json(A.progressionReport(c, weeks).map(({ early_e1rm_kg, recent_e1rm_kg, ...r }) => ({
        ...r, early_e1rm: r1(A.toUnit(early_e1rm_kg, unit)), recent_e1rm: r1(A.toUnit(recent_e1rm_kg, unit)), unit,
      })));
    },
  },
  {
    name: 'get_weekly_muscle_volume',
    description: 'Hard (non-warmup) sets per muscle group for each of the last N weeks. Primary muscle = 1, secondary = 0.5.',
    schema: { weeks: z.number().int().min(1).max(52).default(8) },
    run: async ({ weeks }) => {
      const { weeks: wk, muscles } = A.weeklyMuscleSets(await cache(), weeks);
      return json({ weeks: wk, note: 'last week is the current (partial) week', muscles });
    },
  },
  {
    name: 'get_routines',
    description: 'The user\'s saved Hevy routines (planned programs) with target sets.',
    schema: {},
    run: async () => {
      const c = await cache();
      const unit = A.unitOf(c);
      return c.routines.map(r => `## ${r.title} [${r.id}]\n` + r.exercises.map(e =>
        `- ${e.title}: ${e.sets.map(s => A.formatSet(s, unit)).join(', ')}${e.rest_seconds ? ` (rest ${e.rest_seconds}s)` : ''}${e.notes ? ` — ${e.notes}` : ''}`).join('\n')).join('\n\n') || 'No routines.';
    },
  },
  {
    name: 'get_body_measurements',
    description: 'Logged body measurements (bodyweight, body fat, circumferences), newest first.',
    schema: {},
    run: async () => {
      const c = await cache();
      const rows = [...c.body_measurements].sort((a, b) => b.date.localeCompare(a.date))
        .map(m => Object.fromEntries(Object.entries(m).filter(([, v]) => v != null)));
      return rows.length ? json(rows) : 'No body measurements logged.';
    },
  },
];

const byName = new Map(tools.map(t => [t.name, t]));

/** JSON Schema for a tool's input, for providers that take raw schemas. */
export function jsonSchema(tool) {
  const { $schema, ...s } = z.toJSONSchema(z.object(tool.schema), { io: 'input' });
  return s;
}

/** Validate model-supplied args and run the tool. Throws on unknown tool or invalid input. */
export async function runTool(name, args) {
  const tool = byName.get(name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  const parsed = z.object(tool.schema).safeParse(args ?? {});
  if (!parsed.success) throw new Error(`Invalid input for ${name}: ${parsed.error.message}`);
  return tool.run(parsed.data);
}
