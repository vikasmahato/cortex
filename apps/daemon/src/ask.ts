import type { Region } from '@cortex/core';
import type { CortexDB } from '@cortex/db';
import { complete } from './llm.ts';

export interface Source {
  ref: string; // S1, E3 …
  type: 'session' | 'event';
  sessionId: string;
  title: string;
  project: string | null;
  ts: string;
  snippet: string;
}

export interface Answer {
  answer: string;
  sources: Source[];
  regions: Region[]; // regions the memories came from (drives the brain visual)
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const day = (ts: string) => ts.slice(0, 10);

export async function askCortex(db: CortexDB, question: string): Promise<Answer> {
  const { summaries, events } = db.recall(question);
  const sources: Source[] = [];
  const blocks: string[] = [];

  summaries.forEach((s, i) => {
    const sess = db.getSession(s.session_id);
    const ref = `S${i + 1}`;
    sources.push({
      ref, type: 'session', sessionId: s.session_id, title: s.title,
      project: sess?.project ?? null, ts: sess?.last_at ?? s.created_at, snippet: clip(s.summary, 220),
    });
    blocks.push(
      `[${ref}] ${s.title} — project ${sess?.project ?? '?'}, ${day(sess?.last_at ?? s.created_at)}, category ${s.category}\n` +
        `Summary: ${s.summary}` +
        (s.decisions.length ? `\nDecisions: ${s.decisions.join('; ')}` : '') +
        (s.learnings.length ? `\nLearnings: ${s.learnings.join('; ')}` : '') +
        (s.files.length ? `\nFiles: ${s.files.join(', ')}` : ''),
    );
  });

  // raw event hits give detail for sessions that have no summary yet
  const seen = new Set<string>();
  let n = 0;
  for (const e of events) {
    if (n >= 8) break;
    const dupKey = `${e.session_id}:${e.text.slice(0, 60)}`;
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);
    const ref = `E${++n}`;
    const sess = db.getSession(e.session_id);
    sources.push({
      ref, type: 'event', sessionId: e.session_id, title: sess?.title ?? e.kind,
      project: e.project, ts: e.ts, snippet: clip(e.text, 220),
    });
    blocks.push(`[${ref}] ${e.kind === 'prompt' ? 'User said' : 'Claude said'} (project ${e.project ?? '?'}, ${day(e.ts)}): ${clip(e.text, 600)}`);
  }

  const regions = new Set<Region>(['hippocampus']);
  for (const e of events) regions.add(e.region as Region);
  for (const s of summaries.slice(0, 4)) for (const r of db.dominantRegions(s.session_id, 2)) regions.add(r.region);

  if (blocks.length === 0) {
    return { answer: "I couldn't find anything in your memory that matches that. Try different keywords, or summarize more sessions first.", sources: [], regions: ['hippocampus'] };
  }

  const prompt = `You are Cortex, the user's personal second brain. Answer the user's question using ONLY the memories below, which are records of their past work with Claude Code. Be concrete and concise (a short paragraph or a few bullets). Cite the memories you rely on inline like [S1] or [E2]. If the memories don't contain the answer, say so plainly and mention the closest related thing you do have. Do not invent details.

Question: ${question}

Memories:
${clip(blocks.join('\n\n'), 14_000)}`;

  const answer = await complete(prompt, 'smart');
  const cited = new Set([...answer.matchAll(/\[([SE]\d+)\]/g)].map((m) => m[1]));
  return {
    answer,
    sources: sources.filter((s) => cited.has(s.ref)).concat(sources.filter((s) => !cited.has(s.ref)).slice(0, 4)),
    regions: [...regions],
  };
}
