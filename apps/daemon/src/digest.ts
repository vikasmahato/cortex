import type { CortexDB } from '@cortex/db';
import { complete } from './llm.ts';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export interface Digest {
  day: string;
  text: string;
  created_at: string;
  stale: boolean;
}

/**
 * "What did I do that day?" — built from session summaries where they exist and
 * from raw prompts otherwise. Cached per day; regenerated on demand (or when the
 * day has grown a lot since it was written).
 */
export async function getDigest(db: CortexDB, day: string, refresh = false): Promise<Digest | null> {
  const count = db.dayCount(day);
  if (count === 0) return null;
  const cached = db.getDigest(day);
  const grown = cached ? count > cached.event_count * 1.3 + 20 : false;
  if (cached && !refresh) return { day, text: cached.digest, created_at: cached.created_at, stale: grown };

  const sessions = db.daySessions(day);
  const prompts = db.dayPrompts(day, 40);
  const sessionLines = sessions
    .map((s) => {
      const head = `- [${s.project ?? 'unknown'}] ${s.title ?? clip(s.first_prompt ?? 'untitled', 100)} (${s.n} events)`;
      return s.summary ? `${head}\n  ${clip(s.summary, 400)}` : head;
    })
    .join('\n');
  const promptLines = prompts.map((p) => `- (${p.project ?? '?'}) ${clip(p.text.replace(/\s+/g, ' '), 180)}`).join('\n');

  const prompt = `You are writing a daily recap for a personal "second brain". Below is everything the user did with Claude Code on ${day}: sessions (with summaries where available) and the requests they typed.

Write the recap as plain text:
- First line: a one-sentence headline of the day (what the main thrust was).
- Then 3-7 bullets starting with "- ", grouped by project where sensible, in past tense, concrete (name the things built, fixed or decided; include numbers when given).
- No markdown headings, no bold, no preamble.

Sessions:
${sessionLines}

User requests:
${promptLines}`;

  const text = (await complete(prompt, 'fast')).trim();
  db.saveDigest(day, text, count);
  return { day, text, created_at: new Date().toISOString(), stale: false };
}
