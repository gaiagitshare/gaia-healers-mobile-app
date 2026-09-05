/**
 * The five rules that decide who is a member and what they hold.
 *
 * Each of these was established by an audit of live data, and each is the kind
 * of rule an implementation drifts away from quietly — the tier still renders,
 * the course still opens, and nobody notices that the reason changed. They are
 * pinned here as behaviour rather than left as comments in the modules that
 * happen to implement them today.
 *
 * The numbers behind rule 1: this location carries 105 `ahc-gold-active` tags
 * and 107 `ahc-gold-trial` against ZERO active Gold subscriptions. A tag is a
 * label somebody once applied. It is not evidence that anybody is being billed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCourseAuthority } from './course-authority-fixture.js';

const SECRET = 'rules-secret-'.padEnd(48, 'r');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-rules-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
const storeFile = path.join(workdir, 'data', 'member-entitlements.json');
process.chdir(workdir);
installCourseAuthority(workdir, ['rules-course-1']);

const PORT = 8933;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET, AUTH_SESSION_SECRET: SECRET,
  MEMBER_ENTITLEMENTS_FILE: storeFile,
  WEBHOOK_TELEMETRY_FILE: path.join(workdir, 'data', 'webhook-telemetry.json'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  MEMBERSHIP_FIXTURES: '', MEMBERSHIP_FIXTURE_KEY: '',
});
await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 400));

const url = `http://127.0.0.1:${PORT}/api/webhooks/ghl/member-access`;
let n = 0;
const hook = (body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
// Before anything is written the file does not exist at all — which is the
// strongest possible form of "nothing was granted", so it reads as an empty
// store rather than as an error.
const store = () => {
  try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')); }
  catch (_) { return { contacts: {} }; }
};
const membershipOf = (id) => store().contacts?.[id]?.membership || null;

const GOLD_MONTHLY = '691cbb52396387d816e0f670';
const SILVER_ANNUAL = '69177f9c54010d7d6f6a8abe';
const T = '2026-08-17T10:00:00Z';

test('RULE 1 — a GHL tag alone cannot grant a verified membership', async () => {
  const c = 'rules-tag-only';
  const res = await hook({
    eventId: `r-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T,
    tags: ['ahc-gold-active', 'ahc-gold-trial', 'gold-membership'],
  });
  assert.equal(res.json.applied, false, 'a payload full of tier tags grants nothing');
  assert.equal(res.json.reason, 'BILLING_ID_REQUIRED');
  assert.equal(membershipOf(c), null, 'and no membership record is created');
});

test('RULE 2 — a body-supplied tier alone cannot grant a verified membership', async () => {
  const c = 'rules-claim-only';
  const res = await hook({
    eventId: `r-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T,
    tier: 'diamond', membership: { key: 'diamond', status: 'active' },
  });
  assert.equal(res.json.applied, false, 'saying "diamond" is not evidence of paying for diamond');
  assert.equal(membershipOf(c), null);
});

test('RULE 3 — canonical billing evidence decides the tier, and disagreement is recorded', async () => {
  const c = 'rules-billing-wins';
  const res = await hook({
    eventId: `r-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T,
    priceId: SILVER_ANNUAL, tier: 'gold',      // the body claims Gold; the price is Silver
  });
  assert.equal(res.json.applied, true);
  const m = membershipOf(c);
  assert.equal(m.key, 'silver', 'the billing id decides');
  assert.equal(m.source, 'ghl_subscription');
  assert.equal(m.evidence_id, SILVER_ANNUAL, 'and the evidence is kept with it');
  assert.ok((res.json.notes || []).some((x) => /id wins/.test(x)),
    'the contradiction is REPORTED, not silently corrected — a lying workflow must be findable');
});

test('RULE 4 — an operator grant is always recorded as source: manual', async () => {
  // Written through the same ledger module the Membership console uses, so the
  // property is the module's, not this test's.
  const { assignMembership } = await import(new URL('../membership/admin-ops.js', import.meta.url).href);
  const s = { version: 1, contacts: {}, sources: {}, auditLog: [], proposals: [] };
  const out = assignMembership(s, 'rules-manual', { key: 'gold' }, { actor: 'admin', note: 'comped' });
  assert.equal(out.ok, true);
  assert.equal(out.membership.source, 'manual',
    'an operator can grant access; they cannot make it look like a subscription');
  assert.notEqual(out.membership.source, 'ghl_subscription');
});

test('RULE 5 — a membership tier never creates course access', async () => {
  const c = 'rules-gold-no-courses';
  const res = await hook({
    eventId: `r-${++n}`, eventType: 'membership_activated', contactId: c, timestamp: T,
    priceId: GOLD_MONTHLY, tier: 'gold',
  });
  assert.equal(res.json.applied, true, 'the membership itself applies');
  assert.equal(membershipOf(c).key, 'gold');
  const rec = store().contacts[c];
  assert.deepEqual(rec.courses || [], [],
    'and it grants no course — access comes from a purchase, never from a tier');
  assert.deepEqual(rec.communities || [], []);
});

test('RULE 5 holds in reverse — a course grant never creates a membership', async () => {
  const c = 'rules-course-no-tier';
  const res = await hook({
    type: 'course_access_granted', contactId: c, courseId: 'rules-course-1',
    courseName: 'rules-course-1', timestamp: T, webhookId: `r-${++n}`,
  });
  assert.equal(res.json.applied, true);
  assert.equal(membershipOf(c), null, 'holding a course is not being a member');
});
