// MCP server exposing Hevy training data to Claude (Claude Code, Claude Desktop, etc.).
// Reads from the local cache; call the `sync_hevy` tool to pull fresh data.
// Never write to stdout here except via the MCP transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sync, ensureCache, loadCache } from './lib/hevy.mjs';
import * as A from './lib/analytics.mjs';

const log = m => console.error(`[hevy] ${m}`);
const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 1) }] });
const cache = async () => {
  const c = await ensureCache(log);
  // auto-refresh if the cache is more than an hour old
  if (Date.now() - new Date(c.last_sync) > 3600e3) {
    try { await sync({ log }); return loadCache(); } catch (e) { log(`auto-sync failed: ${e.message}`); }
  }
  return c;
};
const r1 = n => (n == null ? null : Math.round(n * 10) / 10);

const server = new McpServer({ name: 'hevy', version: '1.0.0' }, {
  instructions:
    'Hevy workout data for the user. Start with get_training_overview for context, then drill into ' +
    'list_workouts / get_exercise_progress / get_progression_report. Weights are shown in the user\'s ' +
    'preferred unit. Set notation: 80x8 = 80 weight for 8 reps; @8 = RPE; (W) warmup, (D) dropset, (F) failure. ' +
    'Weekly muscle sets count primary muscle as 1 set and each secondary muscle as 0.5.',
});

server.registerTool('sync_hevy', {
  description: 'Pull the latest workouts, routines and measurements from Hevy into the local cache. Use full=true to rebuild from scratch.',
  inputSchema: { full: z.boolean().optional() },
}, async ({ full }) => text(await sync({ full, log })));

server.registerTool('get_training_overview', {
  description: 'High-level summary: frequency, session length, weekly totals, streak, and average weekly hard sets per muscle group over the last N weeks.',
  inputSchema: { weeks: z.number().int().min(2).max(104).default(12) },
}, async ({ weeks }) => {
  const c = await cache();
  const o = A.overview(c, weeks);
  o.weekly = o.weekly.map(({ volume_kg, ...r }) => r);
  return text(o);
});

server.registerTool('list_workouts', {
  description: 'Full set-by-set detail of workouts, newest first, in compact text. Filter by date range (YYYY-MM-DD) and/or a title substring.',
  inputSchema: {
    since: z.string().optional().describe('YYYY-MM-DD inclusive'),
    until: z.string().optional().describe('YYYY-MM-DD inclusive'),
    title: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(10),
    include_notes: z.boolean().default(true),
  },
}, async ({ since, until, title, limit, include_notes }) => {
  const c = await cache();
  let ws = A.workouts(c, { since, until: until && `${until}T23:59:59Z` });
  if (title) ws = ws.filter(w => w.title.toLowerCase().includes(title.toLowerCase()));
  const shown = ws.slice(0, limit);
  return text(`${ws.length} matching workouts, showing ${shown.length}. Unit: ${A.unitOf(c)}\n\n` +
    shown.map(w => A.formatWorkout(w, c, { notes: include_notes })).join('\n\n'));
});

server.registerTool('get_workout', {
  description: 'One workout by id, set by set.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const c = await cache();
  const w = c.workouts[id];
  return text(w ? A.formatWorkout(w, c) : `No workout ${id}`);
});

server.registerTool('list_exercises', {
  description: 'Every exercise the user has logged, with session count, last date and primary muscle. Optional name filter.',
  inputSchema: { query: z.string().optional() },
}, async ({ query }) => {
  const c = await cache();
  let ex = A.usedExercises(c);
  if (query) ex = ex.filter(e => e.title.toLowerCase().includes(query.toLowerCase()));
  return text(ex.map(e => `${e.title} — ${e.sessions} sessions, last ${e.last}, ${e.muscle ?? '?'} [${e.id}]`).join('\n'));
});

