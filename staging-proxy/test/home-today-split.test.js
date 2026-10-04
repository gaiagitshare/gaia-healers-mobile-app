/**
 * HOME AND TODAY — two screens with two jobs.
 *
 * The centre of the bar is Home: the dashboard (greeting, what is new, your
 * access, next steps). The Today tab is the day itself: the daily energy
 * check, today's sky, the readings shortcut, the next booking. One host per
 * thing, owned by the file that already renders it; nothing is duplicated.
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

test('the shell has a Today screen (daily) beside Home (today), and the bar sends Today there', () => {
  const html = read('home.html');
  assert.match(html, /data-screen="today" aria-label="Home"/);
  assert.match(html, /data-screen="daily" aria-label="Today"/);
  assert.match(html, /id="daily-superapp"/);
  const nav = read('shared-nav.js');
  assert.match(nav, /\{ id: 'daily', href: 'home\.html\?view=daily', label: 'Today', icon: 'ph-sun' \}/);
  assert.match(nav, /daily: 'daily',/);
  assert.match(nav, /gaia-tabbar__home" href="home\.html\?view=today"/, 'the centre is Home');
  const ui = read('gaia-ui.js');
  assert.match(ui, /today: 'Home',\n\s+daily: 'Today',/, 'titles follow');
});

test('Assist knows both screens: the guide, the navigate enum on every surface, the voice page', () => {
  const guide = read('staging-proxy/assist-guide.js');
  assert.match(guide, /today: 'Home: the member dashboard/); assert.match(guide, /daily: 'Today: the day itself/);
  const tools = read('staging-proxy/assist-tools.js');
  assert.equal((tools.match(/enum: \['today', 'daily', 'academy'/g) || []).length, 2, 'member and practitioner declarations');
  const voice = read('gaia-realtime-voice.js');
  assert.match(voice, /NAVIGATE_SCREENS = \['today', 'daily',/);
});

test('the daily energy check and the sky render on Today only; Home has a door to Today instead', () => {
  const sa = read('gaia-superapp.js');
  assert.match(sa, /function renderToday\(\)/); assert.match(sa, /function todayDoor\(authed\)/);
  const home = sa.slice(sa.indexOf('function renderHome()'), sa.indexOf('function todayDoor('));
  assert.doesNotMatch(home, /data-daily-host/, 'Home no longer carries the daily check'); assert.doesNotMatch(home, /data-sky-host/, 'nor the sky');
  assert.match(home, /todayDoor\(true\)/); assert.match(home, /todayDoor\(false\)/);
  const today = sa.slice(sa.indexOf('function renderToday()'), sa.indexOf('/** The member\'s way back'));
  for (const host of ['data-today-readings', 'data-daily-host', 'data-sky-host', 'nextBookingCard()']) assert.ok(today.includes(host), host);
  assert.match(sa, /renderToday\(\);\n/, 'Today is drawn whenever Home is');
  const readings = read('gaia-my-readings.js');
  assert.match(readings, /#daily-superapp \[data-today-readings\]/, 'the readings shortcut sits on Today');
  // The observer that re-places the row must never watch the row's own contents: a rewrite re-triggered it forever (seen live, 4 Oct).
  assert.match(readings, /nudgeObserver\.observe\(root, \{ childList: true \}\)/);
  assert.doesNotMatch(readings, /subtree: true/);
  assert.match(readings, /if \(el\.innerHTML !== html\) el\.innerHTML = html;/);
});

test('the avatar: Today in the bubble and the tour, a local greeting line, and glances toward the next tab', () => {
  const js = read('gaia-avatar.js');
  assert.match(js, /case 'daily': return/);
  assert.match(js, /sel: '\[data-app-nav="daily"\]', eyebrow: 'Today'/);
  assert.match(js, /function greetingLine\(\)/);
  assert.match(js, /\{ source: 'avatar', greeting: greetingLine\(\) \}/, 'chat from the bubble opens with one local line, shown in her own log');
  assert.doesNotMatch(js.slice(js.indexOf('function greetingLine()'), js.indexOf('function hop()')), /fetch|dispatchEvent/);
  const ui = read('gaia-ui.js');
  assert.match(ui, /event\.detail\?\.greeting && !transcript\.querySelector\('\.gaia-assist__bubble--user'\)/, 'the shell shows it only in a fresh transcript');
  assert.match(ui, /appendMessage\('assistant', String\(event\.detail\.greeting\)\.slice\(0, 300\)\)/, 'as Gaia\'s own bubble, never sent anywhere');
  const idle = js.slice(js.indexOf('// ── idle personality'), js.indexOf('// ── end idle personality'));
  assert.match(idle, /const glanced = \{ you: false, today: false \};/, 'once per session each');
  assert.match(idle, /glanceAt\(document\.querySelector\('\[data-app-nav="profile"\]'\), 1800\)/);
  assert.match(idle, /new Date\(\)\.getHours\(\) < 11/, 'the morning glance toward Today');
});

test('the in-app window always has a reachable Close, and bookings send a member to the directory first', () => {
  const member = read('gaia-member.js');
  assert.match(member, /height:min\(92dvh,100%\);max-height:100%/, 'the sheet never grows past the screen');
  assert.match(member, /gaia-booking-modal__foot"><button type="button" class="gaia-booking-modal__done" data-book-close>Close<\/button>/, 'a Close at the thumb');
  assert.match(member, /href="home\.html\?view=directory" data-app-nav="directory">Find a practitioner near you/);
  const css = read('gaia-avatar.css');
  assert.match(css, /\.g-super-home > \.g-super-today-door \{ grid-column: 1;/); assert.match(css, /\.g-super-primary:not\(\.g-super-today-door\) \{ grid-column: 2;/);
});
