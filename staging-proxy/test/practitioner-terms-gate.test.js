// Gaia Practitioners gates MCP behind AI data-sharing terms the practitioner accepts in their dashboard.
// The answer below is the exact one their staging server gave on 27 Oct 2026 to a connected, valid token.
// It must read as "accept the terms", not as an outage, an unreadable profile or a broken connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mcpCall, resolveProfile, verifyPractitioner, linkState, saveToken, partnerTermsRequired, PROFILE_SOURCE, VERIFICATION_VERSION } = await import('../practitioners-oauth.js');

const CFG = { enabled: true, base: 'https://staging.example.invalid', mcpUrl: 'https://staging.example.invalid/api/mcp', clientId: 'c', clientSecret: 's', redirectUri: 'https://api.example.invalid/api/practitioners/callback', scope: 'mcp.read' };
const TERMS = { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Accept the AI data-sharing terms in your Gaia Practitioners dashboard (MCP Connection) first.' } };
const answering = (body) => { let calls = 0; const f = async () => { calls += 1; return { ok: true, status: 200, text: async () => JSON.stringify(body) }; }; f.calls = () => calls; return f; };

test('the partner terms answer is recognised; other -32001 errors are not', () => {
  assert.equal(partnerTermsRequired(TERMS.error), true);
  assert.equal(partnerTermsRequired({ code: -32001, message: 'rate limited' }), false);
  assert.equal(partnerTermsRequired({ code: -32000, message: 'x', data: { code: 'terms_required' } }), true);
  assert.equal(partnerTermsRequired(null), false);
});

test('a tool call under the terms gate fails once, as partner_terms_required (409), without retries', async () => {
  const f = answering(TERMS);
  await assert.rejects(() => mcpCall(CFG, 't', 'list_customers', {}, f), (e) => e.code === 'partner_terms_required' && e.status === 409);
  assert.equal(f.calls(), 1);
});

test('the profile under the terms gate is unverified for that reason, not "profile unreadable"', async () => {
  const who = await resolveProfile(CFG, 't', answering(TERMS));
  assert.equal(who.raw_ok, false);
  assert.equal(who.terms_required, true);
  assert.deepEqual(verifyPractitioner(who), { verified: null, reason: 'partner_terms_required' });
});

test('a new connection under the terms gate shows as unverified with the terms reason, never as connected', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pterms-')), 'tokens.json');
  const who = await resolveProfile(CFG, 't', answering(TERMS));
  const v = verifyPractitioner(who);
  saveToken('contact-1', { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 864e5, usable: true, ...who, verified: v.verified, verify_reason: v.reason, verification_version: VERIFICATION_VERSION }, file);
  const s = linkState('contact-1', file);
  assert.equal(s.state, 'unverified');
  assert.equal(s.reason, 'partner_terms_required');
});

test('an ordinary profile is unaffected', async () => {
  const ok = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ id: 7, name: 'Test', email: 't@example.invalid', status: 'active' }) }] } };
  const who = await resolveProfile(CFG, 't', answering(ok));
  assert.equal(who.profile_source, PROFILE_SOURCE);
  assert.equal(who.terms_required, undefined);
  assert.equal(verifyPractitioner(who).verified, true);
});
