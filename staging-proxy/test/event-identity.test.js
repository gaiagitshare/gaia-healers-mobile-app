/**
 * The proxy half of attendee identity.
 *
 * The Event Manager decides what a person holds. This layer decides who is
 * asking — and it is the only place that reads the Gaia session. If it passes
 * the wrong identity across, or claims an email was verified when it was not,
 * every guarantee on the other side is void.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityFromSession, phaseOf, toAppRow } from '../membership/event-identity.js';

const proxyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const session = (member, extra = {}) => ({ member, ...extra });

// ── What the session is allowed to claim ────────────────────────────────────

test('a magic-link session passes its email as verified', () => {
  const id = identityFromSession(session({ email: 'Sam@Example.com' }, { emailVerified: true }));
  assert.equal(id.email, 'sam@example.com', 'normalised for exact matching');
  assert.equal(id.email_verified, true);
});

test('a session that never proved its email says so', () => {
  // The embedded-claim path can produce this. The Event Manager will then
  // refuse to resolve on the address, which is the intended outcome.
  const id = identityFromSession(session({ email: 'sam@example.com', contactId: 'ghl-1' }));
  assert.equal(id.email_verified, false);
  assert.equal(id.contact_id, 'ghl-1', 'the contact id is still usable evidence');
});

test('verification is never inferred from a truthy-looking value', () => {
  for (const value of ['true', 1, 'yes', {}, []]) {
    const id = identityFromSession(session({ email: 'a@b.com' }, { emailVerified: value }));
    assert.equal(id.email_verified, false, `${JSON.stringify(value)} must not count as proof`);
  }
});

test('no session, no identity', () => {
  assert.equal(identityFromSession(null), null);
  assert.equal(identityFromSession({}), null);
  assert.equal(identityFromSession(session({})), null, 'a member with neither email nor id is nobody');
  assert.equal(identityFromSession(session({ email: '   ' })), null);
});

test('memberId is accepted as a contact id, since GHL uses both names', () => {
  assert.equal(identityFromSession(session({ memberId: 'ghl-42' })).contact_id, 'ghl-42');
  assert.equal(
    identityFromSession(session({ contactId: 'wins', memberId: 'loses' })).contact_id,
    'wins',
    'an explicit contactId is preferred',
  );
});

// ── Event phase ─────────────────────────────────────────────────────────────

test('an event is upcoming, live or past according to its own dates', () => {
  const row = { start_date: '2026-11-01T09:00:00', end_date: '2026-11-03T18:00:00' };
  assert.equal(phaseOf(row, new Date('2026-10-01T12:00:00')), 'upcoming');
  assert.equal(phaseOf(row, new Date('2026-11-02T12:00:00')), 'live');
  assert.equal(phaseOf(row, new Date('2026-12-01T12:00:00')), 'past');
});

test('an event with no end date is not silently declared finished', () => {
  const row = { start_date: '2026-01-01T09:00:00', end_date: null };
  assert.equal(phaseOf(row, new Date('2026-06-01T12:00:00')), 'live');
});

// ── What reaches the client ─────────────────────────────────────────────────

test('the list view carries no QR code', () => {
  // My Events is a list. A list has no use for a door credential, and shipping
  // one to every row would put every ticket a person holds into any response
  // that leaked.
  const row = toAppRow({
    event_id: 4,
    event_name: 'Elevate 2026',
    attendee: { first_name: 'Sam', last_name: 'Reed', qr_code: 'ATT-SECRET', pass_label: 'VIP' },
  }, new Date());
  assert.equal(JSON.stringify(row).includes('ATT-SECRET'), false,
    'the QR must not appear anywhere in a My Events row');
  assert.equal(row.ticket.passLabel, 'VIP');
});

test('access flags come across as booleans, never as a pass name', () => {
  const row = toAppRow({
    event_id: 1,
    attendee: { pass_label: 'VIP Gold All Access', is_vip: false, grants_workshops: false },
  }, new Date());
  assert.equal(row.ticket.isVip, false,
    'the label says VIP but the ticket type did not grant it — the flag wins');
  assert.equal(row.ticket.passLabel, 'VIP Gold All Access');
});

test('a missing attendee block degrades to empty rather than throwing', () => {
  const row = toAppRow({ event_id: 9, event_name: 'Sparse' }, new Date());
  assert.equal(row.ticket.checkedIn, false);
  assert.equal(row.ticket.passLabel, '');
});

// ── The route contract ──────────────────────────────────────────────────────

test('the client can never name an attendee', () => {
  const source = fs.readFileSync(path.join(proxyRoot, 'membership', 'event-identity.js'), 'utf8');
  assert.ok(!/attendee_id|attendeeId/.test(source),
    'nothing in this module accepts an attendee id from a caller');

  const server = fs.readFileSync(path.join(proxyRoot, 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("url.pathname === '/api/events/mine'"));
  const block = route.slice(0, route.indexOf('return;'));
  assert.ok(block.includes('cookieForRequest(req)'),
    'identity is read from the signed session, not from the request');
  assert.ok(!/searchParams/.test(block),
    'and never from a query parameter');
});

test('a ticket response is never cached', () => {
  const server = fs.readFileSync(path.join(proxyRoot, 'server.js'), 'utf8');
  const start = server.indexOf("/^\\/api\\/events\\/\\d+\\/ticket$/");
  assert.ok(start > 0, 'the ticket route exists');
  const block = server.slice(start, server.indexOf('return;', start));
  assert.ok(/no-store/.test(block), 'a personal credential must not sit in a cache');
  assert.ok(/private/.test(block), 'nor in a shared one');
});

test('the service token is never sent to the browser', () => {
  const source = fs.readFileSync(path.join(proxyRoot, 'membership', 'event-identity.js'), 'utf8');
  // It may be read from the environment and put in an Authorization header,
  // but must not appear in anything returned to a caller.
  const returned = source.slice(
    source.indexOf('async function myEvents'),
    source.indexOf('async function myUpgrades'),
  );
  assert.ok(!/IDENTITY_SERVICE_TOKEN/.test(returned),
    'the token is used only in the server-to-server call, never in a response');
});

test('an unreachable Event Manager is reported, not shown as an empty list', () => {
  const source = fs.readFileSync(path.join(proxyRoot, 'membership', 'event-identity.js'), 'utf8');
  assert.ok(source.includes('event_manager_unreachable'),
    'a service outage has its own reason code');
  // "You have no tickets" and "we could not check" must not look the same to
  // someone standing at a door.
  const myEvents = source.slice(source.indexOf('async function myEvents'),
    source.indexOf('async function myTicket'));
  assert.ok(/ok: false/.test(myEvents), 'an outage returns ok:false, not an empty success');
});
