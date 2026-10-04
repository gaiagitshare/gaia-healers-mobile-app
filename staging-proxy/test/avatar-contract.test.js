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
  // the state of a live conversation comes from the shell's own announcement, never tracked twice
  assert.match(js, /addEventListener\('gaia:assist-state'/); assert.match(ui, /gaia:assist-state/);
});

test('nothing in the avatar can cost a token: no fetch, no model route, no prompt', () => {
  const js = read('gaia-avatar.js');
  assert.doesNotMatch(js, /\bfetch\(/, 'the avatar makes no request of its own');
  assert.doesNotMatch(js, /api\/assist\/(chat|voice|tool)/);
  assert.doesNotMatch(js, /XMLHttpRequest|WebSocket|EventSource/);
  assert.doesNotMatch(js, /prompt: '/, 'no chip carries a prompt of its own; only the member\'s typed words reach the box, and the shell only pre-fills');
  assert.match(js, /detail: text \? \{ source: 'avatar', prompt: text \} : \{ source: 'avatar' \}/);
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
  assert.doesNotMatch(js, /\.gaia-tabbar'\)\s*\?*\.(remove|replaceWith)/, 'the tab bar stays');
  const sharedNav = read('shared-nav.js');
  assert.match(sharedNav, /class="gaia-tabbar__assist gaia-tabbar__home" href="home\.html\?view=today" data-app-nav="today" aria-label="Home"/, 'the centre of the bar is Home; Gaia Assist lives in the avatar');
  assert.doesNotMatch(sharedNav, /data-gaia-tab-assist/, 'no second door to Assist in the bar');
  assert.match(js, /function hop\(\)/, 'the tap itself gets a reaction');
  assert.match(js, /gava-bubble__input/, 'the member can type from the bubble');
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

test('every chip that moves the screen points at where it landed, and "meet Gaia" happens once', () => {
  const js = read('gaia-avatar.js');
  assert.doesNotMatch(js, /dressOrb/, 'the centre button is Home and stays the logo');
  assert.match(js, /const goAndPoint = /);
  for (const k of ['energy', 'academy', 'community', 'plans']) assert.match(js, new RegExp(`${k}: \\{[^\\n]*goAndPoint\\(`));
  assert.match(js, /localStorage\.getItem\('gaia-avatar-met'\)/);
});

test("moments, the two switches and the chime: still no fetch, no event, no model; sound only when chosen and after a touch", () => {
  const js = read('gaia-avatar.js');
  const idle = section(js, '// ── idle personality', '// ── end idle personality');
  assert.match(idle, /function moment\(name, ms\)/); assert.match(idle, /function glanceAt\(el, ms = 1600\)/);
  assert.match(idle, /if \(!root \|\| prefs\.idleOff \|\| reduced\(\) \|\| document\.hidden\) return;/, 'a moment respects the switch and reduced motion');
  assert.match(idle, /gaia:readings-loaded/); assert.match(idle, /gaia:readings-status/);
  assert.match(idle, /if \(!root \|\| document\.hidden \|\| prefs\.idleOff\) return false;/, 'the idle switch gates everything');
  // the switches arrive from the app, never fetched by the avatar
  assert.match(idle, /document\.addEventListener\('gaia:prefs-changed', \(e\) => readPrefs\(e\.detail\?\.prefs\)\)/);
  assert.doesNotMatch(js, /\bfetch\(/);
  // the chime: Web Audio, no file, off by default, only after a touch and only when chosen
  assert.match(idle, /if \(!prefs\.chime \|\| !audioUnlocked \|\| document\.hidden\) return;/);
  assert.match(idle, /createOscillator\(\)/); assert.doesNotMatch(idle, /new Audio\(|\.mp3|\.wav|\.ogg/, 'no audio file, nothing to download');
  assert.match(idle, /const prefs = \{ idleOff: false, chime: false \};/, 'defaults: animations on, chime off');
  // the settings rows under Account write the server preferences
  const member = read('gaia-member.js');
  assert.ok(member.includes("prefRow(\"Gaia's idle animations\", 'avatar_idle_off'")); assert.ok(member.includes("prefRow('Soft chime on her hello', 'avatar_hello_chime'")); assert.ok(member.includes('data-pref-toggle="\' + key + \'"'));
  assert.match(member, /gaia:prefs-changed/);
  const prefsMod = read('staging-proxy/member-prefs.js');
  assert.match(prefsMod, /avatar_idle_off/); assert.match(prefsMod, /avatar_hello_chime/);
});
