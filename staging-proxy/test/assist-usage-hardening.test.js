/**
 * USAGE LOGGING, PRODUCTION-GRADE — accounting only, never breaks a reply.
 *
 * What is pinned: the exact field list; that nothing resembling content or
 * identity can get in; that malformed provider data yields nulls; that a
 * full disk, a read-only directory or a bad path warns once and returns; that
 * concurrent writers do not interleave; and that the file is private.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const u = await import('../assist-usage.js');
const MOD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assist-usage.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-h-'));
const withLog = (file, fn) => { const prev = process.env.GAIA_USAGE_LOG; process.env.GAIA_USAGE_LOG = file; try { return fn(); } finally { if (prev === undefined) delete process.env.GAIA_USAGE_LOG; else process.env.GAIA_USAGE_LOG = prev; } };
const read = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ── shape ─────────────────────────────────────────────────────────────────

test('a record carries exactly USAGE_FIELDS, in order, whatever the caller passes', () => {
  const rec = u.buildRecord({ channel: 'text', provider: 'gemini', model: 'gemini-3.6-flash', state: 'member',
    usage: u.normalizeUsage('gemini', { promptTokenCount: 5, candidatesTokenCount: 2 }),
    // things that must NOT get in, however they are passed
    prompt: 'I cannot sleep', reply: 'Try breathing', contactId: 'C-123', email: 'a@b.c', ip: '203.0.113.9',
    cookie: 'gaia_member_session=abc', authorization: 'Bearer xyz', args: { clientId: '474', name: 'Arman' } });
  assert.deepEqual(Object.keys(rec), [...u.USAGE_FIELDS]);
  assert.ok(!/sleep|breathing|C-123|a@b\.c|203\.0\.113|session=|Bearer|Arman|474/.test(JSON.stringify(rec)));
});

test('the field list itself contains nothing that could hold content or identity', () => {
  for (const f of u.USAGE_FIELDS) {
    assert.ok(!/prompt|reply|text$|message|content|name|email|phone|contact|member|ip|token|cookie|auth|args|url|body|session/i.test(f) || f === 'textIn' || f === 'textOut',
      `${f} looks like it could carry content or identity`);
  }
});

test('an error is stored as a category, never a message or a body', () => {
  const rec = u.buildRecord({ channel: 'text', provider: 'gemini', model: 'gemini-3.6-flash',
    error: new Error('gemini stream request failed with 503: {"error":{"message":"The model is overloaded. Prompt was: I cannot sleep"}}') });
  assert.equal(rec.outcome, 'failed');
  assert.equal(rec.error, 'server');
  assert.ok(!/overloaded|cannot sleep|Prompt was/.test(JSON.stringify(rec)));
  assert.ok(u.ERROR_CATEGORIES.includes(rec.error));
});

test('error categories are narrow and unambiguous', () => {
  const cat = u.errorCategory;
  assert.equal(cat({ message: '{"code":"AccessDenied.Unpurchased","message":"Access to model denied."}' }), 'access_denied');
  assert.equal(cat({ message: 'gemini chat request failed with 401: unauthorized' }), 'auth');
  assert.equal(cat({ message: 'groq chat request failed with 429: rate limit' }), 'rate_limit');
  assert.equal(cat({ name: 'TimeoutError', code: 'TimeoutError', message: 'The operation was aborted due to timeout' }), 'timeout');
  assert.equal(cat({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 1.2.3.4:443' }), 'network');
  assert.equal(cat({ message: 'fetch failed' }), 'network');
  assert.equal(cat({ message: '<50002> InternalError.Algo.ModelServingError: Internal Error' }), 'server');
  assert.equal(cat({ message: 'qwen_error:invalid_value' }), 'bad_request');
  assert.equal(cat('empty-reply'), 'empty');
  assert.equal(cat('stall'), 'stall');
  assert.equal(cat('client_closed'), 'client_closed');
  assert.equal(cat({ message: 'something nobody anticipated' }), 'unknown');
});

// ── malformed provider data ───────────────────────────────────────────────

test('malformed or missing usage from a provider yields nulls, not an exception', () => {
  for (const raw of [undefined, null, 'usage', 42, [], { promptTokenCount: 'lots' }, { input_token_details: 'nope' },
                     { promptTokensDetails: 'x' }, { promptTokensDetails: [null, 7, { modality: 'TEXT' }] }]) {
    for (const provider of ['gemini', 'qwen', 'groq', 'somebody-new']) {
      const n = u.normalizeUsage(provider, raw);
      assert.deepEqual(Object.keys(n).sort(), Object.keys(u.emptyUsage()).sort());
      for (const v of Object.values(n)) assert.ok(v === null || Number.isFinite(v));
    }
  }
});

test('an unknown provider or model still produces a valid record with null cost', () => {
  const rec = u.buildRecord({ channel: 'text', provider: 'somebody-new', model: 'their-model-9000',
    usage: u.normalizeUsage('somebody-new', { prompt_tokens: 10, completion_tokens: 3 }) });
  assert.equal(rec.input, 10);
  assert.equal(rec.estCostUsd, null);
  assert.equal(rec.priceList, null);
  assert.equal(rec.usageReported, true);
});

test('usageReported is false when the provider returned no counts', () => {
  const rec = u.buildRecord({ channel: 'voice', provider: 'qwen', model: 'qwen3.8-omni-flash-realtime', outcome: 'failed', error: 'access_denied' });
  assert.equal(rec.usageReported, false);
  assert.equal(rec.input, null);
  assert.equal(rec.estCostUsd, null, 'no counts, no cost -- a failed attempt is not priced by guessing');
});

// ── the file ──────────────────────────────────────────────────────────────

test('the log file is created private (0600) in a private directory', () => {
  const dir = path.join(tmp(), 'data');
  const file = path.join(dir, 'u.jsonl');
  withLog(file, () => u.recordUsage({ channel: 'text', provider: 'gemini', model: 'gemini-3.6-flash', usage: u.emptyUsage() }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('an unwritable location warns once and never throws', () => {
  const blocker = path.join(tmp(), 'a-file'); fs.writeFileSync(blocker, 'x');
  const warnings = [];
  const orig = console.warn; console.warn = (...a) => warnings.push(a);
  try {
    withLog(path.join(blocker, 'sub', 'u.jsonl'), () => {
      for (let i = 0; i < 5; i += 1) assert.doesNotThrow(() => u.recordUsage({ channel: 'text', provider: 'g', model: 'm', usage: u.emptyUsage() }));
    });
  } finally { console.warn = orig; }
  assert.ok(warnings.length >= 1 && warnings.length <= 2, `warned ${warnings.length} times; once a minute is the rule`);
  assert.match(String(warnings[0][0]), /could not write the usage log/);
  assert.ok(!/sleep|prompt/.test(JSON.stringify(warnings)), 'the warning carries a code, not content');
});

test('recordUsage returns the record even when the log is off, so callers can still read it', () => {
  const rec = withLog('', () => u.recordUsage({ channel: 'text', provider: 'gemini', model: 'gemini-3.6-flash', usage: u.emptyUsage() }));
  assert.equal(rec.channel, 'text');
});

test('many concurrent writers produce whole lines, never interleaved ones', async () => {
  const file = path.join(tmp(), 'c.jsonl');
  const body = `
    const u = await import(${JSON.stringify(MOD)});
    for (let i = 0; i < 200; i++) u.recordUsage({ channel: 'text', provider: 'p' + process.pid, model: 'm', usage: u.normalizeUsage('groq', { prompt_tokens: i, completion_tokens: 1 }) });`;
  const kids = Array.from({ length: 6 }, () => spawnSync(process.execPath, ['--input-type=module', '-e', body], { env: { ...process.env, GAIA_USAGE_LOG: file }, encoding: 'utf8' }));
  for (const k of kids) assert.equal(k.status, 0, k.stderr);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1200);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), 'every line must parse on its own');
});

test('a record survives a process restart: nothing is buffered', () => {
  const file = path.join(tmp(), 'r.jsonl');
  const body = `const u = await import(${JSON.stringify(MOD)}); u.recordUsage({ channel: 'voice', provider: 'qwen', model: 'qwen3.8-omni-flash-realtime', usage: u.emptyUsage(), outcome: 'failed', error: 'access_denied' }); process.exit(0);`;
  spawnSync(process.execPath, ['--input-type=module', '-e', body], { env: { ...process.env, GAIA_USAGE_LOG: file } });
  assert.equal(read(file).length, 1, 'written synchronously, so an immediate exit loses nothing');
});

test('the module makes no network call and reads no request', () => {
  const src = fs.readFileSync(MOD, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/fetch\(|WebSocket|http\.|https\.|net\./.test(src));
  assert.ok(!/req\.|headers|cookie|remoteAddress/.test(src));
});

test('an error after a streamed reply has started ends the response instead of crashing the proxy', () => {
  // Found while adding failed-attempt accounting: a ReferenceError inside the
  // stream loop's catch reached the top-level handler, which answered with
  // sendJson() on a response whose SSE headers were already out. That throws
  // ERR_HTTP_HEADERS_SENT from inside the catch, nothing catches it, and the
  // process exits -- taking every other member's request with it.
  const src = fs.readFileSync(path.resolve(path.dirname(MOD), 'server.js'), 'utf8');
  const i = src.lastIndexOf("sendJson(res, 404, { ok: false, error: 'Not found' }, origin);");
  const tail = src.slice(i, i + 700);
  assert.match(tail, /if \(res\.headersSent\) \{ try \{ res\.end\(\); \} catch \{[^}]*\} return; \}/);
  assert.ok(tail.indexOf('res.headersSent') < tail.indexOf('sendJson(res, 500'), 'the headersSent check must come first');
});
