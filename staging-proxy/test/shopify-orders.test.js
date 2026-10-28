/**
 * Shopify -> Event Manager connector (28 Oct 2026): Elevate tickets sold on
 * gaiahealers.com were recorded nowhere. Offline: fake Shopify, fake Event
 * Manager, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  shopifyConfig, verifyShopifyHmac, shopifyLineAmount, ticketsFromShopifyOrder,
  processShopifyOrder, shopifyMappings, syncShopifyOrders,
} from '../shopify-orders.mjs';

const maps = shopifyMappings({ mappings: [
  { provider: 'shopify', external_product_id: '111', ticket_type_id: 4, event_id: 1, is_upgrade: false, is_active: true },
  { provider: 'shopify', external_product_id: '222', ticket_type_id: 16, event_id: 1, is_upgrade: false, is_active: true },
  { provider: 'ghl', external_product_id: '111', ticket_type_id: 8, event_id: 1, is_upgrade: false, is_active: true },
] });

const order = (over = {}) => ({
  id: 9001, email: 'Buyer@Example.invalid', financial_status: 'paid', processed_at: '2026-10-28T10:00:00-04:00',
  customer: { first_name: 'Zz', last_name: 'Shop' }, total_price: '1268.82',
  line_items: [
    { product_id: 222, title: 'Saturday', price: '197.00', quantity: 1, tax_lines: [{ price: '11.82' }], discount_allocations: [] },
    { product_id: 111, title: 'VIP', price: '999.00', quantity: 1, tax_lines: [{ price: '59.94' }], discount_allocations: [{ amount: '0.00' }] },
    { product_id: 333, title: 'Elevate tote bag', price: '20.00', quantity: 1, tax_lines: [], discount_allocations: [] },
  ], ...over });

function fakeEm() {
  const calls = [];
  const seen = new Set();
  const em = async (path, body) => {
    calls.push({ path, body });
    if (path === '/identity/reconcile-attendee') {
      const k = `${body.order_id}|${body.product_id}`;
      const created = !seen.has(k); seen.add(k);
      return { status: 200, j: { ok: true, created } };
    }
    return { status: 200, j: { ok: true } };
  };
  return { em, calls };
}

test('only Shopify mappings are used, and the config is inert without credentials', () => {
  assert.equal(maps.get('111').ticket_type_id, 4);
  assert.equal(shopifyConfig({}).enabled, false);
  assert.equal(shopifyConfig({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't' }).base,
    'https://x.myshopify.com/admin/api/2024-10');
});

test('webhook signatures: right secret passes, anything else fails', () => {
  const raw = JSON.stringify(order());
  const sig = crypto.createHmac('sha256', 's3cret').update(raw).digest('base64');
  assert.equal(verifyShopifyHmac(raw, sig, 's3cret'), true);
  assert.equal(verifyShopifyHmac(raw, sig, 'other'), false);
  assert.equal(verifyShopifyHmac(raw + ' ', sig, 's3cret'), false);
  assert.equal(verifyShopifyHmac(raw, '', 's3cret'), false);
});

test('each ticket line carries its own amount; the biggest goes first; non-tickets are listed apart', () => {
  assert.equal(shopifyLineAmount({ price: '999.00', quantity: 1, tax_lines: [{ price: '59.94' }] }), 1058.94);
  assert.equal(shopifyLineAmount({ price: '97.00', quantity: 2, discount_allocations: [{ amount: '19.40' }], tax_lines: [{ price: '10.48' }] }), 185.08);
  const t = ticketsFromShopifyOrder(order(), maps);
  assert.deepEqual(t.lines.map((l) => [l.product_id, l.ticket_type_id, l.amount]), [['111', 4, 1058.94], ['222', 16, 208.82]]);
  assert.equal(t.lines[0].order_id, 'shopify:9001');
  assert.equal(t.lines[0].email, 'buyer@example.invalid');
  assert.deepEqual(t.unmapped.map((u) => u.title), ['Elevate tote bag']);
});

test('a paid order reconciles each ticket line; a replay creates nothing new', async () => {
  const { em, calls } = fakeEm();
  const a = await processShopifyOrder(order(), maps, em);
  assert.deepEqual([a.reconciled, a.already, a.unmapped], [2, 0, 1]);
  const b = await processShopifyOrder(order(), maps, em);
  assert.deepEqual([b.reconciled, b.already], [0, 2]);
  assert.equal(calls.filter((c) => c.path === '/identity/reconcile-attendee').length, 4);
});

test('refunds reach the Event Manager; test, cancelled and email-less orders are skipped', async () => {
  const { em, calls } = fakeEm();
  const r = await processShopifyOrder(order({ financial_status: 'refunded',
    refunds: [{ transactions: [{ kind: 'refund', status: 'success', amount: '1268.82' }] }] }), maps, em);
  assert.equal(r.refunded, 1);
  const rf = calls.find((c) => c.path === '/identity/refund-ticket').body;
  assert.deepEqual([rf.order_id, rf.full, rf.amount_refunded], ['shopify:9001', true, 1268.82]);
  assert.equal((await processShopifyOrder(order({ test: true }), maps, em)).skipped, 'test_order');
  assert.equal((await processShopifyOrder(order({ cancelled_at: '2026-10-28', financial_status: 'voided' }), maps, em)).skipped, 'cancelled');
  assert.equal((await processShopifyOrder(order({ email: '', customer: {} }), maps, em)).skipped, 'no_email');
});

test('the backstop pages through Link headers and retries a 429', async () => {
  const pages = {
    first: { orders: [order({ id: 1 })], link: '<https://x/next>; rel="next"' },
    next: { orders: [order({ id: 2 })], link: '' },
  };
  let throttled = false;
  const fetchImpl = async (url) => {
    const page = url.includes('/next') ? 'next' : 'first';
    if (page === 'next' && !throttled) { throttled = true; return { ok: false, status: 429, headers: { get: () => '' } }; }
    return { ok: true, status: 200, json: async () => ({ orders: pages[page].orders }), headers: { get: () => pages[page].link } };
  };
  const { em } = fakeEm();
  const st = await syncShopifyOrders({ cfg: { base: 'https://x', token: 't' }, since: '2026-10-14T00:00:00Z', byPid: maps, em, fetchImpl });
  assert.deepEqual([st.orders, st.reconciled, st.errors], [2, 4, 0]);
});

test('a Shopify that keeps failing makes the pass fail loudly, not quietly', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, headers: { get: () => '' } });
  await assert.rejects(syncShopifyOrders({ cfg: { base: 'https://x', token: 't' }, since: 's', byPid: maps, em: fakeEm().em, fetchImpl }),
    /kept failing/);
  const unauthorised = async () => ({ ok: false, status: 401, headers: { get: () => '' } });
  await assert.rejects(syncShopifyOrders({ cfg: { base: 'https://x', token: 't' }, since: 's', byPid: maps, em: fakeEm().em, fetchImpl: unauthorised }),
    /Shopify 401/);
});
