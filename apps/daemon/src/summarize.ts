import type { CortexDB } from '@cortex/db';
import { complete, extractJson } from './llm.ts';

export const CATEGORIES = [
  'Coding', 'Debugging', 'Architecture & Planning', 'Research', 'Writing & Docs',
  'DevOps & Shell', 'Data & Analysis', 'Learning', 'Ideas', 'Automation', 'Misc',
] as const;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const MAX_INPUT = 14_000;

/** Condense a session into a compact transcript an LLM can summarize cheaply. */
export function buildSessionDigest(db: CortexDB, sessionId: string): string | null {
  const session = db.getSession(sessionId);
  if (!session) return null;
  const events = db.sessionEventsForSummary(sessionId);
  const lines: string[] = [];
  const toolCounts = new Map<string, number>();
  const files = new Set<string>();

  for (const e of events) {
    if (e.kind === 'prompt') lines.push(`USER: ${clip(e.text, 700)}`);
    else if (e.kind === 'reply') lines.push(`CLAUDE: ${clip(e.text, 450)}`);
    else if (e.kind === 'tool_use' && e.tool) {
      toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1);
      const m = /^(?:Read|Edit|Write|MultiEdit|NotebookEdit): (.+)$/.exec(e.text);
      if (m) files.add(m[1]!.split(/[\\/]/).slice(-2).join('/'));
    } else if (e.kind === 'tool_result' && e.is_error) lines.push(`(tool error: ${clip(e.text, 120)})`);
  }

  // keep the beginning and the end when over budget; the middle is least informative
  let body = lines.join('\n');
  if (body.length > MAX_INPUT) {
    const half = MAX_INPUT / 2;
    body = body.slice(0, half) + '\n…[middle omitted]…\n' + body.slice(-half);
  }
  const tools = [...toolCounts].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(', ');
  return [
    `Project: ${session.project ?? 'unknown'}  Branch: ${session.branch ?? '-'}`,
    `Span: ${session.started_at} → ${session.last_at}`,
    `Tools used: ${tools || 'none'}`,
    `Files touched: ${[...files].slice(0, 25).join(', ') || 'none'}`,
    '',
    body,
  ].join('\n');
}

const PROMPT = (digest: string) => `You are the memory-indexer for a personal "second brain". Below is a condensed log of one working session between a user and Claude Code. Summarize it so the user can recall it months later.

Return ONLY a JSON object, no prose, with exactly these keys:
{
  "title": "5-9 word specific title",
  "summary": "2-4 sentences: what the user wanted, what was done, and the outcome/state",
  "category": one of ${JSON.stringify(CATEGORIES)},
  "tags": ["3-6 lowercase keywords: technologies, topics, project names"],
  "decisions": ["concrete decisions or choices made, with the reason (max 5, may be empty)"],
  "learnings": ["non-obvious facts, fixes or gotchas worth remembering (max 5, may be empty)"],
  "files": ["most important files or artifacts (max 8, may be empty)"]
}

Session log:
${digest}`;

interface Raw {
  title?: string; summary?: string; category?: string;
  tags?: string[]; decisions?: string[]; learnings?: string[]; files?: string[];
}
const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, n).map((x) => clip(String(x), 300)) : []);

export async function summarizeSession(db: CortexDB, sessionId: string): Promise<boolean> {
  const digest = buildSessionDigest(db, sessionId);
  const session = db.getSession(sessionId);
  if (!digest || !session) return false;
  const raw = extractJson<Raw>(await complete(PROMPT(digest), 'fast'));
  if (!raw.title || !raw.summary) throw new Error('summary missing title/summary');
  const category = (CATEGORIES as readonly string[]).includes(raw.category ?? '') ? raw.category! : 'Misc';
  db.saveSummary({
    session_id: sessionId,
    title: clip(raw.title, 120),
    summary: clip(raw.summary, 1200),
    category,
    tags: strs(raw.tags, 6).map((t) => t.toLowerCase()),
    decisions: strs(raw.decisions, 5),
    learnings: strs(raw.learnings, 5),
    files: strs(raw.files, 8),
    event_count: session.event_count,
    model: 'haiku',
  });
  return true;
}

/** Summarize a batch of pending sessions with bounded concurrency. */
export async function summarizePending(
  db: CortexDB,
  opts: { limit: number; concurrency?: number; minIdleMinutes?: number; minEvents?: number; sinceIso?: string; log?: (m: string) => void },
) {
  const todo = db.sessionsNeedingSummary({
    limit: opts.limit, minIdleMinutes: opts.minIdleMinutes ?? 15, minEvents: opts.minEvents ?? 6, sinceIso: opts.sinceIso,
  });
  const log = opts.log ?? (() => {});
  let done = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const s = todo[i++]!;
      try {
        await summarizeSession(db, s.id);
        done++;
        log(`  ✓ ${s.project ?? '?'} ${s.id.slice(0, 8)} (${done + failed}/${todo.length})`);
      } catch (e) {
        failed++;
        log(`  ✗ ${s.id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 2, todo.length) }, worker));
  return { total: todo.length, done, failed };
}
