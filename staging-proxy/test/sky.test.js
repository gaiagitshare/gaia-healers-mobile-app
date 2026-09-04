/**
 * Today's sky.
 *
 * This is the one piece of Gaia a stranger sees before they have given us
 * anything, so it carries more weight than its size suggests: if it is wrong,
 * it is wrong in public, and anyone can check it by looking up.
 *
 * These tests hold it to that. Real dates with known moons, no tolerance for a
 * phase label that drifts from the arithmetic, and an explicit check that the
 * astronomy module has not grown its own copy of Gaia's symbolic vocabulary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todaySky, PHASES, PHASE_GUIDANCE, SIGNS, phaseFor } from '../membership/sky.js';
import { appTest } from './_app-present.js';

const at = (iso) => new Date(iso);
const proxyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');



test('known full and new moons come back as full and new moons', () => {
  // Real astronomical events. If the ephemeris or our phase windows ever drift,
  // these are the dates that catch it.
  const full = todaySky({ at: at('2026-08-28T12:00:00Z') });
  assert.equal(full.moon.phase, 'full');
  assert.ok(full.moon.illumination > 98, `a full moon should be near-fully lit, got ${full.moon.illumination}%`);

  const dark = todaySky({ at: at('2026-09-11T12:00:00Z') });
  assert.equal(dark.moon.phase, 'new');
  assert.ok(dark.moon.illumination < 2, `a new moon should be near-dark, got ${dark.moon.illumination}%`);
});

test('the reading changes from one day to the next', () => {
  // The whole reason this earns a return visit is that it is genuinely
  // different tomorrow. A cached or rounded-flat value would quietly kill that.
  const a = todaySky({ at: at('2026-08-18T12:00:00Z') });
  const b = todaySky({ at: at('2026-08-19T12:00:00Z') });
  assert.notEqual(a.moon.illumination, b.moon.illumination);
  assert.notEqual(a.date, b.date);
});

test('waxing and waning follow the moon, not the calendar', () => {
  // Between new and full it is filling; after full it is emptying.
  assert.equal(todaySky({ at: at('2026-08-22T12:00:00Z') }).moon.waxing, true);
  assert.equal(todaySky({ at: at('2026-09-02T12:00:00Z') }).moon.waxing, false);
});

test('every phase window is covered and none overlap', () => {
  // A gap would mean an angle with no phase; an overlap would mean the label
  // depends on array order rather than on the sky.
  for (let angle = 0; angle < 360; angle += 0.5) {
    const matches = PHASES.filter((p) => angle >= p.from && angle < p.to);
    assert.equal(matches.length, 1, `angle ${angle} matched ${matches.length} phases`);
  }
  assert.equal(phaseFor(0).key, 'new');
  assert.equal(phaseFor(180).key, 'full');
  assert.equal(phaseFor(359.9).key, 'new', 'the wrap back to new must not fall through');
});

test('every phase has guidance, and none of it predicts anything', () => {
  const keys = new Set(PHASES.map((p) => p.key));
  for (const key of keys) {
    const g = PHASE_GUIDANCE[key];
    assert.ok(g, `${key} has no guidance`);
    assert.ok(g.theme && g.invitation && g.practice, `${key} guidance is incomplete`);
    // Gaia's standing rule: reflective, never predictive or medical.
    const text = `${g.invitation} ${g.practice}`.toLowerCase();
    // What is out of bounds is promising an outcome. Telling someone to decide
    // one thing they will do is the opposite — it hands the day back to them.
    const promises = /you will (feel|receive|meet|find|get|attract|manifest|be)|will happen|guarantee|\bcure\b|diagnos|heal your|predict|destined/;
    const claim = text.match(promises);
    assert.equal(claim, null, `${key} guidance promises an outcome: "${claim && claim[0]}"`);
  }
});

test('the moon lands in a real zodiac sign', () => {
  for (const day of ['2026-01-15', '2026-04-02', '2026-08-18', '2026-11-30']) {
    const sky = todaySky({ at: at(`${day}T12:00:00Z`) });
    assert.ok(SIGNS.includes(sky.moon.sign), `${day} produced sign "${sky.moon.sign}"`);
  }
});

test('the moon moves through every sign over a month', () => {
  // It circles the zodiac in ~27 days, so a month of samples should touch all
  // twelve. If longitude were miscomputed it would stick or skip.
  const seen = new Set();
  for (let d = 0; d < 30; d += 1) {
    const when = new Date('2026-03-01T12:00:00Z');
    when.setUTCDate(when.getUTCDate() + d);
    seen.add(todaySky({ at: when }).moon.sign);
  }
  assert.equal(seen.size, 12, `expected all twelve signs in a month, saw ${seen.size}`);
});

test('the next full and new moons are ahead of us, not behind', () => {
  const sky = todaySky({ at: at('2026-08-18T12:00:00Z') });
  assert.ok(sky.upcoming.nextFullMoon > sky.date, 'the next full moon must be in the future');
  assert.ok(sky.upcoming.nextNewMoon > sky.date, 'the next new moon must be in the future');
  // A lunar month is ~29.5 days, so nothing should be further out than that.
  assert.ok(sky.upcoming.daysToFullMoon <= 30 && sky.upcoming.daysToNewMoon <= 30);
});

test('the day before a full moon counts down to it, not past it', () => {
  const eve = todaySky({ at: at('2026-08-27T12:00:00Z') });
  assert.equal(eve.upcoming.nextFullMoon, '2026-08-28');
  assert.ok(eve.upcoming.daysToFullMoon <= 1);
});

test('the astronomy module does not carry its own chakra vocabulary', () => {
  // Gaia's sign→chakra correspondence lives in wellness-router.js and is what a
  // member's birth chart is read against. A second copy here would drift, and
  // then today's sky would contradict the reading a member already trusts.
  const source = fs.readFileSync(path.join(proxyRoot, 'membership', 'sky.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/SIGN_CHAKRA\s*=/.test(code), 'sky.js must not define its own sign→chakra map');
  assert.ok(!todaySky().moon.chakra, 'the raw sky carries no symbolic layer; the router attaches it');
});

test('the router attaches the chakra layer using Gaia existing map', () => {
  const router = fs.readFileSync(path.join(proxyRoot, 'wellness-router.js'), 'utf8');
  assert.ok(router.includes("import { todaySky } from './membership/sky.js'"),
    'the router imports only the astronomy');
  assert.ok(/CHAKRAS\.find\(\(c\) => c\.id === SIGN_CHAKRA\[sky\.moon\.sign\]\)/.test(router),
    'and resolves the moon chakra through the map the birth chart already uses');
});

test('the sky route is public — no session, no profile, no gate', () => {
  const router = fs.readFileSync(path.join(proxyRoot, 'wellness-router.js'), 'utf8');
  const start = router.indexOf("if (p === '/api/wellness/sky'");
  assert.ok(start > 0, 'the route exists');
  const route = router.slice(start, router.indexOf("if (p === '/api/wellness/logout'", start));
  assert.ok(!/401|not_signed_up|requireSession/.test(route),
    'nothing in the sky route may turn a visitor away');

  // And the mount in server.js hands off without checking anyone first.
  const server = fs.readFileSync(path.join(proxyRoot, 'server.js'), 'utf8');
  const mount = server.indexOf("url.pathname.startsWith('/api/wellness/')");
  assert.ok(mount > 0, 'the wellness router is mounted');
  const block = server.slice(mount, server.indexOf('return;', mount));
  assert.ok(!/requireSessionMember|requireMember|401/.test(block),
    'the wellness mount must not gate on a session');
});

test('an ephemeris failure says so rather than inventing a moon', () => {
  const router = fs.readFileSync(path.join(proxyRoot, 'wellness-router.js'), 'utf8');
  const start = router.indexOf("if (p === '/api/wellness/sky'");
  const route = router.slice(start, router.indexOf("if (p === '/api/wellness/logout'", start));
  assert.ok(route.includes('sky_unavailable'), 'a failure is reported, not filled in with a guess');
  assert.ok(/try\s*{[\s\S]*todaySky\(\)/.test(route), 'the computation is guarded');
});

/**
 * The drawn moon.
 *
 * The card claims the shape on screen is the shape in the sky. That claim is
 * only worth making if the geometry holds, so these read the SVG the client
 * would emit and check it against the arithmetic — no browser required.
 */
