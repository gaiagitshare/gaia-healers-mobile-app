#!/usr/bin/env node
// Gaia Healers beta preview: three fresh, fictional demo members in the STAGING Membership 2.0 database.
// Idempotent (safe to re-run). Actor: beta-demo-setup. Prints ids/statuses only.
//
//   set -a; . /root/.config/gaia-membership-staging.env; set +a
//   node /root/gaia-membership-staging-app/beta-demo-setup.mjs [--dry-run]
//
// The proxy side of these members is defined like every other fixture, in
// staging-proxy/membership/fixtures.js (beta-demo-free / beta-demo-pilot / beta-demo-silver), and they are
// listed in staging-proxy/data/onboarding-complete.json. Here, in the service database:
//   free   no subscription, not on the pilot list
//   pilot  on the pilot list, no subscription
//   silver one fictional legacy Silver row (mapped, active; last_seen_at = the current mirror maximum, so the
//          mirror's freshness does not move) and a migration offer in state `offered`
//   standard / professional / inner-circle  an active Gaia-owned subscription (provider 'simulated', no Stripe), entitlements
//          from the plan version, and the plan's own monthly coin allowance
//   all    a small goodwill credit; free / pilot / silver also a 100-coin allowance, so no wallet is empty
// Nothing else is touched: the real legacy rows are only read (for max(last_seen_at)).
const SRC = process.env.BETA_MEMBERSHIP_SOURCE || new URL('../membership-service/src',import.meta.url).pathname;
const { createPool } = await import(`${SRC}/db.js`);
const { resolveOrCreatePerson, findPerson, linkIdentity } = await import(`${SRC}/identity.js`);
const { addPilotMember } = await import(`${SRC}/launch.js`);
const { grantAllowance, creditGoodwill, walletView } = await import(`${SRC}/coins.js`);
const { createOffer } = await import(`${SRC}/migration-offers.js`);
const { currentVersion } = await import(`${SRC}/plans.js`);
const { audit } = await import(`${SRC}/audit.js`);
const { createSubscription } = await import(`${SRC}/subscriptions.js`);
const { cycleStart } = await import(`${SRC}/jobs/allowance.js`);
const { evaluate } = await import(`${SRC}/entitlements.js`);

