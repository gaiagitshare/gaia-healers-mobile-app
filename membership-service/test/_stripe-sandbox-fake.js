/**
 * Loopback fake Stripe (test mode) for the sandbox runner: the routes the
 * runner's scenarios call, with Stripe-like idempotency, test payment-method
 * tokens (pm_card_visa succeeds, pm_card_chargeDeclined is a 402 card_error),
 * deletes and archives. In memory; never a network.
 */
import crypto from 'node:crypto';
import { fakeServer } from './_providers-fakes.js';

const err = (status, type, code, headers) => ({ status, headers, json: { error: { type, code, message: code } } });

export async function fakeSandboxStripe() {
  const db = { customers: new Map(), products: new Map(), prices: new Map(), pms: new Map(), subscriptions: new Map(), intents: new Map(), charges: new Map(), refunds: new Map(), invoices: new Map() };
  const idem = new Map();
  let n = 0;
  const now = () => Math.floor(Date.now() / 1000);
  const id = (p) => `${p}_sbx_${++n}`;
  const meta = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
  const expand = (f) => Object.entries(f).filter(([k]) => k.startsWith('expand[')).map(([, v]) => v);
  const base = (o) => ({ livemode: false, created: now(), ...o });

  const route = (r) => {
    if (!/^Bearer (sk|rk)_test_/.test(r.headers.authorization || '')) return err(401, 'invalid_request_error', 'api_key_invalid');
    const f = r.form || {};
    let m;
    if (r.method === 'POST' && r.path === '/v1/customers') {
      const c = base({ id: id('cus'), object: 'customer', email: f.email, name: f.name, metadata: meta(f) }); db.customers.set(c.id, c); return { json: c };
    }
    if (r.method === 'DELETE' && (m = r.path.match(/^\/v1\/customers\/([^/]+)$/))) {
      if (!db.customers.has(m[1])) return err(404, 'invalid_request_error', 'resource_missing');
      db.customers.delete(m[1]);
      for (const s of db.subscriptions.values()) if (s.customer === m[1]) s.status = 'canceled';
      return { json: { id: m[1], object: 'customer', deleted: true } };
    }
    if (r.method === 'POST' && r.path === '/v1/products') { const p = base({ id: id('prod'), object: 'product', name: f.name, active: true, metadata: meta(f) }); db.products.set(p.id, p); return { json: p }; }
    if (r.method === 'POST' && r.path === '/v1/prices') {
      const p = base({ id: id('price'), object: 'price', product: f.product, currency: f.currency, unit_amount: Number(f.unit_amount), active: true, recurring: f['recurring[interval]'] ? { interval: f['recurring[interval]'] } : null });
      db.prices.set(p.id, p); return { json: p };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/v1\/(products|prices)\/([^/]+)$/))) {
      const o = db[m[1]].get(m[2]); if (!o) return err(404, 'invalid_request_error', 'resource_missing');
      if (f.active === 'false') o.active = false; return { json: o };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/v1\/payment_methods\/([^/]+)\/attach$/))) {
      if (!db.customers.has(f.customer)) return err(404, 'invalid_request_error', 'resource_missing');
      const pm = base({ id: id('pm'), object: 'payment_method', token: m[1], customer: f.customer }); db.pms.set(pm.id, pm); return { json: pm };
    }
    const charge = (amount, customer, invoice = null) => { const c = base({ id: id('ch'), object: 'charge', amount, currency: 'usd', customer, invoice, paid: true, status: 'succeeded', refunded: false }); db.charges.set(c.id, c); return c; };
    if (r.method === 'POST' && r.path === '/v1/subscriptions') {
      const price = db.prices.get(f['items[0][price]']);
      if (!price || !db.customers.has(f.customer) || !db.pms.has(f.default_payment_method)) return err(400, 'invalid_request_error', 'parameter_invalid');
      const inv = base({ id: id('in'), object: 'invoice', status: 'paid', amount_paid: price.unit_amount, currency: 'usd', customer: f.customer });
      inv.charge = charge(price.unit_amount, f.customer, inv.id).id; db.invoices.set(inv.id, inv);
      const s = base({ id: id('sub'), object: 'subscription', status: 'active', customer: f.customer, cancel_at_period_end: false, latest_invoice: inv.id, metadata: meta(f) });
      db.subscriptions.set(s.id, s);
      return { json: { ...s, latest_invoice: expand(f).includes('latest_invoice') ? inv : inv.id } };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const s = db.subscriptions.get(m[1]); if (!s) return err(404, 'invalid_request_error', 'resource_missing');
      if (f.cancel_at_period_end === 'true') s.cancel_at_period_end = true; return { json: s };
    }
    if (r.method === 'POST' && r.path === '/v1/payment_intents') {
      if (!db.customers.has(f.customer)) return err(404, 'invalid_request_error', 'resource_missing');
      if (f.payment_method === 'pm_card_chargeDeclined') return err(402, 'card_error', 'card_declined', { 'stripe-should-retry': 'false' });
      const ch = charge(Number(f.amount), f.customer);
      const pi = base({ id: id('pi'), object: 'payment_intent', status: 'succeeded', amount: Number(f.amount), customer: f.customer, latest_charge: ch.id, metadata: meta(f) });
      ch.payment_intent = pi.id; db.intents.set(pi.id, pi);
      return { json: { ...pi, latest_charge: expand(f).includes('latest_charge') ? ch : ch.id } };
    }
    if (r.method === 'POST' && r.path === '/v1/refunds') {
      const pi = db.intents.get(f.payment_intent); if (!pi) return err(404, 'invalid_request_error', 'resource_missing');
      const ch = db.charges.get(pi.latest_charge);
      const done = [...db.refunds.values()].filter((x) => x.charge === ch.id).reduce((s, x) => s + x.amount, 0);
      if (done + Number(f.amount) > ch.amount) return err(400, 'invalid_request_error', 'charge_already_refunded');
      const re = base({ id: id('re'), object: 'refund', status: 'succeeded', amount: Number(f.amount), currency: 'usd', charge: ch.id, payment_intent: pi.id });
      db.refunds.set(re.id, re); return { json: re };
    }
    if (r.method === 'GET' && (m = r.path.match(/^\/v1\/(invoices|charges|refunds|disputes)$/))) {
      const all = [...(db[m[1]] || new Map()).values()];
      return { json: { object: 'list', data: all.slice(0, Number(r.query.get('limit') || 10)), has_more: all.length > Number(r.query.get('limit') || 10) } };
    }
    return err(404, 'invalid_request_error', 'unknown_route');
  };

  const srv = await fakeServer((r) => {
    if (r.method !== 'POST') return route(r);
    const key = r.headers['idempotency-key'];
    if (!key) return err(400, 'invalid_request_error', 'idempotency_key_required_by_fake');
    const h = crypto.createHash('sha256').update(r.method + r.path + r.raw).digest('hex');
    const prev = idem.get(key);
    if (prev) return prev.hash === h ? prev.out : err(400, 'idempotency_error', 'idempotency_error');
    const out = route(r);
    if ((out.status || 200) < 500) idem.set(key, { hash: h, out });
    return out;
  });
  return { ...srv, db };
}
