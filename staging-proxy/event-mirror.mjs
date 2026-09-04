/**
 * GHL -> Gaia mirror. READ-ONLY against GHL.
 *
 * The webhook is the fast path. This is the recovery path: it re-reads the
 * source of truth on a schedule and makes Gaia converge to it. It is not a
 * second source of truth — it never writes to GHL, and it only ever tells the
 * Event Manager what GHL already says.
 *
 * It exists because a webhook that is never delivered leaves no trace. Four
 * people bought a day pass and nobody found out for a day; a missed webhook
 * would be worse, because nothing at all would be logged.
 *
 * Covers: completed orders, PAID INVOICES (which the webhook path cannot
 * resolve at all), refunds/reversals, and products nobody has mapped.
 *
 *   node event-mirror.mjs [--since-days=14] [--dry-run]
 */
import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync('/root/gaia-staging-proxy/.env', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const LOC = env.GHL_LOCATION_ID;
const GHL = 'https://services.leadconnectorhq.com';
const GH = { Authorization: `Bearer ${env.GHL_API_TOKEN}`, Version: '2021-07-28', Accept: 'application/json' };
const EM = (env.EVENT_MANAGER_BASE_URL || 'http://127.0.0.1:8002').replace(/\/+$/, '');
const SVC = env.IDENTITY_SERVICE_TOKEN;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const SINCE_DAYS = Number((args.find((a) => a.startsWith('--since-days=')) || '').split('=')[1] || 14);
const since = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString();
const log = (o) => console.log(JSON.stringify({ evt: 'event_mirror', ...o }));

const ghl = async (p) => {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(GHL + p, { headers: GH });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 700 + i * 500)); continue; }
    try { return await r.json(); } catch (e) { return {}; }
  }
  return {};
};
const em = async (path, body) => {
  const r = await fetch(EM + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SVC}` },
    body: JSON.stringify(body) });
  try { return { status: r.status, j: await r.json() }; } catch (e) { return { status: r.status, j: null }; }
};

async function pageAll(url, key) {
  const out = []; let off = 0;
  for (;;) {
    const j = await ghl(`${url}&limit=100&offset=${off}`);
    const rows = j[key] || j.data || [];
    out.push(...rows);
    if (rows.length < 100 || off > 3000) break;
    off += 100;
  }
  return out;
}

// The mappings are Gaia's, and they decide what counts as a ticket.
const mapsRes = await fetch(`${EM}/identity/ticket-mappings`, { headers: { Authorization: `Bearer ${SVC}` } });
const maps = mapsRes.ok ? await mapsRes.json() : { mappings: [] };
const byPid = new Map();
// Same scope as the webhook: only EVENT mappings can mint an attendee. A
// membership or course mapping shares the endpoint and must never become a seat.
const EVENT_TYPES = new Set(["EVENT_TICKET", "EVENT_UPGRADE"]);
for (const m of (maps.mappings || maps || [])) {
  if (m.is_active === false) continue;
  if (m.provider && m.provider !== "ghl") continue;
  if (!EVENT_TYPES.has(m.entitlement_type || "EVENT_TICKET")) continue;
  byPid.set(m.external_product_id, m);
}
log({ phase: 'start', since, dry_run: DRY, mapped_products: byPid.size });

const stats = { orders_seen: 0, invoices_seen: 0, reconciled: 0, already: 0, unmapped: 0, refunds: 0, errors: 0 };

// ── 1. completed orders ───────────────────────────────────────────────────
const orders = await pageAll(`/payments/orders?altId=${LOC}&altType=location`, 'data');
for (const o of orders) {
  if (String(o.createdAt || '') < since) continue;
  if (String(o.status || '').toLowerCase() !== 'completed') continue;
  stats.orders_seen++;
  const full = await ghl(`/payments/orders/${o._id}?altId=${LOC}&altType=location`);
  const items = ((full && (full.order || full)).items) || [];
  const pids = [...new Set(items.map((i) => (i.product && i.product._id) || i.productId).filter(Boolean))];
  const hits = pids.map((p) => byPid.get(p)).filter(Boolean);
  const email = String(o.contactEmail || '').toLowerCase();
  if (!email) continue;
  if (!hits.length) {
    stats.unmapped++;
    if (!DRY) await em('/identity/report-unmapped-sale', {
      reference: o._id, source: 'ghl_order', product_id: pids[0] || null,
      product_name: (items[0] && ((items[0].product && items[0].product.name) || items[0].name)) || null,
      buyer_email: email, buyer_name: o.contactName, contact_id: o.contactId,
      amount: o.amount, paid_at: String(o.createdAt).slice(0, 10) });
    continue;
  }
  for (const m of hits.sort((a, b) => (a.is_upgrade ? 1 : 0) - (b.is_upgrade ? 1 : 0))) {
    if (DRY) { stats.reconciled++; continue; }
    const nm = String(o.contactName || '').split(' ');
    // The line for THIS product carries the quantity, which is the only field
    // that distinguishes one person paying for three seats from three people.
    const line = items.find((i) => String((i.product && i.product._id) || i.productId) === m.external_product_id);
    const qty = Math.max(1, Number((line && (line.qty != null ? line.qty : line.quantity)) || 1));
    const { j } = await em('/identity/reconcile-attendee', {
      event_id: m.event_id, email, ticket_type_id: m.ticket_type_id, is_upgrade: !!m.is_upgrade,
      contact_id: o.contactId, order_id: o._id,
      // Recorded so the ledger can be classified later without guessing: the
      // immutable product id, the seat count, the money, and WHEN GHL took it
      // (not when Gaia happened to reconcile it).
      product_id: m.external_product_id, quantity: qty, amount: o.amount,
      // Full timestamp, not a date: minutes are what separate a duplicate
      // charge from a second seat bought the same afternoon.
      purchased_at: String(o.createdAt || '').slice(0, 19) || null,
      first_name: nm[0] || '', last_name: nm.slice(1).join(' ') });
    if (j && j.ok) { if (j.created) stats.reconciled++; else stats.already++; } else stats.errors++;
  }
}

// ── 2. paid invoices — the channel the webhook cannot resolve ─────────────
const invoices = await pageAll(`/invoices/?altId=${LOC}&altType=location`, 'invoices');
for (const iv of invoices) {
  const when = String(iv.issueDate || iv.createdAt || '');
  if (when < since) continue;
  if (!['paid', 'partially_paid'].includes(String(iv.status || '').toLowerCase())) continue;
  stats.invoices_seen++;
  const cd = iv.contactDetails || {};
  const email = String(cd.email || '').toLowerCase();
  if (!email) continue;
  const full = await ghl(`/invoices/${iv._id}?altId=${LOC}&altType=location`);
  const items = (full && (full.invoiceItems || (full.invoice && full.invoice.invoiceItems))) || iv.invoiceItems || [];
  for (const it of items) {
    const m = byPid.get(String(it.productId || ''));
    if (!m) continue;                       // not a ticket; invoices sell many things
    if (DRY) { stats.reconciled++; continue; }
    const nm = String(cd.name || '').split(' ');
    const { j } = await em('/identity/reconcile-invoice', {
      event_id: m.event_id, email, invoice_id: iv._id, contact_id: cd.id,
      product_id: it.productId, price_id: it.priceId, amount: iv.amountPaid,
      quantity: Number(it.qty || it.quantity || 1), status: iv.status,
      first_name: nm[0] || '', last_name: nm.slice(1).join(' '), phone: cd.phoneNo,
      issued_at: when });
    if (j && j.ok) { if (j.created) stats.reconciled++; else stats.already++; } else stats.errors++;
  }
}

// ── 3. refunds and reversals ─────────────────────────────────────────────
const txns = await pageAll(`/payments/transactions?altId=${LOC}&altType=location`, 'data');
const reversed = txns.filter((t) => String(t.createdAt || '') >= since
  && ['refunded', 'partially_refunded'].includes(String(t.status || '').toLowerCase()));
for (const t of reversed) {
  stats.refunds++;
  if (DRY) continue;
  // An invoice sale is ledgered under its invoice id, never a made-up order id,
  // so the reference is passed as whatever GHL says it is.
  const isInvoice = String(t.entityType || '').toLowerCase().includes('invoice');
  const ref = String(t.entityId || '');
  // Key on the MONEY, never on the person. Most refunds here are not tickets at
  // all -- sponsorships and Bio-Well kits are refunded too -- and passing an
  // email would let refund-ticket match that buyer's unrelated event ticket by
  // address and revoke a seat nobody refunded. With reference only, a refund we
  // did not ledger is a clean no-op.
  await em('/identity/refund-ticket', {
    order_id: isInvoice ? null : (ref || null),
    invoice_id: isInvoice ? (ref || null) : null,
    transaction_id: t._id,
    amount: t.amount, amount_refunded: t.amountRefunded,
    full: String(t.status).toLowerCase() === 'refunded',
    reason: 'ghl_reconcile', actor: 'mirror' });
}

log({ phase: 'done', ...stats });
