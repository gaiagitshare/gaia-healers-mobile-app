/**
 * THE PAID-API RULE, ENFORCED IN CODE (AGENTS.md).
 *
 * On 2-3 Oct 2026 a test harness sent ~5,400 requests and ~90 million tokens to
 * a pay-as-you-go model account -- about 99% of that month's bill -- because
 * nothing counted. These tests make the rule hold without anyone remembering it:
 *
 *   - the guard refuses a run above its cap, and never raises its own cap
 *   - a run that miscounts its plan still cannot spend past the cap
 *   - --dry-run sends nothing
 *   - EVERY script that can reach a paid API uses the guard, including ones
 *     written later. A new probe without it fails here, in CI.
 *
 * Nothing in this file touches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appRoots } from './_app-present.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyRoot = path.resolve(here, '..');
const GUARD = path.join(proxyRoot, 'tools', 'paid-call-guard.mjs');

/** Run a tiny script that installs the guard, in a child, with fetch faked. */
function runGuarded({ planned, argv = [], calls = 0 }) {
  const body = `
    globalThis.fetch = async () => new Response('{}');           // no network, ever
    const { installPaidCallGuard } = await import(${JSON.stringify(GUARD)});
    installPaidCallGuard({ label: 't', planned: ${planned}, argv: ${JSON.stringify(argv)} });
    let made = 0;
    try { for (let i = 0; i < ${calls}; i++) { await fetch('https://paid.example.com/v1'); made++; } }
    catch (e) { console.log('THREW after ' + made + ': ' + e.message); process.exit(3); }
    console.log('MADE ' + made);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', body], { encoding: 'utf8' });
}

test('above the default cap of 5, the run is refused before anything is sent', () => {
  const r = runGuarded({ planned: 6, calls: 6 });
  assert.equal(r.status, 2, 'a refused run exits 2');
  assert.match(r.stderr, /REFUSED: 6 planned paid calls exceeds the cap of 5/);
  assert.ok(!/MADE/.test(r.stdout), 'and makes no calls at all');
});

test('the refusal says what approval needs: count, tokens, cost, reason', () => {
  const r = runGuarded({ planned: 40 });
  assert.match(r.stderr, /planned paid calls: 40/);
  assert.match(r.stderr, /explicit approval FIRST/);
  assert.match(r.stderr, /request count, estimated tokens, minimum cost and the reason/);
});

test('an unknown cost is called out as a reason to stop and ask', () => {
  const r = runGuarded({ planned: 1, argv: ['--dry-run'] });
  assert.match(r.stderr, /cost cannot be estimated reliably/);
  assert.match(r.stderr, /stop and ask/);
});

test('estimates are presented as a floor, because failed calls can still bill', () => {
  const r = runGuarded({ planned: 1, argv: ['--dry-run'] });
  assert.match(r.stderr, /estimates are a floor/);
});

test('--dry-run sends nothing, even within the cap', () => {
  const r = runGuarded({ planned: 2, calls: 2, argv: ['--dry-run'] });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /dry run: nothing sent/);
  assert.ok(!/MADE/.test(r.stdout));
});

test('a run that miscounted its plan still cannot spend past the cap', () => {
  // Plans 1, actually tries 9. The sixth outbound call must throw.
  const r = runGuarded({ planned: 1, calls: 9 });
  assert.equal(r.status, 3, `expected the guard to stop the run: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /THREW after 5: .*paid-call cap reached \(5\)/);
});

test('an approved larger cap is honoured exactly, and not exceeded', () => {
  const r = runGuarded({ planned: 8, calls: 9, argv: ['--max-requests', '8'] });
  assert.match(r.stdout, /THREW after 8/, 'approval for 8 is approval for 8, not 9');
});

