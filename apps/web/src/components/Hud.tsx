import { useUI } from '../lib/neural.ts';

export function Header() {
  const connected = useUI((s) => s.connected);
  const openBrowse = useUI((s) => s.openBrowse);
  const setTimelineOpen = useUI((s) => s.setTimelineOpen);
  const btn = 'glass rounded-full px-3.5 py-1.5 text-white/80 transition hover:text-white';
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-6">
      <div>
        <h1 className="font-mono text-xl font-semibold tracking-[0.35em] text-white">C.O.R.T.E.X</h1>
        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
          <b className="font-semibold text-cyan-300">C</b>ontinuous <b className="font-semibold text-cyan-300">O</b>bservation,{' '}
          <b className="font-semibold text-cyan-300">R</b>ecall &amp; <b className="font-semibold text-cyan-300">T</b>hought{' '}
          <b className="font-semibold text-cyan-300">EX</b>traction
        </p>
        <p className="mt-1 text-xs text-white/35">What you're working on, and where</p>
      </div>
      <div className="pointer-events-auto flex items-center gap-2 text-xs">
        <button onClick={() => setTimelineOpen(true)} className={btn}>Timeline</button>
        <button onClick={() => openBrowse()} className={btn}>Browse</button>
        <div className="glass flex items-center gap-2 rounded-full px-3 py-1.5" title={connected ? 'Connected to the Cortex daemon' : 'Daemon not reachable'}>
          <span className={`live-dot h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} />
          <span className="text-white/60">{connected ? 'live' : 'offline'}</span>
        </div>
      </div>
    </header>
  );
}

export function SearchPill() {
  const setOpen = useUI((s) => s.setSearchOpen);
  return (
    <button
      onClick={() => setOpen(true)}
      className="glass absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full px-5 py-3 text-sm text-white/60 transition hover:text-white"
    >
      <span>Ask about anything you've done…</span>
      <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/50">Ctrl K</kbd>
    </button>
  );
}
