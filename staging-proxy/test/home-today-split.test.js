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

test('the daily energy check and the sky render on Today only; the member Home is the dashboard said once', () => {
  const sa = read('gaia-superapp.js');
  assert.match(sa, /function renderToday\(\)/); assert.match(sa, /function renderHomeMember\(root, greeting\)/);
  assert.doesNotMatch(sa, /todayDoor/, 'no "Open Today" card: Today is a tab');
  const home = sa.slice(sa.indexOf('function renderHome()'), sa.indexOf('function homeLine()'));
  assert.doesNotMatch(home, /data-daily-host/, 'Home no longer carries the daily check'); assert.doesNotMatch(home, /data-sky-host/, 'nor the sky');
  const member = sa.slice(sa.indexOf('function renderHomeMember('), sa.indexOf('function homeLine()'));
  assert.doesNotMatch(member, /g-super-hero|g-super-services|g-super-sync|upgradeCard\(\)|primaryMemberAction\(\)/, 'no hero, no second access grid, no permanent sync notice, no giant upgrade card');
  assert.match(member, /<header class="g-home2__greet"><h1>' \+ greeting \+ '<\/h1>/, 'the greeting is the page heading');
  // 6 Oct 2026 hierarchy: my own state first (readings or today's check), then
  // what is happening for me (course, booking, gathering), then my places.
  for (const part of ['stateHero()', 'forYou()', "serviceLink(v, i, t, m)", 'bookActions()', 'membershipStrip()']) assert.ok(member.includes(part), part);
  assert.ok(member.indexOf('stateHero()') < member.indexOf('forYou()'), 'my state leads');
  assert.match(sa, /function forYou\(\)[\s\S]*eventCompact\(\)/, 'the gathering sits in For you, smaller than my state');
  assert.match(member, /meta\.degraded \|\| meta\.stale/, 'sync is said only when something is wrong');
  assert.match(sa, /<small>Continue learning<\/small>[\s\S]*<small>Coming up<\/small>/, 'a course and a booking each get a For you tile');
  const guest = sa.slice(sa.indexOf('this is the\n      // guest on-ramp'), sa.indexOf('bind(root);\n    renderToday();'));
  assert.match(guest, /guestHero\(dayGreeting\)[\s\S]*guestExplore\(\)[\s\S]*guestJoin\(\)[\s\S]*guestEvent\(\)/, 'guest: what Gaia is, the tools, the way in, the gathering');
  assert.doesNotMatch(guest, /eventFeatureCarousel\(\)/);
  const ui = read('gaia-ui.js');
  assert.match(ui, /sel: '\.gava-char', title: 'Get a little guidance'/, 'the first-run guidance points at her, not the old orb');
  assert.doesNotMatch(ui, /sel: '\.gaia-tabbar__assist', eyebrow: 'Your guide'/);
  // every destination is the one that was here before
  for (const id of ['scans', 'bio-welldemo']) assert.ok(sa.includes(id), id);
  // Home, Today's card and Bookings offer one set of sessions (Babak, 5 Oct 2026): the Bookings list
  const book = sa.slice(sa.indexOf('function bookActions()'), sa.indexOf('/** Membership, in one strip'));
  assert.match(book, /bookingSet\(\)/, 'Home books from the shared list');
  assert.doesNotMatch(book, /widget\/form\//, 'no separate hard-coded forms on Home');
  assert.match(read('gaia-member.js'), /window\.GaiaBookingSet/, "Today's booking card reads the shared list");
  assert.match(sa, /href="home\.html\?view=store&tab=membership"/); assert.match(sa, /href="home\.html\?view=events"/);
  const today = sa.slice(sa.indexOf('function renderToday()'), sa.indexOf('// Next booking — the member\'s soonest'));
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
  assert.match(js, /GaiaTour\.run\(undefined, \{ remember: !member \}\)/, 'the avatar replays the shared current tour');
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
  assert.match(member, /href="home\.html\?view=directory" data-dir-intent="scan">Find a practitioner near you/, 'You: the directory, with the scan intent');
  // Bio-Well scan: the practitioner first, then a time on THEIR calendar (gaiapractitioners.com publishes meetingLink)
  const dir = read('gaia-directory.js');
  assert.match(dir, /function isBioWell\(p\) \{ return \/bio-\?well\/i\.test/, 'Bio-Well practitioners are found by specialty or tag');
  assert.match(dir, /window\.GaiaDirectory = \{ open: openWith \}/);
  assert.match(dir, /Book a Bio-Well scan/); assert.match(dir, /SCAN_FALLBACK = 'https:\/\/api\.leadconnectorhq\.com\/widget\/bookings\/scans'/, 'a practitioner without a calendar still books through the Gaia scan calendar, in the app');
  assert.match(dir, /function nearMe\(\)/); assert.match(dir, /navigator\.geolocation\.getCurrentPosition/, 'near me sorts by distance, only when tapped');
  assert.doesNotMatch(dir.slice(dir.indexOf('async function load()')), /getCurrentPosition/, 'never on load');
  assert.match(dir, /Bio-Well practitioners'\)/, 'the count names what is shown');
  assert.match(dir, /function embeds\(url\) \{ return \/\^https\?:/, 'Calendly and GHL calendars open in the app');
  const sa2 = read('gaia-superapp.js');
  assert.match(sa2, /'biowell-scan': \{[^}]*intent: 'scan'/, 'Home: the scan action opens the directory with the intent');
  assert.match(sa2, /data-dir-intent\]'\)\.forEach/);
  // My readings on You: In short first, the rest one tap away (and Gaia's open-my-readings unfolds it)
  const readings2 = read('gaia-my-readings.js');
  assert.match(readings2, /function foldedCard\(r\)/); assert.match(readings2, /expanded \? readingsCard\(r\.body, status, prefs\) : foldedCard\(r\.body\)/);
  assert.match(readings2, /if \(!expanded && lastReadings\) \{ expanded = true;/, 'reveal unfolds');
  // the pass and its next level are one card
  const mui = read('gaia-membership-ui.js');
  assert.match(mui, /'<div class="g-pass-stack">' \+ memberPass\(access\) \+ nextLevel\(access, plans\) \+ '<\/div>'/);
  const css = read('gaia-superapp.css');
  for (const bp of ['min-width: 768px', 'min-width: 1024px', 'min-width: 1440px', 'max-width: 1023px']) assert.ok(css.slice(css.indexOf('.g-super-home--v2')).includes(bp), bp);
  assert.match(css, /\.g-super-home--v2 \{ display: block !important;/, 'the old two-column grid does not apply to the v2 Home');
});
