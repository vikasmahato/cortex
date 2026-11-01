import { create } from 'zustand';
import { REGIONS, type Region } from '@cortex/core';

/**
 * Hot, per-frame state lives outside React (typed arrays mutated by the render
 * loop). Cold UI state (selection, connection, overlays) lives in a zustand store.
 */
export const act = new Float32Array(REGIONS.length); // short-term activation, decays in seconds
export const mem = new Float32Array(REGIONS.length); // long-term retention, 0..1, seeded from history
export const memCount = new Float64Array(REGIONS.length);
/** Real-time activity only (no project glow): what the status indicator reads. */
export const live = new Float32Array(REGIONS.length);
const hold = new Float32Array(REGIONS.length); // sustained glow while a project is selected (its work "profile")

const TAU = 2.4; // seconds for activation to decay by 1/e
const pend = new Float32Array(REGIONS.length); // energy waiting to ramp in (smooths bursts of events)
const ATTACK = 0.3; // seconds for pending energy to flow into activation
const MAX_ACT = 3; // soft-saturated in the shaders, so this only bounds the maths

export function fire(region: Region, intensity = 0.7) {
  const i = REGIONS.indexOf(region);
  if (i < 0) return;
  pend[i] = Math.min(MAX_ACT, pend[i]! + intensity);
  mem[i] = Math.min(1, mem[i]! + 0.002 * intensity); // retention creeps up with use
}

/** Advance activation: pending energy ramps in smoothly, then decays. No instant jumps, so no flicker. */
export function decay(dt: number) {
  const attack = 1 - Math.exp(-dt / ATTACK);
  const k = Math.exp(-dt / TAU);
  for (let i = 0; i < act.length; i++) {
    const m = pend[i]! * attack;
    pend[i] = pend[i]! - m;
    live[i] = Math.min(MAX_ACT, live[i]! * k + m);
    act[i] = Math.max(hold[i]!, live[i]!);
  }
}

/**
 * Make the brain show the *kind of work* in a project: regions glow in proportion to
 * how much of the project's activity falls in them. Pass null to clear.
 */
export function setProfile(mix: Record<string, number> | null) {
  hold.fill(0);
  if (!mix) return;
  const max = Math.max(1, ...Object.values(mix));
  REGIONS.forEach((r, i) => {
    const share = (mix[r] ?? 0) / max; // 0..1 relative to the project's dominant region
    hold[i] = share * 0.9;
    if (share > 0.15) fire(r, share * 0.8); // a one-off pulse so the change is noticeable
  });
}

/** Seed long-term retention from historical event counts (log-scaled). */
export function seedMemory(byRegion: { region: string; n: number }[]) {
  const max = Math.max(1, ...byRegion.map((r) => Math.log1p(r.n)));
  for (const { region, n } of byRegion) {
    const i = REGIONS.indexOf(region as Region);
    if (i >= 0) {
      memCount[i] = n;
      mem[i] = Math.log1p(n) / max;
    }
  }
}

const readFlag = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const writeFlag = (key: string, value: boolean) => {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* storage unavailable: fine */ }
};
// on narrow windows the panels start collapsed so the brain is visible
const WIDE = typeof window !== 'undefined' && window.innerWidth >= 1200;

export interface NowItem {
  project: string | null;
  text: string;
  ts: string;
}

interface UIState {
  connected: boolean;
  now: NowItem | null;
  /** bumped whenever new activity or summaries arrive, so lists know to refetch */
  dataVersion: number;
  selectedProject: string | null;
  leftOpen: boolean;
  rightOpen: boolean;
  focus: Region | null;
  searchOpen: boolean;
  browseOpen: boolean;
  browseSession: string | null;
  timelineOpen: boolean;
  replayDay: string | null;
  setConnected: (c: boolean) => void;
  setNow: (n: NowItem | null) => void;
  bumpData: () => void;
  selectProject: (name: string | null) => void;
  setLeftOpen: (o: boolean) => void;
  setRightOpen: (o: boolean) => void;
  setFocus: (r: Region | null) => void;
  setSearchOpen: (o: boolean) => void;
  openBrowse: (sessionId?: string | null) => void;
  closeBrowse: () => void;
  setTimelineOpen: (o: boolean) => void;
  startReplay: (day: string) => void;
  stopReplay: () => void;
}

export const useUI = create<UIState>((set) => ({
  connected: false,
  now: null,
  dataVersion: 0,
  selectedProject: null,
  leftOpen: readFlag('cortex.left', WIDE),
  rightOpen: readFlag('cortex.right', WIDE),
  focus: null,
  searchOpen: false,
  browseOpen: false,
  browseSession: null,
  timelineOpen: false,
  replayDay: null,
  setConnected: (connected) => set({ connected }),
  setNow: (now) => set({ now }),
  bumpData: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
  selectProject: (selectedProject) => set(selectedProject ? { selectedProject, rightOpen: true } : { selectedProject }),
  setLeftOpen: (leftOpen) => { writeFlag('cortex.left', leftOpen); set({ leftOpen }); },
  setRightOpen: (rightOpen) => { writeFlag('cortex.right', rightOpen); set({ rightOpen }); },
  setFocus: (focus) => set({ focus }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  openBrowse: (sessionId = null) => set({ browseOpen: true, browseSession: sessionId, searchOpen: false }),
  closeBrowse: () => set({ browseOpen: false, browseSession: null }),
  setTimelineOpen: (timelineOpen) => set({ timelineOpen }),
  startReplay: (replayDay) => set({ replayDay, timelineOpen: false, searchOpen: false, browseOpen: false }),
  stopReplay: () => set({ replayDay: null }),
}));
