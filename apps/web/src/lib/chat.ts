import { create } from 'zustand';
import { BASE } from './live.ts';
import { useUI } from './neural.ts';

export type ChatMode = 'ask' | 'edit';
export interface ChatMsg {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
}
interface Chat {
  sessionId: string | null;
  messages: ChatMsg[];
  busy: boolean;
  mode: ChatMode;
}
interface ChatStore {
  chats: Record<string, Chat>;
  send: (project: string, prompt: string) => Promise<void>;
  stop: (project: string) => void;
  setMode: (project: string, mode: ChatMode) => void;
  reset: (project: string) => void;
}

const blank = (): Chat => ({ sessionId: null, messages: [], busy: false, mode: 'ask' });
const aborters = new Map<string, AbortController>();
let nextId = 1;

type ServerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'done'; ok: boolean; text?: string }
  | { type: 'error'; message: string };

export const useChat = create<ChatStore>((set, get) => {
  const patch = (project: string, fn: (c: Chat) => Chat) =>
    set((s) => ({ chats: { ...s.chats, [project]: fn(s.chats[project] ?? blank()) } }));
  const push = (project: string, role: ChatMsg['role'], text: string) =>
    patch(project, (c) => ({ ...c, messages: [...c.messages, { id: nextId++, role, text }] }));

  const handle = (project: string, ev: ServerEvent) => {
    switch (ev.type) {
      case 'session':
        patch(project, (c) => ({ ...c, sessionId: ev.sessionId }));
        break;
      case 'text':
        push(project, 'assistant', ev.text);
        break;
      case 'tool':
        push(project, 'tool', `${ev.name}${ev.detail ? ` · ${ev.detail}` : ''}`);
        break;
      case 'done':
        if (ev.text) push(project, 'assistant', ev.text);
        if (!ev.ok) push(project, 'error', 'Claude reported an error for this request.');
        break;
      case 'error':
        push(project, 'error', ev.message);
        break;
    }
  };

  return {
    chats: {},

    setMode: (project, mode) => patch(project, (c) => ({ ...c, mode })),
    reset: (project) => {
      aborters.get(project)?.abort();
      patch(project, (c) => ({ ...blank(), mode: c.mode }));
    },
    stop: (project) => aborters.get(project)?.abort(),

    send: async (project, prompt) => {
      const cur = get().chats[project] ?? blank();
      if (cur.busy || !prompt.trim()) return;
      push(project, 'user', prompt);
      patch(project, (c) => ({ ...c, busy: true }));

      const ac = new AbortController();
      aborters.set(project, ac);
      try {
        const res = await fetch(`${BASE}/api/projects/${encodeURIComponent(project)}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cortex-client': 'web' },
          body: JSON.stringify({ prompt, sessionId: cur.sessionId ?? undefined, mode: cur.mode }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          push(project, 'error', j.error ?? `Request failed (${res.status})`);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data:')) {
                try { handle(project, JSON.parse(line.slice(5).trim()) as ServerEvent); } catch { /* ignore a malformed frame */ }
              }
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') push(project, 'error', (e as Error).message);
        else push(project, 'error', 'Stopped.');
      } finally {
        aborters.delete(project);
        patch(project, (c) => ({ ...c, busy: false }));
        useUI.getState().bumpData(); // the conversation is now a session in this project
      }
    },
  };
});
