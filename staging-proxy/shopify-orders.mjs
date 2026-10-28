/**
 * Shopify -> Event Manager: Elevate tickets sold on gaiahealers.com.
 *
 * On 28 Oct 2026 the Shopify store had five Elevate ticket products on sale
 * (VIP, 3-Day, Fri/Sat/Sun) and nothing read its orders: a buyer there got no
 * record and no badge. This connects it the same way GHL is connected:
 *
 *   real time   POST /api/webhooks/shopify-order   (orders/paid, orders/updated,
 *               refunds/create; HMAC-verified)        -> processShopifyOrder()
 *   backstop    syncShopifyOrders() every 15 minutes, run by event-mirror.mjs,
 *               re-reading orders updated in the last 14 days
 *
 * Which Shopify product is which ticket lives in the Event Manager's
 * ticket_mappings with provider "shopify" (external_product_id = the Shopify
 * product id) -- the one table that already decides what every product grants.
 * Unmapped products are reported, never guessed. Orders are keyed
 * "shopify:<order id>", so a replay updates instead of duplicating.
 *
 * Inert until SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN (read_orders) are
 * set; the webhook also needs SHOPIFY_WEBHOOK_SECRET.
 */
import crypto from 'node:crypto';

export const SHOPIFY_API_VERSION = '2024-10';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;

