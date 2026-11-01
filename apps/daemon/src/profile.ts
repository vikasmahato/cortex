import type { CortexDB } from '@cortex/db';
import { complete, extractJson } from './llm.ts';

export interface Thread {
  name: string;
  status: 'active' | 'paused' | 'done' | 'blocked';
  summary: string;
  last_touched: string;
}
export interface ProjectProfile {
  description: string;
  threads: Thread[];
  open_items: string[];
}
export interface StoredProfile extends ProjectProfile {
  created_at: string;
  stale: boolean;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const parse = (v: string | null): string[] => {
  try { return v ? (JSON.parse(v) as string[]) : []; } catch { return []; }
};
const STATUSES = new Set(['active', 'paused', 'done', 'blocked']);

/**
 * "What is this project, and what am I working on in it?" — written from the
 * user's own session history (summaries where they exist, first prompts otherwise).
 * Cached; considered stale once the project has gained sessions since.
 */
export async function getProfile(db: CortexDB, name: string, refresh = false): Promise<StoredProfile | null> {
  const sessions = db.projectSessions(name);
  if (sessions.length === 0) return null;

  const cached = db.getProfile(name);
  if (cached && !refresh) {
    return { ...(cached.profile as ProjectProfile), created_at: cached.created_at, stale: sessions.length > cached.session_count };
  }

  const today = new Date().toLocaleDateString('en-CA');
  const lines = sessions.slice(0, 45).map((s) => {
    const date = s.last_at.slice(0, 10);
    if (!s.title) return `- ${date} | (not yet summarized) ${clip(s.first_prompt ?? 'untitled', 180)}`;
    const decisions = parse(s.decisions).slice(0, 2).join('; ');
    return `- ${date} | ${s.title} | ${clip(s.summary ?? '', 280)}${decisions ? ` | decided: ${clip(decisions, 200)}` : ''}`;
  });

  const prompt = `You maintain a personal "second brain" for one person. Below is the history of their sessions with Claude Code for ONE project, newest first. Today is ${today}.

Describe the project and what THEY are working on in it. Write from the user's point of view in plain, concrete language (say "you", name real things, include numbers where given). Group sessions into a few distinct *threads of work* (e.g. "Dataset retagging", "Pi video migration"), not one per session.

Return ONLY a JSON object:
{
  "description": "1-2 sentences: what this project is and its purpose",
  "threads": [
    { "name": "2-5 word thread name",
      "status": "active | paused | done | blocked",
      "summary": "one sentence: where this thread stands right now",
      "last_touched": "YYYY-MM-DD" }
  ],
  "open_items": ["unfinished things, next steps, or known problems (max 5, may be empty)"]
}
Use at most 6 threads, most recently touched first. "active" = touched in the last ~10 days and unfinished; "done" = clearly completed; "blocked" = stuck on something stated in the history.

Project: ${name}
Sessions (${sessions.length} total):
${lines.join('\n')}`;

  const raw = extractJson<Partial<ProjectProfile>>(await complete(prompt, 'fast'));
  const profile: ProjectProfile = {
    description: clip(String(raw.description ?? ''), 400),
    threads: (raw.threads ?? []).slice(0, 6).map((t) => ({
      name: clip(String(t.name ?? 'Untitled'), 60),
      status: STATUSES.has(String(t.status)) ? (t.status as Thread['status']) : 'paused',
      summary: clip(String(t.summary ?? ''), 300),
      last_touched: String(t.last_touched ?? '').slice(0, 10),
    })),
    open_items: (raw.open_items ?? []).slice(0, 5).map((s) => clip(String(s), 240)),
  };
  db.saveProfile(name, profile, sessions.length);
  return { ...profile, created_at: new Date().toISOString(), stale: false };
}
