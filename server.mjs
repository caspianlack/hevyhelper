// Local web viewer. `npm start` then open http://localhost:4321
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync, ensureCache, loadCache } from './lib/hevy.mjs';
import * as A from './lib/analytics.mjs';
import { chat, providers } from './lib/chat.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4321;

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const routes = {
  'GET /api/dashboard': async (c, url) => {
    const weeks = Math.min(104, Math.max(4, Number(url.searchParams.get('weeks')) || 12));
    return {
      overview: A.overview(c, weeks),
      muscles: A.weeklyMuscleSets(c, weeks),
      workouts: A.workouts(c).map(w => ({ id: w.id, title: w.title, start_time: w.start_time, ...A.workoutStats(w) })),
      exercises: A.usedExercises(c),
      records: A.personalRecords(c),
      progression: A.progressionReport(c, 8),
    };
  },
  'GET /api/workout': async (c, url) => {
    const w = c.workouts[url.searchParams.get('id')];
    return w && { ...w, stats: A.workoutStats(w), unit: A.unitOf(c) };
  },
  'GET /api/exercise': async (c, url) => {
    const id = url.searchParams.get('id');
    return { template: c.templates[id] ?? null, unit: A.unitOf(c), sessions: A.exerciseSessions(c, id) };
  },
};

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

// Streams newline-delimited JSON events: conversation, text, tool, error, done.
async function handleChat(req, res) {
  const { conversationId, provider, message } = await readJson(req);
  if (!message?.trim()) return json(res, { error: 'empty message' }, 400);
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  const emit = e => res.write(JSON.stringify(e) + '\n');
  try {
    await chat({ conversationId, provider, message }, emit);
    emit({ type: 'done' });
  } catch (err) {
    console.error(err);
    emit({ type: 'error', message: err.message });
  }
  res.end();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/chat/providers') return json(res, providers());
    if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      return json(res, await sync({ full: url.searchParams.has('full'), log: console.log }));
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      const body = await route(await ensureCache(console.log), url);
      return body ? json(res, body) : json(res, { error: 'not found' }, 404);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res);
    }
    json(res, { error: 'not found' }, 404);
  } catch (err) {
    console.error(err);
    json(res, { error: err.message }, 500);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Hevy viewer on http://localhost:${PORT}${loadCache() ? '' : ' (first load will sync from Hevy)'}`);
});
