import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIELD_KEYS } from '../onboarding-store.js';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-onboarding-api-'));
process.chdir(work);
const SECRET = 'onboarding-session-test-'.padEnd(48, 's');
const PORT = 8998;
Object.assign(process.env, { PORT: String(PORT), HOST: '127.0.0.1', AUTH_SESSION_SECRET: SECRET, COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, GHL_API_BASE_URL: 'https://ghl.invalid', GHL_API_TOKEN: 'synthetic-token', GHL_LOCATION_ID: 'synthetic-location', ALLOWED_ORIGINS: 'https://gaiahealers.app' });
const contact = { id: 'member-a', email: 'ada@example.test', firstName: 'Ada', tags: [], customFields: [] };
let unavailable = false, ambiguous = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://ghl.invalid')) return realFetch(url, opts);
  const u = new URL(url);
  const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  if (unavailable) return new Response('{}', { status: 503 });
  if (u.pathname === '/contacts/search') return response({ contacts: ambiguous ? [contact, { ...contact, id: 'member-b' }] : [contact] });
  if (u.pathname === '/contacts') return response({ contacts: [contact] });
  if (u.pathname.includes('/customFields')) return response({ customFields: Object.entries(FIELD_KEYS).map(([k, v]) => ({ id: k, fieldKey: 'contact.' + v, model: 'contact' })) });
  if (u.pathname === '/contacts/member-a') {
    if (opts.method === 'PUT') for (const f of JSON.parse(opts.body).customFields) { const old = contact.customFields.find(x => x.id === f.id); if (old) old.value = f.fieldValue; else contact.customFields.push({ id: f.id, value: f.fieldValue }); }
    return response({ contact });
  }
  if (u.pathname.endsWith('/tags')) { contact.tags = [...new Set([...contact.tags, ...JSON.parse(opts.body).tags])]; return response({ tags: contact.tags }); }
  return response({ subscriptions: [], data: [], contacts: [] });
};
const { closeServer } = await import('../server.js');
test.after(async () => { await closeServer(); globalThis.fetch = realFetch; fs.rmSync(work, { recursive: true, force: true }); });
function cookie(includeId = true) {
  const payload = Buffer.from(JSON.stringify({ member: { email: contact.email, ...(includeId ? { contactId: contact.id } : {}) }, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64url');
  return `gaia_member_session=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}
async function call({ body, auth = true, includeId = true, origin = 'https://gaiahealers.app' } = {}) {
  const r = await realFetch(`http://127.0.0.1:${PORT}/api/assist/onboarding`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin, ...(auth ? { cookie: cookie(includeId) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
test('visitors cannot read or write another member onboarding profile', async () => {
  assert.equal((await call({ auth: false })).status, 401);
  assert.equal((await call({ auth: false, body: { stepKey: 'primary_interests', selections: ['Water'] } })).status, 401);
});
test('signed-in email resolves the existing GHL contact and exposes only a safe schema', async () => {
  const r = await call({ includeId: false });
  assert.equal(r.status, 200); assert.equal(r.data.member.name, 'Ada'); assert.equal(r.data.nextStep, 'primary_interests');
  assert.equal(JSON.stringify(r.data.schema).includes('tags'), false);
});
test('visual clicks save to the session contact, ignoring a supplied contact or tag target', async () => {
  const r = await call({ body: { stepKey: 'primary_interests', selections: ['Water'], freeText: '', complete: false, source: 'visual', contactId: 'victim', tags: ['admin'] } });
  assert.equal(r.status, 200); assert.deepEqual(r.data.answers.primary_interests, ['Water']);
  assert.ok(contact.tags.includes('product_general_water_interest')); assert.ok(!contact.tags.includes('admin'));
});
test('cross-site writes and invented answers are rejected', async () => {
  const body = { stepKey: 'primary_interests', selections: ['ater'], source: 'visual' };
  assert.equal((await call({ body })).status, 400);
  assert.equal((await call({ body, origin: 'https://untrusted.example' })).status, 403);
});
test('ambiguous emails and GHL outages produce a recovery response without guessing a contact', async () => {
  ambiguous = true; assert.equal((await call({ includeId: false })).status, 503); ambiguous = false;
  unavailable = true; assert.equal((await call()).status, 503); unavailable = false;
  assert.equal((await call()).status, 200);
});

test('central member gate denies protected APIs for new/partial contacts and GHL failures', async () => {
  contact.tags = []; contact.customFields = [];
  for (const path of ['/api/member/profile', '/api/member/courses', '/api/member/communities', '/api/member/events', '/api/academy/manifest', '/api/assist/lookup']) {
    const r = await realFetch(`http://127.0.0.1:${PORT}${path}`, { method: path.endsWith('lookup') ? 'POST' : 'GET', headers: { cookie: cookie(), origin: 'https://gaiahealers.app', 'content-type': 'application/json' }, ...(path.endsWith('lookup') ? { body: '{}' } : {}) });
    assert.equal(r.status, 403, path); assert.equal((await r.json()).reason, 'onboarding_required');
  }
  await call({ body: { stepKey: 'primary_interests', selections: ['Water'], source: 'visual' } });
  const partial = await call(); assert.equal(partial.data.state, 'incomplete'); assert.equal(partial.data.nextStep, 'why_join');
  unavailable = true;
  const outage = await realFetch(`http://127.0.0.1:${PORT}/api/member/profile`, { headers: { cookie: cookie() } });
  assert.equal(outage.status, 503); unavailable = false;
});
test('session bootstrap checks GHL and completed marker permits the member API', async () => {
  contact.tags = ['gaia_app_onboarding_complete'];
  const r = await realFetch(`http://127.0.0.1:${PORT}/api/auth/session`, { headers: { cookie: cookie() } });
  assert.equal((await r.json()).onboardingStatus, 'complete');
  const profile = await realFetch(`http://127.0.0.1:${PORT}/api/member/profile`, { headers: { cookie: cookie() } });
  assert.equal(profile.status, 200);
  unavailable = true;
  const fresh = await realFetch(`http://127.0.0.1:${PORT}/api/auth/session`, { headers: { cookie: cookie() } });
  assert.equal((await fresh.json()).onboardingStatus, 'unavailable'); unavailable = false;
});
