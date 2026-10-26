import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP, actor, person } from './_db.js';
import { seedCatalog, currentVersion, versionDetails, createDraftVersion, publishVersion, retireVersion } from '../src/plans.js';
import { createSubscription } from '../src/subscriptions.js';

test('the v2.5 catalogue: four tiers at the decided prices and coin allowances', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    assert.deepEqual(await seedCatalog(pool), ['free', 'standard', 'professional', 'inner_circle']);
    assert.deepEqual(await seedCatalog(pool), [], 'seeding twice changes nothing');
    const expect = { free: [{ none: 0 }, 0], standard: [{ month: 4700, year: 47000 }, 500], professional: [{ month: 9700, year: 97000 }, 2000], inner_circle: [{ month: 29700, year: 297000 }, 4000] };
    for (const [key, [prices, coins]] of Object.entries(expect)) {
      const v = await versionDetails(pool, (await currentVersion(pool, key)).id);
      assert.deepEqual(v.prices, prices, key + ' prices');
      assert.equal(v.monthly_coin_grant, coins, key + ' coins');
    }
    const pro = await versionDetails(pool, (await currentVersion(pool, 'professional')).id);
    const ic = await versionDetails(pool, (await currentVersion(pool, 'inner_circle')).id);
    assert.equal(pro.entitlements['crm.ghl_subaccount'], true);
    assert.equal(pro.entitlements['discount.certifications_pct'], 20);
    assert.equal(pro.entitlements['listing.badge.gaia_recommended'], undefined, 'badge is Inner Circle only (D14)');
    assert.equal(ic.entitlements['listing.badge.gaia_recommended'], true);
    for (const k of Object.keys(pro.entitlements)) assert.ok(k in ic.entitlements, 'Inner Circle includes everything in Professional: ' + k);
    const packs = (await pool.query('SELECT key, coins, price_cents, status FROM coin_packages ORDER BY coins')).rows;
    assert.deepEqual(packs.map((p) => [p.key, p.coins, p.price_cents, p.status]), [['starter', 500, 500, 'draft'], ['regular', 1200, 1000, 'draft'], ['pro', 3000, 2500, 'draft']]);
  } finally { await pool.end(); }
});

test('published versions are immutable; a price change is a new version and grandfathers subscribers', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const v1 = await currentVersion(pool, 'standard');
    await assert.rejects(pool.query('UPDATE plan_version_prices SET amount_cents = 1 WHERE plan_version_id = $1', [v1.id]), /cannot change/);
    await assert.rejects(pool.query('UPDATE plan_versions SET monthly_coin_grant = 9999 WHERE id = $1', [v1.id]), /immutable/);
    await assert.rejects(pool.query('DELETE FROM plan_version_entitlements WHERE plan_version_id = $1', [v1.id]), /cannot change/);
    await assert.rejects(pool.query('DELETE FROM plan_versions WHERE id = $1', [v1.id]), /cannot be deleted/);

    const p = await person(pool);
    const sub = await createSubscription(pool, { personId: p, planVersionId: v1.id, interval: 'month', status: 'active' }, actor);
    const planId = (await pool.query('SELECT plan_id FROM plan_versions WHERE id = $1', [v1.id])).rows[0].plan_id;
    const v2 = await createDraftVersion(pool, planId, { prices: { month: 5200, year: 52000 }, monthlyCoinGrant: 500 }, actor);
    await publishVersion(pool, v2.id, actor);
    await retireVersion(pool, v1.id, actor);
    assert.equal((await currentVersion(pool, 'standard')).id, v2.id);
    const s = (await pool.query('SELECT plan_version_id FROM subscriptions WHERE id = $1', [sub])).rows[0];
    assert.equal(s.plan_version_id, v1.id, 'the existing subscriber keeps version 1');
    assert.equal((await versionDetails(pool, v1.id)).prices.month, 4700, 'and its price');
    await assert.rejects(createSubscription(pool, { personId: p, planVersionId: v1.id, interval: 'month' }, actor), (e) => e.code === 'PLAN_ARCHIVED', 'retired versions are not sold');
  } finally { await pool.end(); }
});

test('legacy versions are only assigned by an explicit legacy import', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    await seedCatalog(pool);
    const planId = (await pool.query("SELECT id FROM plans WHERE key = 'standard'")).rows[0].id;
    const legacy = await createDraftVersion(pool, planId, { prices: { month: 4700 }, isLegacy: true, terms: { note: 'fixture legacy terms' } }, actor);
    await publishVersion(pool, legacy.id, actor);
    assert.notEqual((await currentVersion(pool, 'standard')).id, legacy.id, 'legacy is never the version on sale');
    const p = await person(pool);
    await assert.rejects(createSubscription(pool, { personId: p, planVersionId: legacy.id, interval: 'month' }, actor), (e) => e.code === 'FORBIDDEN');
    assert.ok(await createSubscription(pool, { personId: p, planVersionId: legacy.id, interval: 'month', source: 'legacy_import', status: 'active' }, actor));
  } finally { await pool.end(); }
});
