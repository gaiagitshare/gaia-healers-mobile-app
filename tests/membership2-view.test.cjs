/* Membership 2.0 customer view (gaia-membership2.js) — static contracts.
 *
 * The view renders what /api/membership2/* says and decides nothing: no prices,
 * plan names or tier rules in the source; every write carries a requestId; the
 * view and its entry points do not exist unless the feature probe succeeded;
 * customer copy says "Gaia Healers"; and there is no card form anywhere.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const src = read('gaia-membership2.js');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const strings = () => code.match(/'(?:[^'\\\n]|\\.)*'/g) || [];

test('no hard-coded prices, coin amounts or "months free" figures', () => {
  assert.deepEqual(src.match(/\$\s?\d/g) || [], [], 'a currency figure in the source');
  assert.doesNotMatch(code.replace('r.status < 500', ''), /\b(4700|9700|29700|47000|97000|500|2000|4000)\b/, 'a catalogue number in the source');
  assert.doesNotMatch(code, /['"]\d+\s*months? free['"]/i, '"N months free" must be derived from the API prices');
  assert.match(code, /12 \* Number\(prices\.month\)/, 'free months are computed from prices.month and prices.year');
  assert.match(code, /money\(amount\)/, 'prices are formatted from the API amount');
});

test('no tier names or tier logic: plans, labels and benefits come from the API', () => {
  assert.doesNotMatch(code, /\b(silver|gold|diamond|bronze|platinum|standard|professional|inner[_ ]circle)\b/i,
    'a tier name in code (legacy tier names come from legacy[].tier)');
  assert.match(code, /getJson\('\/plans'\)/);
  assert.match(code, /b\.label/, 'benefit labels are the API labels');
  assert.match(code, /p\.monthlyCoins/, 'monthly coins come from the plan');
  assert.match(code, /availability/, 'whether a member may buy is the server\'s availability answer');
  assert.doesNotMatch(code, /rank\s*[<>]=?\s*\d|\.rank\s*[<>]/, 'no upgrade/downgrade decision by rank');
});

test('every write is a JSON POST with credentials and a requestId reused on retry', () => {
  const posts = code.match(/postJson\('[^']+'|postJson\("[^"]+"|postJson\([^,]+,/g) || [];
  assert.ok(posts.length >= 5, 'checkout, coins, cancel-preview, cancel, accept go through postJson');
  assert.equal((code.match(/method: 'POST'/g) || []).length, 1, 'postJson is the only place that POSTs');
  const i = code.indexOf('async function postJson');
  const body = code.slice(i, i + 900);
  assert.match(body, /credentials: 'include'/);
  assert.match(body, /'content-type': 'application\/json'/);
  assert.match(body, /requestId/);
  assert.match(body, /requestIdFor\(action\)/, 'one id per action');
  assert.match(body, /if \(r\.status < 500\) pendingIds\.delete\(action\)/, 'kept for a retry after a network or 5xx failure');
  assert.match(code, /randomUUID/);
  assert.match(code, /replace\(\/\[\^A-Za-z0-9_-\]\/g, ''\)\.slice\(0, 64\)/, 'ids fit the gateway pattern');
  for (const route of ['/checkout', '/coins/checkout', '/cancel-preview', '/cancel', '/accept']) assert.ok(code.includes(route), route);
  assert.match(code, /'\/migration\/' \+ encodeURIComponent\(d\.m2Migrate\) \+ '\/checkout'/);
});

test('hidden unless the feature probe succeeds; production routing falls back to the Store', () => {
  assert.match(code, /state\.available = ok/);
  assert.match(code, /r\.status === 200 && r\.body && r\.body\.ok !== false && Array\.isArray\(r\.body\.plans\)/);
  assert.match(code, /if \(!el \|\| state\.available !== true\) return;/, 'nothing renders before a successful probe');
  const i = code.indexOf('probe().then((ok)');
  const after = code.slice(i, i + 1200);
  assert.ok(after.indexOf('if (!ok)') < after.indexOf('mountEntry('), 'entry points are mounted only after ok');
  assert.match(code, /go\?\.\('store', \{ tab: 'membership', replace: true \}\)/, 'an unavailable view redirects to Store > Membership');
  const ui = read('gaia-ui.js');
  assert.match(ui, /if \(view === 'membership'\) return window\.GaiaMembership2\?\.available\?\.\(\) === true \? 'membership' : 'store';/);
  const html = read('home.html');
  assert.match(html, /<div id="m2-entry-store" hidden><\/div>/);
  assert.match(html, /<div id="m2-entry-you" hidden><\/div>/);
  assert.match(html, /<main class="gaia-main g-page g-m2" id="m2-root" aria-busy="true"><\/main>/, 'the view ships empty');
  assert.ok(html.indexOf('gaia-membership2.js') < html.indexOf('gaia-ui.js'), 'loads before the shell so the boot URL is captured');
});

test('the view is not in the assistant screen map (no prompt tokens added)', () => {
  new Function(read('staging-proxy/assist-guide.js'))();
  assert.ok(!Object.hasOwn(globalThis.GaiaAssistGuide.screens, 'membership'));
  assert.doesNotMatch(globalThis.GaiaAssistGuide.appMap, /membership =/);
  assert.match(read('gaia-ui.js'), /const screen=view==='membership'\?'store':view;/, 'the assistant hears "store" while on it');
});

test('customer copy says "Gaia Healers", never a bare "Gaia"', () => {
  const bare = strings().filter((s) => /\bGaia\b(?! Healers)/.test(s) && !/^'(gaia|Gaia)[A-Za-z]*'$/.test(s));
  assert.deepEqual(bare, []);
  assert.match(code, /Contact Gaia Healers Support/);
  assert.match(code, /'https:\/\/gaiahealers\.com\/pages\/contact-us'/, 'the app\'s existing support link');
  const html = read('home.html');
  const sec = html.slice(html.indexOf('data-screen="membership"'), html.indexOf('</section>', html.indexOf('data-screen="membership"')));
  assert.match(sec, /aria-label="Gaia Healers Membership"/);
});

test('no card-entry fields; payment details stay with Stripe', () => {
  assert.doesNotMatch(src, /<input|<form|cardNumber|card-number|\bcvc\b|\bcvv\b|autocomplete="cc-/i);
  assert.match(code, /managed securely by Stripe/);
  assert.match(code, /u\.protocol !== 'https:'/, 'only an https checkout URL from the API is followed');
});

test('every server answer has plain-language copy', () => {
  for (const s of ['migration_required', 'review_required', 'change_plan_required', 'already_subscribed', 'not_available',
    'PROVIDER_UNAVAILABLE', 'pilot_only', 'legacy_member_use_migration', 'existing_customer', 'coins_need_membership2', 'no_subscription']) {
    assert.ok(code.includes(`'${s}'`), s);
  }
  assert.match(code, /Not open yet/);
  assert.match(code, /Billing isn’t connected in this environment|Billing isn\\u2019t connected in this environment/);
  assert.match(code, /Coin packs are coming soon/);
  assert.doesNotMatch(code, /\/change-plan/, 'only the gateway\'s plan-change routes');
  for (const st of ['change_pending', 'not_changeable', 'preview_expired', 'no_pending_change', 'not_cancellable', 'SERVICE_UNAVAILABLE']) assert.ok(code.includes(`'${st}'`), st);
  assert.match(code, /Membership is temporarily unavailable/, 'an outage has its own copy, not the billing one');
  const i = code.indexOf("if (b.code === 'SERVICE_UNAVAILABLE')");
  assert.ok(i > 0 && i < code.indexOf("if (b.code === 'PROVIDER_UNAVAILABLE')"));
});

test('plan change: the server decides; preview in plain words, then confirm; pending change banner with "Keep my current plan"', () => {
  const i = code.indexOf('async function changePlanTo');
  const body = code.slice(i, code.indexOf('async function keepCurrentPlan'));
  assert.ok(i > 0);
  assert.ok(body.indexOf("'/change-preview'") < body.indexOf("'/change',"), 'preview first, then the change');
  assert.match(body, /p\.timing === 'after_payment'/, 'timing comes from the preview answer');
  assert.match(body, /You’ll be charged ' \+ money\(p\.amountDueNowCents, p\.currency\) \+ ' today and get ' \+ toName \+ ' right after payment/);
  assert.match(body, /Your plan changes to ' \+ toLabel \+ ' on ' \+ date\(p\.effectiveAt\) \+ '; you keep ' \+ fromName \+ ' until then/);
  assert.match(body, /GaiaNotice\.confirm\(ask/);
  assert.match(body, /prorationDate: p\.prorationDate/, 'the charged amount is the previewed one');
  assert.match(body, /if \(!yes\) \{ pendingIds\.delete\(action\)/);
  for (const o of ["'scheduled'", "'payment_required'"]) assert.ok(body.includes(o), o);
  assert.match(code, /'\/change\/cancel'/);
  assert.match(code, /Keep my current plan/);
  assert.match(code, /Plan change scheduled/);
  assert.match(code, /Payment required/);
  assert.match(code, /c\.paymentUrl && \/\^https:/, 'only an https payment link is shown');
  assert.match(code, /live\.source === 'legacy_import'/, 'imported legacy subscriptions get no change buttons');
  assert.doesNotMatch(body, /\.rank|amountDueNowCents\s*[<>]/, 'no upgrade/downgrade decision in the view');
});

test('wallet shows goodwill as its own never-expiring line and the spend order from the API', () => {
  assert.match(code, /w\.goodwill \? tile\('Goodwill', w\.goodwill\)/);
  assert.match(code, /They never expire/);
  assert.match(code, /w\.spendOrder\.map/);
});

test('staging / test-mode banner: from /plans environment + stripeMode; nothing for production with live Stripe', () => {
  assert.match(code, /state\.env = typeof r\.body\.environment === 'string'/);
  assert.match(code, /e\.environment === 'production' && e\.stripeMode === 'live'\)\) return ''/);
  assert.match(code, /STAGING \/ TEST MODE/);
  assert.match(code, /envBannerHtml\(\) \+ '<div class="g-page__head">/);
});

test('legacy members never get a buy button; return states toast and refresh', () => {
  assert.match(code, /if \(legacyLive\(\)\.length\) return '<p class="g-m2__plan-state">Your account team can move you<\/p>';/);
  assert.match(code, /Billed through your existing plan/);
  for (const s of ['done', 'cancelled', 'coins', 'migrated']) assert.match(code, new RegExp(`\\b${s}: \\{ tone`));
  assert.match(code, /GaiaNotice\?\.toast\?\./);
});

test('accessibility basics: live region, labelled sections, focusable notice, pressed toggle', () => {
  assert.match(code, /role="status" aria-live="polite"/);
  assert.match(code, /aria-labelledby="m2-h-/);
  assert.match(code, /data-m2-notice tabindex="-1"/);
  assert.match(code, /aria-pressed="/);
  assert.match(code, /GaiaNotice\.confirm\(ask, \{ detail/, 'cancellation confirms with the exact access-end date');
  assert.match(read('gaia-membership2.css'), /:focus-visible/);
});
