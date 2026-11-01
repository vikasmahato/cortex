import { watch } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer, type WebSocket } from 'ws';
import { REGIONS, projectFromCwd, regionForHook, regionForTool, type FireSignal, type Region } from '@cortex/core';
import { CortexDB } from '@cortex/db';
import { PROJECTS_DIR, ingestFile, listTranscripts } from './ingest.ts';
import { askCortex } from './ask.ts';
import { getDigest } from './digest.ts';
import { getProfile } from './profile.ts';
import { buildContext, canEdit, resolveProjectDir, streamChat, type ChatMode } from './chat.ts';
import { randomUUID } from 'node:crypto';
import { streamSSE } from 'hono/streaming';
import { summarizePending, summarizeSession } from './summarize.ts';

const PORT = Number(process.env.CORTEX_PORT ?? 7777);
const HOST = '127.0.0.1'; // never expose captured activity beyond this machine

const db = new CortexDB();
// sessions are grouped into projects by working directory; re-derive on every start so rule changes apply to history
console.log(`[cortex] projects re-grouped: ${db.reproject(projectFromCwd)} sessions updated`);
const clients = new Set<WebSocket>();

function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}

// ---- transcript ingestion (source of truth) -------------------------------

const timers = new Map<string, NodeJS.Timeout>();
function scheduleIngest(path: string, delay = 150) {
  clearTimeout(timers.get(path));
  timers.set(
    path,
    setTimeout(() => {
      timers.delete(path);
      try {
        const fresh = ingestFile(db, path);
        if (fresh.length) {
          broadcast({
            type: 'events',
            count: fresh.length,
            sessionId: fresh[0]!.sessionId,
            // compact preview so the UI can fire the right regions without a refetch
            events: fresh.slice(-40).map((e) => ({
              region: e.region, kind: e.kind, tool: e.tool, project: e.project,
              ts: e.ts, text: e.text.slice(0, 160),
            })),
          });
        }
      } catch (err) {
        console.error('[ingest]', path, err);
      }
    }, delay),
  );
}

async function initialBackfill() {
  const files = listTranscripts();
  let n = 0;
  for (const f of files) {
    n += ingestFile(db, f).length;
    await new Promise((r) => setImmediate(r)); // keep the server responsive
  }
  console.log(`[cortex] backfill: ${files.length} transcripts, ${n} new events`);
}

try {
  watch(PROJECTS_DIR, { recursive: true }, (_evt, name) => {
    if (name && name.endsWith('.jsonl')) scheduleIngest(join(PROJECTS_DIR, name));
  });
} catch (err) {
  console.error('[cortex] cannot watch', PROJECTS_DIR, err);
}

// ---- HTTP API --------------------------------------------------------------

const app = new Hono();
app.use('*', cors({
  origin: (o) => (o && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : null),
  allowHeaders: ['content-type', 'x-cortex-client'],
}));

app.get('/health', (c) => c.json({ ok: true, clients: clients.size }));

/** Called by the cortex-hook CLI on every Claude Code hook event. */
app.post('/hook', async (c) => {
  const p = (await c.req.json().catch(() => null)) as Record<string, any> | null;
  if (!p || typeof p.hook_event_name !== 'string') return c.json({ ok: false }, 400);

  const hook: string = p.hook_event_name;
  const isTool = hook === 'PostToolUse' || hook === 'PreToolUse';
  const failed = hook === 'PostToolUse' && Boolean(p.tool_response?.is_error ?? p.tool_response?.error);
  const region = isTool ? regionForTool(p.tool_name, p.tool_input, failed) : regionForHook(hook);

  const signal: FireSignal = {
    region,
    tool: isTool ? (p.tool_name ?? null) : null,
    hook,
    sessionId: String(p.session_id ?? ''),
    project: projectFromCwd(p.cwd),
    intensity: hook === 'Stop' || hook === 'SessionEnd' ? 1 : isTool ? 0.7 : 0.5,
    ts: new Date().toISOString(),
  };
  broadcast({ type: 'fire', signal });

  if (typeof p.transcript_path === 'string') scheduleIngest(p.transcript_path, 400);
  return c.json({ ok: true });
});

app.get('/api/events', (c) => c.json(db.recentEvents(Math.min(Number(c.req.query('limit') ?? 100), 500))));
app.get('/api/sessions', (c) => c.json(db.sessions(Math.min(Number(c.req.query('limit') ?? 50), 200))));
app.get('/api/sessions/:id', (c) => c.json(db.sessionEvents(c.req.param('id'))));
app.get('/api/search', (c) => c.json(db.search(c.req.query('q') ?? '', Math.min(Number(c.req.query('limit') ?? 25), 100))));
app.get('/api/stats', (c) => c.json(db.stats()));

