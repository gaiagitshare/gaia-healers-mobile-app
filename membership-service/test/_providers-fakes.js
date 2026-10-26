/**
 * Loopback fakes for Stripe, GHL and the Gaia Practitioners API. Each one is a
 * real HTTP server on 127.0.0.1 (so the adapters' fetch, headers, retries and
 * encodings are exercised end to end) with an in-memory store, a request log
 * and fault injection (`faults.push({ status, headers, json })` is served
 * before the next real response). Nothing here knows any real credential.
 */
import http from 'node:http';
import crypto from 'node:crypto';

export async function fakeServer(handler) {
  const requests = [];
  const faults = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const ct = String(req.headers['content-type'] || '');
      const form = ct.includes('x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : null;
      let json = null;
      if (ct.includes('json') && raw) { try { json = JSON.parse(raw); } catch { json = null; } }
      const r = { method: req.method, path: u.pathname, query: u.searchParams, headers: req.headers, raw, form, json };
      requests.push(r);
      let out;
      try { out = faults.length ? faults.shift() : await handler(r); } catch (e) { out = { status: 500, json: { error: { message: String(e.message) } } }; }
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(out.json === undefined ? '' : JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, faults, close: () => new Promise((r) => server.close(r)) };
}

const err = (status, type, code, message = code) => ({ status, json: { error: { type, code, message } } });

/** Fake Stripe (test mode). opts.livemode makes every object claim live mode. */
export async function fakeStripe({ livemode = false, lists = {} } = {}) {
  const db = { customers: new Map(), products: new Map(), prices: new Map(), sessions: new Map(), subscriptions: new Map(), invoices: new Map(), schedules: new Map(), changes: [], payOutcome: 'ok' };
  const idem = new Map();
  let n = 0;
  const id = (p) => `${p}_fake_${++n}`;
  const meta = (form, prefix = 'metadata') => Object.fromEntries(Object.entries(form || {}).filter(([k]) => k.startsWith(prefix + '[')).map(([k, v]) => [k.slice(prefix.length + 1, -1), v]));

  const route = (r) => {
    if (!/^Bearer sk_test_/.test(r.headers.authorization || '')) return err(401, 'invalid_request_error', 'api_key_invalid');
    const f = r.form || {};
    if (r.method === 'POST' && r.path === '/v1/customers') {
      const c = { id: id('cus'), object: 'customer', email: f.email || null, metadata: meta(f), livemode };
      db.customers.set(c.id, c); return { json: c };
    }
    let m;
    if (r.method === 'GET' && (m = r.path.match(/^\/v1\/products\/(.+)$/))) {
      const p = db.products.get(m[1]);
      return p ? { json: p } : err(404, 'invalid_request_error', 'resource_missing');
    }
    if (r.method === 'POST' && r.path === '/v1/products') {
      if (db.products.has(f.id)) return err(400, 'invalid_request_error', 'resource_already_exists');
      const p = { id: f.id || id('prod'), object: 'product', name: f.name, metadata: meta(f), livemode };
      db.products.set(p.id, p); return { json: p };
    }
    if (r.method === 'GET' && r.path === '/v1/prices') {
      const keys = r.query.getAll('lookup_keys[]');
      return { json: { object: 'list', data: [...db.prices.values()].filter((p) => keys.includes(p.lookup_key)), has_more: false } };
    }
    if (r.method === 'POST' && r.path === '/v1/prices') {
      if ([...db.prices.values()].some((p) => p.lookup_key && p.lookup_key === f.lookup_key)) return err(400, 'invalid_request_error', 'lookup_key_exists');
      const p = { id: id('price'), object: 'price', product: f.product, currency: f.currency, unit_amount: Number(f.unit_amount), lookup_key: f.lookup_key || null,
        recurring: f['recurring[interval]'] ? { interval: f['recurring[interval]'], interval_count: Number(f['recurring[interval_count]'] || 1) } : null, metadata: meta(f), livemode };
      db.prices.set(p.id, p); return { json: p };
    }
    if (r.method === 'POST' && r.path === '/v1/checkout/sessions') {
      const s = { id: id('cs_test'), object: 'checkout.session', url: `https://checkout.stripe.invalid/pay/${n}`, mode: f.mode, customer: f.customer,
        metadata: meta(f), expires_at: 1900000000, livemode };
      db.sessions.set(s.id, { ...s, form: f }); return { json: s };
    }
    if (r.method === 'GET' && (m = r.path.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const s = db.subscriptions.get(m[1]);
      return s ? { json: s } : err(404, 'invalid_request_error', 'resource_missing');
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/v1\/subscriptions\/(.+)$/))) {
      const s = db.subscriptions.get(m[1]);
      if (!s) return err(404, 'invalid_request_error', 'resource_missing');
      if (f.cancel_at_period_end === 'true') { s.cancel_at_period_end = true; s.cancel_at = s.items.data[0].current_period_end; }
      if (f.trial_end) s.trial_end = Number(f.trial_end);
      if (f['items[0][price]']) {
        // Plan change. With pending_if_incomplete the item changes only once the prorated invoice is paid (db.payOutcome).
        const item = s.items.data.find((i) => i.id === f['items[0][id]']); const price = db.prices.get(f['items[0][price]']);
        if (!item || !price) return err(400, 'invalid_request_error', 'parameter_invalid');
        db.changes.push({ subscription: s.id, form: f });
        if (f.proration_behavior === 'always_invoice') {
          const amount = Math.max(0, Math.round((price.unit_amount - (item.price.unit_amount || 0)) / 2));
          const paid = db.payOutcome === 'ok';
          const inv = { id: id('in'), object: 'invoice', status: paid ? 'paid' : 'open', amount_due: amount, currency: 'usd', billing_reason: 'subscription_update',
            subscription: s.id, customer: s.customer, hosted_invoice_url: paid ? null : `https://invoice.stripe.invalid/i/${n}`, livemode,
            lines: { data: [{ price: { id: price.id }, amount }, { price: { id: item.price.id }, amount: -amount }] } };
          db.invoices.set(inv.id, inv); s.latest_invoice = inv.id;
          if (paid || f.payment_behavior !== 'pending_if_incomplete') { item.price = price; s.pending_update = null; }
          else s.pending_update = { expires_at: 1900000000, subscription_items: [{ id: item.id, price }] };
        } else item.price = price;
      }
      const exp = Object.entries(f).filter(([k]) => k.startsWith('expand[')).map(([, v]) => v);
      return { json: { ...s, latest_invoice: exp.includes('latest_invoice') && s.latest_invoice ? db.invoices.get(s.latest_invoice) : s.latest_invoice } };
    }
    if (r.method === 'POST' && r.path === '/v1/invoices/create_preview') {
      const s = db.subscriptions.get(f.subscription); const price = db.prices.get(f['subscription_details[items][0][price]']);
      if (!s || !price || f.customer !== s.customer) return err(400, 'invalid_request_error', 'parameter_invalid');
      const item = s.items.data[0];
      return { json: { object: 'invoice', id: null, amount_due: Math.max(0, Math.round((price.unit_amount - (item.price.unit_amount || 0)) / 2)), currency: 'usd', livemode } };
    }
    if (r.method === 'POST' && r.path === '/v1/subscription_schedules') {
      const s = db.subscriptions.get(f.from_subscription);
      if (!s) return err(400, 'invalid_request_error', 'resource_missing');
      if (s.schedule) return err(400, 'invalid_request_error', 'subscription_schedule_exists');
      const it = s.items.data[0];
      const sch = { id: id('sub_sched'), object: 'subscription_schedule', status: 'active', subscription: s.id, end_behavior: 'release', livemode,
        phases: [{ start_date: it.current_period_start, end_date: it.current_period_end, items: [{ price: it.price.id, quantity: 1 }] }] };
      s.schedule = sch.id; db.schedules.set(sch.id, sch); return { json: sch };
    }
    if (r.method === 'POST' && (m = r.path.match(/^\/v1\/subscription_schedules\/([^/]+)(\/release)?$/))) {
      const sch = db.schedules.get(m[1]);
      if (!sch) return err(404, 'invalid_request_error', 'resource_missing');
      if (m[2]) {
        if (sch.status !== 'active') return err(400, 'invalid_request_error', 'schedule_not_active');
        sch.status = 'released'; sch.released_subscription = sch.subscription; db.subscriptions.get(sch.subscription).schedule = null; return { json: sch };
      }
      const phases = [];
      for (let i = 0; f[`phases[${i}][items][0][price]`]; i++) {
        phases.push({ start_date: Number(f[`phases[${i}][start_date]`]) || null, end_date: Number(f[`phases[${i}][end_date]`]) || null,
          iterations: Number(f[`phases[${i}][iterations]`]) || null, proration_behavior: f[`phases[${i}][proration_behavior]`],
          items: [{ price: f[`phases[${i}][items][0][price]`], quantity: Number(f[`phases[${i}][items][0][quantity]`] || 1) }] });
      }
      if (phases[0] && phases[0].start_date !== sch.phases[0].start_date) return err(400, 'invalid_request_error', 'phase_start_mismatch');
      Object.assign(sch, { phases, end_behavior: f.end_behavior, proration_behavior: f.proration_behavior, metadata: meta(f) });
      return { json: sch };
    }
    if (r.method === 'GET' && (m = r.path.match(/^\/v1\/(invoices|charges|refunds|disputes)$/))) {
      const all = (lists[m[1]] || []).map((o) => ({ livemode, ...o }));
      const after = r.query.get('starting_after');
      const limit = Number(r.query.get('limit') || 10);
      const start = after ? all.findIndex((o) => o.id === after) + 1 : 0;
      const data = all.slice(start, start + limit);
      return { json: { object: 'list', data, has_more: start + limit < all.length } };
    }
    return err(404, 'invalid_request_error', 'unknown_route');
  };

  const srv = await fakeServer((r) => {
    if (r.method !== 'POST') return route(r);
    const key = r.headers['idempotency-key'];
    if (!key) return err(400, 'invalid_request_error', 'idempotency_key_required_by_fake');
    const h = crypto.createHash('sha256').update(r.method + r.path + r.raw).digest('hex');
    const prev = idem.get(key);
    if (prev) return prev.hash === h ? prev.out : { status: 400, json: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters' } } };
    const out = route(r);
    if ((out.status || 200) < 500) idem.set(key, { hash: h, out });
    return out;
  });
  return { ...srv, db };
}

/** Fake GHL contacts API. contacts: [{ id, email, additionalEmails, tags, customFields: [{ id, value }] }]
 * fieldDefinitions: location custom-field definitions served at GET /locations/{id}/customFields. */
export async function fakeGhl({ contacts = [], fieldDefinitions = [] } = {}) {
  const db = new Map(contacts.map((c) => [c.id, structuredClone({ tags: [], customFields: [], additionalEmails: [], ...c })]));
  const srv = await fakeServer((r) => {
    if (!/^Bearer /.test(r.headers.authorization || '') || r.headers.version !== '2021-07-28') return { status: 401, json: { message: 'unauthorized' } };
    let m;
    if (r.method === 'GET' && /^\/locations\/[^/]+\/customFields$/.test(r.path)) return { json: { customFields: fieldDefinitions } };
    if (r.method === 'POST' && r.path === '/contacts/search') {
      const q = String(r.json?.query || '').toLowerCase();
      // fuzzy, like GHL: substring of the local part also matches
      const local = q.split('@')[0];
      const hits = [...db.values()].filter((c) => [c.email, ...c.additionalEmails].some((e) => String((e && typeof e === 'object' ? e.email : e) || '').toLowerCase().includes(local)));
      return { json: { contacts: hits.map((c) => ({ id: c.id, email: c.email })), total: hits.length } };
    }
    if ((m = r.path.match(/^\/contacts\/([^/]+)$/))) {
      const c = db.get(m[1]);
      if (!c) return { status: 404, json: { message: 'not found' } };
      if (r.method === 'GET') return { json: { contact: c } };
      if (r.method === 'PUT') {
        for (const f of r.json?.customFields || []) {
          const cur = c.customFields.find((x) => x.id === f.id);
          if (cur) cur.value = f.field_value; else c.customFields.push({ id: f.id, value: f.field_value });
        }
        return { json: { contact: c } };
      }
    }
    if ((m = r.path.match(/^\/contacts\/([^/]+)\/tags$/))) {
      const c = db.get(m[1]);
      if (!c) return { status: 404, json: { message: 'not found' } };
      const tags = (r.json?.tags || []).map((t) => String(t).toLowerCase());
      if (r.method === 'POST') c.tags = [...new Set([...c.tags, ...tags])];
      if (r.method === 'DELETE') c.tags = c.tags.filter((t) => !tags.includes(t));
      return { json: { tags: c.tags } };
    }
    return { status: 404, json: { message: 'unknown route' } };
  });
  return { ...srv, db };
}

/**
 * Fake GHL payments (read side). Offset pagination like GHL (`limit`, `offset`,
 * `totalCount`). Anything but GET is answered 405 and logged, so a test can
 * prove the reader never sent one.
 *   subscriptions / transactions: arrays of GHL-shaped objects
 *   prices: { [productId]: [{ _id, ... }] }
 */
export async function fakeGhlPayments({ subscriptions = [], transactions = [], prices = {} } = {}) {
  const state = { subscriptions, transactions, prices };
  const page = (all, q) => {
    const limit = Number(q.get('limit') || 100); const offset = Number(q.get('offset') || 0);
    return { json: { data: all.slice(offset, offset + limit), totalCount: all.length } };
  };
  const srv = await fakeServer((r) => {
    if (!/^Bearer /.test(r.headers.authorization || '') || r.headers.version !== '2021-07-28') return { status: 401, json: { message: 'unauthorized' } };
    if (r.method !== 'GET') return { status: 405, json: { message: 'read-only fake' } };
    if (r.path === '/payments/subscriptions') return page(state.subscriptions, r.query);
    if (r.path === '/payments/transactions') {
      const since = r.query.get('startAt') ? new Date(r.query.get('startAt')) : null;
      return page(state.transactions.filter((t) => !since || new Date(t.createdAt) >= since), r.query);
    }
    const m = r.path.match(/^\/products\/([^/]+)\/price$/);
    if (m) return state.prices[m[1]] ? { json: { prices: state.prices[m[1]], total: state.prices[m[1]].length } } : { status: 404, json: { message: 'not found' } };
    return { status: 404, json: { message: 'unknown route' } };
  });
  return { ...srv, state };
}

/**
 * Fake partner API. routes: { '/v1/practitioners/gp_1': object | [page, page, ...] }.
 * Arrays are served as cursor pages: page i gets next_cursor `cur_<i+1>` unless it is last
 * (a page may override next_cursor itself to simulate partner bugs).
 */
export async function fakePartner({ routes = {}, token } = {}) {
  return fakeServer((r) => {
    if (r.method !== 'GET') return { status: 405, json: { error: { code: 'method_not_allowed', message: 'read-only' } } };
    if (token && r.headers.authorization !== `Bearer ${token}`) return { status: 401, json: { error: { code: 'unauthorized', message: 'bad token' } } };
    const v = routes[r.path];
    if (v === undefined) return { status: 404, json: { error: { code: 'not_found', message: 'not found' } } };
    if (!Array.isArray(v)) return { json: v };
    const cursor = r.query.get('cursor');
    const i = cursor ? Number(cursor.replace('cur_', '')) : 0;
    const page = v[i];
    if (!page) return { status: 400, json: { error: { code: 'bad_cursor', message: 'bad cursor' } } };
    return { json: { next_cursor: i + 1 < v.length ? `cur_${i + 1}` : null, ...page } };
  });
}

export const noSleep = () => Promise.resolve();
export const fetchVia = (...a) => globalThis.fetch(...a);   // the guarded fetch: loopback only