export function shopifyConfig(env = process.env) {
  const domain = String(env.SHOPIFY_STORE_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = String(env.SHOPIFY_ADMIN_TOKEN || '').trim();
  return { domain, token, secret: String(env.SHOPIFY_WEBHOOK_SECRET || '').trim(),
    base: String(env.SHOPIFY_API_BASE || (domain ? `https://${domain}/admin/api/${SHOPIFY_API_VERSION}` : '')).replace(/\/+$/, ''),
    enabled: Boolean(domain && token) };
}

/** Shopify signs webhooks with base64 HMAC-SHA256 of the raw body. */
export function verifyShopifyHmac(rawBody, header, secret) {
  if (!secret || !header) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest); const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** What each line actually cost: price x qty, minus its discounts, plus its taxes. */
export function shopifyLineAmount(line) {
  const gross = num(line.price) * Math.max(1, num(line.quantity) || 1);
  const disc = (line.discount_allocations || []).reduce((s, d) => s + num(d.amount), 0);
  const tax = (line.tax_lines || []).reduce((s, t) => s + num(t.price), 0);
  return r2(gross - disc + tax);
}

/** One reconcile payload per mapped ticket line; unmapped lines listed apart. */
export function ticketsFromShopifyOrder(order, byPid) {
  const email = String(order.email || (order.customer && order.customer.email) || '').trim().toLowerCase();
  const cust = order.customer || {};
  const bill = order.billing_address || {};
  const first = cust.first_name || bill.first_name || '';
  const last = cust.last_name || bill.last_name || '';
  const out = { lines: [], unmapped: [] };
  const lines = (order.line_items || []).map((l) => ({ l, amount: shopifyLineAmount(l) }))
    .sort((a, b) => b.amount - a.amount);           // biggest ticket first: the buyer keeps it
  for (const { l, amount } of lines) {
    const m = byPid.get(String(l.product_id || ''));
    if (!m) { out.unmapped.push({ product_id: l.product_id, title: l.title, amount }); continue; }
    out.lines.push({
      event_id: m.event_id, email, ticket_type_id: m.ticket_type_id, is_upgrade: !!m.is_upgrade,
      first_name: first, last_name: last, phone: order.phone || cust.phone || bill.phone || null,
      contact_id: null, order_id: `shopify:${order.id}`, product_id: String(l.product_id),
      quantity: Math.max(1, num(l.quantity) || 1), amount,
      purchased_at: String(order.processed_at || order.created_at || '').slice(0, 19) || null,
    });
  }
  return out;
}

const PAID = new Set(['paid', 'partially_refunded']);
const REFUNDED = new Set(['refunded', 'partially_refunded']);

/**
 * Apply one Shopify order to the Event Manager. `em(path, body)` posts with the
 * service token and resolves to { status, j }. Returns what happened.
 */
export async function processShopifyOrder(order, byPid, em) {
  const fin = String(order.financial_status || '').toLowerCase();
  const res = { order: String(order.id), reconciled: 0, already: 0, unmapped: 0, refunded: 0, skipped: null, errors: 0 };
  if (order.test === true) { res.skipped = 'test_order'; return res; }
  if (order.cancelled_at && !REFUNDED.has(fin)) { res.skipped = 'cancelled'; return res; }
  const t = ticketsFromShopifyOrder(order, byPid);
  res.unmapped = t.unmapped.length;
  if (PAID.has(fin)) {
    if (!t.lines.length) return res;
    if (!t.lines[0].email) { res.skipped = 'no_email'; return res; }
    for (const p of t.lines) {
      const { status, j } = await em('/identity/reconcile-attendee', p);
      if (j && j.ok) { if (j.created) res.reconciled++; else res.already++; } else if (status !== 409) res.errors++;
    }
  }
  if (REFUNDED.has(fin) && t.lines.length) {
    const refundedTotal = (order.refunds || []).reduce((s, rf) =>
      s + (rf.transactions || []).reduce((x, tx) => x + (tx.kind === 'refund' && tx.status === 'success' ? num(tx.amount) : 0), 0), 0);
    await em('/identity/refund-ticket', {
      order_id: `shopify:${order.id}`, invoice_id: null, transaction_id: null,
      amount: num(order.total_price), amount_refunded: r2(refundedTotal),
      full: fin === 'refunded', reason: 'shopify_reconcile', actor: 'shopify' });
    res.refunded = 1;
  }
  return res;
}

/** Event mappings for Shopify products: productId -> mapping. */
export function shopifyMappings(maps) {
  const by = new Map();
  for (const m of (maps && (maps.mappings || maps)) || []) {
    if (m.is_active === false || m.provider !== 'shopify') continue;
    if (!['EVENT_TICKET', 'EVENT_UPGRADE'].includes(m.entitlement_type || 'EVENT_TICKET')) continue;
    by.set(String(m.external_product_id), m);
  }
  return by;
}

/**
 * The backstop pass: every order updated since `since`, paged with Shopify's
 * Link header, each one applied. Retries 429/5xx; a persistent failure throws.
 */
export async function syncShopifyOrders({ cfg, since, byPid, em, fetchImpl = fetch, log = () => {}, maxPages = 40 }) {
  const stats = { orders: 0, reconciled: 0, already: 0, unmapped: 0, refunded: 0, skipped: 0, errors: 0 };
  let url = `${cfg.base}/orders.json?status=any&limit=250&updated_at_min=${encodeURIComponent(since)}`;
  for (let page = 0; url && page < maxPages; page++) {
    let r = null; let last = '';
    for (let i = 0; i < 5; i++) {
      try { r = await fetchImpl(url, { headers: { 'X-Shopify-Access-Token': cfg.token, Accept: 'application/json' } }); }
      catch (e) { last = `network ${e && e.message}`; r = null; }
      if (r && r.ok) break;
      if (r && r.status !== 429 && r.status < 500) throw new Error(`Shopify ${r.status} on orders`);
      last = r ? `HTTP ${r.status}` : last;
      await new Promise((s) => setTimeout(s, 300 * (i + 1)));
      r = null;
    }
    if (!r) throw new Error(`Shopify kept failing (${last})`);
    const body = await r.json();
    for (const order of body.orders || []) {
      stats.orders++;
      const res = await processShopifyOrder(order, byPid, em);
      stats.reconciled += res.reconciled; stats.already += res.already; stats.unmapped += res.unmapped;
      stats.refunded += res.refunded; stats.errors += res.errors; if (res.skipped) stats.skipped++;
      if (res.unmapped) log({ phase: 'shopify_unmapped', order: res.order, lines: res.unmapped });
    }
    const link = (r.headers && r.headers.get && r.headers.get('link')) || '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1] : null;
  }
  return stats;
}