const ACTOR = 'beta-demo-setup';
const DRY = process.argv.includes('--dry-run');
const env = process.env;
const u = new URL(env.MEMBERSHIP_DATABASE_URL || 'postgres://none');
if (env.MEMBERSHIP_ENV !== 'staging' || u.hostname !== '127.0.0.1' || u.port !== '55500' || u.pathname !== '/gaia_membership_staging') {
  console.error('REFUSED: staging database only'); process.exit(2);
}
const MEMBERS = [
  { key: 'free', coins: { allowance: 100, goodwill: 25 } },
  { key: 'pilot', pilot: true, coins: { allowance: 100, goodwill: 25 } },
  { key: 'silver', legacy: true, coins: { allowance: 100, goodwill: 25 } },
  // One demo member per paid tier: an active Gaia-owned subscription through createSubscription (provider
  // 'simulated', so Stripe is never involved), entitlements from the plan version, the plan's own monthly allowance.
  { key: 'standard', plan: 'standard', coins: { goodwill: 25 } },
  { key: 'professional', plan: 'professional', coins: { goodwill: 25 } },
  { key: 'inner-circle', plan: 'inner_circle', coins: { goodwill: 25 } },
];
const pool = createPool(env.MEMBERSHIP_DATABASE_URL, { max: 2 });
try {
  if (DRY) { console.log('dry run: would set up', MEMBERS.map((m) => 'fixture-beta-demo-' + m.key).join(', ')); process.exit(0); }
  for (const m of MEMBERS) {
    const contactId = `fixture-beta-demo-${m.key}`; const email = `${contactId}@fixture.invalid`;
    // Same identities the staging proxy's /v1/identities/ensure creates for a fixture session (ghl contact + email).
    const { personId, created } = await resolveOrCreatePerson(pool, { platform: 'ghl', kind: 'contact', externalId: contactId }, { linkedBy: ACTOR });
    if (!(await findPerson(pool, { platform: 'email', kind: 'address', externalId: email }))) await linkIdentity(pool, personId, { platform: 'email', kind: 'address', externalId: email }, { linkedBy: ACTOR });
    const subs = (await pool.query('SELECT count(*)::int n FROM subscriptions WHERE person_id = $1', [personId])).rows[0].n;
    if (subs && !m.plan) { console.error(`${contactId}: has ${subs} subscription(s); this demo member must have none. Stopping.`); process.exit(1); }
    let subId = null;
    if (m.plan) {
      const v = await currentVersion(pool, m.plan);
      const providerSubscriptionId = `fixture_beta_demo_${m.plan}`;
      const have = (await pool.query("SELECT id FROM subscriptions WHERE provider = 'simulated' AND provider_subscription_id = $1", [providerSubscriptionId])).rows[0];
      const now = new Date(); const start = new Date(now.getTime() - 10 * 86400000); const end = new Date(start.getTime() + 30 * 86400000);
      subId = have ? have.id : await createSubscription(pool, { personId, planVersionId: v.id, interval: 'month', provider: 'simulated', providerSubscriptionId,
        status: 'active', source: 'new', periodStart: start, periodEnd: end, providerStateAt: now }, { actorType: 'admin', actorId: ACTOR });
      const s = (await pool.query('SELECT s.*, v.monthly_coin_grant FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id WHERE s.id = $1', [subId])).rows[0];
      if (s.monthly_coin_grant > 0) {
        const cs = cycleStart(s.current_period_start || s.created_at, now);
        await grantAllowance(pool, { personId, coins: s.monthly_coin_grant, cycleKey: `${s.id}:${cs.toISOString()}`, resetAt: cs, actor: ACTOR });
      }
    }
    if (m.pilot) await addPilotMember(pool, personId, { note: 'beta preview demo member (fictional)' }, { actorType: 'admin', actorId: ACTOR });
    let offer = null;
    if (m.legacy) {
      const mirrorMax = (await pool.query('SELECT max(last_seen_at) AS t FROM legacy_memberships')).rows[0].t;
      if (!mirrorMax) { console.error('legacy mirror is empty; stopping'); process.exit(1); }
      const extId = 'beta-demo-silver-legacy-1';
      const ins = await pool.query(
        `INSERT INTO legacy_memberships (source, external_subscription_id, external_contact_id, person_id, payment_provider, external_price_id, tier, mapping,
                                         reported_status, billing_interval, last_payment_at, paid_through_estimate, first_seen_at, last_seen_at, updated_at)
         VALUES ('ghl', $1, $2, $3, 'stripe', 'beta-demo-silver-monthly', 'silver', 'mapped', 'active', 'month',
                 $4::timestamptz - interval '10 days', $4::timestamptz + interval '20 days', $4, $4, now())
         ON CONFLICT (source, external_subscription_id) DO NOTHING RETURNING id`, [extId, contactId, personId, mirrorMax]);
      const legacyId = ins.rows[0]?.id || (await pool.query("SELECT id FROM legacy_memberships WHERE source = 'ghl' AND external_subscription_id = $1", [extId])).rows[0].id;
      if (ins.rowCount) await audit(pool, { actorType: 'admin', actorId: ACTOR, action: 'legacy_membership.demo_insert', entityType: 'legacy_membership', entityId: legacyId, after: { tier: 'silver', mapping: 'mapped', demo: true } });
      offer = (await pool.query("SELECT id, status FROM migration_offers WHERE legacy_membership_id = $1 AND status IN ('offered','accepted','checkout_started','subscribed')", [legacyId])).rows[0];
      if (!offer) {
        const v = await currentVersion(pool, 'standard');
        offer = await createOffer(pool, { legacyMembershipId: legacyId, targetPlanVersionId: v.id, targetInterval: 'month' }, ACTOR);
      }
      const after = (await pool.query('SELECT max(last_seen_at) AS t FROM legacy_memberships')).rows[0].t;
      console.log(`  legacy mirror max last_seen_at unchanged: ${String(+after === +mirrorMax)}`);
    }
    if (m.coins.allowance) await grantAllowance(pool, { personId, coins: m.coins.allowance, cycleKey: `beta-demo:${personId}:2026-10`, resetAt: new Date('2026-10-01T00:00:00Z'), actor: ACTOR });
    await creditGoodwill(pool, { personId, coins: m.coins.goodwill, idempotencyKey: `beta-demo-goodwill:${personId}`, requestRef: 'beta-demo-setup', actor: ACTOR });
    const w = await walletView(pool, personId);
    const pilot = (await pool.query('SELECT 1 FROM pilot_members WHERE person_id = $1 AND removed_at IS NULL', [personId])).rowCount > 0;
    const ents = Object.keys((await evaluate(pool, personId)).entitlements).length;
    const nsubs = (await pool.query('SELECT count(*)::int n FROM subscriptions WHERE person_id = $1', [personId])).rows[0].n;
    console.log(`${contactId}: person ${created ? 'created' : 'existing'}, subscriptions ${nsubs}${m.plan ? ' (' + m.plan + ', active, simulated)' : ''}, entitlements ${ents}, pilot ${pilot}, offer ${offer ? offer.status : '-'}, coins granted ${w.granted.coins} goodwill ${w.goodwill?.coins ?? '?'}`);
  }
} finally { await pool.end(); }
