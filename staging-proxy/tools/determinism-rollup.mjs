/**
 * Turns the harness's incremental .jsonl files into one run file the comparer
 * reads, so a run that was cut short -- or split across several workers to get
 * through it faster -- is still worth something.
 *
 * Usage: node tools/determinism-rollup.mjs out.json a.jsonl [b.jsonl ...]
 */
import fs from 'node:fs';
const [out, ...srcs] = process.argv.slice(2);
if (!out || !srcs.length) { console.error('usage: determinism-rollup.mjs <out.json> <run.jsonl...>'); process.exit(1); }
const records = srcs.flatMap((src) =>
  fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }   // a half-written tail line
  }).filter(Boolean));
fs.writeFileSync(out, JSON.stringify({ model: 'qwen3.8-omni-flash-realtime', at: new Date().toISOString(), sources: srcs, records }, null, 2));
const by = {};
for (const r of records) by[r.variant || '?'] = (by[r.variant || '?'] || 0) + 1;
const bad = records.filter((r) => r.invalid).length;
console.log(`${records.length} turns from ${srcs.length} file(s) -> ${out}`);
console.log(`  ${Object.entries(by).map(([k, v]) => `${k}: ${v}`).join('   ')}   (${bad} upstream failures)`);
