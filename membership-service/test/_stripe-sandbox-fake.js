/**
 * Loopback fake Stripe (test mode) for the sandbox runner: the routes the
 * runner's scenarios call, with Stripe-like idempotency, test payment-method
 * tokens (pm_card_visa succeeds, pm_card_chargeDeclined is a 402 card_error,
 * pm_card_chargeCustomerFail attaches but fails on charge,
 * pm_card_authenticationRequired needs 3DS), test clocks that advance
 * asynchronously and bill on the way (renewals, failed renewals, cancel at
 * period end), checkout sessions, events, deletes and archives. In memory;
 * never a network.
 *
 * Options: clockPollsUntilReady (default 1: the first status poll after an
 * advance sees `ready`); clockNeverReady (the clock stays `advancing`).
 */
import crypto from 'node:crypto';
import { fakeServer } from './_providers-fakes.js';

const err = (status, type, code, headers) => ({ status, headers, json: { error: { type, code, message: code } } });
const PERIOD = 30 * 86400;

export async function fakeSandboxStripe({ clockPollsUntilReady = 1, clockNeverReady = false } = {}) {
  const db = {
    customers: new Map(), products: new Map(), prices: new Map(), pms: new Map(), subscriptions: new Map(), intents: new Map(), charges: new Map(),
    refunds: new Map(), invoices: new Map(), clocks: new Map(), sessions: new Map(), schedules: new Map(), events: [], prorations: [],
  };
  const idem = new Map();
  let n = 0;
  const realNow = () => Math.floor(Date.now() / 1000);
  const id = (p) => `${p}_sbx_${++n}`;
  const meta = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));
  const expand = (f) => Object.entries(f).filter(([k]) => k.startsWith('expand[')).map(([, v]) => v);
  const nowFor = (customerId) => { const c = db.customers.get(customerId); const clock = c?.test_clock && db.clocks.get(c.test_clock); return clock ? clock.frozen_time : realNow(); };
  const base = (o, created = realNow()) => ({ livemode: false, created, ...o });
  const emit = (type, object) => db.events.push(base({ id: id('evt'), object: 'event', type, data: { object: structuredClone(object) } }));
  const outcome = (pmId) => {
    const token = db.pms.get(pmId)?.token;
    if (token === 'pm_card_chargeCustomerFail') return 'fail';
    if (token === 'pm_card_authenticationRequired') return 'auth';
    return token ? 'ok' : 'none';
  };
  const charge = (amount, customer, invoice = null) => { const c = base({ id: id('ch'), object: 'charge', amount, currency: 'usd', customer, invoice, paid: true, status: 'succeeded', refunded: false }); db.charges.set(c.id, c); return c; };
  const newInvoice = (sub, reason) => {
    const price = sub.items.data[0].price;
    const inv = base({ id: id('in'), object: 'invoice', status: 'open', paid: false, attempt_count: 0, amount_due: price.unit_amount, amount_paid: 0, currency: 'usd',
      customer: sub.customer, subscription: sub.id, billing_reason: reason }, nowFor(sub.customer));
    db.invoices.set(inv.id, inv); sub.latest_invoice = inv.id;
    return inv;
  };
  const attempt = (inv, pmId) => {
    inv.attempt_count += 1;
    if (outcome(pmId) !== 'ok') { emit('invoice.payment_failed', inv); return false; }
    inv.status = 'paid'; inv.paid = true; inv.amount_paid = inv.amount_due; inv.charge = charge(inv.amount_due, inv.customer, inv.id).id;
    emit('invoice.paid', inv);
    return true;
  };
  /** Unused share of the old price credited, the new price's share charged, from the proration date to the period end. */
  const prorated = (from, to, at, s) => {
    const t = Number(at) || nowFor(s.customer);
    const left = Math.max(0, Math.min(1, (s.current_period_end - t) / (s.current_period_end - s.current_period_start)));
    return Math.max(0, Math.round((to.unit_amount - from.unit_amount) * left));
  };
  const subView = (s, exp) => ({ ...s, latest_invoice: exp.includes('latest_invoice') ? db.invoices.get(s.latest_invoice) : s.latest_invoice });

  /** What Stripe does while a clock moves to `to`: bill every period end crossed. */
  const bill = (clock, to) => {
    for (const s of db.subscriptions.values()) {
      if (db.customers.get(s.customer)?.test_clock !== clock.id) continue;
      while (['active', 'past_due'].includes(s.status) && s.current_period_end <= to) {
        if (s.cancel_at_period_end) { s.status = 'canceled'; s.canceled_at = s.current_period_end; emit('customer.subscription.deleted', s); break; }
        clock.frozen_time = s.current_period_end;
        const sch = s.schedule && db.schedules.get(s.schedule);
        if (sch && sch.status === 'active' && sch.phases[1] && sch.phases[0].end_date <= s.current_period_end) {
          s.items.data[0].price = db.prices.get(sch.phases[1].items[0].price); sch.current_phase = 1;
        }
        s.current_period_start = s.current_period_end; s.current_period_end += PERIOD;
        const inv = newInvoice(s, 'subscription_cycle');
        s.status = attempt(inv, s.default_payment_method) ? 'active' : 'past_due';
        emit('customer.subscription.updated', s);
      }
    }
    clock.frozen_time = to;
  };

  const route = (r) => {
    if (!/^Bearer (sk|rk)_test_/.test(r.headers.authorization || '')) return err(401, 'invalid_request_error', 'api_key_invalid');
    const f = r.form || {};
    let m;
    if (r.method === 'POST' && r.path === '/v1/test_helpers/test_clocks') {
      const c = base({ id: id('clock'), object: 'test_helpers.test_clock', name: f.name, frozen_time: Number(f.frozen_time), status: 'ready' }); db.clocks.set(c.id, c); return { json: c };
    }
    if ((m = r.path.match(/^\/v1\/test_helpers\/test_clocks\/([^/]+)(\/advance)?$/))) {
      const c = db.clocks.get(m[1]); if (!c) return err(404, 'invalid_request_error', 'resource_missing');
      const { pending, polls, target, ...pub } = c;
      if (r.method === 'POST' && m[2]) {
        if (!(Number(f.frozen_time) > c.frozen_time)) return err(400, 'invalid_request_error', 'parameter_invalid');
        c.status = 'advancing'; c.target = Number(f.frozen_time); c.polls = clockPollsUntilReady; return { json: { ...pub, status: 'advancing' } };
      }
      if (r.method === 'GET' && !m[2]) {
        if (c.status === 'advancing' && !clockNeverReady && --c.polls <= 0) { bill(c, c.target); c.status = 'ready'; }
        const { pending: _p, polls: _q, target: _t, ...view } = c; return { json: view };
      }
      if (r.method === 'DELETE' && !m[2]) {
        if (c.status === 'advancing') return err(400, 'invalid_request_error', 'test_clock_advancing');
        db.clocks.delete(c.id);
        for (const [cid, cus] of db.customers) if (cus.test_clock === c.id) { db.customers.delete(cid); for (const s of db.subscriptions.values()) if (s.customer === cid) s.status = 'canceled'; }
        return { json: { id: c.id, object: 'test_helpers.test_clock', deleted: true } };
      }
    }
    if (r.method === 'POST' && r.path === '/v1/customers') {
      if (f.test_clock && !db.clocks.has(f.test_clock)) return err(400, 'invalid_request_error', 'resource_missing');
      const c = base({ id: id('cus'), object: 'customer', email: f.email, name: f.name, test_clock: f.test_clock || null, metadata: meta(f) }); db.customers.set(c.id, c); return { json: c };
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
      if (m[1] === 'tok_chargeDeclined' || m[1] === 'pm_card_chargeDeclined') return err(402, 'card_error', 'card_declined', { 'stripe-should-retry': 'false' });
      const pm = base({ id: id('pm'), object: 'payment_method', token: m[1], customer: f.customer }); db.pms.set(pm.id, pm); return { json: pm };
    }
    if (r.method === 'POST' && r.path === '/v1/subscriptions') {
      const price = db.prices.get(f['items[0][price]']);
      if (!price || !db.customers.has(f.customer) || !db.pms.has(f.default_payment_method)) return err(400, 'invalid_request_error', 'parameter_invalid');
      const o = outcome(f.default_payment_method);
      const behavior = f.payment_behavior || 'allow_incomplete';
      if (o !== 'ok' && behavior === 'error_if_incomplete') return err(402, 'card_error', o === 'auth' ? 'authentication_required' : 'card_declined', { 'stripe-should-retry': 'false' });
      const t = nowFor(f.customer);
      const s = base({ id: id('sub'), object: 'subscription', status: 'incomplete', customer: f.customer, cancel_at_period_end: false, canceled_at: null,
        default_payment_method: f.default_payment_method, current_period_start: t, current_period_end: t + PERIOD,
        items: { object: 'list', data: [{ id: id('si'), object: 'subscription_item', price }] }, latest_invoice: null, metadata: meta(f) }, t);
      db.subscriptions.set(s.id, s);
      const inv = newInvoice(s, 'subscription_create');
      if (attempt(inv, s.default_payment_method)) s.status = 'active';
      emit('customer.subscription.created', s);
      return { json: subView(s, expand(f)) };
    }
    if ((m = r.path.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const s = db.subscriptions.get(m[1]); if (!s) return err(404, 'invalid_request_error', 'resource_missing');
      if (r.method === 'GET') return { json: subView(s, r.query.getAll('expand[]')) };
      if (r.method === 'DELETE') {
        if (s.status === 'canceled') return err(400, 'invalid_request_error', 'subscription_canceled');
        s.status = 'canceled'; s.canceled_at = nowFor(s.customer); emit('customer.subscription.deleted', s); return { json: s };
      }
      if (r.method === 'POST') {
        if (f.cancel_at_period_end === 'true') s.cancel_at_period_end = true;
        if (f.default_payment_method) { if (!db.pms.has(f.default_payment_method)) return err(400, 'invalid_request_error', 'resource_missing'); s.default_payment_method = f.default_payment_method; }
        if (f['items[0][price]']) {
          const item = s.items.data.find((x) => x.id === f['items[0][id]']); const price = db.prices.get(f['items[0][price]']);
          if (!item || !price) return err(400, 'invalid_request_error', 'parameter_invalid');
          if (f.proration_behavior !== 'none') db.prorations.push({ subscription: s.id, from: item.price.id, to: price.id });
          if (f.proration_behavior === 'always_invoice') {
            // The prorated difference, invoiced and charged now. pending_if_incomplete: the item changes only if it is paid.
            const inv = base({ id: id('in'), object: 'invoice', status: 'open', paid: false, attempt_count: 0, amount_due: prorated(item.price, price, f.proration_date, s), amount_paid: 0, currency: 'usd',
              customer: s.customer, subscription: s.id, billing_reason: 'subscription_update' }, nowFor(s.customer));
            db.invoices.set(inv.id, inv); s.latest_invoice = inv.id;
            const ok = attempt(inv, s.default_payment_method);
            if (ok || f.payment_behavior !== 'pending_if_incomplete') { item.price = price; s.pending_update = null; }
            else s.pending_update = { expires_at: nowFor(s.customer) + 23 * 3600, subscription_items: [{ id: item.id, price: price.id }] };
          } else item.price = price;
        }
        emit('customer.subscription.updated', s);
        return { json: subView(s, expand(f)) };
      }
    }
    if (r.method === 'POST' && r.path === '/v1/invoices/create_preview') {
      const s = db.subscriptions.get(f.subscription); const price = db.prices.get(f['subscription_details[items][0][price]']);
      if (!s || !price || f.customer !== s.customer) return err(400, 'invalid_request_error', 'parameter_invalid');
      return { json: base({ object: 'invoice', id: null, amount_due: prorated(s.items.data[0].price, price, f['subscription_details[proration_date]'], s), currency: 'usd' }) };
    }
    if (r.method === 'POST' && r.path === '/v1/subscription_schedules') {
      const s = db.subscriptions.get(f.from_subscription);
      if (!s) return err(400, 'invalid_request_error', 'resource_missing');
      if (s.schedule) return err(400, 'invalid_request_error', 'subscription_schedule_exists');
      const sch = base({ id: id('sub_sched'), object: 'subscription_schedule', status: 'active', subscription: s.id, end_behavior: 'release', current_phase: 0,
        phases: [{ start_date: s.current_period_start, end_date: s.current_period_end, items: [{ price: s.items.data[0].price.id, quantity: 1 }] }] });
      s.schedule = sch.id; db.schedules.set(sch.id, sch); return { json: sch };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/v1\/subscription_schedules\/([^/]+)(\/release)?$/))) {
      const sch = db.schedules.get(m[1]); if (!sch) return err(404, 'invalid_request_error', 'resource_missing');
      if (m[2]) { if (sch.status !== 'active') return err(400, 'invalid_request_error', 'schedule_not_active'); sch.status = 'released'; db.subscriptions.get(sch.subscription).schedule = null; return { json: sch }; }
      const phases = [];
      for (let i = 0; f[`phases[${i}][items][0][price]`]; i++) {
        if (!db.prices.has(f[`phases[${i}][items][0][price]`])) return err(400, 'invalid_request_error', 'resource_missing');
        phases.push({ start_date: Number(f[`phases[${i}][start_date]`]) || null, end_date: Number(f[`phases[${i}][end_date]`]) || null, iterations: Number(f[`phases[${i}][iterations]`]) || null,
          items: [{ price: f[`phases[${i}][items][0][price]`], quantity: 1 }] });
      }
      if (!phases.length || phases[0].start_date !== sch.phases[0].start_date) return err(400, 'invalid_request_error', 'parameter_invalid');
      Object.assign(sch, { phases, end_behavior: f.end_behavior || sch.end_behavior }); return { json: sch };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/v1\/invoices\/([^/]+)\/pay$/))) {
      const inv = db.invoices.get(m[1]); if (!inv) return err(404, 'invalid_request_error', 'resource_missing');
      if (inv.status !== 'open') return err(400, 'invalid_request_error', 'invoice_not_open');
      if (!attempt(inv, f.payment_method || db.subscriptions.get(inv.subscription)?.default_payment_method)) return err(402, 'card_error', 'card_declined', { 'stripe-should-retry': 'false' });
      const s = db.subscriptions.get(inv.subscription);
      if (s && s.latest_invoice === inv.id && ['past_due', 'incomplete'].includes(s.status)) { s.status = 'active'; emit('customer.subscription.updated', s); }
      return { json: inv };
    }
    if (r.method === 'POST' && r.path === '/v1/checkout/sessions') {
      if (!db.customers.has(f.customer) || !db.prices.has(f['line_items[0][price]']) || !f.success_url) return err(400, 'invalid_request_error', 'parameter_invalid');
      const s = base({ id: id('cs_test'), object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/cs_test_sbx_${n}`, status: 'open', mode: f.mode, customer: f.customer, metadata: meta(f) });
      db.sessions.set(s.id, s); return { json: s };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) {
      const s = db.sessions.get(m[1]); if (!s) return err(404, 'invalid_request_error', 'resource_missing');
      if (s.status !== 'open') return err(400, 'invalid_request_error', 'checkout_session_not_open');
      s.status = 'expired'; s.url = null; return { json: s };
    }
    if (r.method === 'POST' && r.path === '/v1/payment_intents') {
      if (!db.customers.has(f.customer)) return err(404, 'invalid_request_error', 'resource_missing');
      if (f.payment_method === 'pm_card_chargeDeclined') return err(402, 'card_error', 'card_declined', { 'stripe-should-retry': 'false' });
      const ch = charge(Number(f.amount), f.customer);
      const pi = base({ id: id('pi'), object: 'payment_intent', status: 'succeeded', amount: Number(f.amount), customer: f.customer, latest_charge: ch.id, metadata: meta(f) });
      ch.payment_intent = pi.id; db.intents.set(pi.id, pi); emit('payment_intent.succeeded', pi);
      return { json: { ...pi, latest_charge: expand(f).includes('latest_charge') ? ch : ch.id } };
    }
    if (r.method === 'POST' && r.path === '/v1/refunds') {
      const pi = db.intents.get(f.payment_intent); if (!pi) return err(404, 'invalid_request_error', 'resource_missing');
      const ch = db.charges.get(pi.latest_charge);
      const done = [...db.refunds.values()].filter((x) => x.charge === ch.id).reduce((s, x) => s + x.amount, 0);
      if (done + Number(f.amount) > ch.amount) return err(400, 'invalid_request_error', 'charge_already_refunded');
      const re = base({ id: id('re'), object: 'refund', status: 'succeeded', amount: Number(f.amount), currency: 'usd', charge: ch.id, payment_intent: pi.id });
      db.refunds.set(re.id, re); emit('refund.created', re); return { json: re };
    }
    if (r.method === 'GET' && r.path === '/v1/events') {
      const limit = Math.min(100, Number(r.query.get('limit') || 10));
      const all = [...db.events].reverse();
      return { json: { object: 'list', data: all.slice(0, limit), has_more: all.length > limit } };
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
    // Snapshot, as Stripe stores the response: later changes to the object do not leak into a replay.
    const snap = { ...out, json: out.json === undefined ? undefined : structuredClone(out.json) };
    if ((out.status || 200) < 500) idem.set(key, { hash: h, out: snap });
    return snap;
  });
  return { ...srv, db };
}
