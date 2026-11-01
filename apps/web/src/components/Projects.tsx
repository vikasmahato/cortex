import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { REGIONS } from '@cortex/core';
import { REGION_META, type Region } from '../lib/regions.ts';
import { live, setProfile, useUI } from '../lib/neural.ts';
import { api, post } from '../lib/live.ts';
import { useChat } from '../lib/chat.ts';

// ------------------------------------------------------------------ types & helpers

interface Project {
  name: string; sessions: number; events: number; first_at: string; last_at: string; summarized: number;
  spark: number[]; regionMix: Record<string, number>; latestTitle: string | null;
}
interface Thread { name: string; status: 'active' | 'paused' | 'done' | 'blocked'; summary: string; last_touched: string }
interface Profile { description: string; threads: Thread[]; open_items: string[]; created_at: string; stale: boolean }
interface ProjectSession {
  id: string; started_at: string; last_at: string; events: number;
  title: string | null; first_prompt: string | null; summary: string | null; category: string | null; tags: string[];
}
interface Detail {
  name: string; dir: string | null; canEdit: boolean;
  sessions: ProjectSession[]; tags: string[]; files: string[];
  recentPrompts: { ts: string; text: string }[]; profile: Profile | null;
}

export function ago(ts: string) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const dayLabel = (ts: string) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s);
const clean = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const STATUS: Record<Thread['status'], { label: string; color: string }> = {
  active: { label: 'Active', color: '#34d399' },
  paused: { label: 'Paused', color: '#94a3b8' },
  done: { label: 'Done', color: '#4f8cff' },
  blocked: { label: 'Blocked', color: '#ff3b5c' },
};

/** Small round button that collapses/expands a side panel. */
function CollapseButton({ onClick, dir, label }: { onClick: () => void; dir: '‹' | '›'; label: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="flex h-6 w-6 items-center justify-center rounded-full text-sm text-white/45 transition hover:bg-white/10 hover:text-white">
      {dir}
    </button>
  );
}

// ------------------------------------------------------------------ left: projects I'm working on

export function ProjectList() {
  const dataVersion = useUI((s) => s.dataVersion);
  const selected = useUI((s) => s.selectedProject);
  const select = useUI((s) => s.selectProject);
  const open = useUI((s) => s.leftOpen);
  const setOpen = useUI((s) => s.setLeftOpen);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    api<Project[]>('/api/projects').then(setProjects).catch(() => {});
  }, [dataVersion]);

  const [, tick] = useState(0); // refresh the "x min ago" labels
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const groups = useMemo(() => {
    const now = Date.now();
    const working: Project[] = [], earlier: Project[] = [], small: Project[] = [];
    for (const p of projects) {
      if (p.events < 60) small.push(p);
      else if (now - new Date(p.last_at).getTime() < 7 * 86_400_000) working.push(p);
      else earlier.push(p);
    }
    return { working, earlier, small };
  }, [projects]);

  const pick = (name: string) => select(selected === name ? null : name);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="glass absolute left-6 top-28 z-10 flex items-center gap-2 rounded-full px-4 py-2 text-xs text-white/80 transition hover:text-white">
        Projects <span className="font-mono text-white/40">{projects.length}</span> <span className="text-white/45">›</span>
      </button>
    );
  }

  return (
    <aside className="glass absolute bottom-6 left-6 top-28 z-10 flex w-[min(340px,calc(100vw-3rem))] flex-col rounded-2xl">
      <div className="flex items-center gap-2 px-5 pb-2 pt-4">
        <h2 className="text-sm font-medium text-white">Projects</h2>
        <span className="font-mono text-[11px] text-white/35">{projects.length}</span>
        <span className="ml-auto"><CollapseButton onClick={() => setOpen(false)} dir="‹" label="Collapse projects" /></span>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
        <Group title="Working on · this week" items={groups.working} selected={selected} onPick={pick} />
        <Group title="Earlier" items={groups.earlier} selected={selected} onPick={pick} />
        <Group title="Quick one-offs" items={groups.small} selected={selected} onPick={pick} compact />
        {projects.length === 0 && <div className="px-3 py-8 text-center text-sm text-white/35">No projects yet — start a Claude Code session.</div>}
      </div>
    </aside>
  );
}

