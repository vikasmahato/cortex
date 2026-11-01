#!/usr/bin/env node
// Claude Code hook -> Cortex daemon. Must be fast and must NEVER break Claude:
// any failure is swallowed and the process always exits 0 with no output.
const URL = process.env.CORTEX_URL ?? 'http://127.0.0.1:7777/hook';

// Cortex's own headless claude calls must not feed back into Cortex.
if (process.env.CORTEX_INTERNAL) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', async () => {
  try {
    if (raw.trim()) {
      await fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
        signal: AbortSignal.timeout(500),
      });
    }
  } catch {
    // daemon not running: transcript backfill will catch up later
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