import vm from 'node:vm';

function loadClient() {
  const source = fs.readFileSync(path.resolve(proxyRoot, '..', 'gaia-sky.js'), 'utf8');
  const sandbox = {
    // The client subscribes to a wellness-updated event on load. The stub only
    // has to accept the listener -- these tests read the SVG geometry it emits,
    // and never fire browser events at it.
    window: { addEventListener() {}, removeEventListener() {} },
    document: { querySelectorAll: () => [], addEventListener() {} },
    fetch: () => Promise.resolve({ json: () => ({}) }),
    URLSearchParams, location: { hostname: 'gaiahealers.app', search: '' },
    console, String, Number, Math, Object, Array, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'gaia-sky.js' });
  return sandbox.window.GaiaSky;
}

/** The terminator's half-width, as a fraction of the disc radius. */
function terminator(svg) {
  const rx = Number(/<ellipse[^>]*rx="([\d.]+)"/.exec(svg)[1]);
  return rx / 42;
}
const shadowIsLit = (svg) => /<ellipse class="g-sky__moon-lit"/.test(svg);
const litSide = (svg) => (/ 0 0 1 50 92/.test(svg) ? 'right' : 'left');

appTest('the terminator sits where the illuminated fraction puts it', () => {
  const sky = loadClient();
  // At half phase the terminator is a straight line down the middle; at the
  // extremes it reaches the limb.
  assert.ok(terminator(sky.moonSvg(50, true, '#fff')) < 0.01, 'half moon: a straight terminator');
  assert.ok(Math.abs(terminator(sky.moonSvg(25, true, '#fff')) - 0.5) < 0.01, 'quarter lit: halfway out');
  assert.ok(Math.abs(terminator(sky.moonSvg(100, true, '#fff')) - 1) < 0.01, 'full: at the limb');
  assert.ok(Math.abs(terminator(sky.moonSvg(0, true, '#fff')) - 1) < 0.01, 'new: at the limb');
});

