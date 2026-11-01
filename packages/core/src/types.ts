export const REGIONS = [
  'prefrontal', 'occipital', 'motor', 'parietal',
  'temporal', 'hippocampus', 'cerebellum', 'amygdala',
] as const;
export type Region = (typeof REGIONS)[number];

export const EVENT_KINDS = ['prompt', 'reply', 'thinking', 'tool_use', 'tool_result'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** A normalized, redacted unit of activity extracted from a Claude Code transcript. */
export interface CortexEvent {
  /** Stable de-dup key: `${transcript uuid}:${block index}` */
  key: string;
  sessionId: string;
  ts: string; // ISO-8601
  kind: EventKind;
  region: Region;
  tool: string | null;
  text: string;
  isError: boolean;
  isSidechain: boolean;
  cwd: string | null;
  project: string | null;
  branch: string | null;
}

/** Live signal pushed to the UI so the brain can fire immediately. */
export interface FireSignal {
  region: Region;
  tool: string | null;
  hook: string;
  sessionId: string;
  project: string | null;
  intensity: number; // 0..1
  ts: string;
}
