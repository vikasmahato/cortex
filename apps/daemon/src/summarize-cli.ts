import { CortexDB } from '@cortex/db';
import { summarizePending } from './summarize.ts';

// usage: npm run summarize -- [--limit 20] [--concurrency 2] [--idle 15]
const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};

const db = new CortexDB();
const limit = arg('limit', 20);
console.log(`Summarizing up to ${limit} sessions (newest first)…`);
const r = await summarizePending(db, { limit, concurrency: arg('concurrency', 2), minIdleMinutes: arg('idle', 15), log: console.log });
console.log(`Done: ${r.done} summarized, ${r.failed} failed, of ${r.total}.`);
db.close();
