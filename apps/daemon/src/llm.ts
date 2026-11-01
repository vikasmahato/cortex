import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { CORTEX_HOME } from '@cortex/db';

export type ModelTier = 'fast' | 'smart';

const API_MODELS: Record<ModelTier, string> = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' };
const CLI_MODELS: Record<ModelTier, string> = { fast: 'haiku', smart: 'sonnet' };

/**
 * One-shot text completion. Uses the Anthropic API when ANTHROPIC_API_KEY is set,
 * otherwise falls back to the user's logged-in `claude` CLI in headless mode so
 * no separate key is needed.
 *
 * CLI calls run with --no-session-persistence (nothing lands in ~/.claude/projects,
 * so Cortex never ingests its own prompts) and CORTEX_INTERNAL=1 (the capture hook
 * ignores them).
 */
export async function complete(prompt: string, tier: ModelTier = 'fast', timeoutMs = 180_000): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? viaApi(prompt, tier, key, timeoutMs) : viaCli(prompt, tier, timeoutMs);
}

async function viaApi(prompt: string, tier: ModelTier, key: string, timeoutMs: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: API_MODELS[tier], max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return data.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

function viaCli(prompt: string, tier: ModelTier, timeoutMs: number): Promise<string> {
  mkdirSync(CORTEX_HOME, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--model', CLI_MODELS[tier], '--no-session-persistence', '--tools', '', '--output-format', 'text'],
      { cwd: CORTEX_HOME, env: { ...process.env, CORTEX_INTERNAL: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude CLI timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out.trim()) : reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

/** Pull the first balanced JSON object out of an LLM reply. */
export function extractJson<T>(text: string): T {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1)) as T;
  }
  throw new Error('unterminated JSON in reply');
}
