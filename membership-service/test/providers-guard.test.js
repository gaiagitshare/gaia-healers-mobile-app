import './_providers-deny-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'providers');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('network deny: fetch, DNS and raw sockets to any non-loopback host are refused', async () => {
  await assert.rejects(fetch('https://api.stripe.com/v1/customers'), /TEST NETWORK DENY/);
  await assert.rejects(fetch('https://services.leadconnectorhq.com/contacts/x'), /TEST NETWORK DENY/);
  await assert.rejects(fetch('http://93.184.216.34/'), /TEST NETWORK DENY/, 'literal public IP');
  await assert.rejects(dns.promises.lookup('api.stripe.com'), /TEST NETWORK DENY/);
  assert.throws(() => net.connect({ host: '8.8.8.8', port: 443 }), /TEST NETWORK DENY/);
  assert.throws(() => net.connect(443, '1.1.1.1'), /TEST NETWORK DENY/);
});

test('every provider test file installs the network deny before anything else', () => {
  const files = fs.readdirSync(HERE).filter((f) => /^providers-.*\.test\.js$/.test(f));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const first = fs.readFileSync(path.join(HERE, f), 'utf8').split('\n').find((l) => l.trim() && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith(' *'));
    assert.equal(first.trim(), "import './_providers-deny-network.mjs';", `${f} must import the network deny first`);
  }
});

test('provider adapters never read the environment, never default to global fetch, never enable live mode', () => {
  for (const file of walk(SRC)) {
    const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /process\.env/, `${file} reads process.env (credentials must be injected)`);
    assert.doesNotMatch(code, /globalThis\.fetch|\bfetch\s*=\s*\w|require\(|node:https?['"]|node:net['"]/, `${file} defaults to a global fetch or opens its own transport`);
    assert.doesNotMatch(code, /allowLive:\s*true/, `${file} enables Stripe live mode`);
    assert.doesNotMatch(code, /sk_live_[A-Za-z0-9]{6,}|rk_live_[A-Za-z0-9]{6,}/, `${file} contains a live key`);
  }
});
