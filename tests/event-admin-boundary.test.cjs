/**
 * One Event Manager, not two.
 *
 * Gaia Healers Admin embeds the real /event/ application in an iframe. The day
 * somebody starts building an attendee list, a check-in screen or a badge
 * renderer inside the Admin shell instead, the two panels begin to disagree
 * about who is checked in — and nobody notices until an event day.
 *
 * This test is the tripwire. See design-reference/EVENT-ADMIN-ARCHITECTURE.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const shellRaw = read('admin/gadmin.js');

// Comments explain the boundary, so they naturally name the things that must
// not appear in the code. Strip them, then judge what is actually executed.
const shell = shellRaw
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

test('the Admin shell embeds the real Event Manager rather than reimplementing it', () => {
  assert.match(shell, /<iframe[^>]*src="\/event\/"/, 'Events is an iframe onto /event/');
  assert.match(shell, /localStorage\.setItem\('token'/, 'and it hands the iframe the same session (SSO)');
});

test('no event-domain logic has crept into the Admin shell', () => {
  // Each of these belongs to the Event Manager. Finding one here means a second
  // implementation has been started.
  // What this list is for: a SECOND implementation. The failure it prevents is
  // two panels computing check-in independently and disagreeing on the day.
  //
  // Amended deliberately: the Contacts drawer shows a person's event attendance,
  // joined server-side by the proxy from the Event Manager's own API and
  // rendered read-only. That cannot drift, because it computes nothing and
  // writes nothing — the noun "attendee" now appears in the shell as a label.
  // The verbs below are what would signal a real second implementation, and
  // they stay forbidden, as does calling the event backend from here at all
  // (asserted in the next test).
  const forbidden = [
    'checkin', 'check-in', 'walk-in', 'walkin',
    'badge-label', 'badge_print', 'door-report', 'acquisition-report',
    'ticket_type', 'ticket-mappings', 'public_token', 'qr_code',
  ];
  const found = forbidden.filter((word) => shell.toLowerCase().includes(word));
  assert.deepEqual(found, [],
    `event logic must live in /event/, not the Admin shell — found: ${found.join(', ')}`);
});

test('the Admin shell only reaches the event backend for sign-in', () => {
  // SSO needs /auth/. Anything else is event functionality in the wrong place.
  const calls = [...shell.matchAll(/evPost\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, 'the shell does call the event backend for auth');
  const notAuth = calls.filter((p) => !p.startsWith('/auth/'));
  assert.deepEqual(notAuth, [],
    `only /auth/* may be called from the Admin shell — found: ${notAuth.join(', ')}`);
});

test('event data in the shell is displayed, never computed or written', () => {
  // The drawer may render what the proxy already joined. It may not decide
  // anything about an attendee, and it may not write one.
  const writeShapes = [
    /authorize\s*\(/i, /undo-?checkin/i, /scan\s*\(/i,
    /is_checked_in\s*=/, /registration_status\s*=/,
  ];
  const offenders = writeShapes.filter((re) => re.test(shell));
  assert.deepEqual(offenders.map(String), [],
    'the Admin shell must not perform event actions — those belong to /event/');
});

test('the architecture is written down where a developer will find it', () => {
  const doc = read('design-reference/EVENT-ADMIN-ARCHITECTURE.md');
  assert.match(doc, /one\b.{0,20}Event Manager/i, 'it states there is a single Event Manager');
  assert.match(doc, /Gaia Healers Admin → Events is the official entry point/,
    'and which door staff should use');
  assert.match(shellRaw, /EVENT-ADMIN-ARCHITECTURE\.md/,
    'and the shell points at it from the mount point itself');
});
