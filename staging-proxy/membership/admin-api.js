/**
 * Membership Admin API — the routes behind /api/admin/membership/*.
 *
 * Mounted by admin-router.js AFTER its auth gate, so nothing here re-implements
 * authentication. Everything it does goes through admin-ops.js, which means
 * every write is audited and carries a source.
 *
 * Two stores, deliberately separate:
 *   - the POLICY file  — what each plan promises (data/membership-policy.json)
 *   - the LEDGER file  — what each member actually holds (owned by server.js)
 * They never merge. Editing a plan changes no member's access; only an explicit
 * "apply policy" writes entitlement records.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEMBERSHIP_ORDER, MEMBERSHIP_STATUSES, BILLING_CYCLES,
  ENTITLEMENT_TYPES, ENTITLEMENT_STATUSES, ENTITLEMENT_SOURCES,
  MEMBERSHIP_PRESENTATION, isFixtureContactId,
} from './config.js';
import { defaultPolicy, normalizePolicy, normalizePlan, plansInOrder, benefitsToEntitlements, POLICY_VERSION } from './policy.js';
import {
  assignMembership, endMembership, grantEntitlement, revokeEntitlement,
  applyPolicy, policyDrift, setOverride,
} from './admin-ops.js';
import { audit, auditFor } from './audit-log.js';
import { sourceSummary, setSourceState, getSource } from './sources.js';
import { proposalsFor } from './proposals.js';
import { linkIdentity, takeUnresolved, unresolvedCount } from './identity.js';
import { MEMBERSHIP_BILLING, UNRESOLVED_BILLING_IDS } from './config.js';
import { resolveMemberAccess } from './resolver.js';
import { migrateContactRecord } from './ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = process.env.MEMBERSHIP_POLICY_FILE
  || path.join(__dirname, '..', 'data', 'membership-policy.json');

/**
 * The audit actor.
 *
 * Admin is a single shared password, so there is exactly one verified identity:
 * "admin". A name typed into a form is not evidence, and writing it into the
 * audit log as though it were would make the log lie. Operators who want to
 * record who acted put it in the note, where it reads as a claim.
 */
const ACTOR = 'admin';

let _policyCache = null;

