/**
 * GAIA AVATAR — a layer, not a second app.
 *
 * The character floats over the shell and reuses what exists: the Assist
 * sheet, the voice path, navigation, the readings panel and the tour. These
 * assertions keep it that way, and keep it free of model calls: a bubble, a
 * chip, a tour step or a pointing move must never cost a token.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(name) {
  for (const base of ['../../', '../../gaia-healers-mobile-app-1/']) {
    try { return fs.readFileSync(new URL(base + name, import.meta.url), 'utf8'); } catch { /* next */ }
  }
  throw new Error(`${name} not found beside the proxy`);
}

test('the avatar is loaded by the shell, after the things it talks to, with its own stylesheet', () => {
  const html = read('home.html');
  assert.match(html, /gaia-avatar\.css\?v=/);
  assert.match(html, /gaia-avatar\.js\?v=/);
  assert.ok(html.indexOf('gaia-ui.js') < html.indexOf('gaia-avatar.js'), 'after the shell');
  assert.ok(html.indexOf('gaia-my-readings.js') < html.indexOf('gaia-avatar.js'), 'after the readings panel');
});

test('every door the avatar opens already exists; it builds none of its own', () => {
  const js = read('gaia-avatar.js');
  const ui = read('gaia-ui.js');
  // chat and voice go through the shell's own events
  assert.match(js, /gaia:open-assist/); assert.match(ui, /addEventListener\('gaia:open-assist'/);
  assert.match(js, /gaia:assist-voice/); assert.match(ui, /addEventListener\('gaia:assist-voice'/);
  assert.match(ui, /if \(inPipelineMode\(\)\)[\s\S]{0,200}holdStart/, 'in pipeline mode a hold is the orb\'s hold');
  assert.match(ui, /if \(hold === 'start'\) \{ setOpen\(true\); if \(!realtimeVoice\?\.isActive\?\.\(\)\) void onAssistTap\(\); \}/, 'in live mode a start is the orb\'s tap');
  // navigation, readings, tools, sign-in, tour: the existing globals and events
  for (const door of ['GaiaAppShell?.go', 'gaia:open-readings', 'GaiaTools?.open', 'GaiaAuth?.open', 'GaiaTour?.run', 'gaia:open-client']) assert.ok(js.includes(door), door);
  assert.match(ui, /window\.GaiaTour = \{ run: \(steps, opts\) => runTour\(steps, opts\), seen: tourSeen \}/);
  assert.match(ui, /gaia:view-changed/);
  // the state of a live conversation is read from the orb, never tracked twice
  assert.match(js, /data-gaia-tab-assist/); assert.match(js, /attributeFilter: \['data-state'\]/);
});

test('nothing in the avatar can cost a token: no fetch, no model route, no prompt', () => {
  const js = read('gaia-avatar.js');
  assert.doesNotMatch(js, /\bfetch\(/, 'the avatar makes no request of its own');
  assert.doesNotMatch(js, /api\/assist\/(chat|voice|tool)/);
  assert.doesNotMatch(js, /XMLHttpRequest|WebSocket|EventSource/);
  assert.doesNotMatch(js, /prompt:/, 'no chip pre-fills or sends a prompt; a conversation starts only when the member opens chat or holds to talk');
  // the bubble is a table keyed on screen and member state
  assert.match(js, /function bubbleFor\(\)/);
  for (const key of ["case 'profile'", "case 'wellness'", "case 'academy'", "case 'community'", "case 'store'", 'default:']) assert.ok(js.includes(key), key);
});

test('the approved artwork and all six states are the ones in the character', () => {
  const js = read('gaia-avatar.js');
  const css = read('gaia-avatar.css');
  for (const f of ['gava-f-idle', 'gava-f-listen', 'gava-f-speak', 'gava-f-think', 'gava-f-point', 'gava-badge', 'gava-sprout', 'gava-lb', 'gava-lf', 'gava-aura']) assert.ok(js.includes(f), f);
  for (const s of ['listening', 'speaking', 'thinking', 'pointing', 'new']) assert.ok(css.includes(`.gava[data-state="${s}"]`), s);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /z-index: 52/, 'below the Assist sheet (54), above the page');
  assert.doesNotMatch(js, /\.png|\.webp|\.jpg/, 'no image files: SVG only');
});

test('placement is remembered on this device only, and the shell is not restructured', () => {
  const js = read('gaia-avatar.js');
  assert.match(js, /const STORE = 'gaia-avatar-pos'/); assert.match(js, /localStorage\.setItem\(STORE/);
  assert.doesNotMatch(js, /gaia-tabbar__assist'\)\s*\?*\.remove|\.gaia-tabbar'\)\s*\?*\.(remove|replaceWith)/, 'the orb and tab bar stay');
  const sharedNav = read('shared-nav.js');
  assert.match(sharedNav, /data-gaia-tab-assist/, 'the orb is still rendered by the nav');
  const html = read('home.html');
  assert.match(html, /id="member-readings"/);
});

test('the preview page is the same artwork, published as its own page', () => {
  const page = read('gaia-avatar.html');
  for (const s of ['data-state="idle"', 'data-state="listening"', 'data-state="speaking"', 'data-state="thinking"', 'data-state="pointing"', 'data-state="new"']) assert.ok(page.includes(s), s);
  assert.match(page, /48, 72, 96 and 140/);
  assert.doesNotMatch(page, /api\/assist/);
});

// ── idle personality ─────────────────────────────────────────────────────

const section = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to); if (a < 0 || b < 0 || b < a) throw new Error('idle section markers missing'); return src.slice(a, b); };

