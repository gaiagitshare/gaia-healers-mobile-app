/**
 * MEMBER PREFERENCES — a flat map of allowed booleans per member, kept on the
 * server so a phone and a laptop agree. Unknown keys and non-booleans never
 * reach the file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getPrefs, setPrefs, PREF_KEYS } = await import('../member-prefs.js');

test('defaults are false; only allowed boolean keys are stored; unknown keys are dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')); const file = path.join(dir, 'p.json');
  assert.deepEqual(getPrefs('c1', { file }), { next_level_collapsed: false, readings_explainer_collapsed: false, practitioner_card_dismissed: false, avatar_idle_off: false, avatar_hello_chime: false, guides_to_assist: false });
  assert.deepEqual(setPrefs('c1', { next_level_collapsed: true, evil: '<script>', next_level_collapsed_x: true }, { file }), { next_level_collapsed: true, readings_explainer_collapsed: false, practitioner_card_dismissed: false, avatar_idle_off: false, avatar_hello_chime: false, guides_to_assist: false });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw.c1).sort(), ['next_level_collapsed', 'updated_at']);
  assert.equal(setPrefs('c1', { next_level_collapsed: 'yes' }, { file }).next_level_collapsed, true, 'a string is not a boolean: ignored');
  assert.equal(setPrefs('c1', { next_level_collapsed: false }, { file }).next_level_collapsed, false);
  assert.equal(setPrefs('', { next_level_collapsed: true }, { file }), null, 'no member, nothing stored');
  assert.deepEqual(getPrefs('c2', { file }), { next_level_collapsed: false, readings_explainer_collapsed: false, practitioner_card_dismissed: false, avatar_idle_off: false, avatar_hello_chime: false, guides_to_assist: false }, 'members do not see each other');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.ok(Object.keys(PREF_KEYS).length >= 1);
});

test('the app: Next level folds through the prefs route, empty cards fold to one line, Today carries the two numbers', () => {
  const read = (name) => { for (const base of ['../../', '../../gaia-healers-mobile-app-1/']) { try { return fs.readFileSync(new URL(base + name, import.meta.url), 'utf8'); } catch { /* next */ } } throw new Error(name + ' not found'); };
  const ui = read('gaia-membership-ui.js');
  assert.match(ui, /\/api\/member\/prefs/); assert.match(ui, /next_level_collapsed/); assert.match(ui, /data-next-toggle/);
  assert.doesNotMatch(ui, /localStorage/, 'kept on the server, not in the browser');
  const member = read('gaia-member.js');
  assert.match(member, /g-card--empty/);
  assert.match(member, /activityRows\.filter\(\(r\) => r\.active\)\.concat\(activityRows\.filter\(\(r\) => !r\.active\)\)/, 'You: one activity card; rows with something in them come first');
  assert.match(member, /gMeCard\('Your activity'/); assert.doesNotMatch(member, /gMeCard\('Purchases & subscriptions'|gMeCard\('My bookings'|gMeCard\('Forms & surveys'|gMeCard\('Messages'/, 'the four cards are gone');
  assert.match(member, /practitioner_card_dismissed/, '"Not now" on Become a practitioner is a server preference');
  assert.match(member, /getJson\('\/api\/member\/prefs'\)/, 'loaded with the rest of the member data, so the card never flashes');
  const today = read('gaia-superapp.js');
  const todayFn = today.slice(today.indexOf('function renderToday()'));
  assert.ok(todayFn.indexOf('nextBookingCard()') > 0 && todayFn.indexOf('nextBookingCard()') < todayFn.indexOf('data-sky-host'), 'Today: the next booking sits above the sky card');
  assert.match(member, /gaia:prefs-reset/, 'You redraws when "Show hidden cards again" fires from Your data and sharing');
  const html = read('home.html');
  assert.ok(html.indexOf('id="member-me"') < html.indexOf('id="member-data-sharing"'), 'Your data and sharing sits under Account');
  const prac = read('gaia-practitioner.js');
  assert.match(prac, /member-readings'\)\?\.classList\.toggle\('is-on-practice-tab', practice\)/, 'a practitioner who is also a linked member: the readings card belongs to the You tab');
  assert.match(prac, /gaia:open-readings', \(\) => select\('me'\)/, '"open my readings" brings the You tab forward');
  const learn = read('gaia-app-v3-learn-connect.css');
  assert.match(learn, /max-width: 639px[^}]*\n[^}]*#community-body \.g-access__name \{[^}]*-webkit-line-clamp: 2/, 'phones: circle names on two lines');
  assert.match(learn, /max-width: 639px[^}]*\n[^}]*\.g-access__name \{ -webkit-line-clamp: 2/, 'phones: course titles on two lines');
  assert.match(learn, /min-width: 1100px[^}]*\n[^}]*#member-academy \.g-access-grid/, 'Academy goes three abreast on wide desktops');
  const panel = read('gaia-my-readings.js');
  assert.match(panel, /function dataSharingCard/); assert.match(panel, /reset-prefs/); assert.match(panel, /gaia:prefs-reset/);
  assert.match(panel, /g-readings-nudge__nums/);
  assert.match(panel, /hero\.insertAdjacentElement\('afterend', el\)/, 'Today: the readings row sits right under the greeting');
  const srv = read('staging-proxy/server.js');
  assert.match(srv, /url\.pathname === '\/api\/member\/prefs'/);
  assert.match(srv, /requireSessionMember\(req, res, origin\);\n      if \(!memberContext\) return;\n      const id = memberContext\.contactId/, 'signed-in members only, keyed by their own id');
});

test('guides_to_assist is a recorded consent: allowed, off by default, and the sharing card offers it only once linked', async () => {
  assert.ok('guides_to_assist' in PREF_KEYS);
  const { default: fs } = await import('node:fs');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')), 'p.json');
  assert.equal(getPrefs('m1', { file }).guides_to_assist, false);
  assert.equal(setPrefs('m1', { guides_to_assist: true }, { file }).guides_to_assist, true);
  const ui = fs.readFileSync(new URL('../../gaia-my-readings.js', import.meta.url), 'utf8');
  const card = ui.slice(ui.indexOf('function dataSharingCard'), ui.indexOf('let lastSummary'));
  assert.match(card, /status\.linked \? `<div class="g-rows g-datashare__consent">/, 'the consent row exists only for a linked member');
  assert.match(card, /data-readings-action="toggle-guides"/);
  assert.match(card, /nothing is read either way/, 'the copy says plainly that nothing reads it yet');
  assert.match(ui, /body: \{ prefs: \{ guides_to_assist: next \} \}/, 'the toggle is stored server-side');
});
