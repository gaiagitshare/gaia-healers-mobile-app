/**
 * What Gaia is told about the person in front of her, end to end: the real
 * server, fixture members, and a stubbed model provider that records the
 * system prompt instead of calling anyone. No network, no paid call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'focus-secret-'.padEnd(48, 'q');
const FIXTURE_KEY = 'focus-fixture-key-'.padEnd(48, 'w');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-focus-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
const FIXTURES = ['fixture-free', 'fixture-gold-annual', 'fixture-diamond', 'fixture-cancelled-gold'];
fs.writeFileSync(path.join(workdir, 'data', 'onboarding-complete.json'), JSON.stringify({ contacts: FIXTURES }));
process.chdir(workdir);

const PORT = 8963;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
  GAIA_MEMBER_LINK_FILE: path.join(workdir, 'data', 'member-links.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  MEMBERSHIP_FIXTURES: '1', MEMBERSHIP_FIXTURE_KEY: FIXTURE_KEY,
  GAIA_MEMBER_READINGS_ENABLED: 'true',
  GAIA_ASSIST_VOICE_ENABLED: 'true', ASSIST_PROVIDER_ORDER: 'openai', OPENAI_API_KEY: 'stub-not-a-key',
});

// The only outbound call allowed is the model, and it never leaves the process.
const prompts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (/api\.openai\.com/.test(url)) {
    const body = JSON.parse(options.body || '{}');
    prompts.push(body.messages?.[0]?.content || '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  }
  if (/^http:\/\/127\.0\.0\.1:/.test(url)) return realFetch(input, options);
  throw new Error('blocked outbound call in test: ' + url.slice(0, 60));
};

const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));

async function session(fixture) {
  const r = await realFetch(`http://127.0.0.1:${PORT}/api/dev/fixture-session?fixture=${fixture}`, { method: 'POST', headers: { 'x-gaia-fixture-key': FIXTURE_KEY } });
  return r.headers.get('set-cookie').split(';')[0];
}
async function systemPromptFor(cookie, prompt = 'what should I do next?') {
  const before = prompts.length;
  await realFetch(`http://127.0.0.1:${PORT}/api/assist/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt, source: 'chat', appContext: { screen: 'today' } }),
  });
  return prompts.slice(before).join('\n');
}

test('a Gold member: the plan as You shows it, the next level, and a next step', async () => {
  const sys = await systemPromptFor(await session('fixture-gold-annual'));
  assert.match(sys, /MEMBERSHIP \(same as You > Member Pass\): Gold/, 'plan from the ledger, like the screen');
  assert.match(sys, /Next level: diamond; it would add /);
  assert.match(sys, /SUGGESTED NEXT STEP \(only if they ask/);
  assert.match(sys, /No upcoming appointments booked\./);
});

test('the top plan has no next level to sell', async () => {
  const sys = await systemPromptFor(await session('fixture-diamond'));
  assert.match(sys, /MEMBERSHIP \(same as You > Member Pass\): Diamond/);
  assert.match(sys, /This is the top level\./);
  assert.doesNotMatch(sys, /Next level: /);
});

test('a cancelled plan is not described as active', async () => {
  const sys = await systemPromptFor(await session('fixture-cancelled-gold'));
  assert.match(sys, /MEMBERSHIP \(same as You > Member Pass\): Gold, cancelled — not active now\./);
});

test('no readings shared: Gaia says so and never invents one', async () => {
  const sys = await systemPromptFor(await session('fixture-free'), 'explain my latest reading');
  assert.match(sys, /READINGS STATUS: no Bio-Well readings shared with this member yet/);
  assert.match(sys, /Never invent a reading/);
  assert.match(sys, /READINGS: you never see reading values, dates or who shared them/, 'the member rules say what she cannot see');
});

test('a visitor gets no member facts', async () => {
  const sys = await systemPromptFor('', 'which plan should I choose?');
  assert.doesNotMatch(sys, /MEMBERSHIP \(same as You|READINGS STATUS|SUGGESTED NEXT STEP/);
});

test('a forged session is a visitor, not a member', async () => {
  const sys = await systemPromptFor('gaia_member_session=eyJtZW1iZXIiOnsiY29udGFjdElkIjoiZml4dHVyZS1kaWFtb25kIn19.forged', 'what plan am I on?');
  assert.doesNotMatch(sys, /MEMBERSHIP \(same as You/);
});

test('plan questions in everyday words bring the live plan catalogue', async () => {
  const { assistLiveFacts } = await import(new URL('../server.js', import.meta.url).href);
  for (const q of ['how much is Gold?', 'what does silver cost', 'which level is right for me', 'should I upgrade']) {
    const f = await assistLiveFacts(q, {});
    assert.match(f.block, /CURRENT MEMBERSHIP POLICY/, q);
  }
  const off = await assistLiveFacts('what is bio-well', {});
  assert.doesNotMatch(off.block || '', /CURRENT MEMBERSHIP POLICY/, 'not sent when the question is not about plans');
});

test.after(() => closeServer?.());
