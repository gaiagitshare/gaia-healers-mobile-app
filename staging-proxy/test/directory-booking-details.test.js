// Directory quick wins (12 Nov 2026): the booking check keeps the next open
// time, session length and confirmation mode GHL already sends; the directory
// passes on the public address/zip and reviews it used to drop.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as bc from '../booking-check.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const CAL = { id: 'CalOpen0000000000001', widgetSlug: 'open-one', isActive: true, slotDuration: 30, slotDurationUnit: 'mins', autoConfirm: false };
const HOUR = { id: 'CalHour0000000000002', widgetSlug: 'hour', isActive: true, slotDuration: 1, slotDurationUnit: 'hours', autoConfirm: true };
const W = 'https://api.leadconnectorhq.com/widget/bookings/';

test('next open time is the earliest slot still ahead; duration and confirm mode come along', async () => {
  bc._reset();
  const ghlRequest = async (p) => p.includes('CalOpen')
    ? { status: 200, json: { '2026-11-13': { slots: ['2026-11-13T15:00:00Z'] }, '2026-11-12': { slots: ['2026-11-12T09:00:00Z', '2026-11-12T16:30:00Z'] }, traceId: 'x' } }
    : { status: 200, json: { '2026-11-20': { slots: ['2026-11-20T10:00:00Z'] } } };
  await bc.runOnce({ ghlRequest, listCalendars: async () => [CAL, HOUR],
    practitionerLinks: async () => [{ id: 1, meetingLink: W + 'open-one' }, { id: 2, meetingLink: W + 'hour' }],
    pageStatus: async () => 200 }, { now: NOW, paceMs: 0, refreshLinks: true });
  assert.deepEqual(bc.bookingFor(1, NOW), { status: 'online', next: '2026-11-12T16:30:00.000Z', durationMin: 30, autoConfirm: false });
  assert.deepEqual(bc.bookingFor(2, NOW), { status: 'online', next: '2026-11-20T10:00:00.000Z', durationMin: 60, autoConfirm: true });
  // once that time has passed it is no longer offered as "next"
  assert.equal(bc.bookingFor(1, Date.parse('2026-11-12T17:00:00Z')).next, undefined);
  assert.deepEqual(bc.bookingFor(99, NOW), { status: 'unknown' });
});

test('calendarMeta reads minutes and hours, and nothing it does not know', () => {
  assert.deepEqual(bc.calendarMeta({ slotDuration: 45, slotDurationUnit: 'mins', autoConfirm: true }), { durationMin: 45, autoConfirm: true });
  assert.deepEqual(bc.calendarMeta({ slotDuration: 2, slotDurationUnit: 'hours' }), { durationMin: 120 });
  assert.deepEqual(bc.calendarMeta({}), {});
});

test('directions only to plausible street addresses; review dates read properly', async () => {
  const d = await import('../directory-router.js');
  assert.equal(d.plausibleStreet('220 S Wall St #206'), '220 S Wall St #206');
  assert.equal(d.plausibleStreet('212-320 Matheson Blvd West'), '212-320 Matheson Blvd West');
  for (const bad of ['PO Box 242', '123 abc dr', 'Mutual Locations', '14', 'Point Clare', '']) assert.equal(d.plausibleStreet(bad), '', bad);
  assert.equal(d.isoDate('7/12/2024'), '2024-07-12');
  assert.equal(d.isoDate('24/4/2024'), '2024-04-24');
  assert.equal(d.isoDate('12/25/2024'), '2024-12-25');
  assert.equal(d.isoDate('31/31/2024'), '');
  assert.equal(d.isoDate('2025-01-03T10:00:00Z'), '2025-01-03');
  assert.equal(d.isoDate('soon'), '');
  const by = d.indexReviews([{ practitioner: 5, rating: 5, feedback: 'Old', date: '6/22/2024', name: 'Ann Lee' }, { practitioner: 5, rating: 4, feedback: 'New', date: '1/3/2025', name: 'Bo' }, { practitioner: 5, rating: 5, feedback: '', date: '1/1/2025' }]);
  assert.deepEqual(by.get('5').map((r) => [r.text, r.date, r.by]), [['New', '2025-01-03', 'Bo'], ['Old', '2024-06-22', 'Ann']]);
});
