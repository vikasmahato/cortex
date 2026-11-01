import { regionForTool } from './regions.ts';
import { redact } from './redact.ts';
import type { CortexEvent } from './types.ts';

const MAX_TEXT = 4000;
const clean = (s: string) => {
  const r = redact(s);
  return r.length > MAX_TEXT ? r.slice(0, MAX_TEXT) + '…[truncated]' : r;
};

/** Folders that merely *contain* projects; the project is the next path segment. */
const CONTAINERS = new Set([
  'desktop', 'documents', 'downloads', 'projects', 'repos', 'source', 'dev', 'code', 'workspace', 'workspaces',
  'pycharmprojects', 'studioprojects', 'androidstudioprojects', 'webstormprojects', 'intellijprojects', 'rubymineprojects',
]);

/**
 * Map a working directory to the project it belongs to, so sub-folders
 * (`proj\data\parsed`, `StockBot\data\work\XOM`) roll up into one project.
 * Pure and deterministic: no filesystem access.
 */
export function projectFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const segs = cwd.replace(/\//g, '\\').split('\\').filter(Boolean);
  if (segs.length === 0) return null;
  const lower = segs.map((s) => s.toLowerCase());

  if (lower.includes('appdata')) {
    return lower.includes('scratch-workspaces') ? 'Claude scratch' : lower.includes('temp') ? 'Scratch' : 'App data';
  }
  if (lower[1] === 'windows') return 'System';

  const i = lower.findIndex((s, idx) => idx >= 1 && CONTAINERS.has(s));
  if (i >= 0) return segs[i + 1] ?? segs[i]!;

  if (lower[1] === 'users' && segs.length <= 3) return 'Home folder'; // C:\Users\<name> itself

  // loose folders on a drive root, e.g. D:\neha_projects, D:\New folder\Videos
  const first = segs[1];
  if (first && /^new folder/i.test(first)) return segs[2] ?? 'Unsorted files';
  return first ?? segs[0] ?? null;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : ((c as Block)?.text ?? ''))).join('\n');
  }
  return '';
}

function describeToolUse(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const key = i.file_path ?? i.command ?? i.pattern ?? i.query ?? i.url ?? i.prompt ?? i.description;
  return key ? `${name}: ${String(key)}` : name;
}

const isNoise = (s: string) => s.startsWith('<system-reminder>') || s.startsWith('<command-') || s.startsWith('<local-command');

/** Normalize one parsed transcript JSONL line into zero or more events. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeTranscriptLine(line: Record<string, any>): CortexEvent[] {
  const type = line.type;
  if ((type !== 'user' && type !== 'assistant') || !line.message || !line.uuid || !line.sessionId) return [];

  const base = {
    sessionId: String(line.sessionId),
    ts: String(line.timestamp ?? new Date().toISOString()),
    isSidechain: Boolean(line.isSidechain),
    cwd: (line.cwd as string) ?? null,
    project: projectFromCwd(line.cwd),
    branch: (line.gitBranch as string) ?? null,
  };
  const out: CortexEvent[] = [];
  const content = line.message.content;

  if (type === 'user') {
    if (line.isMeta) return [];
    if (typeof content === 'string') {
      if (isNoise(content)) return [];
      out.push({ ...base, key: `${line.uuid}:0`, kind: 'prompt', region: 'temporal', tool: null, text: clean(content), isError: false });
    } else if (Array.isArray(content)) {
      (content as Block[]).forEach((b, idx) => {
        if (b.type === 'text' && b.text && !isNoise(b.text)) {
          out.push({ ...base, key: `${line.uuid}:${idx}`, kind: 'prompt', region: 'temporal', tool: null, text: clean(b.text), isError: false });
        } else if (b.type === 'tool_result') {
          const isError = Boolean(b.is_error);
          out.push({
            ...base, key: `${line.uuid}:${idx}`, kind: 'tool_result',
            region: isError ? 'amygdala' : 'occipital', tool: null,
            text: clean(blockText(b.content)), isError,
          });
        }
      });
    }
    return out;
  }

  if (!Array.isArray(content)) return [];
  (content as Block[]).forEach((b, idx) => {
    const key = `${line.uuid}:${idx}`;
    if (b.type === 'text' && b.text?.trim()) {
      out.push({ ...base, key, kind: 'reply', region: 'temporal', tool: null, text: clean(b.text), isError: false });
    } else if (b.type === 'thinking' && b.thinking?.trim()) {
      out.push({ ...base, key, kind: 'thinking', region: 'prefrontal', tool: null, text: clean(b.thinking), isError: false });
    } else if (b.type === 'tool_use' && b.name) {
      out.push({
        ...base, key, kind: 'tool_use', region: regionForTool(b.name, b.input), tool: b.name,
        text: clean(describeToolUse(b.name, b.input)), isError: false,
      });
    }
  });
  return out;
}

/** Locations that say little about what the work was; real projects outrank them, and Cortex won't edit in them. */
export const WEAK_PROJECTS = ['Home folder', 'System', 'Scratch', 'Claude scratch', 'App data', 'Unsorted files'];

/**
 * The folder a project lives in (the path counterpart of `projectFromCwd`), or null when the
 * location is not a real project folder (system/app-data/scratch).
 */
export function projectRoot(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const segs = cwd.replace(/\//g, '\\').split('\\').filter(Boolean);
  if (segs.length === 0) return null;
  const lower = segs.map((s) => s.toLowerCase());
  if (lower.includes('appdata') || lower[1] === 'windows') return null;

  const i = lower.findIndex((s, idx) => idx >= 1 && CONTAINERS.has(s));
  if (i >= 0) return segs.slice(0, i + 2).join('\\') || null;
  if (lower[1] === 'users' && segs.length <= 3) return segs.join('\\');
  if (segs[1] && /^new folder/i.test(segs[1])) return segs.slice(0, 3).join('\\');
  return segs.slice(0, 2).join('\\');
}
