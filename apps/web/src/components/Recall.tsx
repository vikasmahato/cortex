import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { REGION_META, type Region } from '../lib/regions.ts';
import { useUI } from '../lib/neural.ts';
import { api, post } from '../lib/live.ts';

interface Hit {
  id: number; session_id: string; ts: string; kind: string; region: Region; tool: string | null; project: string | null; snippet: string;
}
interface Source {
  ref: string; type: 'session' | 'event'; sessionId: string; title: string; project: string | null; ts: string; snippet: string;
}
interface Answer { answer: string; sources: Source[]; regions: Region[] }

type Mode = 'ask' | 'search';

/** Render the answer text, turning [S1]/[E2] citations into chips. */
function AnswerText({ text, onCite }: { text: string; onCite: (ref: string) => void }) {
  return (
    <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-white/85">
      {text.split(/(\[[SE]\d+\])/g).map((part, i) =>
        /^\[[SE]\d+\]$/.test(part) ? (
          <button
            key={i}
            onClick={() => onCite(part.slice(1, -1))}
            className="mx-0.5 rounded bg-[#fde047]/15 px-1 font-mono text-[11px] text-[#fde047] hover:bg-[#fde047]/30"
          >
            {part.slice(1, -1)}
          </button>
        ) : (
          <span key={i}>{part.replace(/\*\*(.+?)\*\*/g, '$1')}</span>
        ),
      )}
    </div>
  );
}

export function RecallOverlay() {
  const { searchOpen, setSearchOpen, openBrowse } = useUI();
  const [mode, setMode] = useState<Mode>('ask');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asked, setAsked] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(!useUI.getState().searchOpen);
      } else if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearchOpen]);

  useEffect(() => {
    if (searchOpen) setTimeout(() => inputRef.current?.focus(), 30);
  }, [searchOpen, mode]);

  // live keyword search
  useEffect(() => {
    if (mode !== 'search' || !q.trim()) return setHits([]);
    const t = setTimeout(
      () => api<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`).then(setHits).catch(() => setHits([])),
      160,
    );
    return () => clearTimeout(t);
  }, [q, mode]);

  const ask = async () => {
    const question = q.trim();
    if (!question || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    setAsked(question);
    try {
      setAnswer(await post<Answer>('/api/ask', { question }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const openSource = (ref: string) => {
    const s = answer?.sources.find((x) => x.ref === ref);
    if (s) openBrowse(s.sessionId);
  };

  return (
    <AnimatePresence>
      {searchOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-20 flex items-start justify-center bg-black/55 pt-[10vh] backdrop-blur-sm"
          onClick={() => setSearchOpen(false)}
        >
          <motion.div
            initial={{ y: -12, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            className="glass w-[min(760px,94vw)] overflow-hidden rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1 border-b border-white/10 px-3 pt-3 font-mono text-[11px]">
              {(['ask', 'search'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-t-md px-3 py-1.5 uppercase tracking-widest transition ${mode === m ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'}`}
                >
                  {m === 'ask' ? 'Ask Cortex' : 'Search'}
                </button>
              ))}
              <span className="ml-auto pb-1.5 pr-2 text-white/30">Tab to switch · Esc to close</span>
            </div>
            <input
              autoFocus
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  setMode((m) => (m === 'ask' ? 'search' : 'ask'));
                } else if (e.key === 'Enter' && mode === 'ask') void ask();
              }}
              placeholder={mode === 'ask' ? 'Ask anything — “what did I decide about the Pi transfer?”' : 'Search everything you’ve done with Claude…'}
              className="w-full bg-transparent px-5 py-4 text-base text-white outline-none placeholder:text-white/30"
            />

            <div className="scroll-thin max-h-[56vh] overflow-y-auto border-t border-white/10">
              {mode === 'search' && (
                <>
                  {hits.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => openBrowse(h.session_id)}
                      className="block w-full border-b border-white/5 px-5 py-3 text-left last:border-0 hover:bg-white/5"
                    >
                      <div className="flex items-center gap-2 font-mono text-[10px] text-white/40">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: REGION_META[h.region].color }} />
                        <span style={{ color: REGION_META[h.region].color }}>{h.tool ?? h.kind}</span>
                        {h.project && <span>· {h.project}</span>}
                        <span className="ml-auto">{new Date(h.ts).toLocaleString()}</span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap text-sm text-white/75">{h.snippet}</div>
                    </button>
                  ))}
                  {q.trim() && hits.length === 0 && <div className="px-5 py-6 text-sm text-white/35">No memories found.</div>}
                </>
              )}

              {mode === 'ask' && (
                <div className="px-5 py-4">
                  {!asked && !loading && (
                    <div className="py-4 text-sm text-white/35">
                      Press <kbd className="rounded bg-white/10 px-1.5 font-mono text-[10px]">Enter</kbd> to ask. Cortex answers from your
                      own history and cites the sessions it used — the brain lights up where the memories came from.
                    </div>
                  )}
                  {loading && (
                    <div className="flex items-center gap-3 py-4 text-sm text-[#fde047]">
                      <span className="live-dot h-2 w-2 rounded-full bg-[#fde047] shadow-[0_0_12px_#fde047]" />
                      Recalling…
                    </div>
                  )}
                  {error && <div className="py-3 text-sm text-red-400">{error}</div>}
                  {answer && (
                    <div className="space-y-4">
                      <div className="font-mono text-[11px] uppercase tracking-widest text-white/35">{asked}</div>
                      <AnswerText text={answer.answer} onCite={openSource} />
                      {answer.sources.length > 0 && (
                        <div className="space-y-1.5 border-t border-white/10 pt-3">
                          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/35">Sources</div>
                          {answer.sources.map((s) => (
                            <button
                              key={s.ref}
                              onClick={() => openBrowse(s.sessionId)}
                              className="flex w-full items-start gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/5"
                            >
                              <span className="mt-0.5 rounded bg-white/10 px-1.5 font-mono text-[10px] text-[#fde047]">{s.ref}</span>
                              <span className="min-w-0">
                                <span className="block truncate text-xs text-white/80">{s.title}</span>
                                <span className="block font-mono text-[10px] text-white/35">
                                  {s.project ?? '—'} · {s.ts.slice(0, 10)}
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
