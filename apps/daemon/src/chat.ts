import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { WEAK_PROJECTS, projectRoot } from '@cortex/core';
import type { CortexDB } from '@cortex/db';

export type ChatMode = 'ask' | 'edit';

export type ChatEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'done'; ok: boolean; text?: string; costUsd?: number; ms?: number }
  | { type: 'error'; message: string };

/** The project's folder on disk: the most-used project root that still exists. */
export function resolveProjectDir(db: CortexDB, name: string): string | null {
  const tally = new Map<string, number>();
  for (const { cwd, n } of db.projectCwds(name)) {
    const root = projectRoot(cwd);
    if (root) tally.set(root, (tally.get(root) ?? 0) + n);
  }
  for (const [root] of [...tally].sort((a, b) => b[1] - a[1])) if (existsSync(root)) return root;
  return null;
}

export const canEdit = (name: string) => !WEAK_PROJECTS.includes(name);

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Background Claude gets about the project, from Cortex's own memory of the user's work. */
export function buildContext(db: CortexDB, name: string, dir: string): string {
  const parts = [
    `You are being used from Cortex, the user's personal second-brain app, inside their project "${name}" (folder: ${dir}).`,
    'Below is background from their history with Claude Code. Treat it as hints and verify against the actual files before relying on it.',
  ];
  const cached = db.getProfile(name)?.profile as
    | { description?: string; threads?: { name: string; status: string; summary: string }[]; open_items?: string[] }
    | undefined;
  if (cached?.description) parts.push(`Overview: ${cached.description}`);
  if (cached?.threads?.length) {
    parts.push('Threads of work:\n' + cached.threads.map((t) => `- ${t.name} [${t.status}]: ${t.summary}`).join('\n'));
  }
  if (cached?.open_items?.length) parts.push('Still open:\n' + cached.open_items.map((o) => `- ${o}`).join('\n'));
  const recent = db.projectSessions(name).slice(0, 6).filter((s) => s.title);
  if (recent.length) parts.push('Recent sessions:\n' + recent.map((s) => `- ${s.last_at.slice(0, 10)}: ${s.title}`).join('\n'));
  return clip(parts.join('\n\n'), 4000);
}

const describeTool = (name: string, input: Record<string, unknown> | undefined) => {
  const v = input?.file_path ?? input?.pattern ?? input?.path ?? input?.command ?? '';
  return clip(String(v), 140);
};

/**
 * Run Claude Code headless inside a project's folder and stream what it does.
 * - "ask" mode restricts Claude to read-only tools (Read/Grep/Glob) — it cannot change anything.
 * - "edit" mode additionally allows Edit/Write (auto-accepted). Shell commands are never enabled.
 * Sessions are persisted normally, so Cortex captures them like any other work in the project.
 */
export async function* streamChat(o: {
  dir: string;
  prompt: string;
  sessionId: string;
  resume: boolean;
  mode: ChatMode;
  context: string;
  signal: AbortSignal;
}): AsyncGenerator<ChatEvent> {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    o.resume ? '--resume' : '--session-id', o.sessionId,
    '--append-system-prompt', o.context,
    '--tools', o.mode === 'edit' ? 'Read,Grep,Glob,Edit,Write' : 'Read,Grep,Glob',
    '--permission-mode', o.mode === 'edit' ? 'acceptEdits' : 'default',
  ];
  const child = spawn('claude', args, { cwd: o.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const kill = () => child.kill();
  o.signal.addEventListener('abort', kill);
  const timer = setTimeout(kill, 15 * 60_000);
  const exited = new Promise<number | null>((res) => child.on('close', res));
  child.on('error', () => {});
  child.stdin.end(o.prompt);

  yield { type: 'session', sessionId: o.sessionId };
  let sawText = false;
  let finished = false;

  try {
    for await (const line of createInterface({ input: child.stdout })) {
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'text' && b.text?.trim()) { sawText = true; yield { type: 'text', text: b.text }; }
          else if (b.type === 'tool_use') yield { type: 'tool', name: b.name, detail: describeTool(b.name, b.input) };
        }
      } else if (ev.type === 'result') {
        finished = true;
        yield {
          type: 'done', ok: !ev.is_error, text: sawText ? undefined : ev.result,
          costUsd: ev.total_cost_usd, ms: ev.duration_ms,
        };
      }
    }
    const code = await exited;
    if (!finished) {
      yield { type: 'error', message: o.signal.aborted ? 'Stopped.' : stderr.trim().slice(0, 400) || `claude exited with code ${code}` };
    }
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener('abort', kill);
    child.kill();
  }
}
