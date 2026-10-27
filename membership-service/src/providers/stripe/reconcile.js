/**
 * Stripe <-> payment_ledger reconciliation (spec v2.5: daily reconciliation,
 * alert on mismatch).
 *
 * What each Stripe object should have produced in payment_ledger (the same
 * keys handlers.js writes):
 *
 *   Stripe object                       ledger (object_type, object_id, entry_type, amount)
 *   invoice, status=paid                ('invoice',  in_…,  'charge',  +amount_paid)
 *   refund, status=succeeded            ('refund',   re_…,  'refund',  -amount)
 *   dispute (any status)                ('dispute',  dp_…,  'dispute', -amount)
 *   dispute, status=won                 + ('dispute', dp_…, 'dispute_reversal', +amount)
 *   charge WITHOUT an invoice, paid     ('charge',   ch_…,  'charge',  +amount)   (coin packs; see note)
 *   charge WITH an invoice              covered by its invoice: not checked twice
 *
 * Only Gaia's objects are compared: the customer must be linked to a person
 * (person_identities 'stripe'/'customer') or carry metadata.gaia_person_id.
 * Anything else in the account is reported as `skipped`, never a mismatch.
 *
 * Mismatch kinds: missing_in_ledger, amount_mismatch, currency_mismatch,
 * livemode_mismatch, missing_in_stripe (only when the page is COMPLETE for
 * the window, otherwise absence proves nothing).
 *
 * Note: no webhook handler records standalone (coin-pack) charges yet; until
 * one does, such charges show up as missing_in_ledger — which is the correct
 * alert.
 */
import { withTransaction } from '../../db.js';
import { audit } from '../../audit.js';
import { fail } from '../../errors.js';

const ts = (s) => (s == null ? null : new Date(Number(s) * 1000));

function expectedEntries({ invoices = [], charges = [], refunds = [], disputes = [] }) {
  const out = [];
  const add = (obj, objectType, entryType, amount) => out.push({
    key: `${objectType}|${obj.id}|${entryType}`, objectType, objectId: obj.id, entryType, amount,
    currency: String(obj.currency || '').toUpperCase(), livemode: obj.livemode === true,
    customer: obj.customer || obj.charge?.customer || null, gaiaPersonId: obj.metadata?.gaia_person_id || null,
    created: ts(obj.status_transitions?.paid_at ?? obj.created),
  });
  for (const i of invoices) if (i.status === 'paid') add(i, 'invoice', 'charge', i.amount_paid);
  for (const c of charges) if (!c.invoice && c.paid === true && c.status === 'succeeded') add(c, 'charge', 'charge', c.amount);
  for (const r of refunds) if (r.status === 'succeeded') add(r, 'refund', 'refund', -Math.abs(r.amount));
  for (const d of disputes) {
    add(d, 'dispute', 'dispute', -Math.abs(d.amount));
    if (d.status === 'won') add(d, 'dispute', 'dispute_reversal', Math.abs(d.amount));
  }
  return out;
}

/**
 * Compare one page of (fake or real) Stripe objects with the ledger.
 *   page: { invoices, charges, refunds, disputes, window: { from, to }, complete }
 * Returns { checked, matched, skipped, mismatches[] }. Read-only.
 */
