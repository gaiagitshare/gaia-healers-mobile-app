/**
 * Official checkout links (28 Oct 2026): a website button that points at a GHL
 * preview of the checkout opens the published address of the SAME page in the
 * app -- and only when that address is verified to be that page.
 * Offline: fake GHL funnel list and fake page fetches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutLinkResolver, previewPageId } from '../checkout-links.js';

const PAGE = 'mDX2UoHaiINvV0Tujt7X';
const SRC = 'https://elevate.gaiahealers.com/gaia-healers-elevate-conference-page';
const funnels = { funnels: [{ _id: 'ICib74xvODPEJQHFYWOv', steps: [
  { url: '/gaia-healers-elevate-conference', pages: ['mpw8yqCGewhQp9UGDVBA'] },
  { url: '/cart', pages: [PAGE] }] }] };

function make({ list = funnels, pages = {}, clock } = {}) {
  const calls = { ghl: 0, fetch: [] };
  const r = createCheckoutLinkResolver({
    ghlGet: async () => { calls.ghl += 1; return list; }, locationId: 'loc',
    fetchPage: async (u) => { calls.fetch.push(u); return pages[u] || null; },
    now: clock || (() => 1000),
  });
  return { r, calls };
}

test('preview addresses are recognised in both GHL forms; others are not', () => {
  assert.equal(previewPageId(`https://crm.gaiahealers.com/v2/preview/${PAGE}?notrack=true`), PAGE);
  assert.equal(previewPageId(`https://sites.leadconnectorhq.com/preview/${PAGE}`), PAGE);
  assert.equal(previewPageId('https://elevate.gaiahealers.com/cart'), null);
  assert.equal(previewPageId('https://exhibitors.gaiahealers.com/check-out-page'), null);
  assert.equal(previewPageId('not a url'), null);
});

test('a verified published page replaces the preview link', async () => {
  const { r, calls } = make({ pages: { 'https://elevate.gaiahealers.com/cart': { status: 200, body: `<html>${PAGE}</html>` } } });
  const out = await r.resolve(`https://crm.gaiahealers.com/v2/preview/${PAGE}?notrack=true`, SRC);
  assert.equal(out, 'https://elevate.gaiahealers.com/cart');
  assert.deepEqual(calls.fetch, ['https://elevate.gaiahealers.com/cart']);
  await r.resolve(`https://crm.gaiahealers.com/v2/preview/${PAGE}?notrack=true`, SRC);
  assert.equal(calls.ghl, 1, 'the funnel list and the answer are cached');
  assert.equal(calls.fetch.length, 1);
});

test('the website link stands when the published page is not that page, missing, or GHL is unreachable', async () => {
  const preview = `https://crm.gaiahealers.com/v2/preview/${PAGE}?notrack=true`;
  const other = make({ pages: { 'https://elevate.gaiahealers.com/cart': { status: 200, body: '<html>another page</html>' } } });
  assert.equal(await other.r.resolve(preview, SRC), preview);
  const gone = make({ pages: { 'https://elevate.gaiahealers.com/cart': { status: 404, body: PAGE } } });
  assert.equal(await gone.r.resolve(preview, SRC), preview);
  const noGhl = make({ list: null });
  assert.equal(await noGhl.r.resolve(preview, SRC), preview);
  const unknownPage = make({ list: { funnels: [] } });
  assert.equal(await unknownPage.r.resolve(preview, SRC), preview);
  const noSource = make({ pages: { 'https://elevate.gaiahealers.com/cart': { status: 200, body: PAGE } } });
  assert.equal(await noSource.r.resolve(preview, ''), preview, 'without the page it came from there is no host to trust');
});

test('a failed check is retried, not remembered', async () => {
  const pages = {};
  const { r } = make({ pages });
  const preview = `https://sites.leadconnectorhq.com/preview/${PAGE}`;
  assert.equal(await r.resolve(preview, SRC), preview);
  pages['https://elevate.gaiahealers.com/cart'] = { status: 200, body: PAGE };
  assert.equal(await r.resolve(preview, SRC), 'https://elevate.gaiahealers.com/cart');
});

test('correctSite rewrites tickets only where needed and keeps the website link', async () => {
  const { r } = make({ pages: { 'https://elevate.gaiahealers.com/cart': { status: 200, body: PAGE } } });
  const site = {
    tickets: [{ title: 'VIP Pass', url: `https://crm.gaiahealers.com/v2/preview/${PAGE}?notrack=true`, source_url: SRC }],
    packages: [{ title: 'The Ambassador', url: 'https://exhibitors.gaiahealers.com/check-out-page', source_url: SRC },
      { title: 'The Legacy Partner', url: null, source_url: SRC }],
    faq: [{ title: 'Q', body: 'A' }], hotel: [], notes: [],
  };
  const out = await r.correctSite(site);
  assert.equal(out.tickets[0].url, 'https://elevate.gaiahealers.com/cart');
  assert.equal(out.tickets[0].site_url, site.tickets[0].url);
  assert.equal(out.packages[0], site.packages[0], 'a published link is left exactly as it is');
  assert.equal(out.packages[1].url, null);
  assert.deepEqual(out.faq, site.faq);
});

test('a slow GHL never holds up the event feed', async () => {
  const r = createCheckoutLinkResolver({ ghlGet: () => new Promise(() => {}), locationId: 'loc', fetchPage: async () => null });
  const site = { tickets: [{ url: `https://sites.leadconnectorhq.com/preview/${PAGE}`, source_url: SRC }] };
  const t0 = Date.now();
  const out = await r.correctSiteWithin(site, 200);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(out, site);
});
