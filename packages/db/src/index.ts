import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { WEAK_PROJECTS, type CortexEvent, type Region } from '@cortex/core';

export const CORTEX_HOME = process.env.CORTEX_HOME ?? join(homedir(), '.cortex');
export const DB_PATH = join(CORTEX_HOME, 'cortex.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 8000;

CREATE TABLE IF NOT EXISTS project_profiles (
  name          TEXT PRIMARY KEY,
  profile       TEXT NOT NULL,
  session_count INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  session_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  region      TEXT NOT NULL,
  tool        TEXT,
  text        TEXT NOT NULL,
  is_error    INTEGER NOT NULL DEFAULT 0,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  cwd         TEXT,
  project     TEXT,
  branch      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  project     TEXT,
  cwd         TEXT,
  branch      TEXT,
  started_at  TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  title       TEXT
);

CREATE TABLE IF NOT EXISTS files (
  path   TEXT PRIMARY KEY,
  offset INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text, content='events', content_rowid='id', tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS session_summaries (
  session_id  TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  category    TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  decisions   TEXT NOT NULL DEFAULT '[]',
  learnings   TEXT NOT NULL DEFAULT '[]',
  files       TEXT NOT NULL DEFAULT '[]',
  event_count INTEGER NOT NULL,
  model       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_category ON session_summaries(category);
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  session_id UNINDEXED, title, summary, tags, decisions, learnings, tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS day_digests (
  day         TEXT PRIMARY KEY,
  digest      TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

export interface EventRow {
  id: number; key: string; session_id: string; ts: string; kind: string; region: Region;
  tool: string | null; text: string; is_error: number; project: string | null;
}

export interface SessionSummary {
  session_id: string; title: string; summary: string; category: string;
  tags: string[]; decisions: string[]; learnings: string[]; files: string[];
  event_count: number; model: string | null; created_at: string;
}

/** SQL expression: the event's calendar day in the machine's local timezone (YYYY-MM-DD). */
const LOCAL_DAY = "substr(datetime(ts, 'localtime'), 1, 10)";

const STOP = new Set(
  'the and for with that this what when where which who why how did does was were are you your our about from have has had into then than them they there their been being would could should can will just like also not but all any some more most over under again once here very much many what\'s i\'m'.split(' '),
);

/** Natural-language question -> FTS5 query: significant terms, prefix-matched, OR-combined. */
const toFtsOr = (q: string) =>
  [...new Set(q.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])]
    .filter((t) => !STOP.has(t))
    .slice(0, 12)
    .map((t) => `"${t}"*`)
    .join(' OR ');

export class CortexDB {
  readonly db: DatabaseSync;

  constructor(path = DB_PATH) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  /** Insert events in a single transaction. Returns only the events that were new. */
  insertEvents(events: CortexEvent[]): CortexEvent[] {
    if (!events.length) return [];
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO events
       (key, session_id, ts, kind, region, tool, text, is_error, is_sidechain, cwd, project, branch)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const touch = this.db.prepare(
      `INSERT INTO sessions (id, project, cwd, branch, started_at, last_at, event_count, title)
       VALUES (?,?,?,?,?,?,1,?)
       ON CONFLICT(id) DO UPDATE SET
         event_count = event_count + 1,
         started_at = MIN(started_at, excluded.started_at),
         last_at = MAX(last_at, excluded.last_at),
         project = COALESCE(sessions.project, excluded.project),
         cwd = COALESCE(sessions.cwd, excluded.cwd),
         branch = COALESCE(excluded.branch, sessions.branch),
         title = COALESCE(sessions.title, excluded.title)`,
    );
    const fresh: CortexEvent[] = [];
    this.db.exec('BEGIN');
    try {
      for (const e of events) {
        const r = ins.run(
          e.key, e.sessionId, e.ts, e.kind, e.region, e.tool, e.text,
          e.isError ? 1 : 0, e.isSidechain ? 1 : 0, e.cwd, e.project, e.branch,
        );
        if (Number(r.changes) > 0) {
          fresh.push(e);
          const title = e.kind === 'prompt' && !e.isSidechain ? e.text.slice(0, 120) : null;
          touch.run(e.sessionId, e.project, e.cwd, e.branch, e.ts, e.ts, title);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (fresh.length) this.refreshSessionProjects([...new Set(fresh.map((e) => e.sessionId))]);
    return fresh;
  }

  getOffset(path: string): number {
    const row = this.db.prepare('SELECT offset FROM files WHERE path = ?').get(path) as { offset: number } | undefined;
    return row?.offset ?? 0;
  }

  setOffset(path: string, offset: number): void {
    this.db
      .prepare('INSERT INTO files (path, offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset')
      .run(path, offset);
  }

  recentEvents(limit = 100): EventRow[] {
    return this.db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit) as unknown as EventRow[];
  }

  sessions(limit = 50) {
    return this.db.prepare('SELECT * FROM sessions ORDER BY last_at DESC LIMIT ?').all(limit);
  }

  sessionEvents(sessionId: string) {
    return this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY ts').all(sessionId);
  }

  search(query: string, limit = 25) {
    const q = query.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean).map((t) => `${t}*`).join(' ');
    if (!q) return [];
    return this.db
      .prepare(
        `SELECT e.id, e.session_id, e.ts, e.kind, e.region, e.tool, e.project,
                snippet(events_fts, 0, '[', ']', '…', 24) AS snippet
         FROM events_fts JOIN events e ON e.id = events_fts.rowid
         WHERE events_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(q, limit);
  }

  /** Sessions with no summary (or new activity since) that have been idle for a while. */
  sessionsNeedingSummary(opts: { limit: number; minIdleMinutes: number; minEvents: number; sinceIso?: string }) {
    const cutoff = new Date(Date.now() - opts.minIdleMinutes * 60_000).toISOString();
    return this.db
      .prepare(
        `SELECT s.id, s.project, s.event_count, s.last_at
         FROM sessions s LEFT JOIN session_summaries m ON m.session_id = s.id
         WHERE s.event_count >= ? AND s.last_at <= ? AND s.last_at >= ?
           AND (m.session_id IS NULL OR s.event_count > m.event_count * 1.5 + 10)
         ORDER BY s.last_at DESC LIMIT ?`,
      )
      .all(opts.minEvents, cutoff, opts.sinceIso ?? "0000", opts.limit) as { id: string; project: string | null; event_count: number; last_at: string }[];
  }

  getSession(id: string) {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | { id: string; project: string | null; cwd: string | null; branch: string | null; started_at: string; last_at: string; event_count: number; title: string | null }
      | undefined;
  }

  /** Non-sidechain events of a session, oldest first (used to build summary input). */
  sessionEventsForSummary(id: string) {
    return this.db
      .prepare("SELECT ts, kind, tool, text, is_error FROM events WHERE session_id = ? AND is_sidechain = 0 ORDER BY ts")
      .all(id) as { ts: string; kind: string; tool: string | null; text: string; is_error: number }[];
  }

  saveSummary(s: Omit<SessionSummary, "created_at">) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO session_summaries (session_id,title,summary,category,tags,decisions,learnings,files,event_count,model,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, summary=excluded.summary, category=excluded.category,
             tags=excluded.tags, decisions=excluded.decisions, learnings=excluded.learnings, files=excluded.files,
             event_count=excluded.event_count, model=excluded.model, created_at=excluded.created_at`,
        )
        .run(s.session_id, s.title, s.summary, s.category, JSON.stringify(s.tags), JSON.stringify(s.decisions),
          JSON.stringify(s.learnings), JSON.stringify(s.files), s.event_count, s.model, now);
      this.db.prepare("DELETE FROM summaries_fts WHERE session_id = ?").run(s.session_id);
      this.db
        .prepare("INSERT INTO summaries_fts (session_id,title,summary,tags,decisions,learnings) VALUES (?,?,?,?,?,?)")
        .run(s.session_id, s.title, s.summary, s.tags.join(" "), s.decisions.join(" "), s.learnings.join(" "));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private parseSummary(r: Record<string, any>): SessionSummary {
    const j = (v: string) => { try { return JSON.parse(v) as string[]; } catch { return []; } };
    return { ...r, tags: j(r.tags), decisions: j(r.decisions), learnings: j(r.learnings), files: j(r.files) } as SessionSummary;
  }

  getSummary(id: string): SessionSummary | undefined {
    const r = this.db.prepare("SELECT * FROM session_summaries WHERE session_id = ?").get(id);
    return r ? this.parseSummary(r) : undefined;
  }

  /** Sessions joined with their summaries; category "Unsorted" = not yet summarized. */
  browse(category?: string, limit = 100) {
    const where = !category ? "" : category === "Unsorted" ? "WHERE m.session_id IS NULL" : "WHERE m.category = ?";
    const rows = this.db
      .prepare(
        `SELECT s.id, s.project, s.branch, s.started_at, s.last_at, s.event_count, s.title AS first_prompt,
                m.title, m.summary, m.category, m.tags
         FROM sessions s LEFT JOIN session_summaries m ON m.session_id = s.id
         ${where} ORDER BY s.last_at DESC LIMIT ?`,
      )
      .all(...(where.includes("?") ? [category!, limit] : [limit])) as Record<string, any>[];
    return rows.map((r) => ({ ...r, tags: r.tags ? (JSON.parse(r.tags) as string[]) : [] }));
  }

  categories() {
    return this.db
      .prepare(
        `SELECT COALESCE(m.category, 'Unsorted') AS category, COUNT(*) AS n
         FROM sessions s LEFT JOIN session_summaries m ON m.session_id = s.id GROUP BY 1 ORDER BY n DESC`,
      )
      .all() as { category: string; n: number }[];
  }

  /** Recall retrieval: BM25 over summaries and raw events, OR-combined terms. */
  recall(question: string, opts = { summaries: 8, events: 14 }) {
    const q = toFtsOr(question);
    if (!q) return { summaries: [] as (SessionSummary & { rank: number })[], events: [] as any[] };
    const sums = this.db
      .prepare(
        `SELECT m.*, bm25(summaries_fts, 0, 6, 3, 4, 2, 2) AS rank FROM summaries_fts f
         JOIN session_summaries m ON m.session_id = f.session_id WHERE summaries_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(q, opts.summaries)
      .map((r) => ({ ...this.parseSummary(r as any), rank: (r as any).rank as number }));
    const events = this.db
      .prepare(
        `SELECT e.id, e.session_id, e.ts, e.kind, e.region, e.tool, e.project, e.text, bm25(events_fts) AS rank
         FROM events_fts JOIN events e ON e.id = events_fts.rowid
         WHERE events_fts MATCH ? AND e.kind IN ('prompt','reply','thinking') ORDER BY rank LIMIT ?`,
      )
      .all(q, opts.events);
    return { summaries: sums, events };
  }

  dominantRegions(sessionId: string, top = 2) {
    return this.db
      .prepare("SELECT region, COUNT(*) AS n FROM events WHERE session_id = ? GROUP BY region ORDER BY n DESC LIMIT ?")
      .all(sessionId, top) as { region: Region; n: number }[];
  }

  /**
   * Re-derive every event's project from its cwd (events carry their own cwd as the user
   * moves between folders), then recompute each session's project. Idempotent; runs on startup.
   */
  reproject(fn: (cwd: string | null) => string | null): number {
    const cwds = this.db.prepare('SELECT DISTINCT cwd FROM events').all() as { cwd: string | null }[];
    const upE = this.db.prepare('UPDATE events SET project = ? WHERE cwd IS ? AND project IS NOT ?');
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const { cwd } of cwds) changed += Number(upE.run(fn(cwd), cwd, fn(cwd)).changes);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.refreshSessionProjects();
    return changed;
  }

  /**
   * A session belongs to the project where most of its work happened. Generic locations
   * (home folder, scratch dirs) only win if nothing else was touched.
   */
  refreshSessionProjects(ids?: string[]) {
    const weak = WEAK_PROJECTS.map((w) => `'${w}'`).join(',');
    const sql = `UPDATE sessions SET project = COALESCE(
        (SELECT e.project FROM events e WHERE e.session_id = sessions.id AND e.project IS NOT NULL
         GROUP BY e.project ORDER BY (e.project IN (${weak})) ASC, COUNT(*) DESC LIMIT 1), project)`;
    if (!ids) return void this.db.exec(sql);
    const stmt = this.db.prepare(sql + ' WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }

  /** One row per project with recency, volume, a 14-day sparkline and region mix. */
  projects(sparkDays = 14) {
    const base = this.db
      .prepare(
        `SELECT s.project AS name, COUNT(*) AS sessions, SUM(s.event_count) AS events,
                MIN(s.started_at) AS first_at, MAX(s.last_at) AS last_at,
                SUM(CASE WHEN m.session_id IS NOT NULL THEN 1 ELSE 0 END) AS summarized
         FROM sessions s LEFT JOIN session_summaries m ON m.session_id = s.id
         WHERE s.project IS NOT NULL GROUP BY s.project ORDER BY last_at DESC`,
      )
      .all() as { name: string; sessions: number; events: number; first_at: string; last_at: string; summarized: number }[];

    const since = new Date(Date.now() - sparkDays * 86_400_000).toISOString();
    const dayRows = this.db
      .prepare(
        `SELECT s.project AS project, ${LOCAL_DAY.replace('ts', 'e.ts')} AS day, COUNT(*) AS n
         FROM events e JOIN sessions s ON s.id = e.session_id
         WHERE s.project IS NOT NULL AND e.ts >= ? GROUP BY s.project, day`,
      )
      .all(since) as { project: string; day: string; n: number }[];
    const regRows = this.db
      .prepare(
        `SELECT s.project AS project, e.region AS region, COUNT(*) AS n
         FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.project IS NOT NULL GROUP BY s.project, e.region`,
      )
      .all() as { project: string; region: string; n: number }[];
    const latest = this.db
      .prepare(
        `SELECT s.project, COALESCE(m.title, s.title) AS title, s.last_at
         FROM sessions s LEFT JOIN session_summaries m ON m.session_id = s.id
         WHERE s.project IS NOT NULL ORDER BY s.last_at DESC`,
      )
      .all() as { project: string; title: string | null }[];

    const days = Array.from({ length: sparkDays }, (_, i) => {
      const d = new Date(Date.now() - (sparkDays - 1 - i) * 86_400_000);
      return d.toLocaleDateString('en-CA');
    });
    const spark = new Map<string, Map<string, number>>();
    for (const r of dayRows) (spark.get(r.project) ?? spark.set(r.project, new Map()).get(r.project)!).set(r.day, r.n);
    const mix = new Map<string, Record<string, number>>();
    for (const r of regRows) (mix.get(r.project) ?? mix.set(r.project, {}).get(r.project)!)[r.region] = r.n;
    const latestTitle = new Map<string, string | null>();
    for (const r of latest) if (!latestTitle.has(r.project)) latestTitle.set(r.project, r.title);

    return base.map((p) => ({
      ...p,
      spark: days.map((d) => spark.get(p.name)?.get(d) ?? 0),
      regionMix: mix.get(p.name) ?? {},
      latestTitle: latestTitle.get(p.name) ?? null,
    }));
  }

  projectSessions(name: string) {
    return this.db
      .prepare(
        `SELECT s.id, s.started_at, s.last_at, s.event_count, s.title AS first_prompt,
                m.title, m.summary, m.category, m.tags, m.decisions, m.learnings, m.files
         FROM sessions s LEFT JOIN session_summaries m ON m.session_id = s.id
         WHERE s.project = ? ORDER BY s.last_at DESC`,
      )
      .all(name) as {
      id: string; started_at: string; last_at: string; event_count: number; first_prompt: string | null;
      title: string | null; summary: string | null; category: string | null;
      tags: string | null; decisions: string | null; learnings: string | null; files: string | null;
    }[];
  }

  projectPrompts(name: string, limit = 8) {
    return this.db
      .prepare(
        `SELECT e.ts, e.text FROM events e JOIN sessions s ON s.id = e.session_id
         WHERE s.project = ? AND e.kind = 'prompt' AND e.is_sidechain = 0 ORDER BY e.ts DESC LIMIT ?`,
      )
      .all(name, limit) as { ts: string; text: string }[];
  }

  /** Working directories used in a project's sessions, most-used first (to find its folder on disk). */
  projectCwds(name: string) {
    return this.db
      .prepare(
        `SELECT e.cwd AS cwd, COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id
         WHERE s.project = ? AND e.cwd IS NOT NULL GROUP BY e.cwd ORDER BY n DESC`,
      )
      .all(name) as { cwd: string; n: number }[];
  }

  getProfile(name: string) {
    const r = this.db.prepare('SELECT * FROM project_profiles WHERE name = ?').get(name) as
      | { name: string; profile: string; session_count: number; created_at: string }
      | undefined;
    return r ? { profile: JSON.parse(r.profile) as unknown, session_count: r.session_count, created_at: r.created_at } : undefined;
  }

  saveProfile(name: string, profile: unknown, sessionCount: number) {
    this.db
      .prepare(
        `INSERT INTO project_profiles (name, profile, session_count, created_at) VALUES (?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET profile=excluded.profile, session_count=excluded.session_count, created_at=excluded.created_at`,
      )
      .run(name, JSON.stringify(profile), sessionCount, new Date().toISOString());
  }

  /** Activity per local day, for the heatmap. */
  days(limit = 120) {
    return this.db
      .prepare(
        `SELECT ${LOCAL_DAY} AS day, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions
         FROM events GROUP BY day ORDER BY day DESC LIMIT ?`,
      )
      .all(limit) as { day: string; n: number; sessions: number }[];
  }

  /** Events per local hour and region for one day (stacked hourly chart). */
  dayHourly(day: string) {
    return this.db
      .prepare(
        `SELECT CAST(substr(datetime(ts,'localtime'), 12, 2) AS INTEGER) AS hour, region, COUNT(*) AS n
         FROM events WHERE ${LOCAL_DAY} = ? GROUP BY hour, region`,
      )
      .all(day) as { hour: number; region: Region; n: number }[];
  }

  /** Sessions that had activity on a local day, with summaries where available. */
  daySessions(day: string) {
    return this.db
      .prepare(
        `SELECT e.session_id AS id, s.project AS project, COUNT(*) AS n,
                MIN(e.ts) AS first_ts, MAX(e.ts) AS last_ts,
                m.title, m.summary, m.category, s.title AS first_prompt
         FROM events e
         JOIN sessions s ON s.id = e.session_id
         LEFT JOIN session_summaries m ON m.session_id = e.session_id
         WHERE ${LOCAL_DAY.replace('ts', 'e.ts')} = ?
         GROUP BY e.session_id ORDER BY first_ts`,
      )
      .all(day) as {
      id: string; project: string | null; n: number; first_ts: string; last_ts: string;
      title: string | null; summary: string | null; category: string | null; first_prompt: string | null;
    }[];
  }

  /** User prompts on a day (for the digest). */
  dayPrompts(day: string, limit = 40) {
    return this.db
      .prepare(
        `SELECT ts, project, text FROM events WHERE kind = 'prompt' AND is_sidechain = 0 AND ${LOCAL_DAY} = ?
         ORDER BY ts LIMIT ?`,
      )
      .all(day, limit) as { ts: string; project: string | null; text: string }[];
  }

  /** Compact [epoch_ms, region_index] pairs for replay. */
  dayReplay(day: string, regions: readonly string[], limit = 30000) {
    const rows = this.db
      .prepare(`SELECT ts, region FROM events WHERE ${LOCAL_DAY} = ? ORDER BY ts LIMIT ?`)
      .all(day, limit) as { ts: string; region: string }[];
    return rows.map((r) => [Date.parse(r.ts), regions.indexOf(r.region)] as [number, number]);
  }

  dayCount(day: string) {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${LOCAL_DAY} = ?`).get(day) as { n: number }).n;
  }

  getDigest(day: string) {
    return this.db.prepare('SELECT * FROM day_digests WHERE day = ?').get(day) as
      | { day: string; digest: string; event_count: number; created_at: string }
      | undefined;
  }

  saveDigest(day: string, digest: string, eventCount: number) {
    this.db
      .prepare(
        `INSERT INTO day_digests (day, digest, event_count, created_at) VALUES (?,?,?,?)
         ON CONFLICT(day) DO UPDATE SET digest=excluded.digest, event_count=excluded.event_count, created_at=excluded.created_at`,
      )
      .run(day, digest, eventCount, new Date().toISOString());
  }

  stats() {
    const byRegion = this.db.prepare('SELECT region, COUNT(*) AS n FROM events GROUP BY region').all();
    const byProject = this.db
      .prepare('SELECT project, COUNT(*) AS n FROM events WHERE project IS NOT NULL GROUP BY project ORDER BY n DESC LIMIT 20')
      .all();
    const byDay = this.db
      .prepare(`SELECT ${LOCAL_DAY} AS day, COUNT(*) AS n FROM events GROUP BY day ORDER BY day DESC LIMIT 60`)
      .all();
    const totals = this.db
      .prepare('SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM sessions) AS sessions')
      .get();
    return { totals, byRegion, byProject, byDay };
  }

  close() {
    this.db.close();
  }
}
