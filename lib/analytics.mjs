// Derived training stats computed from the local cache. All weights are stored in kg
// (as Hevy returns them) and converted to the user's preferred unit only for display.

const LB = 2.20462;

export const unitOf = cache => (cache.user?.weight_unit === 'lbs' ? 'lbs' : 'kg');
export const toUnit = (kg, unit) => (kg == null ? null : unit === 'lbs' ? kg * LB : kg);
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

const isWorking = s => s.type !== 'warmup';

/** Epley estimated 1RM; ignores sets above 15 reps where the estimate is meaningless. */
export function e1rm(kg, reps) {
  if (!kg || !reps || reps > 15) return null;
  return reps === 1 ? kg : kg * (1 + reps / 30);
}

export const dateKey = iso => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Local Monday (YYYY-MM-DD) of the week containing iso. */
export function weekKey(iso) {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dateKey(d);
}

function lastWeeks(n) {
  const keys = [];
  const d = new Date(weekKey(new Date().toISOString()) + 'T00:00:00');
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - 7 * i);
    keys.push(dateKey(x));
  }
  return keys;
}

export function workouts(cache, { since, until } = {}) {
  return Object.values(cache.workouts)
    .filter(w => (!since || w.start_time >= since) && (!until || w.start_time <= until))
    .sort((a, b) => b.start_time.localeCompare(a.start_time));
}

export function workoutStats(w) {
  let sets = 0, volume = 0, reps = 0;
  for (const ex of w.exercises) for (const s of ex.sets) {
    if (!isWorking(s)) continue;
    sets++;
    reps += s.reps ?? 0;
    volume += (s.weight_kg ?? 0) * (s.reps ?? 0);
  }
  const duration_min = Math.round((new Date(w.end_time) - new Date(w.start_time)) / 60000);
  return { sets, reps, volume_kg: volume, duration_min, exercises: w.exercises.length };
}

export function formatSet(s, unit) {
  const parts = [];
  if (s.weight_kg != null && s.reps != null) parts.push(`${round(toUnit(s.weight_kg, unit))}x${s.reps}`);
  else if (s.reps != null) parts.push(`${s.reps} reps`);
  else if (s.weight_kg != null) parts.push(`${round(toUnit(s.weight_kg, unit))}${unit}`);
  if (s.distance_meters != null) parts.push(`${s.distance_meters}m`);
  if (s.duration_seconds != null) parts.push(`${s.duration_seconds}s`);
  if (s.rpe != null) parts.push(`@${s.rpe}`);
  const tag = { warmup: 'W', dropset: 'D', failure: 'F' }[s.type];
  return parts.join(' ') + (tag ? ` (${tag})` : '');
}

/** Compact, token-efficient text rendering of a workout for Claude. */
export function formatWorkout(w, cache, { notes = true } = {}) {
  const unit = unitOf(cache);
  const st = workoutStats(w);
  const lines = [`## ${dateKey(w.start_time)} — ${w.title} (${st.duration_min} min, ${st.sets} working sets, ${Math.round(toUnit(st.volume_kg, unit))} ${unit} volume) [id ${w.id}]`];
  if (notes && w.description) lines.push(`Notes: ${w.description}`);
  for (const ex of [...w.exercises].sort((a, b) => a.index - b.index)) {
    const ss = ex.superset_id != null ? ` [superset ${ex.superset_id}]` : '';
    lines.push(`- ${ex.title}${ss}: ${ex.sets.map(s => formatSet(s, unit)).join(', ')}`);
    if (notes && ex.notes) lines.push(`  note: ${ex.notes}`);
  }
  return lines.join('\n');
}

/** Per-session history for one exercise template, oldest first. */
export function exerciseSessions(cache, templateId) {
  const out = [];
  for (const w of workouts(cache).reverse()) {
    const exs = w.exercises.filter(e => e.exercise_template_id === templateId);
    if (!exs.length) continue;
    const sets = exs.flatMap(e => e.sets);
    const working = sets.filter(isWorking);
    let top = null, best = null, volume = 0;
    for (const s of working) {
      volume += (s.weight_kg ?? 0) * (s.reps ?? 0);
      if (s.weight_kg != null && (!top || s.weight_kg > top.weight_kg || (s.weight_kg === top.weight_kg && (s.reps ?? 0) > (top.reps ?? 0)))) top = s;
      const est = e1rm(s.weight_kg, s.reps);
      if (est && (!best || est > best)) best = est;
    }
    out.push({
      date: dateKey(w.start_time),
      workout_id: w.id,
      workout_title: w.title,
      top_weight_kg: top?.weight_kg ?? null,
      top_reps: top?.reps ?? null,
      e1rm_kg: best,
      volume_kg: volume,
      working_sets: working.length,
      max_reps: Math.max(0, ...working.map(s => s.reps ?? 0)),
      sets,
    });
  }
  return out;
}

/** Exercises the user has actually logged, with counts — most frequent first. */
export function usedExercises(cache) {
  const map = new Map();
  for (const w of Object.values(cache.workouts)) for (const ex of w.exercises) {
    const id = ex.exercise_template_id;
    const cur = map.get(id) ?? { id, title: ex.title, sessions: 0, last: null };
    cur.sessions++;
    if (!cur.last || w.start_time > cur.last) cur.last = w.start_time;
    map.set(id, cur);
  }
  return [...map.values()]
    .map(e => ({ ...e, last: dateKey(e.last), muscle: cache.templates[e.id]?.primary_muscle_group ?? null }))
    .sort((a, b) => b.sessions - a.sessions);
}

