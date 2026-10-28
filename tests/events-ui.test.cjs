/* ---- Events experience: regression checks (28 Oct 2026) -------------------
 * The event page shows what the official sources say -- the GHL Elevate pages
 * via the Event Manager -- and never sells anything itself. These run the
 * shipped gaia-superapp.js render functions against a real /api/events/1
 * payload (tests/fixtures/event-detail-elevate-2026-10-28.json) and check
 * tickets, packages, sponsors, speakers, agenda, exhibitors, hotel and FAQ,
 * plus the Overview shortcuts and that every buy button is an official link.
 * ------------------------------------------------------------------------ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'event-detail-elevate-2026-10-28.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(FIXTURE));

// A browser just complete enough for the script to load; nothing renders into it.
function loadSections() {
  const noop = () => {};
  const el = () => ({ addEventListener: noop, appendChild: noop, querySelector: () => null, querySelectorAll: () => [],
    setAttribute: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {} });
  const storage = { getItem: () => null, setItem: noop, removeItem: noop };
  const window = {
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, setTimeout, clearTimeout,
    requestAnimationFrame: (f) => setTimeout(f, 0), localStorage: storage, sessionStorage: storage,
    location: { search: '', href: 'https://gaiahealers.app/home.html', pathname: '/home.html', origin: 'https://gaiahealers.app' },
    matchMedia: () => ({ matches: false, addEventListener: noop }), navigator: { onLine: true },
  };
  const document = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, querySelector: () => null,
    querySelectorAll: () => [], getElementById: () => null, createElement: el, body: el(), documentElement: el(), readyState: 'loading' };
  window.document = document;
  const ctx = vm.createContext({ window, document, localStorage: storage, sessionStorage: storage, navigator: window.navigator,
    location: window.location, setTimeout, clearTimeout, console, URL, URLSearchParams, Intl, Date, Math, JSON,
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, fetch: () => new Promise(noop) });
  vm.runInContext(fs.readFileSync(path.join(root, 'gaia-superapp.js'), 'utf8'), ctx, { filename: 'gaia-superapp.js' });
  assert.ok(window.GaiaEventSections, 'gaia-superapp.js exposes its event-page builders');
  return window.GaiaEventSections;
}

const S = loadSections();
const OFFICIAL = /^https:\/\/(?:[a-z0-9-]+\.)*(?:gaiahealers\.com|leadconnectorhq\.com|synxis\.com)\//;
const hrefs = (html) => [...html.matchAll(/<a [^>]*class="[^"]*g-offer__btn[^"]*"[^>]*href="([^"]+)"|<a [^>]*href="([^"]+)"[^>]*class="[^"]*g-offer__btn/g)]
  .map((m) => (m[1] || m[2]).replace(/&amp;/g, '&'));
const count = (html, needle) => html.split(needle).length - 1;

test('the event page offers the new tabs only when the sources have content', () => {
  const keys = S.tabs.map(([k]) => k);
  for (const k of ['overview', 'tickets', 'agenda', 'speakers', 'exhibitors', 'exhibit', 'sponsors', 'info']) assert.ok(keys.includes(k), k);
  const d = clone();
  assert.ok(S.hasTab('tickets', d) && S.hasTab('exhibit', d));
  d.site = { tickets: [], packages: [], faq: [], hotel: [], notes: [] };
  assert.ok(!S.hasTab('tickets', d) && !S.hasTab('exhibit', d), 'no empty tabs');
  delete d.site;
  assert.ok(!S.hasTab('tickets', d), 'an older payload without `site` still renders');
});

test('Overview shortcuts: Get Tickets and Become an Exhibitor open the app tabs', () => {
  const html = S.shortcuts(clone(), 'upcoming');
  assert.match(html, /data-event-tab="tickets"[^>]*>[\s\S]*Get Tickets/);
  assert.match(html, /data-event-tab="exhibit"[^>]*>[\s\S]*Become an Exhibitor/);
  assert.doesNotMatch(html, /href=/, 'they move inside the app; the tabs carry the official links');
  assert.equal(S.shortcuts(clone(), 'past'), '', 'nothing to buy once the event is over');
  const noPkgs = clone(); noPkgs.site.packages = [];
  assert.doesNotMatch(S.shortcuts(noPkgs, 'upcoming'), /Become an Exhibitor/);
});

test('Tickets: every option from the website, with price and an official checkout link', () => {
  const html = S.tickets(clone());
  for (const t of FIXTURE.site.tickets) {
    assert.ok(html.includes(t.title) && html.includes(t.price), t.title);
  }
  const links = hrefs(html);
  assert.equal(links.length, FIXTURE.site.tickets.length);
  links.forEach((u) => assert.match(u, OFFICIAL, u));
  assert.match(html, /target="_blank"/);
  assert.match(html, /official Gaia Healers checkout/);
});

test('Become an Exhibitor: packages with prices, benefits, availability; filled ones cannot be bought', () => {
  const d = clone();
  const html = S.exhibit(d);
  for (const p of d.site.packages) assert.ok(html.includes(p.title) && html.includes(p.price), p.title);
  assert.match(html, /<s>\$5,000<\/s>/, 'regular price shown struck through');
  assert.match(html, /4 Spots Remaining/);
  assert.equal(count(html, 'This package has been filled'), d.site.packages.filter((p) => p.status === 'filled').length);
  const links = hrefs(html);
  assert.equal(links.length, d.site.packages.filter((p) => p.status !== 'filled' && p.url).length);
  links.forEach((u) => assert.match(u, /^https:\/\/exhibitors\.gaiahealers\.com\//, u));
  assert.match(html, /exhibitor space sales are final/i, 'the package terms come along');
});

test('A change at the source shows on the next load (price, filled, removed)', () => {
  const d = clone();
  d.site.packages[0].price = '$3,900';
  d.site.packages[1].status = 'filled'; d.site.packages[1].url = null;
  d.site.tickets = d.site.tickets.filter((t) => t.title !== 'General Admission');
  const ex = S.exhibit(d);
  assert.match(ex, /\$3,900/);
  assert.equal(count(ex, 'This package has been filled'), d.site.packages.filter((p) => p.status === 'filled').length);
  assert.doesNotMatch(S.tickets(d), /General Admission/);
});

test('Sponsors are grouped exactly as the website groups them, in its order', () => {
  const html = S.sponsors(clone());
  const order = ['Title Sponsors', 'Premium Sponsors', 'Gifted to You By'].map((h) => html.indexOf('<h3>' + h + '</h3>'));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], String(order));
  assert.doesNotMatch(html, />headline<|>gold<|>partner</, 'no internal tier words');
  for (const sp of FIXTURE.sponsors) assert.ok(html.includes(sp.name), sp.name);
  const legacy = clone(); legacy.sponsors.forEach((sp) => { delete sp.category; });
  assert.match(S.sponsors(legacy), /<h3>Title Sponsors<\/h3>/, 'an older payload without category still groups by tier');
});

test('Info: the website FAQ is the FAQ, and the official hotel with its booking link', () => {
  const d = clone();
  const html = S.info(d);
  for (const q of d.site.faq) assert.ok(html.includes(q.title.replace(/'/g, '&#39;')) || html.includes(q.title), q.title);
  const em = (d.info || []).filter((i) => i.section === 'faq');
  em.forEach((i) => assert.ok(!html.includes(i.title), 'Event-Manager-only FAQ hidden while the website has one: ' + i.title));
  assert.match(html, /Rosen Shingle Creek/);
  hrefs(html).forEach((u) => assert.match(u, /^https:\/\/be\.synxis\.com\/.*GRP_GAIA26/, u));
  const noSite = clone(); noSite.site.faq = [];
  if (em.length) assert.ok(S.info(noSite).includes(em[0].title), 'the organiser FAQ returns when the website has none');
});

test('Speakers, agenda and exhibitors are complete and searchable', () => {
  const d = clone();
  const spk = S.speakers(d);
  d.speakers.forEach((sp) => assert.ok(spk.includes(sp.name.replace(/'/g, '&#39;')) || spk.includes(sp.name), sp.name));
  assert.equal(count(spk, 'data-filter-row'), d.speakers.length);
  assert.match(spk, /data-filter-q/);
  const ag = S.agenda(d);
  const sessions = d.agenda.days.reduce((n, day) => n + (day.sessions || []).length, 0);
  assert.equal(count(ag, 'data-filter-row'), sessions);
  assert.match(ag, /data-filter-q/);
  const ex = S.exhibitors(d);
  assert.equal(count(ex, 'data-dir-row'), d.exhibitors.length);
  assert.match(ex, /data-event-tab="exhibit"/, 'the directory leads to Become an Exhibitor');
});

test('Nothing in the event payload is rendered unescaped', () => {
  const d = clone();
  d.site.tickets[0].title = '<img src=x onerror=alert(1)>';
  d.site.packages[0].perks = ['<script>alert(1)</script>'];
  d.sponsors[0].name = '"><b>x</b>';
  const html = S.tickets(d) + S.exhibit(d) + S.sponsors(d);
  assert.doesNotMatch(html, /<img src=x|<script>alert|"><b>x/);
});
