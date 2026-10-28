/**
 * Event data sources are watched one by one (28 Oct 2026): a source that keeps
 * failing while the others run, a sheet with ambiguous rows, orders the webhook
 * missed, paid orders placed on nobody, the public agenda drifting from the
 * app, and Shopify selling Elevate tickets nothing records.
 *
 * Offline: fixture files in a temp folder, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alertExtras } from '../admin-router.js';
import { detect } from '../alerts.js';

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString().slice(0, 19);

function fixture({ sheet = {}, agenda = null, speakers = null, exhibitors = null, site = null, mirror = null, catalog = null } = {}) {
  const ev = fs.mkdtempSync(path.join(os.tmpdir(), 'evsrc-ev-'));
  const px = fs.mkdtempSync(path.join(os.tmpdir(), 'evsrc-px-'));
  fs.writeFileSync(path.join(ev, 'sheet-sync-status.json'), JSON.stringify(sheet));
  if (agenda) fs.writeFileSync(path.join(ev, 'agenda-page-watch.json'), JSON.stringify(agenda));
  if (speakers) fs.writeFileSync(path.join(ev, 'speaker-page-watch.json'), JSON.stringify(speakers));
  if (exhibitors) fs.writeFileSync(path.join(ev, 'exhibitor-page-watch.json'), JSON.stringify(exhibitors));
  if (site) fs.writeFileSync(path.join(ev, 'event-site-watch.json'), JSON.stringify(site));
  if (mirror) fs.writeFileSync(path.join(px, 'event-mirror-status.json'), JSON.stringify(mirror));
  if (catalog) fs.writeFileSync(path.join(px, 'store-catalog.json'), JSON.stringify(catalog));
  return { eventDataDir: ev, proxyDataDir: px, loadLedger: () => ({ contacts: {} }),
    ghlGet: async () => null, ghlConfig: () => ({ enabled: false }) };
}

const keys = async (deps) => detect({ components: [] }, await alertExtras(deps)).map((d) => d.key).filter((k) => k.startsWith('event-source:'));

test('a healthy picture raises nothing', async () => {
  const deps = fixture({
    sheet: { vendor_sync: { ok: true, exit: 0, last_success: iso(0.3) }, speaker_sync: { ok: true, exit: 0, last_success: iso(0.3) } },
    agenda: { synced: true, changed_at: iso(1), first_seen_at: iso(50), rows: 46, problems: [] },
    mirror: { at: iso(0.1), reconciled: 0, no_email_unplaced: 0, last_missed_at: iso(30) },
    catalog: { products: { a: { title: 'Bio-Well 3.0', available: true } } },
  });
  assert.deepEqual(await keys(deps), []);
});

test('the Bio-Well case: a sheet conflict is named, the source is still fresh', async () => {
  const deps = fixture({ sheet: { vendor_sync: { ok: true, exit: 3, last_success: iso(0.3),
    conflicts: '1 duplicate company name(s) in the sheet: Bio-Well' } } });
  const k = await keys(deps);
  assert.deepEqual(k, ['event-source:conflicts:vendor_sync']);
});

test('one source failing for hours while the others run is stale on its own', async () => {
  const deps = fixture({ sheet: { vendor_sync: { ok: true, exit: 0, last_success: iso(0.3) },
    speaker_sync: { ok: false, exit: 1, last_success: iso(5) } } });
  assert.deepEqual(await keys(deps), ['event-source:stale:speaker_sync']);
});

test('the recovery pass catching webhook misses, and paid orders on nobody', async () => {
  const deps = fixture({ mirror: { at: iso(0.1), reconciled: 0, no_email_unplaced: 1, last_missed_at: iso(3), last_missed_count: 2 } });
  const k = await keys(deps);
  assert.ok(k.includes('event-source:webhook-missed'), 'a miss 3 hours ago is still raised after a quiet run');
  assert.ok(k.includes('event-source:order-unplaced'));
  const old = fixture({ mirror: { at: iso(0.1), reconciled: 0, no_email_unplaced: 0, last_missed_at: iso(30) } });
  assert.deepEqual(await keys(old), [], 'a miss older than a day has cleared');
  const silent = fixture({ mirror: { at: iso(3), reconciled: 0, no_email_unplaced: 0 } });
  assert.deepEqual(await keys(silent), ['event-source:order-mirror-silent']);
});

test('the agenda page changed while nothing carries it into the app', async () => {
  const drift = fixture({ agenda: { synced: false, changed_at: iso(2), first_seen_at: iso(48), rows: 46, problems: [] } });
  assert.deepEqual(await keys(drift), ['event-source:agenda-drift']);
  const firstLook = fixture({ agenda: { synced: false, changed_at: iso(1), first_seen_at: iso(1), rows: 46, problems: [] } });
  assert.deepEqual(await keys(firstLook), [], 'the first observation is not a change');
  const broken = fixture({ agenda: { synced: true, changed_at: iso(1), first_seen_at: iso(48), rows: 0, problems: ['only 0 talks found'] } });
  assert.deepEqual(await keys(broken), ['event-source:agenda-unreadable']);
});

test('Shopify selling Elevate tickets is raised; unavailable ones are not', async () => {
  const deps = fixture({ catalog: { products: {
    a: { title: 'Gaia Healers Elevate 2026 VIP', available: true },
    b: { title: 'Gaia Healers Elevate Friday 20th General Admission', available: false },
    c: { title: 'Healeex', available: true } } } });
  const extra = await alertExtras(deps);
  assert.deepEqual(extra.eventSources.shopifyElevate, ['Gaia Healers Elevate 2026 VIP']);
  assert.deepEqual(await keys(deps), ['event-source:shopify-elevate']);
});

test('the speaker line-up on the event page drifting, or no longer readable, is raised', async () => {
  const drift = fixture({ speakers: { synced: false, changed_at: iso(2), first_seen_at: iso(48), rows: 16, problems: [] } });
  assert.deepEqual(await keys(drift), ['event-source:speaker-page-drift']);
  const synced = fixture({ speakers: { synced: true, changed_at: iso(2), first_seen_at: iso(48), rows: 16, problems: [] } });
  assert.deepEqual(await keys(synced), []);
  const broken = fixture({ speakers: { synced: true, changed_at: iso(2), first_seen_at: iso(48), rows: 0, problems: ['only 0 speaker cards found'] } });
  assert.deepEqual(await keys(broken), ['event-source:speaker-page-unreadable']);
});

test('the exhibitors and sponsors on the event page drifting, or no longer readable, is raised', async () => {
  const drift = fixture({ exhibitors: { synced: false, changed_at: iso(2), first_seen_at: iso(48), rows: 21, sponsors: 8, problems: [] } });
  assert.deepEqual(await keys(drift), ['event-source:exhibitor-page-drift']);
  const synced = fixture({ exhibitors: { synced: true, changed_at: iso(2), first_seen_at: iso(48), rows: 21, sponsors: 8, problems: [] } });
  assert.deepEqual(await keys(synced), []);
  const broken = fixture({ exhibitors: { synced: true, changed_at: iso(2), first_seen_at: iso(48), rows: 0, sponsors: 0,
    problems: ['the exhibitor block (exh-section) is not on the page'] } });
  assert.deepEqual(await keys(broken), ['event-source:exhibitor-page-unreadable']);
  const stale = fixture({ sheet: { exhibitor_page_sync: { ok: false, exit: 1, last_success: iso(5) } } });
  assert.deepEqual(await keys(stale), ['event-source:stale:exhibitor_page_sync']);
});

test('tickets, packages, FAQ or hotel on the website drifting, or unreadable, is raised', async () => {
  const drift = fixture({ site: { synced: false, changed_at: iso(2), first_seen_at: iso(48), rows: 22, problems: [] } });
  assert.deepEqual(await keys(drift), ['event-source:event-site-drift']);
  const synced = fixture({ site: { synced: true, changed_at: iso(2), first_seen_at: iso(48), rows: 22, problems: [] } });
  assert.deepEqual(await keys(synced), []);
  const broken = fixture({ site: { synced: false, changed_at: iso(2), first_seen_at: iso(48), rows: 5,
    problems: ['packages page: only 0 package(s) found; the page layout may have changed'] } });
  assert.deepEqual(await keys(broken), ['event-source:event-site-unreadable']);
});