test('the idle personality is a timer, a class and a keyframe: it never fetches, dispatches, navigates, opens Assist or starts voice', () => {
  const js = read('gaia-avatar.js');
  const idle = section(js, '// ── idle personality', '// ── end idle personality');
  for (const forbidden of ['fetch(', 'dispatchEvent', 'gaia:open-assist', 'gaia:assist-voice', 'openChat(', 'startVoice(', 'GaiaAppShell', 'pointAt(', 'runTour(', 'location.', 'XMLHttpRequest', 'WebSocket', 'api/assist']) {
    assert.ok(!idle.includes(forbidden), `idle section must not contain ${forbidden}`);
  }
  assert.match(idle, /root\.classList\.add\('is-anim-' \+ a\.name\)/, 'an animation is a class on the root');
  assert.match(idle, /const IDLE_MIN_MS = 8000, IDLE_MAX_MS = 15000, IDLE_RESUME_MS = 8000;/);
  assert.match(idle, /const HELLO_MIN_MS = 45000, HELLO_MAX_MS = 90000, HELLO_IGNORED_MAX = 2;/);
  for (const a of ['peek', 'wave', 'look', 'bounce', 'blinksmile', 'wiggle', 'curious']) assert.ok(idle.includes(`name: '${a}'`), a);
});

test('never two at once, never while anything else is happening, and it waits after the last touch', () => {
  const js = read('gaia-avatar.js');
  const idle = section(js, '// ── idle personality', '// ── end idle personality');
  assert.match(idle, /if \(state !== 'idle' \|\| pointing \|\| animating\) return false;/);
  assert.match(idle, /!bubble\.hidden \|\| root\.classList\.contains\('is-dragging'\) \|\| root\.classList\.contains\('is-holding'\) \|\| root\.classList\.contains\('is-behind'\)/);
  assert.match(idle, /gaia-assist-panel-open'\) \|\| document\.querySelector\('\.gaia-tour'\)/);
  assert.match(idle, /Date\.now\(\) - lastTouch >= IDLE_RESUME_MS/);
  assert.match(idle, /helloIgnored < HELLO_IGNORED_MAX/, 'a hello that is ignored twice stops');
  assert.match(js, /function touched\(\) \{ lastTouch = Date\.now\(\);[^\n]*stopIdleAnim\(\); \}/);
  // interactions reset the clock
  assert.match(js, /char\.addEventListener\('pointerdown', \(e\) => \{\n\s+if \(e\.button != null && e\.button !== 0\) return;\n\s+touched\(\);/);
  assert.match(js, /const b = spec \|\| bubbleFor\(\);\n\s+touched\(\);/);
});

test('reduced motion keeps breathing and the glow, drops bouncing, waving and tilting; the cursor is desktop only', () => {
  const js = read('gaia-avatar.js');
  const css = read('gaia-avatar.css');
  assert.match(js, /reduced\(\) \? IDLE_ANIMS\.filter\(\(a\) => a\.name === 'blinksmile'\) : IDLE_ANIMS/);
  assert.match(js, /if \(!window\.matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)\.matches \|\| reduced\(\)\) return;/, 'no cursor tracking on touch or with reduced motion');
  assert.match(css, /prefers-reduced-motion: reduce\) \{[\s\S]*\.gava \.gava-whole, \.gava \.gava-sprout, \.gava \.gava-lb, \.gava \.gava-lf \{ animation: none !important; transform: none !important; \}/);
  assert.match(css, /--gava-tilt/); assert.match(css, /--gava-ex/);
  // the artwork is untouched: idle animations target existing classes only
  for (const cls of ['.gava-lf path:nth-child(2)', '.gava-sprout', '.gava-f-think', '.gava-sparks', '.gava-whole', '.gava-aura']) assert.ok(css.includes(cls), cls);
  assert.doesNotMatch(js, /SVG_BODY = "[^"]*gava-eye-new|<path class="gava-extra/, 'no new SVG parts');
});

test('the orb wears the same face, every chip that moves the screen points at where it landed, and "meet Gaia" happens once', () => {
  const js = read('gaia-avatar.js');
  assert.match(js, /function dressOrb\(\)/); assert.match(js, /mark\.replaceWith\(holder\)/);
  assert.match(js, /gava-mini__logo'\)\.appendChild\(mark\)/, 'the logo is kept: it is one side of the coin');
  assert.match(css, /@keyframes gava-coin \{ 0%,42% \{ transform: rotateY\(0\); \} 50%,92% \{ transform: rotateY\(180deg\); \}/, 'logo and face take turns');
  assert.match(css, /\.gaia-tabbar__assist:not\(\[data-state="idle"\]\):not\(\[data-state="error"\]\) \.gava-mini__coin \{ animation: none; transform: rotateY\(180deg\);/, 'a live conversation keeps the face up');
  const css = read('gaia-avatar.css');
  assert.match(css, /\.gaia-tabbar__assist\[data-state="speaking"\] \.gava-mini \.gava-f-speak \{ display: block; \}/);
  assert.match(js, /const goAndPoint = /);
  for (const k of ['energy', 'academy', 'community', 'plans']) assert.match(js, new RegExp(`${k}: \\{[^\\n]*goAndPoint\\(`));
  assert.match(js, /localStorage\.getItem\('gaia-avatar-met'\)/);
});
