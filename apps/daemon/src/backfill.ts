import { CortexDB } from '@cortex/db';
import { ingestFile, listTranscripts } from './ingest.ts';

const db = new CortexDB();
const files = listTranscripts();
let total = 0;
const t0 = Date.now();
for (const [i, f] of files.entries()) {
  total += ingestFile(db, f).length;
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${files.length} files, ${total} events`);
}
console.log(`Backfill done: ${files.length} transcripts, ${total} new events in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(db.stats().totals));
db.close();
