import { useEffect, useRef, useState } from 'react';
import { REGIONS } from '@cortex/core';
import { REGION_META } from '../lib/regions.ts';
import { fire, useUI } from '../lib/neural.ts';
import { api } from '../lib/live.ts';

type Pair = [number, number]; // [epoch ms, region index]

const GAP_CAP_S = 6; // long idle gaps are compressed to at most this many virtual seconds
const BASE_SECONDS = 60; // at 1x the whole (gap-compressed) day plays in ~a minute
const SPEEDS = [0.5, 1, 2, 4];

/** Replays one day of captured activity on the brain, with idle time squeezed out. */
export function ReplayBar() {
  const day = useUI((s) => s.replayDay)!;
  const stop = useUI((s) => s.stopReplay);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);
  const [clock, setClock] = useState('');

  const ev = useRef<Pair[]>([]);
  const virt = useRef<Float64Array>(new Float64Array(0));
  const pos = useRef(0); // virtual seconds
  const ptr = useRef(0); // next event index to fire
  const playingRef = useRef(true);
  const speedRef = useRef(1);
  playingRef.current = playing;
  speedRef.current = speed;

  useEffect(() => {
    let alive = true;
    api<Pair[]>(`/api/day/${day}/replay`).then((rows) => {
      if (!alive) return;
      ev.current = rows;
      const v = new Float64Array(rows.length);
      for (let i = 1; i < rows.length; i++) v[i] = v[i - 1]! + Math.min(GAP_CAP_S, (rows[i]![0] - rows[i - 1]![0]) / 1000);
      virt.current = v;
      pos.current = 0;
      ptr.current = 0;
      setReady(true);
    });
    return () => { alive = false; };
  }, [day]);

  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const total = () => virt.current[virt.current.length - 1] ?? 0;

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const T = total();
      if (playingRef.current && T > 0) {
        pos.current = Math.min(T, pos.current + dt * (T / BASE_SECONDS) * speedRef.current);
        // fire everything that became due, aggregated per region so bursts read as one pulse
        const counts: Record<number, number> = {};
        while (ptr.current < ev.current.length && virt.current[ptr.current]! <= pos.current) {
          const r = ev.current[ptr.current]![1];
          counts[r] = (counts[r] ?? 0) + 1;
          ptr.current++;
        }
        for (const [r, c] of Object.entries(counts)) fire(REGIONS[Number(r)]!, Math.min(0.9, 0.2 + 0.08 * c));
        if (pos.current >= T) setPlaying(false);
      }
      if (now - lastUi > 80) {
        lastUi = now;
        setProgress(T ? pos.current / T : 0);
        const e = ev.current[Math.min(ptr.current, ev.current.length - 1)];
        if (e) setClock(new Date(e[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  const seek = (frac: number) => {
    const T = virt.current[virt.current.length - 1] ?? 0;
    pos.current = frac * T;
    // first event not yet reached
    let lo = 0, hi = virt.current.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (virt.current[mid]! <= pos.current) lo = mid + 1; else hi = mid;
    }
    ptr.current = lo;
    setProgress(frac);
  };

  const replayAgain = () => {
    seek(0);
    setPlaying(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop();
      else if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stop]);

  const pretty = new Date(day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const finished = progress >= 0.999;

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center">
        <div className="glass flex items-center gap-3 rounded-full px-4 py-1.5 font-mono text-xs">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-[#fde047]" />
          <span className="tracking-[0.25em] text-[#fde047]">REPLAY</span>
          <span className="text-white/60">{pretty}</span>
          <span className="w-12 text-right text-white">{clock}</span>
        </div>
      </div>

      <div className="glass absolute bottom-6 left-1/2 flex w-[min(720px,92vw)] -translate-x-1/2 items-center gap-4 rounded-full px-5 py-3">
        <button
          onClick={finished ? replayAgain : () => setPlaying((p) => !p)}
          disabled={!ready}
          className="w-6 text-lg leading-none text-white transition hover:text-[#fde047] disabled:opacity-40"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {finished ? '↻' : playing ? '❚❚' : '▶'}
        </button>
        <input
          type="range" min={0} max={1000} value={Math.round(progress * 1000)}
          onChange={(e) => seek(Number(e.target.value) / 1000)}
          className="h-1 flex-1 cursor-pointer accent-[#fde047]"
          aria-label="Scrub replay"
        />
        <div className="flex gap-1 font-mono text-[11px]">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`rounded px-1.5 py-0.5 ${speed === s ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white'}`}
            >
              {s}×
            </button>
          ))}
        </div>
        <button onClick={stop} className="font-mono text-xs text-white/40 hover:text-white" aria-label="Exit replay">✕</button>
      </div>

      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-sm text-white/40">
          loading {day}…
        </div>
      )}
      <ReplayLegend />
    </>
  );
}

/** Small legend so colours are legible while the rest of the HUD is quiet. */
function ReplayLegend() {
  return (
    <div className="pointer-events-none absolute bottom-24 left-1/2 flex -translate-x-1/2 gap-4 font-mono text-[10px] text-white/45">
      {REGIONS.map((r) => (
        <span key={r} className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: REGION_META[r].color }} />
          {REGION_META[r].label}
        </span>
      ))}
    </div>
  );
}