app.get('/api/categories', (c) => c.json(db.categories()));
app.get('/api/browse', (c) => c.json(db.browse(c.req.query('category') || undefined, Math.min(Number(c.req.query('limit') ?? 100), 300))));
app.get('/api/sessions/:id/summary', (c) => {
  const id = c.req.param('id');
  return c.json({ session: db.getSession(id) ?? null, summary: db.getSummary(id) ?? null });
});
app.post('/api/sessions/:id/summarize', async (c) => {
  const id = c.req.param('id');
  try {
    await summarizeSession(db, id);
    return c.json({ session: db.getSession(id) ?? null, summary: db.getSummary(id) ?? null });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// ---- projects: what am I working on, and where ---------------------------------

app.get('/api/projects', (c) => c.json(db.projects()));

app.get('/api/projects/:name', (c) => {
  const name = c.req.param('name');
  const sessions = db.projectSessions(name);
  if (sessions.length === 0) return c.json({ error: 'unknown project' }, 404);
  const j = (v: string | null): string[] => { try { return v ? (JSON.parse(v) as string[]) : []; } catch { return []; } };

  const tagCounts = new Map<string, number>();
  const files = new Map<string, number>();
  for (const s of sessions) {
    for (const t of j(s.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    for (const f of j(s.files)) files.set(f, (files.get(f) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

  const cached = db.getProfile(name);
  return c.json({
    name,
    dir: resolveProjectDir(db, name),
    canEdit: canEdit(name),
    sessions: sessions.map((s) => ({
      id: s.id, started_at: s.started_at, last_at: s.last_at, events: s.event_count,
      title: s.title, first_prompt: s.first_prompt, summary: s.summary, category: s.category, tags: j(s.tags),
    })),
    tags: top(tagCounts, 12),
    files: top(files, 8),
    recentPrompts: db.projectPrompts(name, 6),
    profile: cached
      ? { ...(cached.profile as object), created_at: cached.created_at, stale: sessions.length > cached.session_count }
      : null,
  });
});

/**
 * Prompt Claude about a project from inside Cortex. Runs Claude Code headless in the project's folder,
 * seeded with what Cortex knows about the project, and streams the reply (SSE).
 */
app.post('/api/projects/:name/chat', async (c) => {
  if (c.req.header('x-cortex-client') !== 'web') return c.json({ error: 'forbidden' }, 403);
  const name = c.req.param('name');
  const body = (await c.req.json().catch(() => null)) as { prompt?: string; sessionId?: string; mode?: ChatMode } | null;
  const prompt = body?.prompt?.trim();
  if (!prompt) return c.json({ error: 'prompt required' }, 400);
  const mode: ChatMode = body?.mode === 'edit' ? 'edit' : 'ask';
  if (mode === 'edit' && !canEdit(name)) return c.json({ error: `Editing is disabled for "${name}" (not a real project folder).` }, 403);
  const dir = resolveProjectDir(db, name);
  if (!dir) return c.json({ error: `Couldn't find a folder on disk for "${name}".` }, 404);
  const resume = Boolean(body?.sessionId && /^[0-9a-f-]{36}$/i.test(body.sessionId));
  const sessionId = resume ? body!.sessionId! : randomUUID();

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    for await (const ev of streamChat({ dir, prompt, sessionId, resume, mode, context: buildContext(db, name, dir), signal: ac.signal })) {
      await stream.writeSSE({ data: JSON.stringify(ev) });
    }
  });
});

app.post('/api/projects/:name/profile', async (c) => {
  try {
    const p = await getProfile(db, c.req.param('name'), true);
    return p ? c.json(p) : c.json({ error: 'unknown project' }, 404);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// ---- days: heatmap, per-day detail, digest, replay ---------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d: string) => DAY_RE.test(d);

app.get('/api/days', (c) => c.json(db.days(Math.min(Number(c.req.query('limit') ?? 120), 400))));

app.get('/api/day/:day', (c) => {
  const day = c.req.param('day');
  if (!validDay(day)) return c.json({ error: 'bad day' }, 400);
  const d = db.getDigest(day);
  return c.json({
    day,
    events: db.dayCount(day),
    sessions: db.daySessions(day),
    hourly: db.dayHourly(day),
    digest: d ? { text: d.digest, created_at: d.created_at, stale: db.dayCount(day) > d.event_count * 1.3 + 20 } : null,
  });
});

app.post('/api/day/:day/digest', async (c) => {
  const day = c.req.param('day');
  if (!validDay(day)) return c.json({ error: 'bad day' }, 400);
  try {
    return c.json(await getDigest(db, day, true));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

app.get('/api/day/:day/replay', (c) => {
  const day = c.req.param('day');
  if (!validDay(day)) return c.json({ error: 'bad day' }, 400);
  return c.json(db.dayReplay(day, REGIONS));
});

/** Ask Cortex: recall relevant memories, answer with citations, and light up the source regions. */
app.post('/api/ask', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { question?: string } | null;
  const question = body?.question?.trim();
  if (!question) return c.json({ error: 'question required' }, 400);
  const sig = (region: Region, intensity: number): FireSignal => ({
    region, tool: null, hook: 'Ask', sessionId: '', project: null, intensity, ts: new Date().toISOString(),
  });
  broadcast({ type: 'fire', signal: sig('hippocampus', 1) }); // recall begins
  try {
    const result = await askCortex(db, question);
    result.regions.forEach((r, i) => setTimeout(() => broadcast({ type: 'fire', signal: sig(r, 0.8) }), 250 + i * 160));
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// ---- background summarizer (opt out with CORTEX_AUTO_SUMMARIZE=0) -------------
if (process.env.CORTEX_AUTO_SUMMARIZE !== '0') {
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const since = new Date(Date.now() - 3 * 86_400_000).toISOString(); // only recent work; backlog is manual
      const r = await summarizePending(db, { limit: 2, concurrency: 1, sinceIso: since, log: (m) => console.log('[summarize]', m) });
      if (r.done) broadcast({ type: 'summaries', count: r.done });
    } catch (e) {
      console.error('[summarize]', e);
    } finally {
      running = false;
    }
  };
  setInterval(cycle, 5 * 60_000);
  setTimeout(cycle, 20_000);
}

// ---- server + websocket ----------------------------------------------------

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[cortex] daemon listening on http://${HOST}:${info.port}  (ws: /ws)`);
  void initialBackfill();
});

const wss = new WebSocketServer({ server: server as any, path: '/ws', verifyClient: ({ origin }: { origin?: string }) =>
  !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'hello', stats: db.stats() }));
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
