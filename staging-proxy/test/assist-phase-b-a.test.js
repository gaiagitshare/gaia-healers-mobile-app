/**
 * PHASE B, ARCHITECTURE A (approved 3 Oct 2026) — three token changes that
 * reword nothing a member hears:
 *
 *   2. the rules for reading a member's private block are the same for every
 *      member, so they are static text sent once (cacheable), not part of each
 *      member's own block;
 *   3. ENERGY ROUTING (a URL format a spoken reply cannot use) is gone — the
 *      navigate tool's enums and CURRENT APP already route;
 *   5. "live facts only from live data" is said once per channel (ACT WITH
 *      YOUR TOOLS in voice, ANSWERS in text) plus the gaia_lookup description,
 *      not five times.
 *
 * Offline; the server module is loaded with the network sealed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-phase-b-a-')));
const S = 'phase-b-a-secret-'.padEnd(48, 'c');
Object.assign(process.env, {
  PORT: '0', HOST: '127.0.0.1', GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9', GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false',
  AUTH_SESSION_SECRET: S, COURSES_SYNC_SECRET: S, GHL_BACKFILL_SECRET: S, GHL_WORKFLOW_WEBHOOK_SECRET: S, GAIA_USAGE_LOG: '',
});
globalThis.fetch = async (u) => { if (!/^(127\.|localhost$)/.test(new URL(String(u)).hostname)) throw new Error('offline'); return new Response('{}'); };
const srv = await import(new URL('../server.js', import.meta.url).href);
test.after(() => srv.closeServer?.());

const member = (name) => `GAIA SESSION STATE: member\nMEMBER CONTEXT (private)\nYou are speaking with ${name}. Use their first name sparingly ("${name.split(' ')[0]}").\nStatus: Gold member.\nONBOARDING PROFILE: DONE\nCURRENT GAIA PROFILE CHOICES: {"goals":["Better sleep"]}`;
const PRACTITIONER = member('Arman Rad').replace('STATE: member', 'STATE: practitioner').replace('Gold member', 'certified practitioner');
const GATED = 'GAIA SESSION STATE: onboarding\nONBOARDING PROFILE: NOT DONE. onboarding_required=true. Resume at primary_interests.';
const voice = (ctx) => srv.buildGaiaLiveInstructions({ view: 'today', memberContext: ctx, appContext: { screen: 'today' } });
const text = (ctx) => srv.assistSystemPrompt(ctx);
const RULES = [/MEMBER CONTEXT RULES/, /WHAT YOU CAN SEE:/, /WHAT YOU CANNOT SEE:/, /Privacy: discuss only THIS member/, /Use the saved CURRENT GAIA PROFILE CHOICES/];

// ── item 2 ────────────────────────────────────────────────────────────────

for (const [who, ctx] of [['member', member('Sara Keshavarz')], ['practitioner', PRACTITIONER]]) {
  for (const [channel, build] of [['voice', voice], ['text', text]]) {
    test(`${channel} / ${who}: every member-block rule is still said, exactly once, and before the member's own facts`, () => {
      const p = build(ctx);
      for (const re of RULES) {
        const hits = p.match(new RegExp(re.source, 'g')) || [];
        assert.equal(hits.length, 1, `${re} said ${hits.length} times`);
        assert.ok(p.search(re) < p.indexOf('You are speaking with'), `${re} must sit in the static part, before this member's facts`);
      }
    });
  }
}

test('a visitor and a gated (onboarding) member are not sent member-block rules -- they have no block', () => {
  for (const ctx of ['', GATED]) for (const p of [voice(ctx), text(ctx)]) for (const re of RULES) assert.doesNotMatch(p, re);
});

test('the rules are identical text for two different members -- that is what makes them cacheable', () => {
  const a = voice(member('Sara Keshavarz')); const b = voice(member('Arman Rad'));
  const cut = (p) => p.slice(0, p.indexOf('\nMEMBER CONTEXT (private)\n'));
  assert.equal(cut(a), cut(b), 'everything before the member block must be the same for both members');
  assert.match(cut(a), /MEMBER CONTEXT RULES/);
});

test('the per-member block no longer carries the rules, only the facts (what buildMemberVoiceContext emits)', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function buildMemberVoiceContext'), src.indexOf('/**\n * Who is asking'));
  assert.ok(fn.length > 1000, 'found the builder');
  for (const re of [/WHAT YOU CAN SEE/, /WHAT YOU CANNOT SEE/, /Privacy: discuss/, /Use these saved choices/, /Never read it aloud/]) assert.doesNotMatch(fn, re);
  assert.match(fn, /'MEMBER CONTEXT \(private\)'/, 'the short label stays, so sessionState and the fixtures still recognise the block');
});

// ── item 3 ────────────────────────────────────────────────────────────────

test('ENERGY ROUTING is gone from both channels; routing still comes from CURRENT APP and the navigate enums', () => {
  for (const p of [voice(''), text(''), voice(member('Sara K'))]) {
    assert.doesNotMatch(p, /ENERGY ROUTING/);
    assert.match(p, /CURRENT APP:/);
    assert.match(p, /tool=numerology/, 'the tool ids are still named in ENERGY TOOLS');
  }
});

// ── item 5 ────────────────────────────────────────────────────────────────

test('voice says "live facts only from live data" once (ACT WITH YOUR TOOLS), not five times', () => {
  const p = voice(member('Sara K'));
  assert.equal((p.match(/use only what it returns/g) || []).length, 1);
  assert.doesNotMatch(p, /never a remembered price|never a remembered schedule|require current verified data/);
  assert.match(p, /prices, stock, practitioner availability, event details or course access — call gaia_lookup/);
});

test('text says it once too (ANSWERS), and the gaia_lookup description keeps its own', async () => {
  const p = text(member('Sara K'));
  assert.equal((p.match(/use only those facts/g) || []).length, 1);
  assert.doesNotMatch(p, /never a remembered price|never a remembered schedule|require current verified data/);
  const tools = await import('../assist-tools.js');
  const lookup = tools.TOOLS.find((t) => t.name === 'gaia_lookup');
  assert.match(JSON.stringify(lookup), /never invent a price, count, or name/);
});

test('what was kept: "missing event data means unavailable", "no redundant lookups", and the medical-device line', () => {
  const p = voice(member('Sara K'));
  assert.match(p, /EVENTS: missing data means unavailable, not no events/);
  assert.match(p, /without redundant lookups/);
  assert.match(p, /wellness and education tools, not medical devices/);
});

// ── the saving, pinned so it cannot silently regress ──────────────────────

test('a member voice prompt is smaller than the Phase 1 figure and the dynamic part is facts only', () => {
  const p = voice(member('Sara Keshavarz'));
  const block = p.slice(p.indexOf('\nMEMBER CONTEXT (private)\n'), p.indexOf('CURRENT NAVIGATION'));
  assert.ok(block.length < 600, `the member's own block is now ${block.length} chars of facts`);
  assert.ok(p.length < 21_500, `member voice prompt is ${p.length} chars`);
});
