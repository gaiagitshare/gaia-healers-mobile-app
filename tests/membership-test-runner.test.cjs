// Phase 5: the one-command runner (scripts/membership-test-all.sh) and its
// loopback-only preload keep their promises: no image pull, no fetch, a
// throwaway loopback database removed on exit, and no non-loopback traffic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const runner = fs.readFileSync(path.join(ROOT, 'scripts/membership-test-all.sh'), 'utf8');
const PRELOAD = path.join(ROOT, 'scripts/membership-test-offline.mjs');
const code = runner.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('runner: postgres is never pulled, bound to loopback only, data in tmpfs, random password', () => {
  assert.match(code, /docker run -d --rm --pull=never /);
  assert.match(code, /-p "127\.0\.0\.1:\$PORT:5432"/);
  assert.match(code, /--tmpfs \/var\/lib\/postgresql\/data/);
  assert.match(code, /PW=\$\(od -An -N24 -tx1 \/dev\/urandom/);
  assert.doesNotMatch(code, /echo[^\n]*\$PW|echo[^\n]*MEMBERSHIP_TEST_DATABASE_URL/, 'the password is never printed');
});

test('runner: the container and the temporary worktree are removed on every exit (trap)', () => {
  assert.match(code, /trap cleanup EXIT/);
  assert.match(code, /cleanup\(\) \{[\s\S]*docker rm -f "\$NAME"[\s\S]*git -C "\$REPO" worktree remove --force "\$VIEW_WT"/);
});

test('runner: nothing reaches the network beyond loopback (offline npm, no fetch, no pull, preload on every node)', () => {
  assert.doesNotMatch(code, /\bgit (fetch|pull)\b|docker pull|\bcurl\b|\bwget\b/);
  for (const m of code.matchAll(/\( ?cd [^\n]*&& npm ci[^\n]*/g)) assert.match(m[0], /npm ci --offline/, m[0]);
  assert.equal([...code.matchAll(/\( ?cd [^\n]*&& npm ci --offline/g)].length, 2);
  assert.match(code, /NODE_OPTIONS="--import=\$deny"/);
  assert.match(code, /DENY="\$REPO\/scripts\/membership-test-offline\.mjs"/);
  assert.match(code, /unset GAIA_LIVE_TESTS/);
});

test('runner: summary has suite, pass, fail, skipped, duration and commit per suite', () => {
  for (const k of ['suite', 'pass', 'fail', 'skipped', 'durationMs', 'commit']) assert.match(code, new RegExp(`\\b${k}\\b`));
  assert.match(code, /npm test --silent/);
  assert.match(code, /node --test tests\/\*\.test\.cjs/);
});

test('preload: a public name does not resolve, a literal public IP is refused, loopback still works', () => {
  const script = `
    const dns = require('node:dns'); const net = require('node:net'); const http = require('node:http');
    (async () => {
      const out = [];
      await new Promise((r) => dns.lookup('example.com', (e) => { out.push('dns:' + (e && e.code)); r(); }));
      try { await fetch('https://example.com/'); out.push('fetch:sent'); } catch (e) { out.push('fetch:' + (e.cause && e.cause.code)); }
      try { net.connect(443, '93.184.215.14'); out.push('ip:sent'); } catch (e) { out.push('ip:' + e.code); }
      const srv = http.createServer((q, s) => s.end('ok')); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      out.push('local:' + await (await fetch('http://127.0.0.1:' + srv.address().port + '/')).text()); srv.close();
      console.log(out.join(' '));
    })();`;
  const r = spawnSync(process.execPath, ['--import', PRELOAD, '-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.stdout.trim(), 'dns:ENOTFOUND fetch:ENOTFOUND ip:ENOTFOUND local:ok', r.stderr);
});