export function findExercise(cache, query) {
  const q = query.toLowerCase().trim();
  const used = usedExercises(cache);
  return used.find(e => e.id === query)
    ?? used.find(e => e.title.toLowerCase() === q)
    ?? used.find(e => e.title.toLowerCase().includes(q))
    ?? used.find(e => q.split(/\s+/).every(t => e.title.toLowerCase().includes(t)));
}

export function personalRecords(cache) {
  return usedExercises(cache).map(ex => {
    const sessions = exerciseSessions(cache, ex.id);
    const pick = f => sessions.reduce((best, s) => (f(s) != null && (!best || f(s) > f(best)) ? s : best), null);
    const heaviest = pick(s => s.top_weight_kg);
    const bestE1rm = pick(s => s.e1rm_kg);
    const mostReps = pick(s => s.max_reps || null);
    return {
      id: ex.id, title: ex.title, sessions: ex.sessions, muscle: ex.muscle,
      heaviest: heaviest && { weight_kg: heaviest.top_weight_kg, reps: heaviest.top_reps, date: heaviest.date },
      best_e1rm: bestE1rm && { kg: bestE1rm.e1rm_kg, date: bestE1rm.date },
      most_reps: mostReps && { reps: mostReps.max_reps, date: mostReps.date },
    };
  });
}

/**
 * Weekly hard sets per muscle group (primary = 1 set, each secondary = 0.5).
 * Returns { weeks: [...monday keys], muscles: { chest: [n per week], ... } }.
 */
export function weeklyMuscleSets(cache, nWeeks = 12) {
  const weeks = lastWeeks(nWeeks);
  const idx = new Map(weeks.map((w, i) => [w, i]));
  const muscles = {};
  const add = (m, i, n) => { (muscles[m] ??= Array(weeks.length).fill(0))[i] += n; };
  for (const w of Object.values(cache.workouts)) {
    const i = idx.get(weekKey(w.start_time));
    if (i == null) continue;
    for (const ex of w.exercises) {
      const n = ex.sets.filter(isWorking).length;
      const t = cache.templates[ex.exercise_template_id];
      add(t?.primary_muscle_group ?? 'other', i, n);
      for (const m of t?.secondary_muscle_groups ?? []) add(m, i, n * 0.5);
    }
  }
  return { weeks, muscles };
}

export function weeklyTotals(cache, nWeeks = 12) {
  const weeks = lastWeeks(nWeeks);
  const rows = weeks.map(week => ({ week, workouts: 0, sets: 0, volume_kg: 0, minutes: 0 }));
  const idx = new Map(weeks.map((w, i) => [w, i]));
  for (const w of Object.values(cache.workouts)) {
    const i = idx.get(weekKey(w.start_time));
    if (i == null) continue;
    const st = workoutStats(w);
    rows[i].workouts++;
    rows[i].sets += st.sets;
    rows[i].volume_kg += st.volume_kg;
    rows[i].minutes += st.duration_min;
  }
  return rows;
}

/**
 * Exercise-level trend over a window: compares best e1RM in the recent half of the
 * window to the earlier half. Flags stalls/regressions on frequently trained lifts.
 */
export function progressionReport(cache, nWeeks = 8) {
  const now = Date.now();
  const cut = now - (nWeeks / 2) * 7 * 864e5;
  const start = now - nWeeks * 7 * 864e5;
  const out = [];
  for (const ex of usedExercises(cache)) {
    const sessions = exerciseSessions(cache, ex.id).filter(s => new Date(s.date) >= start && s.e1rm_kg);
    if (sessions.length < 3) continue;
    const early = sessions.filter(s => new Date(s.date) < cut);
    const late = sessions.filter(s => new Date(s.date) >= cut);
    if (!early.length || !late.length) continue;
    const a = Math.max(...early.map(s => s.e1rm_kg));
    const b = Math.max(...late.map(s => s.e1rm_kg));
    const pct = ((b - a) / a) * 100;
    out.push({ title: ex.title, sessions: sessions.length, early_e1rm_kg: a, recent_e1rm_kg: b, change_pct: round(pct), status: pct > 1.5 ? 'progressing' : pct < -3 ? 'regressing' : 'stalled' });
  }
  return out.sort((x, y) => x.change_pct - y.change_pct);
}

export function overview(cache, nWeeks = 12) {
  const unit = unitOf(cache);
  const totals = weeklyTotals(cache, nWeeks);
  const all = workouts(cache);
  const recent = all.filter(w => new Date(w.start_time) >= new Date(totals[0].week));
  const { weeks, muscles } = weeklyMuscleSets(cache, nWeeks);
  // average over completed weeks only (exclude the current partial week)
  const done = Math.max(1, weeks.length - 1);
  const avgSets = Object.fromEntries(
    Object.entries(muscles)
      .map(([m, arr]) => [m, round(arr.slice(0, -1).reduce((a, b) => a + b, 0) / done)])
      .sort((a, b) => b[1] - a[1]),
  );
  let streak = 0;
  for (let i = totals.length - 2; i >= 0 && totals[i].workouts > 0; i--) streak++;
  if (totals.at(-1).workouts > 0) streak++;
  return {
    unit,
    user: cache.user?.name ?? cache.user?.username,
    last_sync: cache.last_sync,
    total_workouts_all_time: all.length,
    first_workout: all.length ? dateKey(all.at(-1).start_time) : null,
    window_weeks: nWeeks,
    workouts_in_window: recent.length,
    avg_workouts_per_week: round(totals.slice(0, -1).reduce((a, r) => a + r.workouts, 0) / done),
    avg_session_minutes: recent.length ? Math.round(recent.reduce((a, w) => a + workoutStats(w).duration_min, 0) / recent.length) : null,
    weekly_streak: streak,
    weekly: totals.map(r => ({ ...r, volume: Math.round(toUnit(r.volume_kg, unit)) })),
    avg_weekly_sets_per_muscle: avgSets,
  };
}