appTest('a crescent is carved out and a gibbous is filled in', () => {
  const sky = loadClient();
  assert.equal(shadowIsLit(sky.moonSvg(20, true, '#fff')), false, 'a crescent bites into the lit half');
  assert.equal(shadowIsLit(sky.moonSvg(80, true, '#fff')), true, 'a gibbous spills past the middle');
});

appTest('waxing and waning are mirror images, not the same picture twice', () => {
  const sky = loadClient();
  assert.equal(litSide(sky.moonSvg(35, true, '#fff')), 'right', 'a waxing moon lights its right limb');
  assert.equal(litSide(sky.moonSvg(35, false, '#fff')), 'left', 'a waning moon lights its left limb');
});

appTest('a nonsense illumination cannot produce invalid SVG', () => {
  const sky = loadClient();
  for (const bad of [null, undefined, NaN, -30, 400, 'x']) {
    const svg = sky.moonSvg(bad, true, '#fff');
    const rx = Number(/rx="([\d.]+)"/.exec(svg)[1]);
    assert.ok(Number.isFinite(rx) && rx > 0, `rx must stay a positive number, got ${rx} for ${bad}`);
  }
});

appTest('the countdown names the nearer of the two moons, and reads like a person', () => {
  const sky = loadClient();
  assert.match(sky.countdownLine({ daysToFullMoon: 3, daysToNewMoon: 18 }), /3 days to the full moon/);
  assert.match(sky.countdownLine({ daysToFullMoon: 20, daysToNewMoon: 5 }), /5 days to the new moon/);
  assert.match(sky.countdownLine({ daysToFullMoon: 1, daysToNewMoon: 15 }), /full moon is tomorrow/);
  assert.match(sky.countdownLine({ daysToFullMoon: 0, daysToNewMoon: 14 }), /Tonight is the full moon/);
  assert.equal(sky.countdownLine(null), '', 'no data means no sentence, not a broken one');
});

appTest('the card is rendered for a visitor with no account', () => {
  // The entire point of this feature. A gate here would put it behind the same
  // wall as everything else and it would stop being a reason to come back.
  const source = fs.readFileSync(path.resolve(proxyRoot, '..', 'gaia-sky.js'), 'utf8');
  assert.ok(!/signedUp|authed|memberState|isMember/.test(source),
    'the sky card must not consult sign-in state before deciding to draw');
  assert.ok(source.includes('g-sky__invite'), 'and it offers the personal version instead of withholding this one');
});