function Group({ title, items, selected, onPick, compact }: { title: string; items: Project[]; selected: string | null; onPick: (n: string) => void; compact?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="mb-2">
      <div className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.22em] text-white/30">{title}</div>
      {items.map((p) => (
        <ProjectRow key={p.name} p={p} active={selected === p.name} onClick={() => onPick(p.name)} compact={compact} />
      ))}
    </div>
  );
}

function ProjectRow({ p, active, onClick, compact }: { p: Project; active: boolean; onClick: () => void; compact?: boolean }) {
  const max = Math.max(1, ...p.spark);
  const today = Date.now() - new Date(p.last_at).getTime() < 86_400_000;
  return (
    <button onClick={onClick} className={`block w-full rounded-xl px-3 py-2.5 text-left transition ${active ? 'bg-white/10' : 'hover:bg-white/5'}`}>
      <div className="flex items-center gap-2">
        {today && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" title="active in the last 24h" />}
        <span className="truncate text-sm font-medium text-white/90">{p.name}</span>
        <span className="ml-auto shrink-0 text-[11px] text-white/35">{ago(p.last_at)}</span>
      </div>
      {!compact && p.latestTitle && <div className="mt-0.5 truncate text-xs text-white/45">{clip(clean(p.latestTitle), 70)}</div>}
      <div className="mt-1.5 flex items-end justify-between">
        <span className="font-mono text-[10px] text-white/30">{p.sessions} session{p.sessions === 1 ? '' : 's'}</span>
        {!compact && (
          <span className="flex h-4 items-end gap-[2px]" aria-label="activity, last 14 days">
            {p.spark.map((n, i) => (
              <span key={i} className="w-[4px] rounded-[1px] bg-cyan-300" style={{ height: `${n ? 20 + (n / max) * 80 : 8}%`, opacity: n ? 0.85 : 0.15 }} />
            ))}
          </span>
        )}
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ right: detail / today

export function ProjectPanel() {
  const selected = useUI((s) => s.selectedProject);
  const open = useUI((s) => s.rightOpen);
  const setOpen = useUI((s) => s.setRightOpen);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="glass absolute right-6 top-28 z-10 flex max-w-[60vw] items-center gap-2 rounded-full px-4 py-2 text-xs text-white/80 transition hover:text-white">
        <span className="text-white/45">‹</span> <span className="truncate">{selected ?? 'Today'}</span>
      </button>
    );
  }
  return (
    <aside className="glass absolute bottom-24 right-6 top-28 z-10 flex w-[min(420px,calc(100vw-3rem))] flex-col rounded-2xl">
      <AnimatePresence mode="wait">
        {selected ? <ProjectDetail key={selected} name={selected} onCollapse={() => setOpen(false)} /> : <Today key="today" onCollapse={() => setOpen(false)} />}
      </AnimatePresence>
    </aside>
  );
}

function Today({ onCollapse }: { onCollapse: () => void }) {
  const dataVersion = useUI((s) => s.dataVersion);
  const select = useUI((s) => s.selectProject);
  const setTimelineOpen = useUI((s) => s.setTimelineOpen);
  const openBrowse = useUI((s) => s.openBrowse);
  const [day, setDay] = useState<{ sessions: { id: string; project: string | null; title: string | null; first_prompt: string | null; n: number; first_ts: string }[] } | null>(null);
  const today = new Date().toLocaleDateString('en-CA');

  useEffect(() => {
    api<typeof day>(`/api/day/${today}`).then(setDay).catch(() => {});
  }, [today, dataVersion]);

  const byProject = useMemo(() => {
    const m = new Map<string, NonNullable<typeof day>['sessions']>();
    for (const s of day?.sessions ?? []) (m.get(s.project ?? 'Other') ?? m.set(s.project ?? 'Other', []).get(s.project ?? 'Other')!).push(s);
    return [...m];
  }, [day]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start px-5 pb-2 pt-4">
        <div>
          <h2 className="text-sm font-medium text-white">Today</h2>
          <p className="text-xs text-white/40">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <span className="ml-auto"><CollapseButton onClick={onCollapse} dir="›" label="Collapse panel" /></span>
      </div>
      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto px-5 pb-4">
        {byProject.length === 0 && <p className="py-6 text-sm text-white/35">Nothing yet today. Pick a project on the left to see what you've been working on in it.</p>}
        {byProject.map(([name, sessions]) => (
          <div key={name}>
            <button onClick={() => select(name)} className="text-sm font-medium text-white/90 hover:text-cyan-300">{name}</button>
            <ul className="mt-1 space-y-1">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button onClick={() => openBrowse(s.id)} className="flex w-full gap-2 text-left text-xs text-white/55 hover:text-white">
                    <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-white/30" />
                    <span>{clip(clean(s.title ?? s.first_prompt ?? 'Untitled'), 110)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 px-5 py-3">
        <button onClick={() => setTimelineOpen(true)} className="text-xs text-white/50 hover:text-white">See the full day, recap and replay →</button>
      </div>
    </motion.div>
  );
}

function ProjectDetail({ name, onCollapse }: { name: string; onCollapse: () => void }) {
  const dataVersion = useUI((s) => s.dataVersion);
  const select = useUI((s) => s.selectProject);
  const openBrowse = useUI((s) => s.openBrowse);
  const [tab, setTab] = useState<'overview' | 'chat'>('overview');
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => api<Detail>(`/api/projects/${encodeURIComponent(name)}`).then(setD).catch(() => setD(null)), [name]);
  useEffect(() => { void load(); }, [load, dataVersion]);

  // tint the brain with this project's kind of work while it's selected
  useEffect(() => {
    let alive = true;
    api<Project[]>('/api/projects').then((ps) => alive && setProfile(ps.find((p) => p.name === name)?.regionMix ?? null)).catch(() => {});
    return () => { alive = false; setProfile(null); };
  }, [name]);

  const generate = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const profile = await post<Profile>(`/api/projects/${encodeURIComponent(name)}/profile`);
      setD((p) => (p ? { ...p, profile } : p));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [name]);

  // first visit: write the overview automatically
  const needsProfile = d && !d.profile && !busy && !err && d.sessions.some((s) => s.title);
  useEffect(() => { if (needsProfile) void generate(); }, [needsProfile, generate]);

  const p = d?.profile;
  const summarized = d?.sessions.filter((s) => s.title).length ?? 0;

  return (
    <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-2 px-5 pb-1 pt-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-white">{name}</h2>
          {d && <p className="text-xs text-white/40">{d.sessions.length} sessions · last worked {ago(d.sessions[0]!.last_at)}</p>}
        </div>
        <span className="ml-auto flex shrink-0 items-center">
          <CollapseButton onClick={onCollapse} dir="›" label="Collapse panel" />
          <button onClick={() => select(null)} className="ml-1 rounded-md px-2 py-1 text-xs text-white/40 hover:bg-white/10 hover:text-white" aria-label="Close project" title="Back to Today">✕</button>
        </span>
      </div>

      <div className="flex gap-1 px-5 pb-2 pt-1 text-xs">
        {(['overview', 'chat'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1 transition ${tab === t ? 'bg-white/12 text-white' : 'text-white/45 hover:text-white'}`}>
            {t === 'chat' ? 'Chat with Claude' : 'Overview'}
          </button>
        ))}
      </div>

      {tab === 'chat' ? (
        <ChatView name={name} dir={d?.dir ?? null} canEdit={d?.canEdit ?? false} loaded={Boolean(d)} />
      ) : (
        <div className="scroll-thin flex-1 space-y-5 overflow-y-auto px-5 pb-5">
          {!d && <p className="py-6 text-sm text-white/35">Loading…</p>}
          {d && (
            <>
              {p?.description && <p className="text-sm leading-relaxed text-white/75">{p.description}</p>}
              {busy && <p className="live-dot text-xs text-cyan-300">Reading your history to work out what's going on here… (~10s)</p>}
              {err && <p className="text-xs text-red-400">{err}</p>}
              {!p && !busy && summarized === 0 && (
                <p className="text-xs leading-relaxed text-white/40">
                  This project's sessions haven't been summarized yet, so I can't tell what you're working on. Summaries are written in the background — check back shortly.
                </p>
              )}

              {p && p.threads.length > 0 && (
                <Section title="What you're working on">
                  <div className="space-y-2">
                    {p.threads.map((t) => (
                      <div key={t.name} className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white/90">{t.name}</span>
                          <span className="ml-auto rounded-full px-2 py-0.5 text-[10px]" style={{ color: STATUS[t.status].color, background: STATUS[t.status].color + '1f' }}>
                            {STATUS[t.status].label}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-white/55">{t.summary}</p>
                        {t.last_touched && <p className="mt-1 font-mono text-[10px] text-white/30">last touched {dayLabel(t.last_touched + 'T12:00:00')}</p>}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {p && p.open_items.length > 0 && (
                <Section title="Still open">
                  <ul className="space-y-1.5">
                    {p.open_items.map((o, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed text-white/65">
                        <span className="text-amber-300">○</span>
                        <span>{o}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title="Sessions">
                <div className="space-y-1">
                  {d.sessions.slice(0, 12).map((s) => (
                    <button key={s.id} onClick={() => openBrowse(s.id)} className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-white/5">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-xs text-white/80">{clip(clean(s.title ?? s.first_prompt ?? 'Untitled'), 80)}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-white/30">{dayLabel(s.last_at)}</span>
                      </div>
                    </button>
                  ))}
                  {d.sessions.length > 12 && <p className="px-2 pt-1 text-[11px] text-white/30">+ {d.sessions.length - 12} older sessions</p>}
                </div>
              </Section>

              {d.tags.length > 0 && (
                <Section title="Topics">
                  <div className="flex flex-wrap gap-1.5">
                    {d.tags.map((t) => <span key={t} className="rounded-full bg-white/6 px-2.5 py-1 text-[11px] text-white/55">{t}</span>)}
                  </div>
                </Section>
              )}

              {d.files.length > 0 && (
                <Section title="Key files">
                  <ul className="space-y-1 font-mono text-[11px] text-white/45">{d.files.map((f) => <li key={f} className="truncate">{f}</li>)}</ul>
                </Section>
              )}

              {d.recentPrompts.length > 0 && (
                <Section title="What you last asked for">
                  <ul className="space-y-1.5">
                    {d.recentPrompts.map((r, i) => (
                      <li key={i} className="text-xs leading-relaxed text-white/50">
                        <span className="mr-2 font-mono text-[10px] text-white/25">{dayLabel(r.ts)}</span>“{clip(clean(r.text), 130)}”
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <div className="flex items-center gap-3 border-t border-white/10 pt-3">
                {p && (
                  <button onClick={generate} disabled={busy} className="rounded-md px-2 py-1 text-[11px] text-white/45 hover:bg-white/10 hover:text-white disabled:opacity-40">
                    {busy ? 'Updating…' : p.stale ? 'Update overview (new sessions)' : 'Refresh overview'}
                  </button>
                )}
                <span className="ml-auto text-[11px] text-white/30">{summarized}/{d.sessions.length} sessions summarized</span>
              </div>
            </>
          )}
        </div>
      )}
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-white/35">{title}</h3>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ chat: prompt Claude about this project

const SUGGESTIONS = [
  'Where did I leave off, and what should I do next?',
  'Summarize the current state of this project.',
  'What are the riskiest or messiest parts of the code?',
];

function ChatView({ name, dir, canEdit, loaded }: { name: string; dir: string | null; canEdit: boolean; loaded: boolean }) {
  const chat = useChat((s) => s.chats[name]);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const setMode = useChat((s) => s.setMode);
  const reset = useChat((s) => s.reset);
  const c = chat ?? { sessionId: null, messages: [], busy: false, mode: 'ask' as const };
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [c.messages.length, c.busy]);

  const submit = (t = text) => {
    if (!t.trim() || c.busy || !dir) return;
    void send(name, t.trim());
    setText('');
  };
  const editing = c.mode === 'edit';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-5 pb-2">
        {c.messages.length === 0 && (
          <div className="space-y-3 pt-2">
            {!loaded ? (
              <p className="text-xs text-white/35">Loading…</p>
            ) : dir ? (
              <>
                <p className="text-xs leading-relaxed text-white/50">
                  Ask Claude about <span className="text-white/80">{name}</span>. It runs in <span className="font-mono text-[11px] text-white/60">{dir}</span> and already knows what Cortex has learned about this project.
                  This conversation is saved as a normal session in the project.
                </p>
                <div className="flex flex-col gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => submit(s)} className="rounded-lg border border-white/10 px-3 py-2 text-left text-xs text-white/60 transition hover:border-white/25 hover:text-white">{s}</button>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-white/45">Cortex couldn't find a folder on disk for this project, so there's nowhere to run Claude. Chat is unavailable here.</p>
            )}
          </div>
        )}

        {c.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-white/12 px-3.5 py-2 text-sm text-white">{m.text}</div>
            </div>
          ) : m.role === 'assistant' ? (
            <div key={m.id} className="whitespace-pre-wrap text-sm leading-relaxed text-white/85">{m.text}</div>
          ) : m.role === 'tool' ? (
            <div key={m.id} className="truncate font-mono text-[11px] text-white/35">⚙ {m.text}</div>
          ) : (
            <div key={m.id} className="text-xs text-red-400">{m.text}</div>
          ),
        )}
        {c.busy && <div className="live-dot flex items-center gap-2 text-xs text-cyan-300"><span className="h-1.5 w-1.5 rounded-full bg-cyan-300" /> Claude is working…</div>}
        <div ref={endRef} />
      </div>

      <div className="border-t border-white/10 px-4 pb-3 pt-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px]">
          <button onClick={() => setMode(name, 'ask')} className={`rounded-full px-2.5 py-1 transition ${!editing ? 'bg-white/12 text-white' : 'text-white/40 hover:text-white'}`} title="Claude can only read files">Ask · read-only</button>
          <button
            onClick={() => canEdit && setMode(name, 'edit')}
            disabled={!canEdit}
            className={`rounded-full px-2.5 py-1 transition ${editing ? 'bg-amber-400/20 text-amber-200' : 'text-white/40 hover:text-white'} disabled:cursor-not-allowed disabled:opacity-30`}
            title={canEdit ? 'Claude may create and edit files in the project folder (no shell commands)' : 'Not available for this location'}
          >
            Can edit files
          </button>
          {c.messages.length > 0 && <button onClick={() => reset(name)} className="ml-auto rounded px-2 py-1 text-white/35 hover:text-white">New chat</button>}
        </div>
        {editing && <p className="mb-2 text-[11px] text-amber-200/80">Claude can change files in this folder. It can't run shell commands.</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            rows={2}
            disabled={!dir}
            placeholder={dir ? `Ask Claude about ${name}…` : 'No folder found for this project'}
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/30 disabled:opacity-40"
          />
          {c.busy ? (
            <button onClick={() => stop(name)} className="rounded-xl bg-red-500/20 px-3 py-2.5 text-xs text-red-200 hover:bg-red-500/30">Stop</button>
          ) : (
            <button onClick={() => submit()} disabled={!text.trim() || !dir} className="rounded-xl bg-cyan-400/20 px-3 py-2.5 text-xs text-cyan-100 transition hover:bg-cyan-400/30 disabled:opacity-30">Send</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ top: current status

/** What the brain is doing right now, colour-coded, plus the last thing you asked for. */
export function StatusBar() {
  const now = useUI((s) => s.now);
  const select = useUI((s) => s.selectProject);
  const [status, setStatus] = useState<Region | null>(null);
  const [, tick] = useState(0);

  // read live activity a few times a second; hold each status briefly so it doesn't flicker
  useEffect(() => {
    let raf = 0, last = 0, since = 0;
    let cur: Region | null = null;
    const loop = (t: number) => {
      if (t - last > 150) {
        last = t;
        let best = -1, bestV = 0.3;
        for (let i = 0; i < live.length; i++) {
          const v = 1 - Math.exp(-live[i]! * 1.3);
          if (v > bestV) { bestV = v; best = i; }
        }
        const next = best >= 0 ? REGIONS[best]! : null;
        if (next !== cur && t - since > 600) { cur = next; since = t; setStatus(next); }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const clock = setInterval(() => tick((n) => n + 1), 20000);
    return () => { cancelAnimationFrame(raf); clearInterval(clock); };
  }, []);

  const meta = status ? REGION_META[status] : null;
  const color = meta?.color ?? '#7c8599';

  return (
    <div className="pointer-events-none absolute inset-x-0 top-6 flex justify-center px-4">
      <button
        onClick={() => now?.project && select(now.project)}
        className="glass pointer-events-auto flex max-w-[min(640px,92vw)] items-center gap-2.5 rounded-full px-4 py-1.5 text-xs transition hover:bg-white/10"
        title="What the brain is doing right now"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${meta ? 'live-dot' : ''}`} style={{ background: color, boxShadow: meta ? `0 0 10px ${color}` : 'none' }} />
        <span className="w-[88px] shrink-0 text-left font-medium" style={{ color }}>{meta?.status ?? 'Idle'}</span>
        {now && (
          <>
            <span className="shrink-0 text-white/25">·</span>
            {now.project && <span className="shrink-0 font-medium text-white/85">{now.project}</span>}
            <span className="truncate text-white/40">“{clip(clean(now.text), 60)}”</span>
            {!meta && <span className="shrink-0 text-white/30">{ago(now.ts)}</span>}
          </>
        )}
      </button>
    </div>
  );
}
