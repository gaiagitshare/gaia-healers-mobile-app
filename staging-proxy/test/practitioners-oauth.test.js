/**
 * GAIA PRACTITIONERS — the half of the authorization their server cannot enforce.
 *
 * Their side is sound: the token is the practitioner, so every tool returns only
 * that practitioner's customers and no prompt can argue with it. What they cannot
 * know is whether the token we present belongs to the person currently signed into
 * Gaia. That is this file's subject.
 *
 * The three ways that could go wrong, each pinned below:
 *   - a callback arriving with a state we never issued, or one already used
 *   - a code redeemed while a different member is signed in on the browser
 *   - a token readable by anything that asks, rather than by the one row that owns it
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const m = await import('../practitioners-oauth.js');
const {
  practitionersConfig, makePkce, authorizeUrl, rememberFlow, claimFlow,
  exchangeCode, mcpCall, resolveProfile,
  readTokens, writeTokens, saveToken, tokenFor, forgetToken, connectionStatus, unwrapMcp,
  refreshAccess, validAccessToken, _refreshingSize,
  _resetFlows, _pendingSize,
} = m;

const CFG = {
  enabled: true,
  base: 'https://staging.example.invalid',
  mcpUrl: 'https://staging.example.invalid/api/mcp',
  clientId: 'mcp_client_test',
  clientSecret: 'secret_test',
  redirectUri: 'https://api.example.invalid/api/practitioners/callback',
  scope: 'mcp.read',
};

function tmpStore() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ptok-')), 'practitioner-tokens.json');
}

// ── configuration ──────────────────────────────────────────────────────────

test('it stays off until it is deliberately switched on', () => {
  const base = { GAIA_PRACTITIONERS_CLIENT_ID: 'x', GAIA_PRACTITIONERS_OAUTH_BASE: 'https://y.invalid' };
  assert.equal(practitionersConfig({ ...base }).enabled, false, 'absent flag must not enable it');
  assert.equal(practitionersConfig({ ...base, GAIA_PRACTITIONERS_ENABLED: 'True' }).enabled, false,
    'only the exact string "true" enables it');
  assert.equal(practitionersConfig({ ...base, GAIA_PRACTITIONERS_ENABLED: 'true' }).enabled, true);
  assert.equal(practitionersConfig({ GAIA_PRACTITIONERS_ENABLED: 'true' }).enabled, false,
    'enabled without a client id is not enabled');
});

test('the MCP url is derived from the base when it is not set', () => {
  const cfg = practitionersConfig({
    GAIA_PRACTITIONERS_ENABLED: 'true',
    GAIA_PRACTITIONERS_CLIENT_ID: 'x',
    GAIA_PRACTITIONERS_OAUTH_BASE: 'https://staging.example.invalid/',
  });
  assert.equal(cfg.base, 'https://staging.example.invalid', 'trailing slash trimmed');
  assert.equal(cfg.mcpUrl, 'https://staging.example.invalid/api/mcp');
});

// ── PKCE and the authorize url ─────────────────────────────────────────────

test('PKCE is S256 and the verifier is never the challenge', () => {
  const { verifier, challenge } = makePkce();
  assert.ok(verifier.length >= 43, 'verifier too short for RFC 7636');
  assert.notEqual(verifier, challenge, 'a plain verifier in a redirect is a leaked verifier');
  assert.ok(!/[+/=]/.test(challenge), 'must be base64url, not base64');
  const again = makePkce();
  assert.notEqual(verifier, again.verifier, 'verifiers must not repeat');
});

test('the authorize url carries everything their server needs and no secret', () => {
  const u = new URL(authorizeUrl(CFG, { state: 'st', challenge: 'ch' }));
  assert.equal(u.origin + u.pathname, 'https://staging.example.invalid/api/oauth/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), CFG.clientId);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), 'mcp.read');
  assert.equal(u.searchParams.get('state'), 'st');
  // The browser follows this url. A secret in it is a secret in history, in logs,
  // and in the Referer header of whatever loads next.
  assert.ok(!u.toString().includes(CFG.clientSecret), 'client secret must never be in the redirect');
});

// ── state: the part an attacker controls ───────────────────────────────────

test('a state we never issued is refused', () => {
  _resetFlows();
  assert.equal(claimFlow('never-issued'), null);
  assert.equal(claimFlow(''), null);
  assert.equal(claimFlow(undefined), null);
});

test('a state can be used once and never again', () => {
  _resetFlows();
  rememberFlow('s1', { contactId: 'C1', verifier: 'v' });
  assert.equal(claimFlow('s1').contactId, 'C1');
  assert.equal(claimFlow('s1'), null, 'replaying a callback must not reopen the flow');
});

test('an expired state is refused and not left behind', () => {
  _resetFlows();
  rememberFlow('s2', { contactId: 'C1', verifier: 'v' });
  const everything = globalThis.Date.now;
  globalThis.Date.now = () => everything() + 11 * 60 * 1000;
  try {
    assert.equal(claimFlow('s2'), null, 'ten minutes is the window');
  } finally {
    globalThis.Date.now = everything;
  }
  assert.equal(_pendingSize(), 0, 'a refused flow is still consumed');
});

test('pending flows are bounded, so a stranger cannot grow them into a leak', () => {
  _resetFlows();
  for (let i = 0; i < 260; i += 1) rememberFlow(`s${i}`, { contactId: 'C1', verifier: 'v' });
  assert.ok(_pendingSize() <= 200, `pending grew to ${_pendingSize()}`);
});

test('each flow remembers its own verifier and contact', () => {
  _resetFlows();
  rememberFlow('a', { contactId: 'C1', verifier: 'v1' });
  rememberFlow('b', { contactId: 'C2', verifier: 'v2' });
  const b = claimFlow('b');
  assert.equal(b.contactId, 'C2');
  assert.equal(b.verifier, 'v2', 'the wrong verifier would bind a code to the wrong flow');
  assert.equal(claimFlow('a').contactId, 'C1');
});

// ── the token store ────────────────────────────────────────────────────────

test('tokens are written private to this process', () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 't', expires_at: Date.now() + 1000 }, f);
  const mode = fs.statSync(f).mode & 0o777;
  assert.equal(mode, 0o600, `token file is ${mode.toString(8)}, must be 600`);
});

test('a token belongs to one contact and is not readable by another', () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'token-for-one', expires_at: Date.now() + 9e6 }, f);
  saveToken('C2', { access_token: 'token-for-two', expires_at: Date.now() + 9e6 }, f);
  assert.equal(tokenFor('C1', f).access_token, 'token-for-one');
  assert.equal(tokenFor('C2', f).access_token, 'token-for-two');
  assert.equal(tokenFor('C3', f), null, 'an unknown contact has no token, not somebody else\'s');
});

test('an expired token is reported as expired rather than silently used', () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 't', expires_at: Date.now() - 1000 }, f);
  assert.equal(tokenFor('C1', f).expired, true);
  assert.equal(connectionStatus('C1', f).connected, false);
  assert.equal(connectionStatus('C1', f).expired, true);
});

test('saving one contact does not disturb another', () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'one' }, f);
  saveToken('C2', { access_token: 'two' }, f);
  saveToken('C1', { access_token: 'one-again' }, f);
  assert.equal(tokenFor('C2', f).access_token, 'two');
  assert.equal(Object.keys(readTokens(f)).length, 2);
});

test('disconnecting removes the token and says whether it did', () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 't' }, f);
  assert.equal(forgetToken('C1', f), true);
  assert.equal(tokenFor('C1', f), null);
  assert.equal(forgetToken('C1', f), false, 'removing nothing is not an error, but it is not a removal');
});

test('the status the app may see never contains the token', () => {
  const f = tmpStore();
  saveToken('C1', {
    access_token: 'SECRET-VALUE', refresh_token: 'ALSO-SECRET',
    expires_at: Date.now() + 9e6, practitioner_name: 'A Practitioner',
    practitioner_email: 'p@example.invalid', connected_at: '2026-10-02T00:00:00Z',
  }, f);
  const flat = JSON.stringify(connectionStatus('C1', f));
  assert.ok(!flat.includes('SECRET-VALUE'), 'the access token must never reach the browser');
  assert.ok(!flat.includes('ALSO-SECRET'), 'nor the refresh token');
  assert.ok(flat.includes('A Practitioner'), 'but the connected account must be visible to its owner');
});

test('a corrupt store reads as empty rather than throwing', () => {
  const f = tmpStore();
  fs.writeFileSync(f, '{ this is not json');
  assert.deepEqual(readTokens(f), {});
  saveToken('C1', { access_token: 't' }, f);   // and is recoverable by writing
  assert.equal(tokenFor('C1', f).access_token, 't');
});

// ── talking to them ────────────────────────────────────────────────────────

test('the code exchange sends PKCE and the secret in the body, not the url', async () => {
  let seen;
  const fake = async (u, opts) => {
    seen = { url: u, body: String(opts.body), headers: opts.headers };
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'at', expires_in: 2592000, scope: 'mcp.read' }) };
  };
  const out = await exchangeCode(CFG, { code: 'the-code', verifier: 'the-verifier' }, fake);
  assert.equal(out.access_token, 'at');
  assert.equal(seen.url, 'https://staging.example.invalid/api/oauth/token');
  assert.ok(!seen.url.includes('the-code'), 'the code belongs in the body');
  const body = new URLSearchParams(seen.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code_verifier'), 'the-verifier');
  assert.equal(body.get('client_secret'), CFG.clientSecret);
});

test('a failed exchange throws instead of storing a token that is not one', async () => {
  const fake = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) });
  await assert.rejects(() => exchangeCode(CFG, { code: 'x', verifier: 'y' }, fake), /invalid_grant/);
});

test('a 200 with no access_token is still a failure', async () => {
  const fake = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
  await assert.rejects(() => exchangeCode(CFG, { code: 'x', verifier: 'y' }, fake), /token exchange failed/);
});

test('an MCP call carries the token given to it and the tool name asked for', async () => {
  let seen;
  const fake = async (u, opts) => {
    seen = { url: u, headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { customers: [] } }) };
  };
  await mcpCall(CFG, 'the-practitioners-token', 'list_customers', {}, fake);
  assert.equal(seen.headers.Authorization, 'Bearer the-practitioners-token');
  assert.equal(seen.body.method, 'tools/call');
  assert.equal(seen.body.params.name, 'list_customers');
});

test('a rejected token is reported as 401 so the app can ask for re-consent', async () => {
  const fake = async () => ({ ok: false, status: 401, text: async () => '{"error":"Unauthorized"}' });
  await assert.rejects(() => mcpCall(CFG, 't', 'list_customers', {}, fake), (e) => e.code === 401);
});

test('an SSE-framed answer is understood, since streamable HTTP may send one', async () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  const fake = async () => ({ ok: true, status: 200, text: async () => sse });
  const out = await mcpCall(CFG, 't', 'get_dashboard_summary', {}, fake);
  assert.deepEqual(out, { ok: true });
});

test('a tool error surfaces rather than passing as a result', async () => {
  const fake = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: { message: 'no such customer' } }) });
  await assert.rejects(() => mcpCall(CFG, 't', 'get_customer', { customerId: 'x' }, fake), /no such customer/);
});

// ── their server being briefly unavailable ────────────────────────────────
//
// Measured over ~2,500 attempts on 2 Oct 2026, the upstream flapped on a
// timescale of minutes. Everything under mcp.read is a read, so repeating a
// call has no consequence and a bad minute becomes a slower answer.

test('a 5xx fails instead of passing as an empty result', async () => {
  // It used to fall through: the body would not parse, json stayed {}, the
  // handler found no scans and told the practitioner their client had NONE ON
  // FILE. A wrong answer about a client's readings is worse than a card that
  // says it could not load, so this is the most important assertion here.
  for (const [status, body] of [[503, 'Service Unavailable'], [502, '<html>Bad Gateway</html>'], [500, '{"message":"boom"}']]) {
    const fake = async () => ({ ok: false, status, text: async () => body });
    await assert.rejects(
      () => mcpCall(CFG, 't', 'get_customer_scan', { customerId: '474' }, fake),
      (e) => e.code === 'upstream_unavailable' && e.status === status,
      `HTTP ${status} must not look like an answer`,
    );
  }
});

test('a 5xx is retried once, and a second chance is enough to recover', async () => {
  let calls = 0;
  const fake = async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, status: 503, text: async () => 'Service Unavailable' }
      : { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { scans: [{ scanned_at: '2026-09-24' }] } }) };
  };
  const out = await mcpCall(CFG, 't', 'get_customer_scan', { customerId: '474' }, fake);
  assert.equal(calls, 2, 'the first failure has to be retried');
  assert.equal(out.scans.length, 1, 'and the second answer is the one returned');
});

test('a refused connection is retried; a timeout is not', async () => {
  // The difference is what it costs the practitioner. A refused connection
  // comes back in milliseconds. A timeout has already spent thirty seconds
  // against a card that promised about ten, and doing it twice is a worse
  // answer than saying it did not come back.
  let refused = 0;
  await assert.rejects(() => mcpCall(CFG, 't', 'list_customers', {}, async () => {
    refused += 1;
    throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
  }), (e) => e.code === 'upstream_unavailable');
  assert.equal(refused, 2, 'a transport failure is worth one more try');

  let timeouts = 0;
  await assert.rejects(() => mcpCall(CFG, 't', 'get_customer_scan', { customerId: '474' }, async () => {
    timeouts += 1;
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  }), (e) => e.code === 'upstream_unavailable' && /did not answer within/.test(e.message));
  assert.equal(timeouts, 1, 'a timeout must not be doubled');
});

test('a 4xx and a 401 are answers about the request, so neither is retried', async () => {
  let n = 0;
  await assert.rejects(() => mcpCall(CFG, 't', 'get_customer', { customerId: 'x' }, async () => {
    n += 1; return { ok: false, status: 404, text: async () => 'no such tool' };
  }), (e) => e.code === 'upstream_unavailable' && e.status === 404);
  assert.equal(n, 1, 'retrying a 404 would just ask the same wrong question again');

  let m401 = 0;
  await assert.rejects(() => mcpCall(CFG, 't', 'list_customers', {}, async () => {
    m401 += 1; return { ok: false, status: 401, text: async () => 'Unauthorized' };
  }), (e) => e.code === 401);
  assert.equal(m401, 1, 'a rejected token needs re-consent, not another attempt');
});

test('a call that works is made exactly once', async () => {
  // A scan already takes nine to twelve seconds. Retrying a success, or
  // speculatively doubling up, would be the expensive mistake here.
  let calls = 0;
  const fake = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) };
  };
  await mcpCall(CFG, 't', 'get_dashboard_summary', {}, fake);
  assert.equal(calls, 1);
});

test('an unreadable profile records that it is unknown, never a guessed identity', async () => {
  const fake = async () => ({ ok: false, status: 401, text: async () => '{"error":"Unauthorized"}' });
  const who = await resolveProfile(CFG, 't', fake);
  assert.equal(who.raw_ok, false);
  assert.equal(who.practitioner_name, '', 'an unknown name must stay empty, not be invented');
  assert.equal(who.practitioner_id, '');
});

test('a readable profile is what gets stored as the identity mapping', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
    content: [{ type: 'text', text: JSON.stringify({ id: 'prac_42', name: 'Dr Example', email: 'dr@example.invalid', status: 'pending' }) }] } });
  const fake = async () => ({ ok: true, status: 200, text: async () => body });
  const who = await resolveProfile(CFG, 't', fake);
  assert.equal(who.raw_ok, true);
  assert.equal(who.practitioner_name, 'Dr Example');
  assert.equal(who.practitioner_email, 'dr@example.invalid');
  assert.equal(who.practitioner_id, 'prac_42');
});

// ── the shape of the routes, asserted against the source ───────────────────
// These read server.js rather than booting it, because what matters is a property
// of the code: that identity is never taken from the request.

test('the routes take identity from the session and never from the query string', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("'/api/practitioners/status'"), src.indexOf("'/api/practitioners/disconnect'") + 400);
  assert.ok(block.includes('sessionMemberContext(req)'), 'identity must come from the cookie');
  assert.ok(!/contactId\s*=\s*url\.searchParams/.test(block), 'a contact id from the query string would be forgeable');
  assert.ok(block.includes('member.contactId !== flow.contactId'),
    'the callback must refuse a session that is not the one that started the flow');
  // Since 4 Oct 2026 the GHL tag is a mirror, not a gate: any signed-in member
  // may start the consent, and Gaia Practitioners' own profile decides at the
  // callback (verifyPractitioner). A tag alone must never promote anyone.
  assert.ok(!block.slice(0, block.indexOf("'/api/practitioners/callback'")).includes('access?.member?.practitioner'),
    'connect no longer reads GHL tags');
  assert.ok(block.includes('const verdict = verifyPractitioner(who);'),
    'the verdict comes from their profile, at the callback');
});

test('nothing in the routes sends a token to the browser', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("'/api/practitioners/status'"), src.indexOf("'/api/practitioners/disconnect'") + 400);
  assert.ok(!/sendJson\([^)]*access_token/.test(block), 'a token must never be in a JSON response');
  assert.ok(block.includes('connectionStatus('), 'status is reported through the filtered view');
});

test('the MCP envelope is unwrapped however a tool happens to answer', () => {
  // Every tool wraps its payload as a JSON STRING inside content[].text. Reading
  // the envelope as the data finds nothing, which is how resolveProfile first
  // recorded an empty name for a profile it had successfully fetched.
  assert.deepEqual(
    unwrapMcp({ content: [{ type: 'text', text: '{"id":"prac_1","name":"X"}' }] }),
    { id: 'prac_1', name: 'X' });
  assert.deepEqual(unwrapMcp({ structuredContent: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapMcp({ a: 1 }), { a: 1 }, 'a bare object passes through');
  assert.equal(unwrapMcp({ content: [{ type: 'text', text: 'not json' }] }), 'not json',
    'prose stays prose rather than throwing');
  assert.equal(unwrapMcp(null), null);
  assert.deepEqual(unwrapMcp({ content: [] }), { content: [] }, 'an empty envelope is not data');
});

// ── renewal, where a single-use token makes the races matter ───────────────
// Their refresh tokens work once. The response carries the replacement, and the
// old one dies on success -- so losing the replacement, or spending the same one
// twice, breaks the chain permanently and costs the practitioner a re-consent.

test('a live token is used as-is, with no renewal and no network call', async () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'still-good', refresh_token: 'r', expires_at: Date.now() + 9e6 }, f);
  const never = async () => { throw new Error('must not call the token endpoint'); };
  assert.equal(await validAccessToken(CFG, 'C1', { file: f, fetchImpl: never }), 'still-good');
});

test('a token near its end is renewed before it is actually spent', async () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() + 60 * 1000 }, f);
  const fake = async () => ({ ok: true, status: 200, text: async () =>
    JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 2592000 }) });
  assert.equal(await validAccessToken(CFG, 'C1', { file: f, fetchImpl: fake }), 'new',
    'a token a minute from expiry must not be handed out');
});

test('the rotated refresh token replaces the spent one', async () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1 }, f);
  const fake = async () => ({ ok: true, status: 200, text: async () =>
    JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 2592000 }) });
  await validAccessToken(CFG, 'C1', { file: f, fetchImpl: fake });
  const row = tokenFor('C1', f);
  assert.equal(row.refresh_token, 'r2', 'keeping r1 would spend a dead token next time');
  assert.equal(row.access_token, 'new');
  assert.ok(row.expires_at > Date.now(), 'the new expiry must be stored too');
});

test('a response with no new refresh token keeps the one we hold', async () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1 }, f);
  const fake = async () => ({ ok: true, status: 200, text: async () =>
    JSON.stringify({ access_token: 'new', expires_in: 2592000 }) });
  await validAccessToken(CFG, 'C1', { file: f, fetchImpl: fake });
  assert.equal(tokenFor('C1', f).refresh_token, 'r1',
    'blanking the chain because the shape surprised us is the unrecoverable bug');
});

test('two callers at once share one renewal and spend one token', async () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1 }, f);
  let calls = 0;
  const slow = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 25));
    return { ok: true, status: 200, text: async () =>
      JSON.stringify({ access_token: `new${calls}`, refresh_token: `r${calls + 1}`, expires_in: 2592000 }) };
  };
  const [a, b, c] = await Promise.all([
    validAccessToken(CFG, 'C1', { file: f, fetchImpl: slow }),
    validAccessToken(CFG, 'C1', { file: f, fetchImpl: slow }),
    validAccessToken(CFG, 'C1', { file: f, fetchImpl: slow }),
  ]);
  assert.equal(calls, 1, `three callers caused ${calls} refreshes; a single-use token allows one`);
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(_refreshingSize(), 0, 'the in-flight entry must be cleared');
});

test('two different practitioners renew independently', async () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'o1', refresh_token: 'r1', expires_at: Date.now() - 1 }, f);
  saveToken('C2', { access_token: 'o2', refresh_token: 'r2', expires_at: Date.now() - 1 }, f);
  const fake = async (_u, opts) => {
    const sent = new URLSearchParams(String(opts.body)).get('refresh_token');
    return { ok: true, status: 200, text: async () =>
      JSON.stringify({ access_token: `new-for-${sent}`, refresh_token: `${sent}x`, expires_in: 9999 }) };
  };
  const [a, b] = await Promise.all([
    validAccessToken(CFG, 'C1', { file: f, fetchImpl: fake }),
    validAccessToken(CFG, 'C2', { file: f, fetchImpl: fake }),
  ]);
  assert.equal(a, 'new-for-r1');
  assert.equal(b, 'new-for-r2', 'one practitioner must never be renewed with another\'s token');
});

test('a refused refresh ends the chain and says a reconnect is needed', async () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'old', refresh_token: 'spent', expires_at: Date.now() - 1 }, f);
  const refuse = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) });
  await assert.rejects(() => validAccessToken(CFG, 'C1', { file: f, fetchImpl: refuse }),
    (e) => e.code === 'needs_reconnect');
  const row = tokenFor('C1', f);
  assert.equal(row.access_token, '', 'a dead token must not be left for every later call to rediscover');
  assert.equal(row.needs_reconnect, true);
  assert.equal(connectionStatus('C1', f).connected, false);
  assert.equal(connectionStatus('C1', f).needs_reconnect, true,
    'the app must say Reconnect, not Connect');
  // A second call must still refuse rather than hand out the blank token.
  await assert.rejects(() => validAccessToken(CFG, 'C1', { file: f, fetchImpl: refuse }),
    (e) => e.code === 'needs_reconnect');
});

test('a network blip is not treated as a broken chain', async () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1 }, f);
  const down = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(() => validAccessToken(CFG, 'C1', { file: f, fetchImpl: down }), /ECONNRESET/);
  assert.equal(tokenFor('C1', f).refresh_token, 'r1',
    'their server being briefly unreachable must not cost a re-consent');
  assert.notEqual(tokenFor('C1', f).needs_reconnect, true);
});

test('a practitioner who never connected has no token and no error', async () => {
  const f = tmpStore();
  assert.equal(await validAccessToken(CFG, 'nobody', { file: f }), null);
  assert.deepEqual(connectionStatus('nobody', f), { connected: false, needs_reconnect: false },
    'never connected is not the same state as a broken connection');
});

test('an expired token with no refresh token asks for a reconnect', async () => {
  const f = tmpStore();
  saveToken('C1', { access_token: 'old', expires_at: Date.now() - 1 }, f);
  await assert.rejects(() => validAccessToken(CFG, 'C1', { file: f }), (e) => e.code === 'needs_reconnect');
});

test('the refresh request sends the grant and the secret in the body', async () => {
  let seen;
  const fake = async (u, opts) => {
    seen = { url: u, body: String(opts.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'a', expires_in: 10 }) };
  };
  await refreshAccess(CFG, 'the-refresh-token', fake);
  const body = new URLSearchParams(seen.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'the-refresh-token');
  assert.equal(body.get('client_secret'), CFG.clientSecret);
  assert.ok(!seen.url.includes('the-refresh-token'), 'never in the url');
});
