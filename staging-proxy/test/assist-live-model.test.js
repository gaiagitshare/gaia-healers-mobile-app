/**
 * GAIA ASSIST VOICE — never hand the browser a model that is not there.
 *
 * The voice orb is a Gemini Live WebSocket, and the ephemeral token mint does
 * NOT name a model: the model travels to the client and is used in the socket's
 * setup message. So a withdrawn model does not fail on the server, where it
 * would be logged — it fails inside a member's browser, as a silent orb.
 *
 * The configured model is a *preview* model, which is exactly the kind that
 * gets withdrawn. This pins the protection: whatever /api/assist/voice/token
 * hands out must exist in the account's own catalogue, and a stable fallback
 * must be pinned behind it.
 *
 *   node --test test/assist-live-model.test.js
 */
import assert from 'node:assert';
import { env, apiBase as BASE, liveTest } from './_live-env.js';

async function catalogue() {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(env.GEMINI_API_KEY)}&pageSize=200`);
  assert.ok(r.ok, `could not read the Gemini model catalogue: HTTP ${r.status}`);
  const body = await r.json();
  return new Set((body.models || []).map((m) => String(m.name || '').replace(/^models\//, '')));
}

liveTest('a stable live model is pinned behind the preview one', () => {
  const fallback = env.GEMINI_LIVE_FALLBACK_MODEL;
  assert.ok(fallback, 'GEMINI_LIVE_FALLBACK_MODEL is not set');
  assert.ok(!/preview/i.test(fallback),
    `the fallback is itself a preview model (${fallback}) — it can be withdrawn too`);
  assert.notStrictEqual(fallback, env.GEMINI_LIVE_MODEL,
    'the fallback is the same model as the primary, so it is not a fallback');
}, ['GEMINI_API_KEY']);

liveTest('the fallback model actually exists in this account', async () => {
  const models = await catalogue();
  assert.ok(models.has(env.GEMINI_LIVE_FALLBACK_MODEL),
    `${env.GEMINI_LIVE_FALLBACK_MODEL} is not offered to this API key`);
}, ['GEMINI_API_KEY']);

liveTest('the token endpoint only hands out a model that exists', async () => {
  const r = await fetch(`${BASE}/api/assist/voice/token`);
  assert.strictEqual(r.status, 200, `token endpoint returned ${r.status}`);
  const body = await r.json();
  assert.strictEqual(body.ok, true, `token endpoint said: ${JSON.stringify(body).slice(0, 200)}`);
  const models = await catalogue();
  assert.ok(models.has(body.model),
    `the browser was handed "${body.model}", which is not in the catalogue — the socket would refuse it`);
}, ['GEMINI_API_KEY']);

liveTest('and names the spare, unless it is already serving it', async () => {
  const body = await (await fetch(`${BASE}/api/assist/voice/token`)).json();
  if (body.model === env.GEMINI_LIVE_FALLBACK_MODEL) {
    assert.strictEqual(body.fallbackModel, '', 'no spare should be named when already on the spare');
  } else {
    assert.strictEqual(body.fallbackModel, env.GEMINI_LIVE_FALLBACK_MODEL,
      'the client is not told which model to fall back to');
  }
}, ['GEMINI_API_KEY']);