export async function reconcilePage(db, page, { livemode = false } = {}) {
  const expected = expectedEntries(page);
  const customers = [...new Set(expected.map((e) => e.customer).filter(Boolean))];
  const linked = new Set(customers.length ? (await db.query(
    "SELECT external_id FROM person_identities WHERE platform = 'stripe' AND kind = 'customer' AND external_id = ANY($1)", [customers])).rows.map((r) => r.external_id) : []);
  const ours = [], skipped = [];
  for (const e of expected) ((e.customer && linked.has(e.customer)) || e.gaiaPersonId ? ours : skipped).push(e);

  const ids = [...new Set(ours.map((e) => e.objectId))];
  const rows = ids.length ? (await db.query(
    `SELECT provider_object_type, provider_object_id, entry_type, amount_cents, currency, livemode
       FROM payment_ledger WHERE provider = 'stripe' AND provider_object_id = ANY($1)`, [ids])).rows : [];
  const ledger = new Map(rows.map((r) => [`${r.provider_object_type}|${r.provider_object_id}|${r.entry_type}`, r]));

  const mismatches = [];
  let matched = 0;
  for (const e of ours) {
    const l = ledger.get(e.key);
    const ref = { objectType: e.objectType, objectId: e.objectId, entryType: e.entryType };
    if (!l) { mismatches.push({ kind: 'missing_in_ledger', ...ref, stripeAmount: e.amount }); continue; }
    if (l.livemode !== e.livemode) { mismatches.push({ kind: 'livemode_mismatch', ...ref }); continue; }
    if (l.currency !== e.currency) { mismatches.push({ kind: 'currency_mismatch', ...ref, stripe: e.currency, ledger: l.currency }); continue; }
    if (l.amount_cents !== e.amount) { mismatches.push({ kind: 'amount_mismatch', ...ref, stripeAmount: e.amount, ledgerAmount: l.amount_cents }); continue; }
    matched++;
  }

  if (page.complete === true && page.window?.from && page.window?.to) {
    const seen = new Set(expected.map((e) => e.key));
    const inWindow = (await db.query(
      `SELECT provider_object_type, provider_object_id, entry_type, amount_cents FROM payment_ledger
        WHERE provider = 'stripe' AND livemode = $3 AND occurred_at >= $1 AND occurred_at < $2
          AND provider_object_type IN ('invoice', 'charge', 'refund', 'dispute')`,
      [page.window.from, page.window.to, livemode])).rows;
    for (const r of inWindow) {
      const key = `${r.provider_object_type}|${r.provider_object_id}|${r.entry_type}`;
      if (!seen.has(key)) mismatches.push({ kind: 'missing_in_stripe', objectType: r.provider_object_type, objectId: r.provider_object_id, entryType: r.entry_type, ledgerAmount: r.amount_cents });
    }
  }
  return { checked: ours.length, matched, skipped: skipped.map((e) => ({ objectType: e.objectType, objectId: e.objectId })), mismatches };
}

async function listAll(stripe, path, query, { maxPages }) {
  const out = [];
  let after;
  for (let i = 0; i < maxPages; i++) {
    const r = await stripe.get(path, { ...query, limit: 100, ...(after ? { starting_after: after } : {}) });
    const data = Array.isArray(r?.data) ? r.data : [];
    out.push(...data);
    if (!r?.has_more || !data.length) return { data: out, complete: true };
    const next = data[data.length - 1].id;
    if (next === after) fail('PROVIDER_UNAVAILABLE', 'stripe pagination did not advance');
    after = next;
  }
  return { data: out, complete: false };
}

/** Fetch every Gaia-relevant object created in [from, to) — bounded by maxPages per list. */
export async function fetchReconciliationPage(stripe, { from, to, maxPages = 10 }) {
  const created = { 'created[gte]': Math.floor(from.getTime() / 1000), 'created[lt]': Math.floor(to.getTime() / 1000) };
  const [invoices, charges, refunds, disputes] = [
    await listAll(stripe, '/v1/invoices', { ...created, status: 'paid' }, { maxPages }),
    await listAll(stripe, '/v1/charges', created, { maxPages }),
    await listAll(stripe, '/v1/refunds', { ...created, 'expand[]': 'data.charge' }, { maxPages }),     // a refund names its customer only via its charge
    await listAll(stripe, '/v1/disputes', { ...created, 'expand[]': 'data.charge' }, { maxPages }),
  ];
  return {
    invoices: invoices.data, charges: charges.data, refunds: refunds.data, disputes: disputes.data,
    window: { from, to }, complete: invoices.complete && charges.complete && refunds.complete && disputes.complete,
  };
}

/**
 * The daily job body (scheduling lives with the jobs milestone): fetch, compare,
 * record the run (append-only reconciliation_runs) and call `alert(report)`
 * when anything differs.
 */
export async function reconcileStripe({ pool, stripe }, { from, to, maxPages, alert = async () => {} }) {
  if (!(from instanceof Date) || !(to instanceof Date) || !(to > from)) fail('INVALID_INPUT', 'reconciliation needs a window from < to');
  const page = await fetchReconciliationPage(stripe, { from, to, maxPages });
  const report = await reconcilePage(pool, page, { livemode: stripe.livemode });
  report.complete = page.complete;
  report.window = { from, to };
  await withTransaction(pool, async (c) => {
    const id = (await c.query(
      `INSERT INTO reconciliation_runs (provider, window_from, window_to, livemode, complete, checked, matched, mismatch_count, mismatches)
       VALUES ('stripe', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [from, to, stripe.livemode, page.complete, report.checked, report.matched, report.mismatches.length, JSON.stringify(report.mismatches)])).rows[0].id;
    await audit(c, { actorType: 'system', actorId: 'stripe-reconcile', action: 'reconciliation.run', entityType: 'reconciliation_run', entityId: id,
      after: { checked: report.checked, mismatches: report.mismatches.length, complete: page.complete } });
    report.runId = id;
  });
  if (report.mismatches.length || !page.complete) await alert(report);
  return report;
}