function loadPolicy() {
  if (_policyCache) return _policyCache;
  try {
    _policyCache = normalizePolicy(JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')));
  } catch (_) {
    _policyCache = normalizePolicy(defaultPolicy());
  }
  return _policyCache;
}

function savePolicy(policy) {
  const next = { ...policy, version: POLICY_VERSION, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(POLICY_FILE), { recursive: true });
  const temp = `${POLICY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temp, POLICY_FILE);
  _policyCache = next;
  return next;
}

function auditEntry(store, entry) {
  return audit(store, { actor: ACTOR, source: 'admin', ...entry });
}

const text = (value, max = 200) => String(value ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);

/**
 * Fixture ids belong to the isolated demo namespace and must never be written
 * into the real ledger — an operator testing a flow uses an ordinary id.
 */
function contactGuard(contactId) {
  const id = text(contactId, 120);
  if (!id) return { ok: false, reason: 'contact_id_required' };
  if (isFixtureContactId(id)) return { ok: false, reason: 'fixture_ids_are_read_only' };
  return { ok: true, id };
}

/** One member, with everything an operator needs to answer "why". */
function memberView(store, id, policy, now = new Date()) {
  const raw = store.contacts[id];
  if (!raw) return null;
  let record = raw;
  try { record = migrateContactRecord(raw).record; } catch (_) { /* show it as stored */ }
  const access = resolveMemberAccess({ record, subscriptions: [], tags: [] });
  return {
    contactId: id,
    membership: record.membership || null,
    entitlements: record.entitlements || [],
    access,
    drift: policyDrift(record, policy, now),
    audit: auditFor(store, id, 50),
    updatedAt: record.updatedAt || null,
  };
}

function summarize(store, id) {
  const record = store.contacts[id] || {};
  const entitlements = Array.isArray(record.entitlements) ? record.entitlements : [];
  return {
    contactId: id,
    plan: record.membership?.key || null,
    status: record.membership?.status || null,
    source: record.membership?.source || null,
    entitlements: entitlements.filter((e) => e.status === 'active').length,
    total: entitlements.length,
    updatedAt: record.updatedAt || null,
  };
}

/**
 * Route table. `deps` carries the ledger accessors and the JSON helpers from
 * server.js so this module owns no transport or persistence policy of its own.
 */
async function handle(req, res, url, deps) {
  const { origin, sendJson, readJsonBody, loadLedger, saveLedger } = deps;
  const p = url.pathname.replace(/\/+$/, '') || url.pathname;
  const method = req.method;
  const policy = loadPolicy();
  const ok = (payload) => sendJson(res, 200, { ok: true, ...payload }, origin);
  const bad = (reason) => sendJson(res, 200, { ok: false, reason }, origin);

  // ---- shape of the system: what can be granted, what plans exist ----
  if (p === '/api/admin/membership/schema' && method === 'GET') {
    return ok({
      membershipKeys: MEMBERSHIP_ORDER,
      membershipStatuses: [...MEMBERSHIP_STATUSES],
      billingCycles: [...BILLING_CYCLES],
      entitlementTypes: Object.entries(ENTITLEMENT_TYPES)
        .map(([key, value]) => ({ key, ...value }))
        .sort((a, b) => (a.order || 0) - (b.order || 0)),
      entitlementStatuses: [...ENTITLEMENT_STATUSES],
      entitlementSources: [...ENTITLEMENT_SOURCES],
      presentation: MEMBERSHIP_PRESENTATION,
    });
  }

  // ---- policy (what plans PROMISE) ----
  if (p === '/api/admin/membership/policy' && method === 'GET') {
    return ok({ policy: { version: policy.version, updatedAt: policy.updatedAt }, plans: plansInOrder(policy) });
  }
  if (p === '/api/admin/membership/policy' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    const key = text(body.key, 20);
    const plan = normalizePlan(key, body.plan || {}, policy.plans[key] || {});
    if (!plan) return bad('unknown_plan_key');
    const next = savePolicy({ ...policy, plans: { ...policy.plans, [key]: plan } });
    return ok({ plan: next.plans[key], updatedAt: next.updatedAt });
  }
  // A preview, so an operator sees the exact records before writing any.
  if (p === '/api/admin/membership/policy/preview' && method === 'GET') {
    const key = text(url.searchParams.get('plan'), 20);
    if (!policy.plans[key]) return bad('unknown_plan_key');
    return ok({ plan: key, entitlements: benefitsToEntitlements(policy, key) });
  }

  // ---- members (what people actually HAVE) ----
  if (p === '/api/admin/membership/members' && method === 'GET') {
    const store = loadLedger();
    const q = text(url.searchParams.get('q'), 120).toLowerCase();
    const plan = text(url.searchParams.get('plan'), 20);
    let rows = Object.keys(store.contacts || {}).map((id) => summarize(store, id));
    if (q) rows = rows.filter((row) => row.contactId.toLowerCase().includes(q));
    if (plan) rows = rows.filter((row) => (plan === 'none' ? !row.plan : row.plan === plan));
    rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const counts = { none: 0 };
    for (const key of MEMBERSHIP_ORDER) counts[key] = 0;
    for (const id of Object.keys(store.contacts || {})) {
      const key = store.contacts[id]?.membership?.key;
      if (key && counts[key] !== undefined) counts[key] += 1; else counts.none += 1;
    }
    return ok({ members: rows.slice(0, 200), total: rows.length, counts });
  }

  if (p === '/api/admin/membership/member' && method === 'GET') {
    const guard = contactGuard(url.searchParams.get('id'));
    if (!guard.ok) return bad(guard.reason);
    const view = memberView(loadLedger(), guard.id, policy);
    if (!view) return bad('unknown_contact');
    return ok({ member: view });
  }

  // ---- writes ----
  // The member-write routes share identity resolution and a save, so they are
  // handled together. Listed explicitly rather than by prefix: a prefix match
  // silently swallows every POST route added below it.
  const MEMBER_WRITES = [
    '/api/admin/membership/assign',
    '/api/admin/membership/end',
    '/api/admin/membership/grant',
    '/api/admin/membership/revoke',
    '/api/admin/membership/apply-policy',
  ];
  if (method === 'POST' && MEMBER_WRITES.includes(p)) {
    const body = await readJsonBody(req).catch(() => ({}));
    const guard = contactGuard(body.contactId);
    if (!guard.ok) return bad(guard.reason);
    const store = loadLedger();
    const opts = { actor: ACTOR, now: new Date(), note: text(body.note, 300) };
    let result = null;

    if (p === '/api/admin/membership/assign') {
      result = assignMembership(store, guard.id, {
        key: text(body.key, 20),
        status: text(body.status, 20) || 'active',
        billing_cycle: text(body.billing_cycle, 20) || 'none',
        renews_at: body.renews_at || null,
        ends_at: body.ends_at || null,
        source: 'manual',
        evidence_id: text(body.evidence_id, 120) || null,
      }, opts);
    } else if (p === '/api/admin/membership/end') {
      result = endMembership(store, guard.id, {
        ...opts, status: text(body.status, 20) || 'cancelled', endsAt: body.ends_at || null,
      });
    } else if (p === '/api/admin/membership/grant') {
      result = grantEntitlement(store, guard.id, {
        type: text(body.type, 40),
        key: text(body.key, 120),
        value: body.value && typeof body.value === 'object' ? body.value : {},
        status: text(body.status, 20) || 'active',
        source: 'manual',
        evidence_id: text(body.evidence_id, 120) || null,
        expires_at: body.expires_at || null,
      }, opts);
    } else if (p === '/api/admin/membership/revoke') {
      result = revokeEntitlement(store, guard.id,
        { type: text(body.type, 40), key: text(body.key, 120) }, opts);
    } else if (p === '/api/admin/membership/apply-policy') {
      const key = text(body.key, 20) || store.contacts[guard.id]?.membership?.key;
      result = applyPolicy(store, guard.id, policy, key, { ...opts, period: text(body.period, 10) || null });
    }

    if (!result.ok) return bad(result.error);
    saveLedger(store);
    return ok({ result, member: memberView(store, guard.id, policy) });
  }

  // ---- sources / integrations ----
  if (p === '/api/admin/membership/sources' && method === 'GET') {
    const store = loadLedger();
    const summary = sourceSummary(store);
    saveLedger(store);   // the registry seeds itself on first read
    return ok({
      sources: summary,
      unresolved: unresolvedCount(store),
      // Read-only by design: whoever can edit this decides who gets Diamond,
      // so it lives in reviewed code and is shown here for confidence only.
      billingMap: Object.entries(MEMBERSHIP_BILLING).map(([key, map]) => ({
        key,
        ghlProductId: map.ghlProductId,
        monthlyPriceId: map.monthlyPriceId,
        annualPriceId: map.annualPriceId,
        stripeProductId: map.stripeProductId,
        deprecatedIds: map.deprecatedIds || [],
      })),
      quarantinedBillingIds: [...UNRESOLVED_BILLING_IDS],
      billingMapEditable: false,
    });
  }

  if (p === '/api/admin/membership/sources/state' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    const key = text(body.key, 40);
    const state = text(body.state, 20);
    // Promotion to active is not a web-form decision while the adapters do not
    // exist yet. Disabled and shadow are freely switchable; going live is
    // deliberately held behind a server-side flag.
    if (state === 'active' && process.env.GAIA_ALLOW_SOURCE_ACTIVATION !== 'true') {
      return bad('activation_requires_server_flag');
    }
    const store = loadLedger();
    const result = setSourceState(store, key, state);
    if (!result.ok) return bad(result.reason);
    auditEntry(store, { action: 'source.state', note: `${key}: ${result.from} to ${result.to}` });
    saveLedger(store);
    return ok({ sources: sourceSummary(store) });
  }

  // ---- proposals: the shadow-mode review surface ----
  if (p === '/api/admin/membership/proposals' && method === 'GET') {
    const store = loadLedger();
    return ok({
      proposals: proposalsFor(store, {
        source: text(url.searchParams.get('source'), 40),
        state: text(url.searchParams.get('state'), 20),
        contactId: text(url.searchParams.get('id'), 120),
      }),
    });
  }

  // ---- unresolved identities ----
  if (p === '/api/admin/membership/unresolved' && method === 'GET') {
    const store = loadLedger();
    return ok({ unresolved: (store.unresolved || []).slice(-100).reverse() });
  }
  if (p === '/api/admin/membership/unresolved/link' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    const guard = contactGuard(body.contactId);
    if (!guard.ok) return bad(guard.reason);
    const store = loadLedger();
    const entry = takeUnresolved(store, text(body.id, 120));
    if (!entry) return bad('unresolved_entry_not_found');
    const linked = linkIdentity(store, guard.id, {
      field: text(body.field, 40) || undefined,
      value: body.value,
      email: body.email,
      verified: true,
      source: 'manual',
    });
    if (!linked.ok) return bad(linked.reason);
    auditEntry(store, {
      contactId: guard.id, action: 'identity.link',
      note: `resolved ${entry.source} event ${entry.id}`,
    });
    saveLedger(store);
    return ok({ linked: linked.identity, entry });
  }

  // ---- manual override ----
  if (p === '/api/admin/membership/override' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    const guard = contactGuard(body.contactId);
    if (!guard.ok) return bad(guard.reason);
    const store = loadLedger();
    const result = setOverride(store, guard.id, {
      resource: text(body.resource, 20) || 'membership',
      type: text(body.type, 40),
      key: text(body.key, 120),
      until: body.until || null,
      reason: text(body.reason, 200),
    }, { now: new Date() });
    if (!result.ok) return bad(result.error);
    saveLedger(store);
    return ok({ result, member: memberView(store, guard.id, policy) });
  }

  // ---- audit ----
  if (p === '/api/admin/membership/audit' && method === 'GET') {
    const store = loadLedger();
    const id = text(url.searchParams.get('id'), 120);
    return ok({ entries: auditFor(store, id, 200) });
  }

  return sendJson(res, 404, { ok: false, reason: 'unknown_admin_route' }, origin);
}

export { handle, loadPolicy, savePolicy, POLICY_FILE };
