import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useUI } from '../lib/neural.ts';
import { api, post } from '../lib/live.ts';

interface Cat { category: string; n: number }
interface Card {
  id: string; project: string | null; branch: string | null; started_at: string; last_at: string; event_count: number;
  first_prompt: string | null; title: string | null; summary: string | null; category: string | null; tags: string[];
}
interface Detail {
  summary: { title: string; summary: string; category: string; tags: string[]; decisions: string[]; learnings: string[]; files: string[] } | null;
}

const when = (ts: string) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function Browse() {
  const { browseOpen, browseSession, closeBrowse } = useUI();
  const [cats, setCats] = useState<Cat[]>([]);
  const [cat, setCat] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Cat[]>('/api/categories').then(setCats).catch(() => {});
    api<Card[]>(`/api/browse${cat ? `?category=${encodeURIComponent(cat)}` : ''}`).then(setCards).catch(() => {});
  }, [cat]);

  useEffect(() => {
    if (browseOpen) load();
  }, [browseOpen, load]);
  useEffect(() => {
    if (browseOpen) setOpen(browseSession);
  }, [browseOpen, browseSession]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeBrowse();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeBrowse]);

  const total = cats.reduce((a, c) => a + c.n, 0);

  return (
    <AnimatePresence>
      {browseOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-10 bg-black/60 p-4 backdrop-blur-sm md:p-8"
          onClick={closeBrowse}
        >
          <motion.div
            initial={{ y: 16, scale: 0.985 }}
            animate={{ y: 0, scale: 1 }}
            className="glass mx-auto flex h-full max-w-5xl flex-col overflow-hidden rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <h2 className="font-mono text-sm tracking-[0.3em] text-white">MEMORY</h2>
              <button onClick={closeBrowse} className="rounded-md px-2 py-1 font-mono text-xs text-white/40 hover:bg-white/10 hover:text-white">
                Esc
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 border-b border-white/10 px-5 py-3">
              <Chip active={cat === null} onClick={() => setCat(null)} label="All" n={total} />
              {cats.map((c) => (
                <Chip key={c.category} active={cat === c.category} onClick={() => setCat(c.category)} label={c.category} n={c.n} />
              ))}
            </div>
            <div className="scroll-thin flex-1 space-y-2 overflow-y-auto p-4">
              {cards.map((c) => (
                <SessionCard key={c.id} card={c} expanded={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onChanged={load} />
              ))}
              {cards.length === 0 && <div className="p-8 text-center text-sm text-white/35">Nothing here yet.</div>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Chip({ label, n, active, onClick }: { label: string; n: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition ${
        active ? 'border-white/40 bg-white/15 text-white' : 'border-white/10 text-white/55 hover:border-white/25 hover:text-white'
      }`}
    >
      {label} <span className="font-mono text-[10px] text-white/40">{n}</span>
    </button>
  );
}

function SessionCard({ card, expanded, onToggle, onChanged }: { card: Card; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (expanded && card.title) api<Detail>(`/api/sessions/${card.id}/summary`).then(setDetail).catch(() => {});
  }, [expanded, card.id, card.title]);

  const summarize = async () => {
    setBusy(true);
    setErr(null);
    try {
      setDetail(await post<Detail>(`/api/sessions/${card.id}/summarize`));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = card.title ?? card.first_prompt ?? 'Untitled session';
  const d = detail?.summary;

  return (
    <div className={`rounded-xl border transition ${expanded ? 'border-white/20 bg-white/[0.04]' : 'border-white/8 hover:border-white/15 hover:bg-white/[0.02]'}`}>
      <button onClick={onToggle} className="w-full px-4 py-3 text-left">
        <div className="flex items-center gap-2 font-mono text-[10px] text-white/40">
          {card.category ? (
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[#22d3ee]">{card.category}</span>
          ) : (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-white/40">unsummarized</span>
          )}
          <span>{card.project ?? '—'}</span>
          <span>· {card.event_count} events</span>
          <span className="ml-auto">{when(card.last_at)}</span>
        </div>
        <div className="mt-1 text-sm font-medium text-white/90">{title.length > 140 ? title.slice(0, 140) + '…' : title}</div>
        {card.summary && <div className={`mt-1 text-xs leading-relaxed text-white/55 ${expanded ? '' : 'line-clamp-2'}`}>{card.summary}</div>}
        {card.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {card.tags.map((t) => (
              <span key={t} className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] text-white/45">{t}</span>
            ))}
          </div>
        )}
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-white/10 px-4 py-3 text-xs">
          {!card.title && (
            <div className="flex items-center gap-3">
              <button
                onClick={summarize}
                disabled={busy}
                className="rounded-md bg-white/10 px-3 py-1.5 text-white/80 transition hover:bg-white/20 disabled:opacity-50"
              >
                {busy ? 'Summarizing… (~10s)' : 'Summarize now'}
              </button>
              {err && <span className="text-red-400">{err}</span>}
            </div>
          )}
          {d && (
            <>
              <List title="Decisions" items={d.decisions} color="#a78bfa" />
              <List title="Learnings" items={d.learnings} color="#fde047" />
              <List title="Files" items={d.files} color="#4f8cff" mono />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function List({ title, items, color, mono }: { title: string; items: string[]; color: string; mono?: boolean }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em]" style={{ color }}>{title}</div>
      <ul className="space-y-1 text-white/70">
        {items.map((it, i) => (
          <li key={i} className={`flex gap-2 ${mono ? 'font-mono text-[11px]' : ''}`}>
            <span style={{ color }}>›</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
