import type { Region } from '@cortex/core';
import { fire, seedMemory, useUI } from './neural.ts';

export const BASE = (import.meta.env.VITE_CORTEX_URL as string | undefined) ?? 'http://127.0.0.1:7777';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

export const api = async <T>(path: string): Promise<T> => {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
};

export const post = async <T>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${path}: ${r.status}`);
  return j;
};

interface RawEvent {
  id?: number; ts: string; kind: string; region: Region; tool: string | null; text: string; project: string | null;
}
interface Stats {
  totals: { events: number; sessions: number };
  byRegion: { region: string; n: number }[];
  byDay: { day: string; n: number }[];
}

const intensityFor = (kind: string) =>
  kind === 'tool_use' ? 0.7 : kind === 'prompt' ? 0.8 : kind === 'thinking' ? 0.6 : kind === 'tool_result' ? 0.3 : 0.45;

async function refreshStats() {
  const s = await api<Stats>('/api/stats');
  seedMemory(s.byRegion);
}

async function loadInitial() {
  const [, ev] = await Promise.all([refreshStats(), api<RawEvent[]>('/api/events?limit=80')]);
  const p = ev.find((e) => e.kind === 'prompt'); // newest first
  if (p) useUI.getState().setNow({ project: p.project, text: p.text, ts: p.ts });
  useUI.getState().bumpData();
}

export function startLive(): () => void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout>;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      retry = 0;
      useUI.getState().setConnected(true);
      loadInitial().catch(() => {});
    };
    ws.onclose = () => {
      useUI.getState().setConnected(false);
      if (!closed) timer = setTimeout(open, Math.min(8000, 800 * 2 ** retry++));
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data as string);
      if (msg.type === 'fire') {
        if (useUI.getState().replayDay) return; // replay owns the brain while it plays
        // instant hook signal: light the brain right away
        fire(msg.signal.region as Region, msg.signal.intensity ?? 0.7);
      } else if (msg.type === 'events') {
        const events = msg.events as RawEvent[];
        events.forEach((e, i) => setTimeout(() => !useUI.getState().replayDay && fire(e.region, intensityFor(e.kind)), i * 110));
        const p = [...events].reverse().find((e) => e.kind === 'prompt');
        if (p) useUI.getState().setNow({ project: p.project, text: p.text, ts: p.ts });
        useUI.getState().bumpData();
        refreshStats().catch(() => {});
      } else if (msg.type === 'summaries') {
        useUI.getState().bumpData();
      }
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    ws?.close();
  };
}
