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

test('no Event Admin capability is reimplemented in the general Admin shell', () => {
  // The boundary is about OWNERSHIP, not vocabulary. General Admin may show a
  // person's event summary; Event Admin remains the only place that performs
  // event actions. So this looks for the shapes of those actions rather than
  // for nouns — a screen can say "attendee" and be innocent, and can avoid the
  // word entirely while shipping a check-in button.
  const capabilities = [
    ['check-in',              /\bcheck(ing)?[\s_-]?in\s*\(|\bcheckIn[A-Z(]|authorize(Scan)?\s*\(/],
    ['undo check-in',         /undo[\s_-]?check|\bunCheckIn\b/i],
    ['badge scanning',        /Html5Qrcode|qr-?reader|startScanner|\bscanBadge\b/i],
    ['attendee mutation',     /\b(create|update|delete|revoke|reinstate)Attendee\s*\(|attendees?\/\$\{|\/attendees['"`]/],
    ['pass changes',          /changePass\s*\(|ticket_type_id\s*[:=]|setAddonDay/],
    ['badge printing',        /badgeLabel|recordBadgePrint|sendToPrinter/i],
    ['event payment recon',   /reconcile[A-Za-z]*\s*\(|payments\/(sync|reconcile)|mapReconcile/i],
    ['exhibitor management',  /\/exhibitors?['"`]|createExhibitor|updateExhibitor|vendorActivationLink/],
    // The API path or a mutator — not the phrase. The System Map prints
    // "16 active ticket mappings" as a count, which is exactly the read-only
    // summary this boundary permits.
    ['ticket mappings',       /['"`]\/[a-z-]*ticket-mappings|createTicketMapping|updateTicketMapping/i],
    ['event permissions',     /require_cap|authz\.|grantEventRole/i],
    ['walk-in registration',  /walkInCreate|\bwalk[\s_-]?in\b/i],
  ];
  const found = capabilities.filter(([, re]) => re.test(shell)).map(([name]) => name);
  assert.deepEqual(found, [],
    `Event Admin owns these; the general Admin shell must not implement them — found: ${found.join(', ')}`);
});

test('the Admin shell writes nothing to the event domain', () => {
  // Reading a summary is allowed. Changing an event record from here is not,
  // however it is spelled — so any mutating HTTP verb aimed at the event API is
  // a failure regardless of the path.
  const mutating = [...shell.matchAll(/method:\s*['"](POST|PUT|PATCH|DELETE)['"][\s\S]{0,200}?['"`]([^'"`]*event[^'"`]*)['"`]/gi)]
    .map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(mutating, [],
    `the Admin shell must not write to the event domain — found: ${mutating.join(', ')}`);
});

test('event data reaching the shell is server-joined, not fetched from the event API', () => {
  // The one safe shape: the proxy joins it under /api/admin and the shell
  // renders the result. A direct call to the event backend would make the shell
  // a second client with its own idea of the truth.
  const eventApiCalls = [...shell.matchAll(/['"`](\/event-api\/[^'"`]*)['"`]/g)].map((m) => m[1]);
  const notAuth = eventApiCalls.filter((p) => !p.startsWith('/event-api/auth/'));
  assert.deepEqual(notAuth, [],
    `event data must arrive via the proxy's own /api/admin join, not /event-api — found: ${notAuth.join(', ')}`);
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
