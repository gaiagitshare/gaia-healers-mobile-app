/**
 * Diffs two determinism-harness runs. Reports the per-group rate, the overall
 * practitioner-data rate, and -- because a run of eight is a small sample -- a
 * two-proportion z test per group, so a change can be told from noise.
 *
 * Usage: node tools/determinism-compare.mjs before.json after.json [more.json]
 */
import fs from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) { console.error("need at least one run"); process.exit(1); }
let runs = files.map((f) => ({ name: f.replace(/^.*\//, '').replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(f, 'utf8')) }));

// An interleaved run holds both variants in one file; split it so the two are
// compared as separate columns. This is the design that matters: measured an
// hour apart, one configuration scored fifteen points lower than itself.
runs = runs.flatMap((run) => {
  const vs = [...new Set(run.records.map((r) => r.variant).filter(Boolean))];
  if (vs.length < 2) return [run];
  return vs.sort().reverse().map((v) => ({ ...run, name: v, records: run.records.filter((r) => r.variant === v) }));
});

// An upstream ModelServingError is not a decision the model made.
for (const run of runs) {
  const bad = run.records.filter((r) => r.invalid).length;
  if (bad) console.log(`${run.name}: ${bad} of ${run.records.length} turns failed upstream, excluded`);
  run.records = run.records.filter((r) => !r.invalid);
}

const DATA_GROUPS = (g) => g.startsWith('intent/') || g === 'follow-ups';

function tally(run) {
  const g = new Map();
  for (const r of run.records) {
    if (!g.has(r.group)) g.set(r.group, { n: 0, pass: 0 });
    const row = g.get(r.group);
    row.n += 1; if (r.pass) row.pass += 1;
  }
  return g;
}
const tallies = runs.map(tally);
const groups = [...new Set(tallies.flatMap((t) => [...t.keys()]))].sort();

/** Two-proportion z, so "67% vs 45%" can be told from a small-sample wobble. */
function z(a, b) {
  if (!a || !b || !a.n || !b.n) return null;
  const p = (a.pass + b.pass) / (a.n + b.n);
  const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  if (!se) return null;
  return (b.pass / b.n - a.pass / a.n) / se;
}
const sig = (zz) => (zz == null ? '' : Math.abs(zz) >= 2.58 ? ' **' : Math.abs(zz) >= 1.96 ? ' *' : '');
const pct = (r) => (r && r.n ? ((r.pass / r.n) * 100).toFixed(0).padStart(3) + '%' : '    -');
const frac = (r) => (r && r.n ? `${r.pass}/${r.n}` : '-');

const W = Math.max(22, ...groups.map((g) => g.length + 2));
console.log('\n' + 'group'.padEnd(W) + runs.map((r) => r.name.padStart(14)).join('') + '   sig vs first');
console.log('-'.repeat(W + 14 * runs.length + 16));
for (const g of groups) {
  const cells = tallies.map((t) => t.get(g));
  const line = g.padEnd(W) + cells.map((c) => `${pct(c)} ${frac(c).padStart(7)}`.padStart(14)).join('');
  const last = cells[cells.length - 1];
  console.log(line + sig(z(cells[0], last)).padStart(6));
}

console.log('\n' + 'PRACTITIONER DATA (all)'.padEnd(W)
  + tallies.map((t) => {
      const tot = [...t.entries()].filter(([g]) => DATA_GROUPS(g))
        .reduce((a, [, v]) => ({ n: a.n + v.n, pass: a.pass + v.pass }), { n: 0, pass: 0 });
      return `${pct(tot)} ${frac(tot).padStart(7)}`.padStart(14);
    }).join(''));

// Controls are the safety net: a run that gained on data by firing tools during
// small talk has not improved anything.
console.log('CONTROLS (must stay 100%)'.padEnd(W)
  + tallies.map((t) => {
      const c = t.get('controls') || { n: 0, pass: 0 };
      const m = t.get('member') || { n: 0, pass: 0 };
      const tot = { n: c.n + m.n, pass: c.pass + m.pass };
      return `${pct(tot)} ${frac(tot).padStart(7)}`.padStart(14);
    }).join(''));

console.log('\n* p<0.05, ** p<0.01 (two-proportion z, last run vs first)\n');

// ── where the misses go, which is the actionable part ────────────────────
console.log('miss shape, by run:');
for (const [i, run] of runs.entries()) {
  const misses = run.records.filter((r) => !r.pass && DATA_GROUPS(r.group));
  const navigate = misses.filter((r) => r.calls.includes('navigate')).length;
  const silent = misses.filter((r) => !r.calls.length && /\b(I'?ll|I am|I will|let me|I can pull)\b/i.test(r.spoken || '')).length;
  const refused = misses.filter((r) => !r.calls.length && /can'?t|cannot|don'?t have|not on your list|need to know which/i.test(r.spoken || '')).length;
  const answered = misses.length - navigate - silent - refused;
  console.log(`  ${run.name.padEnd(12)} ${String(misses.length).padStart(3)} misses` +
    `  navigate-instead ${String(navigate).padStart(3)}` +
    `  promised-nothing ${String(silent).padStart(3)}` +
    `  declined ${String(refused).padStart(3)}` +
    `  answered-from-context ${String(answered).padStart(3)}`);
}
console.log('');