server.registerTool('get_exercise_progress', {
  description: 'Session-by-session history for one exercise: top set, estimated 1RM (Epley), working sets, volume, and all sets. Accepts a name (fuzzy) or template id.',
  inputSchema: {
    exercise: z.string(),
    weeks: z.number().int().min(1).max(520).optional().describe('Only the last N weeks; omit for all time'),
  },
}, async ({ exercise, weeks }) => {
  const c = await cache();
  const ex = A.findExercise(c, exercise);
  if (!ex) return text(`No logged exercise matches "${exercise}". Try list_exercises.`);
  const unit = A.unitOf(c);
  const u = kg => r1(A.toUnit(kg, unit));
  let sessions = A.exerciseSessions(c, ex.id);
  if (weeks) sessions = sessions.filter(s => new Date(s.date) >= Date.now() - weeks * 7 * 864e5);
  const lines = sessions.map(s =>
    `${s.date}: top ${u(s.top_weight_kg) ?? '-'}x${s.top_reps ?? '-'}, e1RM ${u(s.e1rm_kg) ?? '-'}, ${s.working_sets} sets, vol ${Math.round(u(s.volume_kg))} | ${s.sets.map(x => A.formatSet(x, unit)).join(', ')}`);
  return text(`${ex.title} (${ex.muscle ?? '?'}), unit ${unit}, ${sessions.length} sessions\n${lines.join('\n')}`);
});

server.registerTool('get_personal_records', {
  description: 'Per-exercise records: heaviest weight, best estimated 1RM, most reps in a set — with dates.',
  inputSchema: { query: z.string().optional().describe('Filter by exercise name substring') },
}, async ({ query }) => {
  const c = await cache();
  const unit = A.unitOf(c);
  let prs = A.personalRecords(c);
  if (query) prs = prs.filter(p => p.title.toLowerCase().includes(query.toLowerCase()));
  return text(prs.map(p => [
    `${p.title} (${p.sessions} sessions)`,
    p.heaviest && `heaviest ${r1(A.toUnit(p.heaviest.weight_kg, unit))}${unit}x${p.heaviest.reps} on ${p.heaviest.date}`,
    p.best_e1rm && `e1RM ${r1(A.toUnit(p.best_e1rm.kg, unit))}${unit} on ${p.best_e1rm.date}`,
    p.most_reps && `max reps ${p.most_reps.reps} on ${p.most_reps.date}`,
  ].filter(Boolean).join(' — ')).join('\n'));
});

server.registerTool('get_progression_report', {
  description: 'For every lift trained 3+ times in the window, compares best e1RM in the recent half vs the earlier half and labels it progressing / stalled / regressing.',
  inputSchema: { weeks: z.number().int().min(4).max(52).default(8) },
}, async ({ weeks }) => {
  const c = await cache();
  const unit = A.unitOf(c);
  return text(A.progressionReport(c, weeks).map(r => ({
    ...r, early_e1rm: r1(A.toUnit(r.early_e1rm_kg, unit)), recent_e1rm: r1(A.toUnit(r.recent_e1rm_kg, unit)),
    early_e1rm_kg: undefined, recent_e1rm_kg: undefined, unit,
  })));
});

server.registerTool('get_weekly_muscle_volume', {
  description: 'Hard (non-warmup) sets per muscle group for each of the last N weeks. Primary muscle = 1, secondary = 0.5.',
  inputSchema: { weeks: z.number().int().min(1).max(52).default(8) },
}, async ({ weeks }) => {
  const c = await cache();
  const { weeks: wk, muscles } = A.weeklyMuscleSets(c, weeks);
  return text({ weeks: wk, note: 'last week is the current (partial) week', muscles });
});

server.registerTool('get_routines', {
  description: 'The user\'s saved Hevy routines (planned programs) with target sets.',
  inputSchema: {},
}, async () => {
  const c = await cache();
  const unit = A.unitOf(c);
  return text(c.routines.map(r => `## ${r.title} [${r.id}]\n` + r.exercises.map(e =>
    `- ${e.title}: ${e.sets.map(s => A.formatSet(s, unit)).join(', ')}${e.rest_seconds ? ` (rest ${e.rest_seconds}s)` : ''}${e.notes ? ` — ${e.notes}` : ''}`).join('\n')).join('\n\n') || 'No routines.');
});

server.registerTool('get_body_measurements', {
  description: 'Logged body measurements (bodyweight, body fat, circumferences), newest first.',
  inputSchema: {},
}, async () => {
  const c = await cache();
  const rows = [...c.body_measurements].sort((a, b) => b.date.localeCompare(a.date))
    .map(m => Object.fromEntries(Object.entries(m).filter(([, v]) => v != null)));
  return text(rows.length ? rows : 'No body measurements logged.');
});

await server.connect(new StdioServerTransport());
log('MCP server ready');
