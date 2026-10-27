/**
 * Control Center — Membership 2.0 area (admin/gadmin-membership2.js).
 *
 * Contract: docs/membership/CONTROL-CENTER.md section 6. These tests pin the
 * rules a reviewer cannot see by clicking around: the area is invisible and
 * silent unless the gateway answers its probe; only permitted actions are
 * drawn; no write leaves without a reason; a retry after a network error or a
 * 5xx is the same request (same requestId, same body); API text never becomes
 * markup; and the file uses none of the browser APIs that would leak a token.
 *
 * The module runs in a vm against a minimal fake DOM (no dependencies).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SRC = read('admin/gadmin-membership2.js');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const CODE = strip(SRC);

// ---------------- minimal fake DOM ----------------
function makeDom() {
  let byId;
  class Text { constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; } get textContent() { return this.data; } }
  class El {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = {}; this.childNodes = []; this.parentNode = null; this.listeners = {}; this.value = ''; this.disabled = false; this.className = ''; this.tabIndex = 0; this.offsetParent = {}; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'tabindex') this.tabIndex = Number(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c); return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get firstChild() { return this.childNodes[0] || null; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(t) { this.childNodes = []; if (t !== '') this.appendChild(new Text(t)); }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    dispatch(t, ev) { ev = Object.assign({ type: t, target: this, preventDefault() {}, stopPropagation() {} }, ev || {}); (this.listeners[t] || []).forEach((f) => f(ev)); return ev; }
    click() { this.dispatch('click'); }
    focus() { doc.activeElement = this; }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    querySelectorAll() { return all(this).filter((n) => /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(n.tagName)); }
    get innerHTML() { throw new Error('innerHTML must not be used'); }
    set innerHTML(v) { throw new Error('innerHTML must not be used'); }
  }
  const all = (n, out = []) => { (n.childNodes || []).forEach((c) => { if (c.nodeType === 1) { out.push(c); all(c, out); } }); return out; };
  const doc = {
    activeElement: null,
    listeners: {},
    createElement: (t) => new El(t),
    createTextNode: (t) => new Text(t),
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); },
    getElementById: (id) => all(doc.body).find((n) => n.id === id) || null,
  };
  doc.body = new El('body');
  byId = doc.getElementById;
  return { doc, El, all, byId };
}

// ---------------- harness ----------------
function load(routes) {
  const dom = makeDom();
  const calls = [];
  const fetch = (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', body });
    const key = (opts.method || 'GET') + ' ' + url.split('?')[0];
    let r = routes[key];
    if (typeof r === 'function') r = r(body, calls);
    if (!r) r = { status: 404, j: { ok: false, code: 'NOT_FOUND' } };
    if (r.network) return Promise.reject(new TypeError('network'));
    return Promise.resolve({ status: r.status, json: () => Promise.resolve(r.j) });
  };
  const toasts = [];
  const win = {};
  const ctx = {
    window: win, document: dom.doc, fetch, setTimeout: (f) => { f(); return 0; }, clearTimeout() {},
    AbortController: undefined, Uint8Array, Promise, Object, Array, JSON, Math, Number, String, Date, isNaN, encodeURIComponent, Boolean, TypeError,
  };
  win.crypto = { getRandomValues: (b) => require('node:crypto').randomFillSync(b) };
  // setTimeout runs at once except for the idle timer (long delays) which must not fire.
  ctx.setTimeout = (f, ms) => { if (!ms || ms < 1000) Promise.resolve().then(f); return 0; };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const M2 = win.GaiaMembership2;
  M2.init({ authHeaders: () => ({}), toast: (m) => toasts.push(m), adminExpired: () => {} });
  return { M2, dom, calls, toasts };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const text = (dom) => dom.doc.body.textContent;
const buttons = (dom) => dom.all(dom.doc.body).filter((n) => n.tagName === 'BUTTON');
const button = (dom, label) => buttons(dom).find((b) => b.textContent === label);

const ME = (permissions, role = 'support') => ({ status: 200, j: { ok: true, operator: { id: 'op-1', email: 'ana@example.test', displayName: 'Ana Fictional', role }, permissions, idleExpiresAt: new Date(Date.now() + 30 * 60000).toISOString() } });
const PERSON = {
  status: 200,
  j: {
    // The real shape: top-level sections, and `person` is only the person row.
    ok: true, person: { id: 'P1', status: 'active' },
    identities: [{ platform: 'email', kind: 'email', external_id: 'p@example.test' }], wallet: { granted: { coins: 100, usd: '$1.00' }, purchased: { coins: 0, usd: '$0.00' }, legacy: { coins: 0, usd: '$0.00' }, total: { coins: 100, usd: '$1.00' } }, coinTransactions: [],
      subscriptions: [{ id: 's1', status: 'active', plan_key: 'standard', plan_name: 'Standard', billing_interval: 'month', current_period_end: '2026-11-26T00:00:00Z', cancel_at: null, events: [] }],
      payments: [{ id: 7, provider: 'stripe', provider_object_type: 'charge', entry_type: 'charge', amount_cents: 4700, currency: 'USD', occurred_at: '2026-10-26T10:00:00Z' }],
      legacy: [], offers: [], pilot: false, notes: [{ body: '<img src=x onerror=alert(1)>', created_at: '2026-10-26T10:00:00Z' }], audit: [],
  },
};
async function signedIn(perms, role, extra = {}) {
  const h = load(Object.assign({
    'GET /api/admin/membership2/status': { status: 200, j: { enabled: true, signedIn: true } },
    'GET /api/admin/membership2/me': ME(perms, role),
    'GET /api/admin/membership2/persons/P1': PERSON,
  }, extra));
  assert.equal(await h.M2.probe(), true);
  const box = h.dom.doc.createElement('div'); h.dom.doc.body.appendChild(box);
  h.M2.mount(box); await settle();
  return h;
}
async function openPersonTab(h, tab) {
  const S = h.M2._test.state;
  S.screen = 'members'; S.personId = 'P1'; S.personTab = tab;
  h.M2.mount(h.M2._test.state.box); await settle();
}

// ---------------- static ----------------
test('the file uses no markup sinks, no storage and no eval', () => {
  const banned = [
    ['innerHTML', /\.innerHTML\b/], ['outerHTML', /\.outerHTML\b/], ['insertAdjacentHTML', /insertAdjacentHTML/],
    ['document.write', /document\.write/], ['eval', /\beval\s*\(/], ['new Function', /new\s+Function\s*\(/],
    ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['indexedDB', /indexedDB/],
    ['document.cookie', /document\.cookie/], ['console', /console\./], ['string setTimeout', /setTimeout\(\s*['"`]/],
  ];
  const found = banned.filter(([, re]) => re.test(CODE)).map(([n]) => n);
  assert.deepEqual(found, [], 'forbidden APIs in gadmin-membership2.js: ' + found.join(', '));
});

test('it only talks to the same-origin gateway, and holds no secret', () => {
  const urls = [...CODE.matchAll(/['"`](https?:\/\/[^'"`]+)['"`]/g)].map((m) => m[1]);
  assert.deepEqual(urls, [], 'no absolute URLs');
  assert.match(CODE, /var BASE = '\/api\/admin\/membership2'/);
  assert.ok(!/sk_(live|test)_|whsec_|Bearer\s+[A-Za-z0-9]/.test(CODE), 'no key material');
  assert.ok(!/X-Operator-Session/i.test(CODE), 'the operator token is the gateway\'s business, never the page\'s');
});

test('index.html loads the area before gadmin.js; the gadmin.js hook is small and probe-gated', () => {
  const html = read('admin/index.html');
  assert.ok(html.indexOf('gadmin-membership2.js') > 0 && html.indexOf('gadmin-membership2.js') < html.indexOf('src="gadmin.js'), 'loaded first');
  const g = strip(read('admin/gadmin.js'));
  const hook = g.split('\n').filter((l) => /M2\b/.test(l));
  assert.ok(hook.length <= 12, 'hook stays small, got ' + hook.length + ' lines');
  assert.match(g, /M2 && M2\.enabled\(\) \?/, 'the menu item depends on the probe');
  assert.match(g, /M2\.probe\(\)\.then\(function \(on\) \{ if \(on/, 'membership2 joins VIEWS only when the probe says so');
  assert.ok(!/VIEWS = \[[^\]]*membership2/.test(g), 'membership2 is not a default view');
});

test('branding and the billing-off sentence are exact', () => {
  assert.match(SRC, /Gaia Healers Control Center/);
  assert.match(SRC, /Approved, but billing is not connected in this environment; nothing was charged or refunded\./);
  assert.match(SRC, /Waiting for a second approver/);
  assert.match(SRC, /Sent for approval/);
  assert.match(read('membership-service/src/catalog.js'), /export const COIN_CENTS = 1;/, 'COIN_CENTS mirror matches the catalog');
  assert.match(SRC, /var COIN_CENTS = 1;/);
});

// ---------------- probe gating ----------------
test('probe 404 → hidden, and no other request is ever made', async () => {
  const h = load({});
  assert.equal(await h.M2.probe(), false);
  assert.equal(h.M2.enabled(), false);
  const box = h.dom.doc.createElement('div'); h.dom.doc.body.appendChild(box);
  h.M2.mount(box); await h.M2.signOut(); await settle();
  assert.deepEqual(h.calls.map((c) => c.url), ['/api/admin/membership2/status']);
  assert.equal(box.childNodes.length, 0, 'nothing drawn');
});

test('probe 401 (no admin session) or network error → hidden', async () => {
  for (const r of [{ status: 401, j: {} }, { network: true }]) {
    const h = load({ 'GET /api/admin/membership2/status': r });
    assert.equal(await h.M2.probe(), false);
    assert.equal(h.calls.length, 1);
  }
});

test('probe 200 not signed in → the operator sign-in, with email, password and 6-digit code', async () => {
  const h = load({ 'GET /api/admin/membership2/status': { status: 200, j: { enabled: true, signedIn: false } } });
  assert.equal(await h.M2.probe(), true);
  const box = h.dom.doc.createElement('div'); h.dom.doc.body.appendChild(box);
  h.M2.mount(box); await settle();
  const labels = h.dom.all(box).filter((n) => n.tagName === 'LABEL').map((l) => [l.textContent, l.getAttribute('for')]);
  assert.deepEqual(labels.map((l) => l[0]), ['Operator email', 'Password', 'Authenticator code']);
  labels.forEach(([, f]) => assert.ok(h.dom.byId(f), 'label points at a real control'));
  assert.equal(h.dom.byId('m2code').getAttribute('autocomplete'), 'one-time-code');
  assert.equal(h.calls.length, 1, 'no request until the operator signs in');
});

test('sign-in: generic error on failure, lockout on 429', async () => {
  let n = 0;
  const h = load({
    'GET /api/admin/membership2/status': { status: 200, j: { enabled: true, signedIn: false } },
    'POST /api/admin/membership2/login': () => (++n === 1 ? { status: 401, j: { ok: false, code: 'AUTH_REQUIRED', error: 'invalid_login' } } : { status: 429, j: { ok: false, code: 'RATE_LIMITED' } }),
  });
  await h.M2.probe();
  const box = h.dom.doc.createElement('div'); h.dom.doc.body.appendChild(box);
  h.M2.mount(box); await settle();
  const fill = () => { h.dom.byId('m2em').value = 'a@example.test'; h.dom.byId('m2pw').value = 'pw'; h.dom.byId('m2code').value = '123456'; };
  const form = h.dom.all(box).find((x) => x.tagName === 'FORM');
  fill(); form.dispatch('submit'); await settle();
  assert.equal(h.dom.byId('m2err').textContent, 'Sign-in failed. Check your email, password and code.');
  fill(); form.dispatch('submit'); await settle();
  assert.match(h.dom.byId('m2err').textContent, /locked/);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/login'))[0].body.totp, '123456');
  // A bad code never leaves the page.
  h.dom.byId('m2code').value = '12ab'; form.dispatch('submit'); await settle();
  assert.equal(h.calls.filter((c) => c.url.endsWith('/login')).length, 2);
});

test('a console 401 (admin_auth_required) goes to the console sign-in, not the operator one', async () => {
  const h = load({
    'GET /api/admin/membership2/status': { status: 200, j: { enabled: true, signedIn: true } },
    'GET /api/admin/membership2/me': ME([], 'viewer'),
    'GET /api/admin/membership2/overview': { status: 401, j: { ok: false, code: 'AUTH_REQUIRED', reason: 'admin_auth_required' } },
  });
  let expired = 0;
  h.M2.init({ adminExpired: () => { expired++; } });
  await h.M2.probe();
  const box = h.dom.doc.createElement('div'); h.dom.doc.body.appendChild(box);
  h.M2.mount(box); await settle();
  assert.equal(expired, 1);
});

test('a note is its own reason: no separate reason field, 10 characters minimum', async () => {
  const h = await signedIn(['note.add'], 'support', { 'POST /api/admin/membership2/actions': { status: 200, j: { ok: true, status: 'executed' } } });
  await openPersonTab(h, 'notes');
  button(h.dom, 'Add note').click(); await settle();
  assert.equal(h.dom.byId('m2f-reason'), null, 'no reason box for a note');
  const body = h.dom.byId('m2f-body');
  const form = h.dom.all(h.dom.doc.body).find((n) => n.getAttribute('role') === 'dialog').childNodes[0];
  body.value = 'short'; form.dispatch('submit'); await settle();
  assert.equal(actionCalls(h).length, 0);
  body.value = 'Called member, all fine'; form.dispatch('submit'); await settle();
  const c = actionCalls(h)[0].body;
  assert.equal(c.reason, 'Called member, all fine');
  assert.deepEqual(c.params, { personId: 'P1', body: 'Called member, all fine' });
});

test('AUTH_REQUIRED mid-session returns to sign-in and says why', async () => {
  const h = await signedIn([], 'viewer', { 'GET /api/admin/membership2/overview': { status: 401, j: { ok: false, code: 'AUTH_REQUIRED' } } });
  assert.match(h.dom.byId('m2err').textContent, /operator session has ended/);
});

// ---------------- permissions ----------------
test('only actions in /me.permissions are drawn', async () => {
  const none = await signedIn([], 'viewer');
  await openPersonTab(none, 'coins'); assert.ok(!button(none.dom, 'Credit coins'));
  await openPersonTab(none, 'payments'); assert.ok(!button(none.dom, 'Refund'));
  await openPersonTab(none, 'subscriptions'); assert.ok(!button(none.dom, 'Cancel now') && !button(none.dom, 'Cancel at period end'));
  await openPersonTab(none, 'notes'); assert.ok(!button(none.dom, 'Add note'));

  const some = await signedIn(['coins.credit', 'subscription.cancel_period_end', 'note.add'], 'support');
  await openPersonTab(some, 'coins'); assert.ok(button(some.dom, 'Credit coins'));
  assert.match(text(some.dom), /p@example\.test/, 'person header uses the email identity');
  assert.match(text(some.dom), /100 coins \(\$1\.00\)/, 'wallet balances are {coins, usd} objects');
  await openPersonTab(some, 'payments'); assert.ok(!button(some.dom, 'Refund'), 'support cannot refund');
  await openPersonTab(some, 'subscriptions');
  assert.ok(button(some.dom, 'Cancel at period end')); assert.ok(!button(some.dom, 'Cancel now'));
});

test('launch is read-only unless owner, even if a permission key slipped through', async () => {
  const launch = { 'GET /api/admin/membership2/launch': { status: 200, j: { ok: true, state: { stored: 'INTERNAL_PILOT', ceiling: 'INTERNAL_PILOT', effective: 'INTERNAL_PILOT', limitedCap: 0 }, history: [], pilots: [{ person_id: 'P9', added_at: '2026-10-26T10:00:00Z' }] } } };
  const fin = await signedIn(['launch.set', 'pilot.add', 'pilot.remove'], 'finance', launch);
  fin.M2._test.state.screen = 'launch'; fin.M2.mount(fin.M2._test.state.box); await settle();
  assert.ok(!button(fin.dom, 'Change stage') && !button(fin.dom, 'Remove'));
  assert.match(text(fin.dom), /Read-only/);
  const own = await signedIn(['launch.set', 'pilot.add', 'pilot.remove'], 'owner', launch);
  own.M2._test.state.screen = 'launch'; own.M2.mount(own.M2._test.state.box); await settle();
  assert.ok(button(own.dom, 'Change stage') && button(own.dom, 'Remove') && button(own.dom, 'Add pilot member'));
});

test('own requests wait for a second approver; others show requester and reason', async () => {
  const reqs = { 'GET /api/admin/membership2/requests': { status: 200, j: { ok: true, items: [
    { id: 'r1', action: 'payment.refund', params: { ledgerId: 7, amountCents: 4700 }, reason: 'double charge on 26 Oct', requestedBy: { id: 'op-1', displayName: 'Ana Fictional' }, own: true, canApprove: false, requiredRole: 'finance' },
    { id: 'r2', action: 'coins.credit', params: { personId: 'P1', coins: 900 }, reason: 'service outage goodwill', requestedBy: { id: 'op-2', displayName: 'Ben Fictional' }, own: false, requiredRole: 'finance', canApprove: true },
  ] } } };
  const h = await signedIn([], 'finance', reqs);
  h.M2._test.state.screen = 'requests'; h.M2.mount(h.M2._test.state.box); await settle();
  const t = text(h.dom);
  assert.match(t, /Waiting for a second approver/);
  assert.match(t, /Ben Fictional/); assert.match(t, /service outage goodwill/);
  assert.match(t, /\$47\.00 \(4,700 coins\)/, 'money shows $ and coins');
  assert.equal(buttons(h.dom).filter((b) => b.textContent === 'Approve').length, 1, 'approve only on the other operator\'s request');
});

// ---------------- dialog: reason, requestId, outcomes ----------------
async function creditDialog(actionsRoute) {
  const h = await signedIn(['coins.credit'], 'support', { 'POST /api/admin/membership2/actions': actionsRoute });
  await openPersonTab(h, 'coins');
  button(h.dom, 'Credit coins').click(); await settle();
  const dlg = h.dom.all(h.dom.doc.body).find((n) => n.getAttribute('role') === 'dialog');
  const form = h.dom.all(dlg).find((n) => n.tagName === 'FORM');
  return { h, dlg, form, coins: h.dom.byId('m2f-coins'), reason: h.dom.byId('m2f-reason') };
}
const actionCalls = (h) => h.calls.filter((c) => c.url.endsWith('/actions'));

test('every action dialog states the consequence, and needs a 10-character reason', async () => {
  const d = await creditDialog({ status: 200, j: { ok: true, status: 'executed', result: {} } });
  assert.equal(d.dlg.getAttribute('aria-modal'), 'true');
  assert.ok(d.dlg.getAttribute('aria-labelledby'));
  assert.equal(d.h.dom.doc.activeElement, d.coins, 'focus moves into the dialog');
  d.coins.value = '120'; d.coins.dispatch('input');
  assert.match(text(d.h.dom), /Adds 120 coins \(\$1\.20\)/);
  d.reason.value = 'too short'; d.form.dispatch('submit'); await settle();
  assert.equal(actionCalls(d.h).length, 0, 'no request without a 10-char reason');
  d.reason.value = 'outage on 25 Oct, goodwill'; d.form.dispatch('submit'); await settle();
  const c = actionCalls(d.h);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].body.params, { personId: 'P1', coins: 120 });
  assert.match(c[0].body.requestId, /^[A-Za-z0-9_-]{8,64}$/);
});

test('network error and 5xx reuse the same requestId and body; a 4xx starts a new one', async () => {
  let n = 0;
  const seq = [{ network: true }, { status: 502, j: {} }, { status: 400, j: { ok: false, code: 'INVALID_INPUT', message: 'no' } }, { status: 200, j: { ok: true, status: 'executed' } }];
  const d = await creditDialog(() => seq[n++]);
  d.coins.value = '50'; d.reason.value = 'goodwill for a broken session';
  d.form.dispatch('submit'); await settle();
  assert.equal(d.coins.disabled, true, 'form freezes so the retry is identical');
  d.coins.value = '9999';                       // ignored: the frozen body is resent
  d.form.dispatch('submit'); await settle();
  d.form.dispatch('submit'); await settle();
  const c = actionCalls(d.h);
  assert.equal(c.length, 3);
  assert.equal(c[1].body.requestId, c[0].body.requestId);
  assert.deepEqual(c[1].body, c[0].body);
  assert.equal(c[2].body.requestId, c[0].body.requestId, '5xx retry reuses it too');
  d.form.dispatch('submit'); await settle();
  assert.notEqual(actionCalls(d.h)[3].body.requestId, c[0].body.requestId, 'after a definite 4xx refusal, a fresh id');
});

test('outcome wording: pending, billing-off, forbidden', () => {
  const { outcome } = load({}).M2._test;
  assert.match(outcome({ status: 200, j: { ok: true, status: 'pending', request: { requiredRole: 'finance' } } }).text, /^Sent for approval/);
  assert.equal(outcome({ status: 200, j: { ok: true, status: 'approved_not_executed' } }).text,
    'Approved, but billing is not connected in this environment; nothing was charged or refunded.');
  assert.equal(outcome({ status: 503, j: { ok: false, code: 'PROVIDER_UNAVAILABLE' } }).text,
    'Approved, but billing is not connected in this environment; nothing was charged or refunded.');
  assert.match(outcome({ status: 403, j: { ok: false, code: 'FORBIDDEN', requiredRole: 'finance' } }).text, /needs the finance role/);
});

test('PROVIDER_UNAVAILABLE (503) is a final answer, not a retry', () => {
  const { retryable } = load({}).M2._test;
  assert.equal(retryable({ status: 503, j: { code: 'PROVIDER_UNAVAILABLE' } }), false);
  assert.equal(retryable({ status: 500, j: {} }), true);
  assert.equal(retryable({ status: 0, network: true, j: {} }), true);
  assert.equal(retryable({ status: 409, j: { code: 'CONFLICT' } }), false);
});

test('API text is rendered as text, never as markup', async () => {
  const h = await signedIn(['note.add'], 'support');
  await openPersonTab(h, 'notes');
  assert.match(text(h.dom), /<img src=x onerror=alert\(1\)>/, 'shown literally');
  assert.ok(!h.dom.all(h.dom.doc.body).some((n) => n.tagName === 'IMG'), 'no element created from API data');
});

test('money and coins format', () => {
  const { money, coinsText } = load({}).M2._test;
  assert.equal(money(4700), '$47.00 (4,700 coins)');
  assert.equal(money(4700, 5000), '$47.00 (5,000 coins)', 'API coin figure wins');
  assert.equal(coinsText(500), '500 coins ($5.00)');
  assert.equal(money(-250), '−$2.50 (-250 coins)');
});

// ---------------- Phase 3 owner decisions ----------------
test('first sign-in: a must-change-password session sees only the password screen; the change is checked before sending', async () => {
  let sent = null;
  const h = load({
    'GET /api/admin/membership2/status': { status: 200, j: { enabled: true, signedIn: true, mustChangePassword: true, environment: 'staging', stripeMode: 'none' } },
    'GET /api/admin/membership2/me': { status: 200, j: { ok: true, operator: { id: 'op-9', displayName: 'New Fictional', role: 'finance', mustChangePassword: true }, mustChangePassword: true, permissions: [] } },
    'POST /api/admin/membership2/password': (b) => { sent = b; return { status: 200, j: { ok: true, changed: true } }; },
  });
  await h.M2.probe();
  const box = h.dom.doc.createElement('div'); h.dom.doc.body.appendChild(box);
  h.M2.mount(box); await settle();
  assert.match(text(h.dom), /Choose your own password/);
  assert.ok(!h.dom.byId('m2s-panel'), 'no area until the password is changed');
  const form = h.dom.all(box).find((n) => n.tagName === 'FORM');
  h.dom.byId('m2pwcur').value = 'initial-password-x'; h.dom.byId('m2pwnew').value = 'short'; h.dom.byId('m2pwagain').value = 'short';
  form.dispatch('submit'); await settle();
  assert.equal(sent, null); assert.match(text(h.dom), /at least 12 characters/);
  h.dom.byId('m2pwcur').value = 'initial-password-x'; h.dom.byId('m2pwnew').value = 'a-new-long-passphrase'; h.dom.byId('m2pwagain').value = 'a-new-long-passphras';
  form.dispatch('submit'); await settle();
  assert.equal(sent, null); assert.match(text(h.dom), /do not match/);
  h.dom.byId('m2pwcur').value = 'initial-password-x'; h.dom.byId('m2pwnew').value = 'a-new-long-passphrase'; h.dom.byId('m2pwagain').value = 'a-new-long-passphrase';
  form.dispatch('submit'); await settle();
  assert.deepEqual(sent, { currentPassword: 'initial-password-x', newPassword: 'a-new-long-passphrase' });
});

test('STAGING / TEST MODE banner comes from the server: shown unless production with live Stripe', async () => {
  const h = load({ 'GET /api/admin/membership2/status': { status: 200, j: { enabled: true, signedIn: false, environment: 'staging', stripeMode: 'none' } } });
  assert.equal(h.M2.banner(), null, 'nothing before the probe');
  await h.M2.probe();
  assert.match(h.M2.banner(), /^STAGING \/ TEST MODE — environment: staging · Stripe not connected/);
  const S = h.M2._test.state;
  S.env = { environment: 'production', stripeMode: 'test' }; assert.match(h.M2.banner(), /^TEST MODE/);
  S.env = { environment: 'production', stripeMode: 'live' }; assert.equal(h.M2.banner(), null);
  const g = strip(read('admin/gadmin.js'));
  assert.match(g, /M2 && M2\.banner\(\) \? '    <div class="envbanner" role="status">' \+ esc\(M2\.banner\(\)\)/, 'the console shell draws it, escaped');
});

test('money source badges are labels for the server-side source, never guessed', () => {
  const { badge } = load({}).M2._test;
  assert.equal(badge('stripe_confirmed').textContent, 'Stripe-confirmed');
  assert.equal(badge('test_fixture').textContent, 'Test fixture');
  assert.equal(badge('not_executed').textContent, 'Not executed (billing not connected)');
  assert.equal(badge(undefined), null);
  assert.ok(!/provider_object_id\s*\.\s*(startsWith|match)|\/\^(ch|in|re)_/.test(CODE), 'the UI does not infer the source from ids');
});

test('names, not ids: requests show the member email; audit shows operator names, entity labels and the reason column', async () => {
  const extra = {
    'GET /api/admin/membership2/requests': { status: 200, j: { ok: true, items: [
      { id: 'r9', action: 'payment.refund', status: 'approved_not_executed', dual: true, params: { ledgerId: 7, amountCents: 100 }, reason: 'duplicate charge refund', requestedBy: { id: 'op-2', displayName: 'Ben Fictional' },
        decidedBy: { id: 'op-3', displayName: 'Cy Fictional' }, subject: { personId: 'P1', email: 'member@example.test' }, money: 'not_executed', attempts: 1, canExecute: true, own: false, requiredRole: 'finance', executeRole: 'finance',
        lastAttempt: { outcome: 'not_executed', code: 'PROVIDER_UNAVAILABLE', executedBy: { displayName: 'Cy Fictional' } } },
    ] } },
    'GET /api/admin/membership2/audit': { status: 200, j: { ok: true, items: [
      { id: 1, occurred_at: '2026-10-26T10:00:00Z', actor_type: 'admin', actor_id: 'operator:op-2', actor_name: 'Ben Fictional', action: 'launch.pilot_add', entity_type: 'person', entity_id: 'P1', entity_label: 'member@example.test', reason: 'internal pilot tester' },
    ] } },
    'POST /api/admin/membership2/requests/r9/execute': (b) => ({ status: 200, j: { ok: true, status: 'approved_not_executed', echo: b } }),
  };
  const h = await signedIn([], 'finance', extra);
  h.M2._test.state.screen = 'requests'; h.M2.mount(h.M2._test.state.box); await settle();
  let t = text(h.dom);
  assert.match(t, /member@example\.test/); assert.match(t, /Cy Fictional/); assert.match(t, /Not executed \(billing not connected\)/);
  button(h.dom, 'Execute again').click(); await settle();
  h.dom.byId('m2f-reason').value = 'billing is connected now';
  const form = h.dom.all(h.dom.all(h.dom.doc.body).find((n) => n.getAttribute('role') === 'dialog')).find((n) => n.tagName === 'FORM');
  form.dispatch('submit'); await settle();
  const ex = h.calls.find((c) => c.url.endsWith('/requests/r9/execute'));
  assert.equal(ex.body.reason, 'billing is connected now'); assert.match(ex.body.requestId, /^cc_[0-9a-f]{32}$/);
  h.M2._test.state.screen = 'audit'; h.M2.mount(h.M2._test.state.box); await settle();
  t = text(h.dom);
  assert.match(t, /Ben Fictional \(admin\)/); assert.match(t, /person member@example\.test/); assert.match(t, /internal pilot tester/);
  assert.ok(!/operator:op-2/.test(t), 'no raw operator id when a name exists');
});

test('goodwill shows as its own wallet bucket', async () => {
  const P = JSON.parse(JSON.stringify(PERSON));
  P.j.wallet = { granted: { coins: 10 }, goodwill: { coins: 200 }, purchased: { coins: 5 }, legacy: { coins: 0 }, total: { coins: 215 }, spendOrder: ['granted', 'goodwill', 'purchased', 'legacy'] };
  const h = await signedIn([], 'viewer', { 'GET /api/admin/membership2/persons/P1': P });
  await openPersonTab(h, 'coins');
  const t = text(h.dom);
  assert.match(t, /goodwill \(never expires\)/); assert.match(t, /200 coins/); assert.match(t, /granted → goodwill → purchased → legacy/);
});

test('sidebar: real buttons with aria-current; "live from GHL" is not claimed for Membership 2.0', () => {
  const g = read('admin/gadmin.js');
  assert.match(g, /<button type="button" class="nav__item nav__item--btn ' \+ \(view === id \? 'is-active' : ''\) \+ '" data-nav="' \+ id \+ '"' \+ \(view === id \? ' aria-current="page"' : ''\)/);
  assert.ok(!/<div class="nav__item/.test(g), 'no div pretending to be a button');
  assert.match(g, /view === 'membership2' \? 'Gaia Healers &middot; Membership 2\.0 database' : 'Gaia Healers &middot; live from GHL'/);
  assert.match(read('admin/gadmin.css'), /\.side \.nav__item:focus-visible\{outline:2px solid/);
});

test('retries show their 72-hour deadline and are not offered once it has passed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'admin', 'gadmin-membership2.js'), 'utf8');
  assert.match(src, /retryUntil && new Date\(r\.retryUntil\) <= new Date\(\)/, 'a closed window hides Execute again');
  assert.match(src, /72-hour retry window closed/);
  assert.match(src, /Can run again until/);
});
