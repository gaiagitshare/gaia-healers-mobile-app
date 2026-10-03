/**
 * THE USAGE REPORT — right numbers from synthetic records, offline, honest
 * about what is reported versus estimated versus unavailable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'assist-usage-report.mjs');
const u = await import('../assist-usage.js');

function synthetic(dir) {
  // SYNTHETIC records, built with the real record builder so the shape is exact.
  const rows = [
    // three member text replies on 5 Oct (after the price book's first entry), one with thinking and one with a cache hit
    u.buildRecord({ at: new Date('2026-10-05T10:00:00Z'), channel: 'text', provider: 'gemini', model: 'gemini-3.6-flash', state: 'member',
      usage: u.normalizeUsage('gemini', { promptTokenCount: 4000, candidatesTokenCount: 100, thoughtsTokenCount: 300, cachedContentTokenCount: 0 }) }),
    u.buildRecord({ at: new Date('2026-10-05T11:00:00Z'), channel: 'text', provider: 'gemini', model: 'gemini-3.6-flash', state: 'member',
      usage: u.normalizeUsage('gemini', { promptTokenCount: 4000, candidatesTokenCount: 120, thoughtsTokenCount: 0, cachedContentTokenCount: 3000 }) }),
    u.buildRecord({ at: new Date('2026-10-05T12:00:00Z'), channel: 'text', provider: 'gemini', model: 'gemini-3.6-flash', state: 'visitor',
      usage: u.normalizeUsage('gemini', { promptTokenCount: 3000, candidatesTokenCount: 80 }) }),
    // a failed attempt with no usage
    u.buildRecord({ at: new Date('2026-10-05T12:30:00Z'), channel: 'text', provider: 'gemini', model: 'gemini-3.6-flash', state: 'visitor', outcome: 'failed', error: 'server' }),
    // one voice session on 6 Oct with the full split
    u.buildRecord({ at: new Date('2026-10-06T09:00:00Z'), channel: 'voice', provider: 'qwen', model: 'qwen3.8-omni-flash-realtime', state: 'practitioner', turns: 3, seconds: 90,
      usage: u.normalizeUsage('qwen', { input_tokens: 24000, output_tokens: 400, input_token_details: { text_tokens: 23700, audio_tokens: 300, cached_tokens: 0 }, output_token_details: { text_tokens: 100, audio_tokens: 300 } }) }),
    // an unpriced fallback model
    u.buildRecord({ at: new Date('2026-10-06T10:00:00Z'), channel: 'text', provider: 'groq', model: 'qwen/qwen3.8-27b', state: 'member',
      usage: u.normalizeUsage('groq', { prompt_tokens: 4100, completion_tokens: 90 }) }),
  ];
  const file = path.join(dir, 'assist-usage.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\nthis line is malformed\n');
  return { file, rows };
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

test('totals are the sums of the reported counts, and the malformed line is counted, not crashed on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-')); fs.mkdirSync(path.join(dir, 'data'));
  const { file } = synthetic(path.join(dir, 'data'));
  const j = JSON.parse(run(['--file', file, '--json'], dir).stdout);
  assert.equal(j.records_in_window, 6);
  assert.equal(j.malformed_lines, 1);
  assert.equal(j.total.input_tokens, 4000 + 4000 + 3000 + 24000 + 4100);
  assert.equal(j.total.reasoning_tokens, 300);
  assert.equal(j.total.cached_input_tokens, 3000);
  assert.equal(j.total.audio_in, 300);
  assert.equal(j.total.audio_out, 300);
  assert.equal(j.total.failed_attempts, 1);
  assert.equal(j.total.usage_missing_on, 1, 'the failed attempt has no counts and is said so');
});

test('cost is recomputed from counts under the price book, and unpriced models are counted as such', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-')); fs.mkdirSync(path.join(dir, 'data'));
  const { file } = synthetic(path.join(dir, 'data'));
  const j = JSON.parse(run(['--file', file, '--json'], dir).stdout);
  assert.equal(j.total.unpriced_records, 2, 'the Groq reply and the count-less failure have no price');
  const gemini = j.by_provider_model['gemini/gemini-3.6-flash'];
  const expected = (4000 * 0.75 + 100 * 3.75 + 300 * 3.75 + (4000 - 3000) * 0.75 + 3000 * 0.075 + 120 * 3.75 + 3000 * 0.75 + 80 * 3.75) / 1e6;
  assert.ok(Math.abs(gemini.est_cost_usd_recomputed - expected) < 1e-4, `${gemini.est_cost_usd_recomputed} vs ${expected}`);
  assert.equal(gemini.cache_hit_pct, '27.3%');
});

test('date filters select by day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-')); fs.mkdirSync(path.join(dir, 'data'));
  const { file } = synthetic(path.join(dir, 'data'));
  const d1 = JSON.parse(run(['--file', file, '--from', '2026-10-05', '--to', '2026-10-05', '--json'], dir).stdout);
  assert.equal(d1.records_in_window, 4);
  const d2 = JSON.parse(run(['--file', file, '--from', '2026-10-06', '--to', '2026-10-31', '--json'], dir).stdout);
  assert.equal(d2.records_in_window, 2);
  const none = JSON.parse(run(['--file', file, '--from', '2030-01-01', '--json'], dir).stdout);
  assert.equal(none.records_in_window, 0);
  assert.match(run(['--file', file, '--from', '2030-01-01'], dir).stdout, /No records in this window/);
});

test('rotated .gz files beside the live log are read too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-')); const data = path.join(dir, 'data'); fs.mkdirSync(data);
  const { rows } = synthetic(data);
  // move the first three records into a rotated, compressed file
  const live = fs.readFileSync(path.join(data, 'assist-usage.jsonl'), 'utf8').split('\n');
  fs.writeFileSync(path.join(data, 'assist-usage.jsonl'), live.slice(3).join('\n'));
  fs.writeFileSync(path.join(data, 'assist-usage.jsonl.1.gz'), zlib.gzipSync(live.slice(0, 3).join('\n') + '\n'));
  // the tool resolves data/ relative to its own location; point it at this dir by copying the tool
  const toolsDir = path.join(dir, 'tools'); fs.mkdirSync(toolsDir);
  fs.copyFileSync(TOOL, path.join(toolsDir, 'assist-usage-report.mjs'));
  fs.copyFileSync(path.resolve(path.dirname(TOOL), '..', 'assist-pricing.js'), path.join(dir, 'assist-pricing.js'));
  const r = spawnSync(process.execPath, [path.join(toolsDir, 'assist-usage-report.mjs'), '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.records_on_file, rows.length);
  assert.ok(j.files.some((f) => f.endsWith('.gz')));
});

test('the text report labels every number as reported, estimated or unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-')); fs.mkdirSync(path.join(dir, 'data'));
  const { file } = synthetic(path.join(dir, 'data'));
  const out = run(['--file', file], dir).stdout;
  assert.match(out, /REPORTED\s+input/);
  assert.match(out, /ESTIMATED cost/);
  assert.match(out, /UNAVAILABLE pricing on 2 records/);
  assert.ok(!/sleep|Arman|@/.test(out));
});

test('the report tool is offline by construction', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /dns\.lookup = /, 'name resolution is disabled before anything runs');
  assert.ok(src.indexOf('dns.lookup = ') < src.indexOf("from '../assist-pricing.js'"));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import ${JSON.stringify(TOOL)};`], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'rep-')), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('--write-daily saves a private report file for the day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-')); const data = path.join(dir, 'data'); fs.mkdirSync(data);
  synthetic(data);
  const toolsDir = path.join(dir, 'tools'); fs.mkdirSync(toolsDir);
  fs.copyFileSync(TOOL, path.join(toolsDir, 'assist-usage-report.mjs'));
  fs.copyFileSync(path.resolve(path.dirname(TOOL), '..', 'assist-pricing.js'), path.join(dir, 'assist-pricing.js'));
  const r = spawnSync(process.execPath, [path.join(toolsDir, 'assist-usage-report.mjs'), '--from', '2026-10-05', '--to', '2026-10-05', '--write-daily'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const f = path.join(data, 'usage-reports', '2026-10-05.txt');
  assert.ok(fs.existsSync(f));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(data, 'usage-reports')).mode & 0o777, 0o700);
});
