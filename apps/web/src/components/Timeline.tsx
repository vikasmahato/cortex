import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { REGIONS } from '@cortex/core';
import { REGION_META, type Region } from '../lib/regions.ts';
import { useUI } from '../lib/neural.ts';
import { api, post } from '../lib/live.ts';

interface DayStat { day: string; n: number; sessions: number }
interface DaySession {
  id: string; project: string | null; n: number; first_ts: string; last_ts: string;
  title: string | null; summary: string | null; category: string | null; first_prompt: string | null;
}
interface DayDetail {
  day: string; events: number; sessions: DaySession[];
  hourly: { hour: number; region: Region; n: number }[];
  digest: { text: string; created_at: string; stale: boolean } | null;
}

const WEEKS = 18;
const localDay = (d: Date) => d.toLocaleDateString('en-CA');
const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function Timeline() {
  const { timelineOpen, setTimelineOpen } = useUI();
  const [days, setDays] = useState<DayStat[]>([]);
  const [sel, setSel] = useState<string>(localDay(new Date()));

  useEffect(() => {
    if (timelineOpen) api<DayStat[]>('/api/days?limit=400').then(setDays).catch(() => {});
  }, [timelineOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setTimelineOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTimelineOpen]);

  return (
    <AnimatePresence>
      {timelineOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-10 bg-black/60 p-4 backdrop-blur-sm md:p-8"
          onClick={() => setTimelineOpen(false)}
        >
          <motion.div
            initial={{ y: 16, scale: 0.985 }}
            animate={{ y: 0, scale: 1 }}
            className="glass mx-auto flex h-full max-w-5xl flex-col overflow-hidden rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <h2 className="font-mono text-sm tracking-[0.3em] text-white">TIMELINE</h2>
              <button onClick={() => setTimelineOpen(false)} className="rounded-md px-2 py-1 font-mono text-xs text-white/40 hover:bg-white/10 hover:text-white">
                Esc
              </button>
            </div>
            <div className="scroll-thin flex-1 overflow-y-auto">
              <Heatmap days={days} sel={sel} onSelect={setSel} />
              <DayPanel day={sel} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Heatmap({ days, sel, onSelect }: { days: DayStat[]; sel: string; onSelect: (d: string) => void }) {
  const { cols, max } = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    const max = Math.max(1, ...days.map((d) => d.n));
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7); // Sunday of the first week
    const cols: { day: string; stat?: DayStat; future: boolean }[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const col = [];
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start);
        dt.setDate(start.getDate() + w * 7 + d);
        const key = localDay(dt);
        col.push({ day: key, stat: byDay.get(key), future: dt > today });
      }
      cols.push(col);
    }
    return { cols, max };
  }, [days]);

  const level = (n: number) => Math.min(4, Math.max(1, Math.ceil((Math.sqrt(n) / Math.sqrt(max)) * 4)));
  const shades = ['rgba(255,255,255,0.05)', 'rgba(34,211,238,0.22)', 'rgba(34,211,238,0.4)', 'rgba(34,211,238,0.65)', 'rgba(34,211,238,0.95)'];

  return (
    <div className="border-b border-white/10 px-5 py-4">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">Last {WEEKS} weeks</div>
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {cols.map((col, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {col.map((c) => (
              <button
                key={c.day}
                disabled={c.future}
                onClick={() => onSelect(c.day)}
                title={`${c.day}${c.stat ? ` · ${c.stat.n} events · ${c.stat.sessions} sessions` : ''}`}
                className={`h-[15px] w-[15px] rounded-[3px] transition ${c.future ? 'opacity-0' : 'hover:scale-125'} ${sel === c.day ? 'ring-1 ring-white' : ''}`}
                style={{ background: shades[c.stat ? level(c.stat.n) : 0] }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayPanel({ day }: { day: string }) {
  const { startReplay, openBrowse } = useUI();
  const [d, setD] = useState<DayDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    api<DayDetail>(`/api/day/${day}`).then(setD).catch(() => setD(null));
  }, [day]);
  useEffect(load, [load]);

  const recap = async () => {
    setBusy(true);
    setErr(null);
    try {
      const dg = await post<{ text: string; created_at: string; stale: boolean } | null>(`/api/day/${day}/digest`);
      setD((p) => (p ? { ...p, digest: dg } : p));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const { perHour, regionTotals, maxHour } = useMemo(() => {
    const perHour: Record<number, Partial<Record<Region, number>>> = {};
    const regionTotals: Partial<Record<Region, number>> = {};
    for (const r of d?.hourly ?? []) {
      (perHour[r.hour] ??= {})[r.region] = r.n;
      regionTotals[r.region] = (regionTotals[r.region] ?? 0) + r.n;
    }
    const maxHour = Math.max(1, ...Object.values(perHour).map((h) => Object.values(h).reduce((a, b) => a + (b ?? 0), 0)));
    return { perHour, regionTotals, maxHour };
  }, [d]);

  const pretty = new Date(day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (!d || d.events === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-white/35">
        {pretty} — nothing captured.
      </div>
    );
  }
  const total = Object.values(regionTotals).reduce((a, b) => a + (b ?? 0), 0) || 1;

  return (
    <div className="space-y-5 px-5 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-base font-medium text-white">{pretty}</div>
          <div className="font-mono text-[11px] text-white/40">{d.events.toLocaleString()} events · {d.sessions.length} sessions</div>
        </div>
        <button
          onClick={() => startReplay(day)}
          className="ml-auto rounded-full bg-white/10 px-4 py-2 font-mono text-xs text-white transition hover:bg-white/20"
        >
          ▶ Replay on the brain
        </button>
      </div>

      {/* hourly activity, stacked by region */}
      <div>
        <div className="flex h-24 items-end gap-[3px]">
          {Array.from({ length: 24 }, (_, h) => {
            const hour = perHour[h] ?? {};
            const sum = Object.values(hour).reduce((a, b) => a + (b ?? 0), 0);
            return (
              <div key={h} className="flex h-full flex-1 flex-col-reverse" title={`${h}:00 · ${sum} events`}>
                <div className="flex flex-col-reverse overflow-hidden rounded-sm" style={{ height: `${(sum / maxHour) * 100}%` }}>
                  {REGIONS.map((r) => hour[r] ? <div key={r} style={{ flex: hour[r], background: REGION_META[r].color, opacity: 0.85 }} /> : null)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-white/30">
          {[0, 6, 12, 18, 23].map((h) => <span key={h}>{String(h).padStart(2, '0')}:00</span>)}
        </div>
      </div>

      {/* region mix */}
      <div>
        <div className="flex h-2 overflow-hidden rounded-full">
          {REGIONS.map((r) => regionTotals[r] ? <div key={r} style={{ width: `${(regionTotals[r]! / total) * 100}%`, background: REGION_META[r].color }} /> : null)}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/50">
          {REGIONS.filter((r) => regionTotals[r]).map((r) => (
            <span key={r} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: REGION_META[r].color }} />
              {REGION_META[r].label} {Math.round((regionTotals[r]! / total) * 100)}%
            </span>
          ))}
        </div>
      </div>

      {/* digest */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-2 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.25em] text-[#fde047]">
          Recap
          {d.digest?.stale && <span className="normal-case tracking-normal text-white/35">· day has grown since this was written</span>}
          <button onClick={recap} disabled={busy} className="ml-auto rounded px-2 py-1 normal-case tracking-normal text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-50">
            {busy ? 'Writing… (~10s)' : d.digest ? 'Refresh' : 'Generate'}
          </button>
        </div>
        {d.digest ? (
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-white/80">{d.digest.text}</div>
        ) : (
          <div className="text-sm text-white/35">No recap yet — generate one to see what you did this day at a glance.</div>
        )}
        {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      </div>

      {/* sessions of the day */}
      <div className="space-y-1.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">Sessions</div>
        {d.sessions.map((s) => (
          <button key={s.id} onClick={() => openBrowse(s.id)} className="block w-full rounded-lg border border-white/8 px-3 py-2 text-left hover:border-white/20 hover:bg-white/[0.03]">
            <div className="flex items-center gap-2 font-mono text-[10px] text-white/40">
              {s.category && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[#22d3ee]">{s.category}</span>}
              <span>{s.project ?? '—'}</span>
              <span>· {s.n} events</span>
              <span className="ml-auto">{time(s.first_ts)}–{time(s.last_ts)}</span>
            </div>
            <div className="mt-0.5 truncate text-sm text-white/85">{s.title ?? s.first_prompt ?? 'Untitled session'}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
