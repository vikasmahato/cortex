import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeTranscriptLine, type CortexEvent } from '@cortex/core';
import type { CortexDB } from '@cortex/db';

export const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');

/** Recursively list every transcript (*.jsonl) under the Claude projects directory. */
export function listTranscripts(dir = PROJECTS_DIR): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Read any new complete lines from a transcript since the last stored offset,
 * normalize them, and persist. Returns the newly inserted events.
 * Safe to call repeatedly and concurrently with Claude appending to the file.
 */
export function ingestFile(db: CortexDB, path: string): CortexEvent[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  let offset = db.getOffset(path);
  if (size < offset) offset = 0; // file was truncated/replaced
  if (size === offset) return [];

  const buf = Buffer.alloc(size - offset);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }

  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return []; // no complete line yet
  const chunk = buf.subarray(0, lastNl + 1).toString('utf8');

  const events: CortexEvent[] = [];
  for (const raw of chunk.split('\n')) {
    if (!raw.trim()) continue;
    try {
      events.push(...normalizeTranscriptLine(JSON.parse(raw)));
    } catch {
      // Undocumented format: skip malformed/unknown lines rather than failing the file.
    }
  }
  const fresh = db.insertEvents(events);
  db.setOffset(path, offset + lastNl + 1);
  return fresh;
}
