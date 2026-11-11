// Directory booking check: which practitioners can really be booked online.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bc from '../booking-check.js';

const CALS = [
  { id: 'CalOpen0000000000001', widgetSlug: 'open-one', isActive: true },
  { id: 'CalNoUsers0000000002', widgetSlug: 'nobody', isActive: true },
  { id: 'CalFull000000000003', widgetSlug: 'full-up', isActive: true },
  { id: 'CalOff00000000000004', widgetSlug: 'switched-off', isActive: false },
  { id: 'CalScans000000000005', widgetSlug: 'scans', isActive: true },
  { id: 'CalFlaky00000000006', widgetSlug: 'flaky', isActive: true },
];
const W = 'https://api.leadconnectorhq.com/widget/';
const LINKS = [
  { id: 1, meetingLink: W + 'bookings/open-one' },
  { id: 2, meetingLink: W + 'bookings/nobody' },
  { id: 3, meetingLink: W + 'booking/CalFull000000000003' },
  { id: 4, meetingLink: W + 'bookings/switched-off' },
  { id: 5, meetingLink: '' },
  { id: 6, meetingLink: 'https://calendly.com/someone/scan' },
  { id: 7, meetingLink: W + 'bookings/gone-away' },
  { id: 8, meetingLink: W + 'bookings/other-account' },
  { id: 9, meetingLink: W + 'bookings/open-one' },
  { id: 10, meetingLink: W + 'bookings/flaky' },
];

function fakes(over = {}) {
  const calls = [];
  const ghlRequest = async (p) => {
    calls.push(p);
    const id = p.split('/')[2];
    if (id === 'CalOpen0000000000001') return { status: 200, json: { '2026-11-12': { slots: ['a', 'b'] }, '2026-11-13': { slots: ['c'] }, traceId: 'x' } };
    if (id === 'CalFull000000000003') return { status: 200, json: { traceId: 'x' } };
    if (id === 'CalFlaky00000000006') return over.flaky || { status: 503, json: null };
    return { status: 422, json: { message: 'No users found in the calendar' } };
  };
  return {
    calls,
    deps: {
      ghlRequest,
      listCalendars: async () => (over.noCalendars ? null : CALS),
      practitionerLinks: async () => LINKS,
      pageStatus: async (u) => (/gone-away/.test(u) ? 404 : 200),
      scanTeamSlug: 'scans',
    },
  };
}

test('each practitioner gets the status their calendar earns', async () => {
  bc._reset();
  const { deps } = fakes();
  const out = await bc.runOnce(deps, { now: Date.parse('2026-11-11T12:00:00Z'), paceMs: 0 });
  assert.equal(bc.statusFor(1), 'online', 'open times in the next 30 days');
  assert.equal(bc.statusFor(2), 'unavailable', 'no one assigned in GHL');
  assert.equal(bc.statusFor(3), 'full', 'works, but nothing open for 30 days (booking/<id> link form)');
  assert.equal(bc.statusFor(4), 'unavailable', 'calendar switched off');
  assert.equal(bc.statusFor(5), 'none', 'no link at all');
  assert.equal(bc.statusFor(6), 'unknown', 'another booking service is not judged');
  assert.equal(bc.statusFor(7), 'unavailable', 'a dead link');
  assert.equal(bc.statusFor(8), 'unknown', 'a calendar in another GHL account is not judged');
  assert.equal(bc.statusFor(999), 'unknown', 'never checked');
  assert.equal(bc.scanTeamStatus(), 'unavailable', 'the Gaia scan-team calendar is checked too');
  assert.equal(out.counts.online, 2);
});

test('a calendar shared by two practitioners is asked about once', async () => {
  bc._reset();
  const { deps, calls } = fakes();
  await bc.runOnce(deps, { paceMs: 0 });
  assert.equal(calls.filter((c) => c.includes('CalOpen0000000000001')).length, 1);
  assert.equal(bc.statusFor(9), 'online');
});

test('a timeout or 5xx is no evidence: the last status is kept', async () => {
  bc._reset();
  const first = fakes({ flaky: { status: 200, json: { '2026-11-20': { slots: ['x'] } } } });
  await bc.runOnce(first.deps, { paceMs: 0 });
  assert.equal(bc.statusFor(10), 'online');
  await bc.runOnce(fakes().deps, { paceMs: 0, refreshLinks: true });
  assert.equal(bc.statusFor(10), 'online', 'a 503 does not turn a working calendar into a dead end');
  await bc.runOnce(fakes({ flaky: { status: 429, json: null } }).deps, { paceMs: 0 });
  assert.equal(bc.statusFor(10), 'online', 'nor does rate limiting');
});

test('GHL unreachable: nothing is overwritten', async () => {
  bc._reset();
  await bc.runOnce(fakes().deps, { paceMs: 0 });
  await bc.runOnce(fakes({ noCalendars: true }).deps, { paceMs: 0 });
  assert.equal(bc.statusFor(1), 'online');
  assert.equal(bc.statusFor(2), 'unavailable');
});

test('results survive a restart', async () => {
  bc._reset();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-bc-')), 'directory-booking.json');
  bc.load(file);
  await bc.runOnce(fakes().deps, { paceMs: 0 });
  bc._reset();
  bc.load(file);
  assert.equal(bc.statusFor(2), 'unavailable');
  assert.equal(bc.scanTeamStatus(), 'unavailable');
});

test('only online and unknown count as bookable', () => {
  assert.deepEqual(bc.STATUSES.filter(bc.isBookable), ['online', 'unknown']);
});

test('the directory API carries the status, and the server schedules the check safely', () => {
  const src = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const dir = src('directory-router.js');
  assert.match(dir, /booking: booking\.statusFor\(p\.id\)/);
  assert.match(dir, /scanTeam: booking\.scanTeamStatus\(\)/);
  assert.match(dir, /\/api\/directory\/booking-status/);
  const server = src('server.js');
  assert.match(server, /DIRECTORY_BOOKING_CHECK !== 'false' && ghlConfig\(\)\.enabled && !process\.env\.MEMBER_ENTITLEMENTS_FILE\?\.includes\('tmp'\)/, 'never runs under test');
  assert.match(server, /setInterval\(runBookingCheck, 60 \* 60_000\)\.unref\(\)/, 'hourly, not a tight loop');
});
