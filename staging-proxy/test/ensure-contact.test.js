// Bio-Well station (10 Nov 2026): /api/event/ensure-contact.
// An existing contact is returned untouched; a contact is created (no tags)
// only when none exists; several matches are refused; service token only.
// Loopback fake GHL: no network, no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-contact-'));
const SECRET = 'ensure-contact-session-secret-'.padEnd(48, 'x');
const SVC = 'svc-token-for-tests-0123456789';
const PORT = 8973;
const upserts = [];
const contacts = [{ id: 'c-existing', email: 'known@example.test' }, { id: 'c-a', email: 'twice@example.test' }, { id: 'c-b', email: 'TWICE@example.test' }];

const ghl = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/contacts/') {
      const q = String(u.searchParams.get('query') || '').toLowerCase();
      res.end(JSON.stringify({ contacts: contacts.filter((c) => c.email.toLowerCase().includes(q)) })); return;
    }
    if (req.method === 'POST' && u.pathname === '/contacts/upsert') {
      const b = JSON.parse(body || '{}'); upserts.push(b);
      res.end(JSON.stringify({ contact: { id: 'c-new-' + upserts.length } })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => ghl.listen(0, '127.0.0.1', r));

Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1', GHL_API_BASE_URL: `http://127.0.0.1:${ghl.address().port}`, GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'loc',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9', GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false', GAIA_USAGE_LOG: '',
  AUTH_SESSION_SECRET: SECRET, COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, GHL_WORKFLOW_WEBHOOK_SECRET: SECRET,
  IDENTITY_SERVICE_TOKEN: SVC,
});
process.chdir(dir);
const srv = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => { srv.closeServer?.(); ghl.close(); });

async function call(body, token = SVC) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/event/ensure-contact`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test('service token required', async () => {
  assert.equal((await call({ email: 'a@example.test' }, null)).status, 401);
  assert.equal((await call({ email: 'a@example.test' }, 'wrong')).status, 401);
});

test('an existing contact is returned and NOT updated', async () => {
  const before = upserts.length;
  const r = await call({ email: ' Known@Example.test ', firstName: 'Other', lastName: 'Name' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, contactId: 'c-existing', created: false });
  assert.equal(upserts.length, before, 'no upsert for an existing contact');
});

test('several contacts with the address: refused, nothing created', async () => {
  const before = upserts.length;
  const r = await call({ email: 'twice@example.test' });
  assert.equal(r.status, 409);
  assert.equal(r.json.reason, 'several_contacts');
  assert.equal(upserts.length, before);
});

test('a new address: one contact created, with no tags', async () => {
  const r = await call({ email: 'Guest.Own@example.test', firstName: 'Guest', lastName: 'Own' });
  assert.equal(r.status, 200);
  assert.equal(r.json.created, true);
  const u = upserts[upserts.length - 1];
  assert.equal(u.email, 'guest.own@example.test');
  assert.equal(u.tags, undefined, 'no tags, so no tag-triggered workflow');
  assert.match(u.source, /Bio-Well station/);
});

test('an invalid address is refused', async () => {
  assert.equal((await call({ email: 'not an email' })).status, 400);
});
