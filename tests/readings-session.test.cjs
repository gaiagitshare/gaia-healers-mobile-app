// Run the real readings module with fictional sessions and a small DOM fixture.
// No network or browser dependency; responses deliberately ignore abort to test stale-result guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../gaia-my-readings.js'), 'utf8');
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ pauseStatus = false, pauseReadings = false, partial = false } = {}) {
  const handlers = new Map(), calls = [], rootHandlers = {};  let person = 'A', finishStatus, finishReadings;
  const root = { hidden: false, innerHTML: '', offsetParent: null, classList: { add() {}, remove() {}, toggle() {} }, addEventListener(type, fn) { rootHandlers[type] = fn; }, querySelector: () => null, querySelectorAll: () => [] };
  const share = { ...root };
  const listen = (type, fn) => { const list = handlers.get(type) || []; list.push(fn); handlers.set(type, list); };
  const emit = (type, detail) => (handlers.get(type) || []).forEach(fn => fn({ type, detail }));
  const window = { addEventListener: listen, dispatchEvent: e => emit(e.type, e.detail), setTimeout, requestAnimationFrame: fn => fn(), GaiaMember: { authed: true, data: { profile: { profile: { contactId: 'A' } } } } };
  const document = { readyState: 'complete', getElementById: id => id === 'member-readings' ? root : id === 'member-data-sharing' ? share : null, querySelector: () => null, querySelectorAll: () => [], addEventListener: listen, dispatchEvent: e => emit(e.type, e.detail) };
  const response = v => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const fetch = async url => {
    const owner = person; calls.push({ url, owner });
    if (url.endsWith('/member-link/status')) {
      const body = { ok: true, linked: owner === 'A', practitioner_name: 'Practitioner A' };
      if (pauseStatus && owner === 'A') return new Promise(resolve => { finishStatus = () => resolve(response(body)); });
      return response(body);
    }
    if (url.endsWith('/api/member/prefs')) return response({ ok: true, prefs: {} });
    if (url.endsWith('/my-readings')) {
      const body = { ok: true, partial, latest: { scanned_at: '2026-10-01', energy: 54, stress: 2, chakras: [] }, summary: { headline: 'Private reading for A', lines: [] }, practitioner: { name: 'Practitioner A' }, files: [], series: [], comparisons: [] };
      if (pauseReadings && owner === 'A') return new Promise(resolve => { finishReadings = () => resolve(response(body)); });
      return response(body);
    }
    return response({ ok: true });
  };
  vm.runInNewContext(source, { window, document, fetch, Response, AbortController, URLSearchParams, location: { search: '' }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }, setTimeout, Date, console });
  return { root, share, calls, window, click: action => rootHandlers.click({ target: { closest: () => ({ getAttribute: () => action, disabled: false }) } }), api: window.GaiaMyReadings, signOut: () => emit('gaia:signed-out'), auth: id => { person = id; emit('gaia:auth', { authenticated: !!id, member: id ? { contactId: id } : null }); }, finishStatus: () => finishStatus(), finishReadings: () => finishReadings() };
}

test('signout clears reading values and link state before the next account renders', async () => {
  const f = fixture(); await tick(); assert.equal(f.api.latest().latest.energy, 54);
  f.signOut(); assert.equal(f.api.latest(), null); assert.equal(f.api.status().linked, undefined); assert.equal(f.root.innerHTML, ''); assert.equal(f.share.innerHTML, '');
  f.auth('B'); await tick(); assert.equal(f.api.latest(), null); assert.equal(f.api.status().linked, false); assert(!f.root.innerHTML.includes('Private reading for A'));
  assert(f.calls.some(c => c.owner === 'B' && c.url.endsWith('/member-link/status')));
});

test('a previous account reading response cannot restore data after signout', async () => {
  const f = fixture({ pauseReadings: true }); await tick(); f.signOut(); f.finishReadings(); await tick();
  assert.equal(f.api.latest(), null); assert.equal(f.root.hidden, true); assert.equal(f.root.innerHTML, '');
});

test('an obsolete status response cannot start a reading request for the next account', async () => {
  const f = fixture({ pauseStatus: true }); await tick(); f.auth('B'); await tick(); f.finishStatus(); await tick();
  assert.equal(f.api.latest(), null); assert.equal(f.api.status().linked, false); assert(!f.calls.some(c => c.url.endsWith('/my-readings')));
});

test('partial readings show a retry notice instead of implying every section loaded', async () => {
  const f = fixture({ partial: true }); await tick(); assert(f.root.innerHTML.includes('Some sections could not be loaded')); assert.equal(f.api.latest().latest.energy, 54);
});

test('mounting twice does not register duplicate per-person listeners', async () => {
  const f = fixture(); await tick(); await f.api.mount(); const n = f.calls.length; f.auth('B'); await tick(); assert.equal(f.calls.length - n, 2);
});

 test('a confirmation opened under a previous account cannot unlink the next member', async () => {
  const f = fixture(); await tick(); let confirm;
  f.window.GaiaNotice = { confirm: () => new Promise(resolve => { confirm = resolve; }) };
  const pending = f.click('unlink'); f.auth('B'); await tick(); confirm(true); await pending;
  assert(!f.calls.some(c => c.url.endsWith('/member-link/unlink')));
});
