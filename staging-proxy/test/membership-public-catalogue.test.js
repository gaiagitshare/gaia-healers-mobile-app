/**
 * The public plan catalogue must not depend on being signed in.
 *
 * Production shipped a version where a signed-out visitor was told "Membership
 * plans are unavailable right now" while /api/membership/plans sat there
 * returning all four plans. The catalogue fetch lived inside loadMember(),
 * which only runs after gaia:auth fires with authenticated: true.
 *
 * This runs the real gaia-member.js against a minimal DOM, with every one of
 * the eleven member endpoints returning 401, and asserts the plans still
 * render. It is deliberately behavioural rather than a source scan: the bug was
 * a control-flow mistake, and only executing the file can catch it coming back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { appTest as rawAppTest, readApp } from './_app-present.js';
// Every test here reads gaia-member.js, so the guard checks that file.
const appTest = (name, fn) => rawAppTest(name, fn, 'gaia-member.js');

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Read through the guard: a module-level readFileSync would throw at import
// time on the proxy host, taking the whole file down before any skip applies.
const SOURCE = readApp('gaia-member.js');

const MEMBER_ENDPOINTS = [
  '/api/member/profile', '/api/member/access', '/api/member/appointments',
  '/api/member/notifications', '/api/member/devices', '/api/member/purchases',
  '/api/member/forms', '/api/member/courses', '/api/member/products',
  '/api/member/activity', '/api/member/events',
];

const PLANS = {
  ok: true,
  plans: [
    { key: 'free', label: 'Free', subtitle: 'Gaia Healers Network', prices: { monthly: '$0', annual: '$0' }, displayBenefits: ['Community access'], checkoutUrl: 'https://join.gaiahealers.com/onboarding' },
    { key: 'silver', label: 'Silver', subtitle: 'Gaia Healers Practitioner', prices: { monthly: '$97/mo', annual: '$997/yr' }, displayBenefits: ['Certifications'], checkoutUrl: 'https://join.gaiahealers.com/silver' },
    { key: 'gold', label: 'Gold', subtitle: 'Gaia Healers Practice Pro', prices: { monthly: '$497/mo', annual: '$4,997/yr' }, displayBenefits: ['Managed CRM'], checkoutUrl: 'https://join.gaiahealers.com/gold' },
    { key: 'diamond', label: 'Diamond', subtitle: 'Gaia Healers Leader', prices: { monthly: '$997/mo', annual: '$9,997/yr' }, displayBenefits: ['Leader CRM'], checkoutUrl: 'https://join.gaiahealers.com/diamond' },
  ],
};

/**
 * Just enough DOM for the module to boot and paint. Elements record the HTML
 * written into them, which is all the assertions need.
 */
function makeDom() {
  const nodes = new Map();
  const listeners = new Map();
  const node = (id) => ({
    id, innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeAttribute() {}, setAttribute() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, remove() {},
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
  });
  const doc = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); },
    // gaia-member.js bails out unless it is on home.html, which it detects by
    // this selector. Without it the module returns before registering anything.
    querySelector: (sel) => (sel === '.gaia-main--today' ? node('gaia-main') : null),
    querySelectorAll: () => [],
    createElement: () => node('created'),
    addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
    dispatchEvent() { return true; },
    body: node('body'),
    documentElement: node('html'),
    visibilityState: 'visible',
  };
  // addEventListener above needs the map primed
  doc.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  return { doc, nodes, listeners };
}

async function bootSignedOut({ plansResponse = PLANS, plansStatus = 200 } = {}) {
  const { doc, nodes, listeners } = makeDom();
  const requested = [];

  const fetchStub = async (url) => {
    const path_ = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    requested.push(path_);
    if (MEMBER_ENDPOINTS.includes(path_)) {
      // Exactly what production returns for a signed-out visitor.
      return { ok: false, status: 401, json: async () => ({ ok: false }) };
    }
    if (path_ === '/api/membership/plans') {
      return { ok: plansStatus === 200, status: plansStatus, json: async () => plansResponse };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const sandbox = {
    document: doc,
    window: {
      location: { hostname: 'gaiahealers.app', search: '', href: '' },
      addEventListener() {}, setInterval: () => 0, clearInterval() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      GAIA: {},
    },
    fetch: fetchStub,
    setInterval: () => 0, clearInterval() {}, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    DOMParser: class { parseFromString() { return { body: { textContent: '' } }; } },
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    Date, JSON, Math, Array, Object, String, Number, Boolean, Promise, RegExp, Error,
  };
  sandbox.window.document = doc;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'gaia-member.js' });

  // fire the public boot exactly as a browser would, and never fire gaia:auth
  for (const fn of (listeners.get('DOMContentLoaded') || [])) fn({});
  // let the catalogue fetch settle
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const html = [...nodes.values()].map((n) => n.innerHTML || '').join('\n');
  return { html, requested, listeners, nodes };
}

appTest('a signed-out visitor sees the plan catalogue even though all 11 member endpoints 401', async () => {
  const { html, requested } = await bootSignedOut();

  assert.ok(requested.includes('/api/membership/plans'),
    'the public catalogue must be fetched without waiting for a signed-in member');
  assert.ok(!html.includes('Membership plans are unavailable right now'),
    'this is the exact string production showed a signed-out visitor');

  for (const label of ['Free', 'Silver', 'Gold', 'Diamond']) {
    assert.ok(html.includes(label), `${label} should render for a signed-out visitor`);
  }
  assert.ok(html.includes('$97/mo'), 'prices come from the server catalogue, not from literals here');
});

appTest('gaia:auth never fires, and the catalogue still loaded', async () => {
  const { requested, listeners } = await bootSignedOut();
  // loadMember is wired to gaia:auth; we deliberately never dispatch it.
  assert.ok(listeners.has('gaia:auth'), 'the authenticated path still exists');
  const memberCalls = requested.filter((p) => MEMBER_ENDPOINTS.includes(p));
  assert.equal(memberCalls.length, 0,
    'a signed-out boot must not depend on member endpoints at all');
});

appTest('a failing catalogue degrades to the message, it does not crash', async () => {
  const { html } = await bootSignedOut({ plansStatus: 500, plansResponse: {} });
  assert.ok(html.includes('Membership plans are unavailable right now'),
    'when the public endpoint genuinely fails, saying so is correct');
});

appTest('the catalogue is presentation only and cannot grant anything', async () => {
  const { html } = await bootSignedOut();
  // A plan card may advertise. It must never tell a visitor what they hold —
  // that sentence belongs to My Access, which reads the ledger.
  for (const claim of [/you own/i, /you have access/i, /your licen[cs]e/i, /unlocked/i]) {
    assert.ok(!claim.test(html), `the plan catalogue must not claim entitlement: ${claim}`);
  }
});

appTest('the plans fetch is not nested inside the authenticated loader', () => {
  // Structural backstop for the control-flow mistake itself: loadMember() is
  // only ever called from the gaia:auth handler, so anything fetched inside it
  // is invisible to a signed-out visitor.
  const loader = SOURCE.slice(SOURCE.indexOf('async function loadMember()'));
  const body = loader.slice(0, loader.indexOf('\n  }\n'));
  assert.ok(!body.includes('/api/membership/plans'),
    'the public catalogue must not be fetched from inside loadMember()');
  assert.ok(/loadPlans\(\);/.test(SOURCE), 'and it must be fetched from the public boot');
});
