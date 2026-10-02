/**
 * HOW MANY ASSERTIONS ACTUALLY RAN?
 *
 * "The suite is green" is a weaker statement than it sounds. A test that cannot
 * find the file it asserts on, and returns early rather than failing, reports a
 * pass. Reading the files will not tell you -- the code looks right, because it
 * is right; it just never executes.
 *
 * This counts, per suite, how many assertions the source CONTAINS against how
 * many actually RAN. A suite with 31 written and 7 executed is the shape of the
 * bug. A suite with 0 executed and a reported pass is the bug itself.
 *
 * It works by redirecting `node:assert` through a counting shim with a module
 * resolve hook, so nothing in the tests has to change.
 *
 * On 2 Oct 2026 this found 38 tests and 778 assertions that had never run on
 * the server -- including every UI contract written after somebody could not
 * stop Gaia talking -- plus two files missing from the server's test directory
 * that were taking ten suites down with them.
 *
 * Usage:  node tools/assert-census.mjs            # every suite
 *         node tools/assert-census.mjs test/sky.test.js
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync('test').filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f)).sort();

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-')), 'counts.jsonl');
const register = new URL('./assert-census/register.mjs', import.meta.url).pathname;

const rows = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--import', register, file],
      { stdio: 'ignore', timeout: 180000, env: { ...process.env, AUDIT_OUT: out, AUDIT_FILE: file } });
  } catch { /* a failing suite still reports its count on exit */ }
  const line = fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).pop();
  const executed = line ? JSON.parse(line).executed : 0;
  const src = fs.readFileSync(file, 'utf8');
  const written = (src.match(/\bassert[.(]/g) || []).length;
  rows.push({ file, written, executed });
  process.stderr.write(`\r${rows.length}/${files.length}`);
}
process.stderr.write('\n');

rows.sort((a, b) => (a.written ? a.executed / a.written : 0) - (b.written ? b.executed / b.written : 0));
// Executions, not coverage: an assertion inside a loop runs many times, so the
// ratio can exceed 100%. What matters is the bottom end -- zero, or a handful
// where the source has dozens.
console.log('\n  ran/written       suite   (executions, so >100% just means loops)');
for (const r of rows) {
  const pct = r.written ? Math.round((r.executed / r.written) * 100) : 0;
  const flag = r.executed === 0 && r.written > 0 ? '   <-- NOTHING RAN'
    : (r.written && pct < 50 ? '   <-- under half' : '');
  console.log(`  ${String(r.executed).padStart(4)}/${String(r.written).padEnd(5)} ${String(pct).padStart(3)}%  ${r.file.replace('test/', '')}${flag}`);
}
const total = rows.reduce((a, r) => a + r.executed, 0);
const dark = rows.filter((r) => r.executed === 0 && r.written > 0);
console.log(`\n  ${total} assertions executed across ${rows.length} suites`);
if (dark.length) {
  console.log(`  ${dark.length} suite(s) ran none of theirs -- check whether each one FAILS or quietly passes:`);
  for (const r of dark) console.log(`    ${r.file}`);
}
