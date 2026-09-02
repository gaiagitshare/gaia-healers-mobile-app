const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/* ---- P0: Gaia Assist stereo playback --------------------------------------
 * The playback worklet must mirror mono PCM to EVERY output channel: on
 * stereo hardware the browser zeros unwritten channels, which made Gaia
 * speak in one ear. This runs the actual shipped worklet source.
 * ------------------------------------------------------------------------ */
function loadPlaybackProcessor() {
  const src = read('gaia-realtime-voice.js');
  const start = src.indexOf('const PLAYBACK_WORKLET = `');
  const end = src.indexOf('`;', start);
  const worklet = src.slice(start + 'const PLAYBACK_WORKLET = `'.length, end);
  let Processor;
  const FakeBase = class { constructor() { this.port = { onmessage: null }; } };
  new Function('AudioWorkletProcessor', 'registerProcessor', worklet)(FakeBase, (name, cls) => { Processor = cls; });
  return new Processor();
}

test('assist playback worklet fills both stereo channels identically', () => {
  const proc = loadPlaybackProcessor();
  const chunk = new Float32Array(64);
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = Math.sin(i / 3) * 0.5;
  proc.port.onmessage({ data: chunk });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  proc.process([], [[left, right]]);
  assert.ok(left.some((v) => v !== 0), 'left channel has audio');
  assert.ok(right.some((v) => v !== 0), 'right channel has audio (was silence before the fix)');
  assert.deepEqual(Array.from(right), Array.from(left), 'channels are identical');
});

/* ---- P0: Home announcements + booking CTAs render into real markup ------- */
test('home provides real hosts for bootstrap announcements and bookings', () => {
  const superapp = read('gaia-superapp.js');
  const member = read('gaia-member.js');
  assert.match(superapp, /<div id="home-announcements"><\/div>/, 'announcements host in home markup');
  assert.match(superapp, /<div id="home-book"><\/div>/, 'booking host in home markup');
  // renderHome must not target ids that exist nowhere (the fetch-and-drop bug)
  for (const dead of ['home-event-hero', 'home-member-access', 'home-founder']) {
    assert.ok(!member.includes(`el('${dead}')`), `${dead} write removed`);
  }
  assert.match(member, /announcementsHtml\(state\.announcements\)/);
  assert.match(member, /book\.innerHTML = bookCard\(\)/);
});

