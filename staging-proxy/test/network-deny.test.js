/**
 * THE SUITE CANNOT REACH A PAID PROVIDER, AND CANNOT WRITE THE REAL USAGE LOG.
 *
 * Both used to depend on every test remembering. Now they are structural:
 * test/_deny-network.mjs is loaded by `npm test` before any test file and
 * fails name resolution for anything that is not local or ours, and switches
 * the usage log off unless a test names its own file. These tests prove it,
 * and prove the wiring that makes it apply (package.json, CI, direct runs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyRoot = path.resolve(here, '..');
const PRELOAD = path.join(proxyRoot, 'test', '_deny-network.mjs');

/** Run a snippet in a child with the preload, the way npm test does. */
function withPreload(body, env = {}) {
  return spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', body],
    { encoding: 'utf8', cwd: proxyRoot, env: { ...process.env, ...env }, timeout: 20000 });
}

test('a fetch to a model provider fails at name resolution', () => {
  const r = withPreload(`
    try { await fetch('https://generativelanguage.googleapis.com/v1beta/models'); console.log('REACHED'); }
    catch (e) { console.log('BLOCKED ' + (e.cause?.code || e.code || e.message)); }`);
  assert.match(r.stdout, /BLOCKED/, r.stdout + r.stderr);
  assert.ok(!/REACHED/.test(r.stdout));
});

test('so does a WebSocket to the Qwen realtime host', () => {
  const r = withPreload(`
    import { createRequire } from 'node:module';
    const WebSocket = createRequire(process.cwd() + '/package.json')('ws');
    await new Promise((res) => {
      const ws = new WebSocket('wss://ws-example.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime');
      ws.on('error', (e) => { console.log('BLOCKED ' + e.message); res(); });
      ws.on('open', () => { console.log('REACHED'); res(); });
      setTimeout(() => { console.log('TIMEOUT'); res(); }, 8000);
    });`);
  assert.match(r.stdout, /BLOCKED/, r.stdout + r.stderr);
});

test('and the OpenAI-shaped hosts: Groq, OpenRouter, OpenAI, ElevenLabs', () => {
  for (const host of ['api.groq.com', 'openrouter.ai', 'api.openai.com', 'api.elevenlabs.io']) {
    const r = withPreload(`try { await fetch('https://${host}/'); console.log('REACHED'); } catch (e) { console.log('BLOCKED'); }`);
    assert.match(r.stdout, /BLOCKED/, `${host} was reachable`);
  }
});

test('a host nobody has listed yet is blocked too -- the rule is deny by default', () => {
  const r = withPreload(`try { await fetch('https://some-new-model-provider.example/'); console.log('REACHED'); } catch (e) { console.log('BLOCKED'); }`);
  assert.match(r.stdout, /BLOCKED/);
});

test('local servers still work, by address and by name', () => {
  const r = withPreload(`
    import http from 'node:http';
    const srv = http.createServer((q, s) => s.end('ok'));
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const port = srv.address().port;
    const a = await (await fetch('http://127.0.0.1:' + port + '/')).text();
    const b = await (await fetch('http://localhost:' + port + '/')).text();
    console.log('LOCAL ' + a + b);
    srv.close();`);
  assert.match(r.stdout, /LOCAL okok/, r.stdout + r.stderr);
});

test('our own public hosts are allowed, because the live-env checks use them', () => {
  // Resolution is allowed; whether the host answers is not this test's business.
  const r = withPreload(`
    import dns from 'node:dns';
    for (const h of ['api.gaiahealers.app', 'gaiahealers.app']) {
      await new Promise((res) => dns.lookup(h, (err) => { console.log(h + ' ' + (err && /TEST NETWORK DENY/.test(err.message) ? 'DENIED' : 'allowed')); res(); }));
    }`);
  assert.ok(!/DENIED/.test(r.stdout), r.stdout);
});

test('the preload switches the usage log off unless a test names a file', () => {
  const r = withPreload(`console.log('LOG=' + JSON.stringify(process.env.GAIA_USAGE_LOG));`, { GAIA_USAGE_LOG: undefined });
  assert.match(r.stdout, /LOG=""/);
  const named = withPreload(`console.log('LOG=' + JSON.stringify(process.env.GAIA_USAGE_LOG));`, { GAIA_USAGE_LOG: '/tmp/x.jsonl' });
  assert.match(named.stdout, /LOG="\/tmp\/x\.jsonl"/);
});

// ── the wiring that makes it apply ────────────────────────────────────────

test('npm test loads the preload, and CI runs npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(proxyRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /--import \.\/test\/_deny-network\.mjs/, 'npm test must load the deny preload');
  const ci = path.resolve(proxyRoot, '..', '.github', 'workflows', 'staging-proxy-ci.yml');
  if (fs.existsSync(ci)) assert.match(fs.readFileSync(ci, 'utf8'), /run: npm test/, 'CI must go through npm test');
});

test('every test that boots the server or the relay also redirects the usage log itself', () => {
  // The preload covers `npm test`. A file run directly (`node test/x.test.js`,
  // which the assertion census does) has no preload, so the two suites that
  // open fake voice sessions, and anything that boots server.js, must say so
  // in their own setup. Six fake sessions reached the production log this way.
  const offenders = [];
  for (const f of fs.readdirSync(here).filter((n) => n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(here, f), 'utf8');
    // Opens fake voice sessions, or stubs a text provider whose reply would be recorded.
    const boots = /from '\.\.\/qwen-voice-relay\.js'|import\([^)]*qwen-voice-relay\.js|import\([^)]*\.\.\/server\.js|from '\.\.\/server\.js'/.test(src);
    const stubsProvider = /usageMetadata|x_groq|api\.groq\.com|generativelanguage|response\.done/.test(src);
    if (!boots || !stubsProvider) continue;
    if (!/GAIA_USAGE_LOG/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'these can record usage but do not set GAIA_USAGE_LOG:\n  ' + offenders.join('\n  '));
});

test('under node --test, the default log path is off even without the preload', async () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const u = await import(${JSON.stringify(path.join(proxyRoot, 'assist-usage.js'))});
    u.recordUsage({ channel: 'voice', provider: 'qwen', model: 'm', usage: u.emptyUsage() });
    console.log('exists=' + (await import('node:fs')).existsSync('data/assist-usage.jsonl'));`],
    { encoding: 'utf8', cwd: fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'usage-off-')), env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', GAIA_USAGE_LOG: undefined } });
  assert.match(r.stdout, /exists=false/, r.stdout + r.stderr);
});