test('local calls (the test server itself) are not counted', async () => {
  const body = `
    globalThis.fetch = async () => new Response('{}');
    const { installPaidCallGuard } = await import(${JSON.stringify(GUARD)});
    const g = installPaidCallGuard({ label: 't', planned: 1, argv: [] });
    for (let i = 0; i < 20; i++) await fetch('http://127.0.0.1:8787/health');
    await fetch('http://localhost:9/x');
    console.log('USED ' + g.used());
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], { encoding: 'utf8' });
  assert.match(r.stdout, /USED 0/);
});

test('the guard never raises its own cap', () => {
  const src = fs.readFileSync(GUARD, 'utf8');
  assert.match(src, /export const DEFAULT_MAX_PAID_REQUESTS = 5;/);
  assert.ok(!/max\s*=\s*Math\.max|max\s*\+=|max\s*\*=/.test(src),
    'no code path may increase the cap on the script\'s own initiative');
});

// ── every paid script uses it, including ones not written yet ─────────────

// Provider-independent: any reference to a known model host OR to an
// environment variable that names an API key. A new provider's key will be
// called *_API_KEY too, which is what makes this catch scripts nobody has
// thought about yet.
const PAID = /api-ws\/v1\/realtime|aliyuncs\.com|dashscope|generativelanguage\.googleapis|api\.openai\.com|api\.groq\.com|openrouter\.ai|api\.elevenlabs\.io|api\.anthropic\.com|[A-Z][A-Z0-9_]*_API_KEY\b/;

function scriptsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(mjs|cjs|js|py)$/.test(f)).map((f) => path.join(dir, f));
}

test('every script that can reach a paid API installs the guard', () => {
  const app = appRoots()[0];
  const dirs = [
    path.join(proxyRoot, 'tools'), path.join(proxyRoot, 'scripts'),
    ...(app ? [path.join(app, 'scripts'), path.join(app, 'staging-proxy', 'scripts'), path.join(app, 'staging-proxy', 'tools')] : []),
  ];
  const seen = new Set();
  const offenders = [];
  for (const dir of dirs) {
    for (const file of scriptsIn(dir)) {
      const real = fs.realpathSync(file);
      if (seen.has(real) || path.basename(file) === 'paid-call-guard.mjs') continue;
      seen.add(real);
      const src = fs.readFileSync(file, 'utf8');
      if (!PAID.test(src)) continue;
      if (!/installPaidCallGuard\(/.test(src)) offenders.push(path.relative(path.resolve(proxyRoot, '..'), file));
    }
  }
  assert.deepEqual(offenders, [],
    'these can call a paid API with no programmatic cap -- install tools/paid-call-guard.mjs (AGENTS.md):\n  '
    + offenders.join('\n  '));
});

test('scripts that open a paid WebSocket count it before connecting', () => {
  const app = appRoots()[0];
  const files = [path.join(proxyRoot, 'tools', 'determinism-harness.mjs'),
                 path.join(proxyRoot, 'tools', 'assist-live-check.mjs'),
                 ...(app ? [path.join(app, 'scripts', 'assist-quality-probe.mjs'),
                            path.join(app, 'staging-proxy', 'scripts', 'voice-latency-probe.mjs')] : [])];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/new WebSocket\(/g)) {
      const before = src.slice(Math.max(0, m.index - 220), m.index);
      assert.match(before, /\.count\(/, `${path.basename(file)} opens a WebSocket without counting it first`);
    }
  }
});

test('the project rule itself is in the repository, not only in somebody\'s memory', () => {
  const app = appRoots()[0];
  const candidates = [path.join(proxyRoot, 'AGENTS.md'), ...(app ? [path.join(app, 'AGENTS.md')] : [])];
  const found = candidates.filter((f) => fs.existsSync(f));
  assert.ok(found.length > 0, 'AGENTS.md with the paid-API rule must exist');
  for (const f of found) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /PAID APIs? AND MODELS/i, `${f} is missing the paid-API rule`);
    assert.match(src, /\b5\b/, `${f} must state the default cap`);
  }
});

test('the copies of the rule are identical, so they cannot drift apart', () => {
  // The rule lives at the app repo root, in staging-proxy/ (the mirror), and in
  // the live proxy directory on the server, which is not a git checkout and is
  // where agents often work directly. One wording, three places.
  const app = appRoots()[0];
  const copies = [path.join(proxyRoot, 'AGENTS.md'),
                  ...(app ? [path.join(app, 'AGENTS.md'), path.join(app, 'staging-proxy', 'AGENTS.md')] : [])]
    .filter((f) => fs.existsSync(f));
  const texts = new Set(copies.map((f) => fs.readFileSync(f, 'utf8')));
  assert.equal(texts.size, 1, 'AGENTS.md differs between:\n  ' + copies.join('\n  '));
  for (const f of copies) {
    const claude = path.join(path.dirname(f), 'CLAUDE.md');
    assert.ok(fs.existsSync(claude), `${claude} is missing`);
    assert.match(fs.readFileSync(claude, 'utf8'), /^@AGENTS\.md$/m, `${claude} must import AGENTS.md`);
  }
});
