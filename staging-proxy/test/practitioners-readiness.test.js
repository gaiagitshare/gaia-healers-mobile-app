/**
 * GAIA PRACTITIONERS — production readiness.
 *
 * The switch from their staging to their production is three config values.
 * These tests pin that GAIA_PRACTITIONERS_ENV picks the right host, that an
 * explicit URL still wins, that impossible combinations are named, and that
 * the readiness tool reports READY only when everything lines up -- its probe
 * exercised against a local fake of their endpoints, never the real site.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { practitionersConfig, practitionersBootLine, PRACTITIONERS_HOSTS } from '../practitioners-oauth.js';

const FULL = { GAIA_PRACTITIONERS_ENABLED: 'true', GAIA_PRACTITIONERS_CLIENT_ID: 'id', GAIA_PRACTITIONERS_CLIENT_SECRET: 's',
  GAIA_PRACTITIONERS_REDIRECT_URI: 'https://api.gaiahealers.app/api/practitioners/callback' };

test('GAIA_PRACTITIONERS_ENV picks the host; today\'s explicit staging URLs behave exactly as before', () => {
  const st = practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_ENV: 'staging' });
  assert.equal(st.base, PRACTITIONERS_HOSTS.staging); assert.equal(st.mcpUrl, PRACTITIONERS_HOSTS.staging + '/api/mcp');
  assert.equal(st.environment, 'staging'); assert.deepEqual(st.warnings, []); assert.equal(st.enabled, true);
  const pr = practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_ENV: 'production' });
  assert.equal(pr.base, 'https://gaiapractitioners.com'); assert.equal(pr.mcpUrl, 'https://gaiapractitioners.com/api/mcp'); assert.equal(pr.environment, 'production');
  // the live config as it is today: explicit URLs, no ENV
  const today = practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_OAUTH_BASE: 'https://staging.gaiapractitioners.com', GAIA_PRACTITIONERS_MCP_URL: 'https://staging.gaiapractitioners.com/api/mcp' });
  assert.equal(today.environment, 'staging'); assert.deepEqual(today.warnings, []); assert.equal(today.enabled, true);
  // an explicit URL wins over ENV, and the contradiction is named
  const mixed = practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_ENV: 'production', GAIA_PRACTITIONERS_OAUTH_BASE: 'https://staging.gaiapractitioners.com' });
  assert.equal(mixed.base, 'https://staging.gaiapractitioners.com');
  assert.match(mixed.warnings.join(' '), /ENV=production but .* staging host/);
});

test('impossible combinations are named, and nothing without a host is enabled', () => {
  assert.equal(practitionersConfig({ ...FULL }).enabled, false, 'no ENV and no base: off, as before');
  assert.match(practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_ENV: 'prod' }).warnings.join(' '), /not staging or production/);
  assert.match(practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_ENV: 'staging', GAIA_PRACTITIONERS_MCP_URL: 'https://elsewhere.example/api/mcp' }).warnings.join(' '), /not under/);
  assert.match(practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_OAUTH_BASE: 'http://gaiapractitioners.com' }).warnings.join(' '), /not https/);
  const custom = practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_OAUTH_BASE: 'https://partner.example' });
  assert.equal(custom.environment, 'custom');
});

test('the boot line names the environment and never a secret', () => {
  const on = practitionersBootLine(practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_ENV: 'staging', GAIA_PRACTITIONERS_CLIENT_SECRET: 'super-secret-value' }));
  assert.equal(on.level, 'log'); assert.match(on.message, /ON .*environment: 'staging'/); assert.doesNotMatch(on.message, /super-secret|id'/);
  const off = practitionersBootLine(practitionersConfig({}));
  assert.match(off.message, /OFF/);
  const warned = practitionersBootLine(practitionersConfig({ ...FULL, GAIA_PRACTITIONERS_ENV: 'production', GAIA_PRACTITIONERS_OAUTH_BASE: 'https://staging.gaiapractitioners.com' }));
  assert.equal(warned.level, 'warn');
});

test('the status route tells the app which environment it is connected to', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("'/api/practitioners/status'"), src.indexOf("'/api/practitioners/connect'"));
  assert.match(block, /environment: cfg\.environment/);
  assert.match(src, /practitionersBootLine\(\)/, 'boot line is printed at startup');
});

// ── the tool ──────────────────────────────────────────────────────────────
const TOOL = new URL('../tools/practitioners-readiness.mjs', import.meta.url).pathname;
const envFile = (envText) => { const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-')), '.env'); fs.writeFileSync(file, envText); return file; };
const run = (envText, args = []) => spawnSync(process.execPath, [TOOL, '--env', envFile(envText), '--json', ...args], { encoding: 'utf8', timeout: 20000 });
// The probe talks to a fake server that lives in THIS process, so the tool
// must run asynchronously: a blocking spawn would starve the fake of its loop.
const runAsync = (envText, args = []) => new Promise((resolve) => {
  const child = spawn(process.execPath, [TOOL, '--env', envFile(envText), '--json', ...args]);
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill(), 20000);
  child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
const FULL_ENV = 'GAIA_PRACTITIONERS_ENABLED=true\nGAIA_PRACTITIONERS_CLIENT_ID=id\nGAIA_PRACTITIONERS_CLIENT_SECRET=sec\nGAIA_PRACTITIONERS_REDIRECT_URI=https://api.gaiahealers.app/api/practitioners/callback\n';

test('readiness tool: READY for a complete config, NOT READY naming each gap, secrets never printed', () => {
  const ok = run(FULL_ENV + 'GAIA_PRACTITIONERS_ENV=production\n');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const j = JSON.parse(ok.stdout);
  assert.equal(j.ready, true); assert.equal(j.environment, 'production'); assert.equal(j.clientSecret, 'set');
  assert.doesNotMatch(ok.stdout, /sec"|"id"/);
  const bad = run('GAIA_PRACTITIONERS_ENABLED=true\nGAIA_PRACTITIONERS_ENV=production\n');
  assert.equal(bad.status, 1);
  const p = JSON.parse(bad.stdout).problems.join(' | ');
  assert.match(p, /CLIENT_ID missing/); assert.match(p, /CLIENT_SECRET missing/); assert.match(p, /REDIRECT_URI/);
});

test('readiness tool --probe: a live environment passes, a not-yet-rolled-out one is named (local fake, no real site)', async () => {
  // a fake partner host: metadata + docs + mcp-401
  const live = http.createServer((req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ issuer: `http://127.0.0.1:${live.address().port}`, authorization_endpoint: 'x', token_endpoint: 'y' })); return; }
    if (req.url === '/docs/mcp') { res.setHeader('content-type', 'text/html'); res.end('<html>docs</html>'); return; }
    if (req.url === '/api/mcp') { res.statusCode = 401; res.end('{"error":"unauthorized"}'); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => live.listen(0, '127.0.0.1', r));
  const dead = http.createServer((req, res) => { res.statusCode = 404; res.end('<html>not found</html>'); });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  try {
    const good = await runAsync(FULL_ENV + `GAIA_PRACTITIONERS_OAUTH_BASE=http://127.0.0.1:${live.address().port}\n`, ['--probe']);
    const gj = JSON.parse(good.stdout);
    assert.equal(gj.probe.oauthMetadata.ok, true); assert.equal(gj.probe.docs.ok, true); assert.equal(gj.probe.mcpWithoutToken.ok, true);
    assert.deepEqual(gj.problems, ['GAIA_PRACTITIONERS_OAUTH_BASE is not https'], 'only the http-ness of the fake is wrong');
    const nope = await runAsync(FULL_ENV + `GAIA_PRACTITIONERS_OAUTH_BASE=http://127.0.0.1:${dead.address().port}\n`, ['--probe']);
    assert.equal(nope.status, 1);
    assert.match(JSON.parse(nope.stdout).problems.join(' | '), /serves no OAuth metadata \(HTTP 404\) — this environment is not live yet/);
  } finally { live.close(); dead.close(); }
});