/* ---- P0: inbox badge targets the real nav markup -------------------------- */
test('inbox unread badge mounts on the community tab (no inbox tab exists)', () => {
  const superapp = read('gaia-superapp.js');
  const nav = read('shared-nav.js');
  assert.match(superapp, /\.gaia-tabbar__link\[data-app-nav="community"\]/);
  assert.doesNotMatch(superapp, /data-app-nav="inbox"/);
  assert.match(nav, /data-app-nav="\$\{t\.id\}"/, 'shared-nav really emits the attribute');
  assert.ok(!/\{ id: 'inbox'/.test(nav), 'and there is no inbox tab');
});

/* ---- P0: biowell deep link ------------------------------------------------ */
test('biowell.html lands on the Bio-Well bookings, not generic energy check', () => {
  const shim = read('biowell.html');
  assert.match(shim, /view=bookings/);
  assert.match(shim, /params\.set\('view', 'bookings'\)/);
  assert.doesNotMatch(shim, /params\.set\('tab'/);
  assert.doesNotMatch(shim, /url=home\.html\?view=wellness/);
});

/* ---- P1: community deep links --------------------------------------------- */
test('community ?tab= maps to sections that actually exist in the markup', () => {
  const ui = read('gaia-ui.js');
  const html = read('home.html');
  const mapMatch = /labels = \{ discussion: 'Your circles', members: 'Connect', events: 'Live and updates' \}/.exec(ui);
  assert.ok(mapMatch, 'GaiaCommunityTabs section map exists');
  for (const label of ['Your circles', 'Connect', 'Live and updates']) {
    assert.ok(html.includes(`aria-label="${label}"`), `section aria-label="${label}" exists in home.html`);
  }
});

/* ---- P1: admin passcode gone from public JS ------------------------------- */
test('no hard-coded admin passcode ships in client code', () => {
  for (const f of fs.readdirSync(root).filter((n) => n.endsWith('.js'))) {
    assert.ok(!read(f).includes('gaia2026'), `${f} still contains the passcode`);
  }
});

/* ---- P1: onboarding year cap is not hard-coded ----------------------------- */
test('onboard birth-year cap uses the current year', () => {
  const onboard = read('gaia-onboard.js');
  assert.doesNotMatch(onboard, /2025/);
  assert.match(onboard, /max="' \+ new Date\(\)\.getFullYear\(\) \+ '"/);
  assert.match(onboard, /year <= new Date\(\).getFullYear\(\)/);
});

/* ---- P1: iOS lesson fullscreen has a no-reload fallback ------------------- */
test('academy player falls back to a viewport-fill class for iOS iframes', () => {
  const player = read('gaia-academy-player.js');
  const css = read('gaia-system.css');
  assert.match(player, /requestFullscreen \|\| el\.webkitRequestFullscreen/);
  assert.match(player, /webkitEnterFullscreen/);
  assert.match(player, /gaia-acad--fill/);
  assert.match(css, /\.gaia-acad--fill \.gaia-acad__list/);
});

/* ---- P1: dialog Escape + focus trap (behavioral on the shipped helper) ---- */
function loadDialogA11y() {
  const src = read('gaia-ui.js');
  const start = src.indexOf('function bindDialogA11y(panel, onClose) {');
  const end = src.indexOf('\n  }', start);
  return new Function('document', src.slice(start, end + 4) + '\nreturn bindDialogA11y;')({
    activeElement: null,
    contains: () => true,
  });
}
function fakeFocusable() {
  return {
    listeners: {}, focused: false,
    addEventListener(t, f) { this.listeners[t] = f; },
    removeEventListener(t) { delete this.listeners[t]; },
    focus() { this.focused = true; documentActive = this; },
    getClientRects() { return { length: 1 }; },
  };
}
let documentActive = null;
test('dialog helper: Escape closes, Tab wraps inside the panel', () => {
  // The helper reads `document.activeElement` from ITS closure scope, so the
  // fake document must be one shared, mutable object.
  const sharedDoc = { get activeElement() { return documentActive; }, contains: () => true };
  const src = read('gaia-ui.js');
  const start = src.indexOf('function bindDialogA11y(panel, onClose) {');
  const end = src.indexOf('\n  }', start);
  const bindDialogA11y = new Function('document', src.slice(start, end + 4) + '\nreturn bindDialogA11y;')(sharedDoc);
  let closed = 0;
  const items = [fakeFocusable(), fakeFocusable()];
  const panel = { listeners: {}, ...fakeFocusable(), contains: () => true };
  panel.querySelectorAll = () => items;
  panel.addEventListener = (t, f) => { panel.listeners[t] = f; };
  panel.removeEventListener = () => {};
  const release = bindDialogA11y(panel, () => { closed += 1; });
  const keydown = panel.listeners.keydown;
  keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(closed, 1, 'Escape closes the dialog');
  // Tab from the last focusable wraps to the first
  documentActive = items[1];
  keydown({ key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.ok(items[0].focused, 'focus wrapped to the first focusable');
  release();
});

/* ---- splash ---------------------------------------------------------------- */
test('splash redirect: returning visitors skip before any asset, keeping their link', () => {
  const html = read('index.html');
  const headScript = /<script>\s*(\/\/ Returning visitors[\s\S]*?)<\/script>/.exec(html);
  assert.ok(headScript, 'head-inline redirect present');
  const run = (storage, search, hash) => {
    const calls = [];
    const sandbox = {
      localStorage: storage,
      location: { search, hash, replace: (u) => calls.push(u) },
    };
    new Function('localStorage', 'location', headScript[1])(sandbox.localStorage, sandbox.location);
    return calls;
  };
  assert.deepEqual(run({ getItem: () => '1' }, '?view=events&event=9', '#today'),
    ['home.html?view=events&event=9#today'], 'destination preserved');
  assert.deepEqual(run({ getItem: () => null }, '?view=events', ''), [], 'first-time visitor stays on the splash');
  assert.deepEqual(run({ getItem: () => { throw new Error('private'); } }, '', ''), [], 'private-mode storage failure stays on the splash');
});

test('splash wiring: no inline onclick, skip is JS-bound, copy speaks to both audiences', () => {
  const html = read('index.html');
  const ui = read('gaia-ui.js');
  assert.doesNotMatch(html, /onclick=/, 'inline onclick handlers removed');
  assert.match(html, /data-splash-skip/, 'skip link carries a hook for JS wiring');
  assert.match(ui, /const dest = 'home\.html' \+ window\.location\.search \+ window\.location\.hash/, 'enter/skip carry the deep link');
  assert.match(html, /Members: your courses, events, community, bookings and wellness tools/);
  assert.doesNotMatch(html, /client portal for practitioners and seekers/);
});

test('splash honours prefers-reduced-motion', () => {
  assert.match(read('gaia-splash.css'), /prefers-reduced-motion: reduce/);
});

/* ---- ?store branch + dead keys --------------------------------------------- */
test('?store marks the real tour key; gaia-entered is gone', () => {
  const ui = read('gaia-ui.js');
  assert.match(ui, /localStorage\.setItem\('gaia-tour-v1', '1'\)/);
  for (const f of fs.readdirSync(root).filter((n) => n.endsWith('.js') || n.endsWith('.html'))) {
    assert.ok(!read(f).includes("gaia-entered"), `${f} still references the write-only key`);
  }
});

/* ---- assist chips do what they say ----------------------------------------- */
test('assist booking chip navigates to the bookings view', () => {
  const ui = read('gaia-ui.js');
  assert.match(ui, /intent === 'booking'\)[\s\S]{0,500}go\?\.\('bookings'\)/);
  assert.doesNotMatch(ui, /book a session\/i\.test/);
});
