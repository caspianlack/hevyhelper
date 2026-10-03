// Hevy API client + local cache sync.
// Docs: https://api.hevyapp.com/docs/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://api.hevyapp.com';
export const CACHE_FILE = path.join(ROOT, 'data', 'cache.json');

function apiKey() {
  if (!process.env.HEVY_API_KEY) {
    try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
  }
  const key = process.env.HEVY_API_KEY?.trim();
  if (!key) throw new Error('HEVY_API_KEY is not set. Add HEVY_API_KEY=<your key> to .env (Hevy app > Settings > Developer).');
  return key;
}

async function get(pathname, query = {}) {
  const url = new URL(pathname, BASE);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'api-key': apiKey(), accept: 'application/json' } });
    if (res.status === 429 && attempt < 5) {
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    // Hevy returns 404 for a page past the end on some endpoints
    if (res.status === 404 && query.page > 1) return null;
    if (!res.ok) throw new Error(`Hevy ${res.status} on ${url.pathname}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}

async function getAllPages(pathname, key, pageSize, extra = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const body = await get(pathname, { page, pageSize, ...extra });
    if (!body) break;
    out.push(...(body[key] ?? []));
    if (page >= (body.page_count ?? 1)) break;
  }
  return out;
}

export function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

/**
 * Sync Hevy into data/cache.json. First run (or full=true) pulls everything;
 * afterwards only workout events since the last sync are fetched.
 */
export async function sync({ full = false, log = () => {} } = {}) {
  const prev = full ? null : loadCache();
  const startedAt = new Date().toISOString();
  const cache = prev ?? { workouts: {}, templates: {}, routines: [], body_measurements: [], user: null };

  const user = await get('/v1/user/info');
  cache.user = user.data ?? user;

  let added = 0, deleted = 0;
  if (!prev) {
    log('Fetching all workouts…');
    for (const w of await getAllPages('/v1/workouts', 'workouts', 10)) { cache.workouts[w.id] = w; added++; }
  } else {
    log(`Fetching workout changes since ${prev.last_sync}…`);
    const events = await getAllPages('/v1/workouts/events', 'events', 10, { since: prev.last_sync });
    // events are newest-first; apply oldest-first so the latest state wins
    for (const e of events.reverse()) {
      if (e.type === 'deleted') { delete cache.workouts[e.id]; deleted++; }
      else if (e.workout) { cache.workouts[e.workout.id] = e.workout; added++; }
    }
  }

  // Exercise templates carry muscle groups; refresh on full sync or when we see unknown ids
  const usedIds = new Set(Object.values(cache.workouts).flatMap(w => w.exercises.map(e => e.exercise_template_id)));
  const missing = [...usedIds].some(id => !cache.templates[id]);
  if (!prev || missing) {
    log('Fetching exercise templates…');
    for (const t of await getAllPages('/v1/exercise_templates', 'exercise_templates', 100)) cache.templates[t.id] = t;
  }

  log('Fetching routines and body measurements…');
  cache.routines = await getAllPages('/v1/routines', 'routines', 10);
  cache.body_measurements = await getAllPages('/v1/body_measurements', 'body_measurements', 10).catch(() => cache.body_measurements);

  cache.last_sync = startedAt;
  saveCache(cache);
  const summary = { workouts: Object.keys(cache.workouts).length, updated: added, deleted, mode: prev ? 'incremental' : 'full', last_sync: startedAt };
  log(`Done: ${JSON.stringify(summary)}`);
  return summary;
}

export async function ensureCache(log) {
  return loadCache() ?? (await sync({ log }), loadCache());
}
