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
  const forbidden = [
    'attendee', 'checkin', 'check-in', 'walk-in', 'walkin',
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

test('the architecture is written down where a developer will find it', () => {
  const doc = read('design-reference/EVENT-ADMIN-ARCHITECTURE.md');
  assert.match(doc, /one\b.{0,20}Event Manager/i, 'it states there is a single Event Manager');
  assert.match(doc, /Gaia Healers Admin → Events is the official entry point/,
    'and which door staff should use');
  assert.match(shellRaw, /EVENT-ADMIN-ARCHITECTURE\.md/,
    'and the shell points at it from the mount point itself');
});
