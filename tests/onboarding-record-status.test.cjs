const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
// The outage-safe gate answers GET /api/assist/onboarding with
// { state: 'complete', source: 'record' } (no ok, schema or member) when GHL
// is down for a member who already finished. That is an answer, not a failure.
const src = fs.readFileSync(path.join(__dirname, '..', 'gaia-journey.js'), 'utf8');
const fn = src.slice(src.indexOf('  async function request(method, body) {'), src.indexOf('  function path() {'));
const make = (status, json) => new Function('fetch', 'base', 'AbortSignal', fn + '; return request;')(
  async () => ({ ok: status < 400, status, json: async () => json }), () => 'https://api.test', { timeout: () => undefined });
test('a record-only complete status is accepted', async () => {
  const data = await make(200, { state: 'complete', source: 'record' })('GET');
  assert.equal(data.state, 'complete');
});
test('a full status is still accepted', async () => {
  const data = await make(200, { ok: true, state: 'incomplete', nextStep: 'primary_interests' })('GET');
  assert.equal(data.nextStep, 'primary_interests');
});
test('unavailable and failed writes still throw', async () => {
  await assert.rejects(make(503, { ok: false, onboardingStatus: 'unavailable' })('GET'));
  await assert.rejects(make(200, { state: 'complete' })('POST', {}), 'a POST needs ok');
});
test('the status handler no longer assumes member/schema are present', () => {
  assert.doesNotMatch(src, /data\.member\.name/);
});
