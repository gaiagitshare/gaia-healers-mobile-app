// Loopback verification of the Gaia Healers beta preview. Prints statuses only, never secrets.
'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { chromium } = require('/root/pw-test/node_modules/playwright-core');
const BASE = 'http://127.0.0.1:8800'; const OUT = '/root/audits/beta-screens';
const PW = (/^BETA_PASSWORD=(.*)$/m.exec(fs.readFileSync('/root/.config/gaia-membership-beta.env', 'utf8')) || [])[1];
const ALLOW = new Set(['127.0.0.1', 'localhost', 'fonts.googleapis.com', 'fonts.gstatic.com']);
const WIDTHS = [[1440, 900, 'desktop'], [834, 1112, 'tablet'], [390, 844, 'mobile']];
const results = []; const blocked = new Set(); const pageErrors = [];
const BW = Number(process.env.BASE_W || 1440); const BH = { 1440: 900, 834: 1112, 390: 844 }[BW] || 900; const RIP = process.env.RIP || '198.51.100.20';
const bodies = []; let respCount = 0;
const ok = (name, pass, info = '') => { results.push({ name, pass: !!pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`); };
async function shots(page, name, widths = WIDTHS) {
  for (const [w, h, label] of widths) { await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(OUT, `${name}-${label}-${w}.png`) }); }
  await page.setViewportSize({ width: BW, height: BH });
}
async function bannerCheck(page, where) {
  const r = await page.evaluate(() => {
    const bar = document.getElementById('gaia-beta-bar') || document.querySelector('.bar');
    if (!bar) return { present: false };
    const a = [...bar.querySelectorAll('a')].find((x) => /Back to the current app/.test(x.textContent));
    const cs = getComputedStyle(bar); const rect = bar.getBoundingClientRect();
    // Does the banner sit on top of any of the page's own visible controls?
    const covered = [...document.querySelectorAll('button, a, input, select, [role=button], [role=tab]')].filter((el) => {
      if (bar.contains(el) || el.matches('.gaia-skip-link:not(:focus)')) return false; const b = el.getBoundingClientRect(); if (!b.width || !b.height || b.bottom <= 0) return false;
      const st = getComputedStyle(el); if (st.visibility === 'hidden' || st.display === 'none') return false;
      if (b.top >= rect.bottom) return false;
      const x = Math.min(Math.max(b.left + b.width / 2, 0), innerWidth - 1), y = Math.min(Math.max(b.top + b.height / 2, 0), innerHeight - 1);
      const hit = document.elementFromPoint(x, y); return hit && bar.contains(hit);
    }).map((el) => (el.id || el.className || el.tagName).toString().slice(0, 40));
    return { present: true, text: bar.textContent.replace(/\s+/g, ' ').trim(), href: a && a.getAttribute('href'), tag: a && a.tagName, fg: cs.color, bg: cs.backgroundColor, fixed: cs.position, covered };
  });
  ok(`${where}: banner present`, r.present && /Coming after Elevate 2026/.test(r.text) && /Test data, no real payments/.test(r.text));
  ok(`${where}: back button is a real link to https://gaiahealers.app`, r.tag === 'A' && r.href === 'https://gaiahealers.app');
  if (r.present) ok(`${where}: banner covers no page control`, r.covered.length === 0, r.covered.length ? r.covered.join(',') : `${r.fixed}`);
  return r;
}
function lum(rgb) { const v = rgb.match(/\d+/g).slice(0, 3).map((n) => { n = n / 255; return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1148/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: BW, height: BH }, extraHTTPHeaders: { 'X-Real-IP': RIP } });   // as nginx would set it
  await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); if (!ALLOW.has(u.hostname)) { blocked.add(u.hostname); return r.abort(); } return r.continue(); });
  const page = await ctx.newPage();
  page.on('response', async (r) => { try { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1') return; respCount++;
    const h = JSON.stringify(await r.allHeaders()); const ct = r.headers()['content-type'] || ''; const b = /json|text|javascript|svg/.test(ct) ? await r.text().catch(() => '') : ''; bodies.push(h + b); } catch (e) { /* redirects have no body */ } });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 120)));
  const nonLoopbackRequests = []; page.on('request', (q) => { const h = new URL(q.url()).hostname; if (!['127.0.0.1', 'localhost'].includes(h)) nonLoopbackRequests.push(h); });

  // Landing
  await page.goto(BASE + '/');
  ok('landing: 200 and Membership 2.0 heading', await page.locator('h1', { hasText: 'Gaia Healers Membership 2.0' }).count() === 1);
  const lb = await bannerCheck(page, 'landing');
  ok('landing: banner contrast >= 4.5:1', contrast(lb.fg, lb.bg) >= 4.5, contrast(lb.fg, lb.bg).toFixed(1) + ':1');
  ok('landing: noindex meta', await page.locator('meta[name=robots][content*=noindex]').count() > 0);
  const robots = await page.request.get(BASE + '/robots.txt'); ok('robots.txt disallows all', /Disallow: \/\s*$/m.test(await robots.text()));
  await page.keyboard.press('Tab'); ok('landing: first Tab focuses the banner link', await page.evaluate(() => document.activeElement && /Back to the current app/.test(document.activeElement.textContent)));
  await shots(page, '01-landing');
  // Gate: no cookie
  for (const p of ['/choose', '/app/home.html', '/admin/', '/api/membership2/me', '/api/admin/membership2/status']) { const r = await page.request.get(BASE + p, { maxRedirects: 0 }); ok(`gate: ${p} without beta cookie refused`, [303, 401].includes(r.status()), String(r.status())); }
  // Wrong then right password
  await page.fill('#pw', 'definitely-not-the-password'); await page.click('button[type=submit]');
  ok('gate: wrong password shows an error', await page.locator('.err[role=alert]').count() === 1);
  await shots(page, '02-gate-wrong-password');
  await page.fill('#pw', PW); await page.click('button[type=submit]'); await page.waitForURL(BASE + '/choose');
  ok('gate: right password opens the chooser', await page.locator('h1', { hasText: 'Choose how to look around' }).count() === 1);
  ok('chooser: test-data note visible', await page.getByText('Everything here is test data with fictional people. No real payments are possible.').isVisible());
  const ck = (await ctx.cookies()).find((c) => c.name === 'gaia_beta'); ok('gate: beta cookie HttpOnly + SameSite=Lax, ~12 h', ck && ck.httpOnly && ck.sameSite === 'Lax' && Math.abs(ck.expires - Date.now() / 1000 - 43200) < 120);
  await bannerCheck(page, 'chooser');
  await shots(page, '03-chooser');
  // /api/dev blocked even with the beta cookie
  for (const m of ['GET', 'POST']) { const r = await page.request.fetch(BASE + '/api/dev/fixture-session?fixture=fixture-free', { method: m }); ok(`safety: ${m} /api/dev/fixture-session blocked`, r.status() === 404, String(r.status())); }
  const ast = await page.request.post(BASE + '/api/assist/lookup', { data: { q: 'x' } }); ok('safety: Gaia AI assistant calls blocked', ast.status() === 403, String(ast.status()));

  // Members (fresh beta demo members)
  const EXPECT = {
    free: { id: 'fixture-beta-demo-free', has: [/You don’t have a Gaia Healers Membership 2\.0 plan yet/, /Not open yet/], hasnt: [/Your current membership/] },
    pilot: { id: 'fixture-beta-demo-pilot', has: [/You don’t have a Gaia Healers Membership 2\.0 plan yet/, /Choose Standard/], hasnt: [/Not open yet/] },
    silver: { id: 'fixture-beta-demo-silver', has: [/Gaia Healers Silver membership/, /Your move to Standard \(monthly\)/, /Accept offer/, /Your current plan stays as it is until you choose to move/], hasnt: [/You don’t have/, /Included in your plan/] },
    standard: { id: 'fixture-beta-demo-standard', plan: 'Standard', monthly: '500', has: [/Included in your plan Standard/, /Not in your plan/, /Unlocks with Professional/, /Unlocks with Inner Circle/, /Compare plans to upgrade/], hasnt: [/You don’t have/] },
    professional: { id: 'fixture-beta-demo-professional', plan: 'Professional', monthly: '2,000', has: [/Included in your plan Professional/, /20% off certifications/, /Unlocks with Inner Circle/], hasnt: [/Unlocks with Professional/, /You don’t have/] },
    innercircle: { id: 'fixture-beta-demo-inner-circle', plan: 'Inner Circle', monthly: '4,000', has: [/Included in your plan Inner Circle/, /You have everything Gaia Healers membership includes\./], hasnt: [/Unlocks with/, /Compare plans to upgrade/] },
  };
  async function openMember(key, label) {
    await page.goto(BASE + '/choose');
    await page.getByRole('button', { name: `Look around as the ${label}` }).click();
    await page.waitForURL(/\/app\/home\.html\?view=membership/);
    await page.waitForSelector('.g-m2__sec', { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1500);
  }
  const m2text = async () => ((await page.locator('.g-m2').first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  for (const [key, label, full] of [['free', 'free member', true], ['pilot', 'pilot member', true], ['silver', 'legacy silver member', true], ['standard', 'standard member', true], ['professional', 'professional member', true], ['innercircle', 'inner circle member', true]]) {
    await openMember(key, label);
    const txt = await m2text();
    ok(`member ${key}: Membership screen renders`, (await page.locator('.g-m2__sec').count()) > 0, txt.slice(0, 60));
    const sess = await page.evaluate(async () => { const r = await fetch('/api/auth/session', { credentials: 'include' }); return (await r.json()).member?.contactId || ''; });
    ok(`member ${key}: is the fresh demo member ${EXPECT[key].id}`, sess === EXPECT[key].id, sess);
    const me = await page.evaluate(async () => (await (await fetch('/api/membership2/me', { credentials: 'include' })).json()));
    if (EXPECT[key].plan) ok(`member ${key}: one active ${EXPECT[key].plan} subscription`, (me.membership || []).filter((m) => m.hasAccess).length === 1 && me.membership.find((m) => m.hasAccess).plan_name === EXPECT[key].plan, (me.membership || []).map((m) => m.plan_name + ':' + m.status).join(','));
    else ok(`member ${key}: no Membership 2.0 subscription`, Array.isArray(me.membership) && me.membership.length === 0, String(me.membership?.length));
    if (!EXPECT[key].plan) ok(`member ${key}: pilot list as designed`, (me.availability?.newMembership === true) === (key === 'pilot'), me.availability?.newMembershipReason);
    if (key === 'silver') ok('member silver: one legacy Silver row and an offer in state "offered"', me.legacy?.length === 1 && (me.migrationOffers || []).some((o) => o.status === 'offered'));
    const mon = EXPECT[key].monthly || '100';
    ok(`member ${key}: wallet shows ${mon} monthly + 25 goodwill coins`, new RegExp('MONTHLY ' + mon + ' .*GOODWILL 25').test(txt));
    ok(`member ${key}: screen matches the chooser description`, EXPECT[key].has.every((r) => r.test(txt)) && !EXPECT[key].hasnt.some((r) => r.test(txt)));
    const leak = await page.evaluate(() => document.documentElement.outerHTML.includes('127.0.0.1:8797'));
    ok(`member ${key}: no staging-proxy address left in the page`, !leak);
    await bannerCheck(page, `member ${key}`);
    if (full) await shots(page, '04-member-' + key);
  }

  // Refused member actions render as a calm beta notice (no "Something went wrong", no "Try again"), at 1440 and 390
  async function noticeCheck(name, shot) {
    await page.waitForSelector('[data-m2-notice][data-beta-notice]', { timeout: 5000 }).catch(() => null);
    const n = page.locator('[data-m2-notice]').first();
    const t = ((await n.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    const bad = /Something went wrong|Try again|temporarily unavailable|Billing isn’t connected/i.test(t);
    ok(`member action ${name}: shows "Simulated in the beta preview: no payment or change was made"`, /Simulated in the beta preview: no payment or change was made/.test(t) && !bad, t.slice(0, 110));
    ok(`member action ${name}: says what the button would do after launch`, /After launch, this/.test(t), (t.match(/After launch, this[^.]*/) || [''])[0]);
    await page.waitForTimeout(700); if (shot) await page.screenshot({ path: path.join(OUT, shot) });
    ok(`member action ${name}: no duplicate toast`, !(await page.locator('#gaia-beta-note.on').count()));
    const d = page.locator('[data-m2-dismiss]').first(); if (await d.count()) await d.click();
  }
  for (const [w, h, label] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
    await page.setViewportSize({ width: w, height: h });
    await openMember('pilot', 'pilot member');
    await page.locator('[data-m2-choose]').first().scrollIntoViewIfNeeded(); await page.locator('[data-m2-choose]').first().click();
    await noticeCheck(`checkout monthly (${w})`, `05-member-checkout-simulated-${label}-${w}.png`);
    const annual = page.locator('[data-m2-interval="year"]'); await annual.scrollIntoViewIfNeeded(); await annual.click(); await page.waitForTimeout(300);
    ok(`member pilot: annual switch selects annual prices (${w})`, (await annual.getAttribute('aria-pressed')) === 'true');
    await page.locator('[data-m2-choose]').first().scrollIntoViewIfNeeded(); await page.locator('[data-m2-choose]').first().click();
    await noticeCheck(`checkout annual (${w})`, null);
    await openMember('silver', 'legacy silver member');
    await page.locator('[data-m2-accept]').first().scrollIntoViewIfNeeded(); await page.locator('[data-m2-accept]').first().click();
    await noticeCheck(`migration accept (${w})`, `05-member-migration-simulated-${label}-${w}.png`);
  }
  await page.setViewportSize({ width: BW, height: BH });
  // Plan change, cancel and coin checkout need an existing plan, which the fresh demo members do not have by design.
  // Verified with the older staging fixture that has a Standard plan (session minted test-side; the key is never printed).
  {
    const env = Object.fromEntries(fs.readFileSync('/root/.config/gaia-membership-staging-proxy.env', 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
    const r = await fetch('http://127.0.0.1:8797/api/dev/fixture-session?fixture=fixture-no-membership', { method: 'POST', headers: { 'x-gaia-fixture-key': env.MEMBERSHIP_FIXTURE_KEY } });
    const v = (r.headers.getSetCookie()[0] || '').split(';')[0].split('=').slice(1).join('=');
    for (const [w, h, label] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
      await page.setViewportSize({ width: w, height: h });
      await ctx.addCookies([{ name: 'gaia_member_session', value: v, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
      await page.goto(BASE + '/app/home.html?view=membership'); await page.waitForSelector('[data-m2-change]', { timeout: 15000 }).catch(() => null); await page.waitForTimeout(1200);
      await page.locator('[data-m2-change]').first().scrollIntoViewIfNeeded(); await page.locator('[data-m2-change]').first().click(); await page.waitForTimeout(500);
      await page.locator('[data-m2-change-to]').first().scrollIntoViewIfNeeded(); await page.locator('[data-m2-change-to]').first().click();
      await noticeCheck(`plan change (${w})`, `05-member-plan-change-simulated-${label}-${w}.png`);
      await page.locator('[data-m2-cancel]').first().scrollIntoViewIfNeeded(); await page.locator('[data-m2-cancel]').first().click();
      const yes = page.locator('.g-confirm button', { hasText: 'Cancel membership' }); await yes.waitFor({ timeout: 5000 }).catch(() => null);
      if (await yes.count()) await yes.click(); else { const yb = page.getByRole('button', { name: 'Cancel membership' }).last(); await yb.click(); }
      await noticeCheck(`cancel (${w})`, `05-member-cancel-simulated-${label}-${w}.png`);
      const pack = page.locator('[data-m2-pack]').first();
      if (await pack.count()) { await pack.scrollIntoViewIfNeeded(); await pack.click(); await noticeCheck(`coin checkout (${w})`, `05-member-coins-simulated-${label}-${w}.png`); }
      else { const packs = await page.evaluate(async () => ((await (await fetch('/api/membership2/plans', { credentials: 'include' })).json()).coinPacks || []).length);
        ok(`member action coin checkout (${w}): no Buy coins button because staging has no coin pack on sale`, packs === 0, `${packs} active packs; the API refusal is checked below`); }
    }
    await page.setViewportSize({ width: BW, height: BH });
  }
  // Member writes refused
  for (const [p, body] of [['/api/membership2/checkout', { planKey: 'standard', interval: 'month' }], ['/api/membership2/coins/checkout', { packKey: 'x' }],
    ['/api/membership2/subscriptions/00000000-0000-0000-0000-000000000000/cancel', {}], ['/api/membership2/subscriptions/00000000-0000-0000-0000-000000000000/change', {}],
    ['/api/membership2/subscriptions/00000000-0000-0000-0000-000000000000/change-preview', {}], ['/api/membership2/migration-offers/00000000-0000-0000-0000-000000000000/checkout', {}]]) {
    const r = await page.request.post(BASE + p, { data: body, headers: { origin: BASE } }); const j = await r.json().catch(() => ({}));
    ok(`safety: member POST ${p.replace(/0{8}-0{4}-0{4}-0{4}-0{12}/, ':id')} simulated`, r.status() === 423 && j.code === 'BETA_SIMULATED');
  }

  // Staff
  async function staff(role) {
    await page.goto(BASE + '/choose'); await page.getByRole('button', { name: `Open the Control Center as ${role}` }).click();
    await page.waitForURL(/\/admin\/#membership2/); await page.waitForSelector('.m2-head', { timeout: 20000 }).catch(() => null);
    const head = await page.locator('.m2-head').count(); const who = (await page.locator('.m2-head').textContent().catch(() => '')) || '';
    ok(`staff ${role}: Control Center Membership 2.0 area signed in`, head > 0 && /Demo/i.test(who), who.replace(/\s+/g, ' ').slice(0, 60));
    await bannerCheck(page, `staff ${role}`);
    const fixtureOps = /fixture@example/.test(who); ok(`staff ${role}: a demo operator, not a Phase 3 fixture operator`, !fixtureOps);
  }
  await staff('support'); await shots(page, '06-control-center-support');
  await staff('owner');
  const before = await page.evaluate(async () => (await (await fetch('/api/admin/membership2/launch', { credentials: 'same-origin' })).json()));
  const stage0 = before.effective || before.launch?.effective || JSON.stringify(before).match(/"effective":"([A-Z_]+)"/)?.[1];
  // UI path: Launch screen -> Change stage
  const tab = page.locator('#m2s-launch'); if (await tab.count()) await tab.click();
  await page.waitForTimeout(800); await shots(page, '07-control-center-owner-launch');
  const btn = page.getByRole('button', { name: 'Change stage' });
  if (await btn.count()) {
    await btn.first().click(); await page.waitForSelector('.m2-dlg');
    const sel = page.locator('.m2-dlg select').first(); if (await sel.count()) { const opts = await sel.locator('option').evaluateAll((o) => o.map((x) => x.value)); const other = opts.find((v) => v && v !== stage0); if (other) await sel.selectOption(other); }
    await page.fill('#m2f-reason', 'Beta preview check: this must be refused');
    await page.locator('.m2-dlg button', { hasText: 'Change stage' }).last().click(); await page.waitForTimeout(800);
    const msg = (await page.locator('.m2-dlg__msg').textContent().catch(() => '')) || '';
    const noteTxt = (await page.locator('#gaia-beta-note').textContent()) || '';
    ok('owner: launch stage change in the UI shows "Disabled in the beta preview"', /Disabled in the beta preview: nothing was changed/.test(msg + noteTxt), msg.slice(0, 80));
    await page.screenshot({ path: path.join(OUT, '08-control-center-owner-launch-refused-desktop-1440.png') });
    await page.keyboard.press('Escape');
  } else ok('owner: Change stage button present', false);
  const direct = await page.evaluate(async () => { const r = await fetch('/api/admin/membership2/actions', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch.set', params: { stage: 'PUBLIC' }, reason: 'x', requestId: 'beta-check-1' }) }); return [r.status, (await r.json()).code]; });
  ok('owner: direct launch.set refused', direct[0] === 423 && direct[1] === 'BETA_DISABLED', direct.join(' '));
  const pilot = await page.evaluate(async () => { const r = await fetch('/api/admin/membership2/actions', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pilot.add', params: { personId: 'x' }, reason: 'x', requestId: 'beta-check-2' }) }); return r.status; });
  ok('owner: pilot.add refused', pilot === 423, String(pilot));
  for (const p of ['/api/admin/membership2/login', '/api/admin/membership2/password', '/api/admin/login', '/api/admin/tags']) {
    const s = await page.evaluate(async (p) => (await fetch(p, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })).status, p);
    ok(`safety: browser POST ${p} refused`, s === 423, String(s));
  }
  const after = await page.evaluate(async () => (await (await fetch('/api/admin/membership2/launch', { credentials: 'same-origin' })).json()));
  const stage1 = after.effective || after.launch?.effective || JSON.stringify(after).match(/"effective":"([A-Z_]+)"/)?.[1];
  ok('owner: staging launch stage unchanged', stage0 && stage0 === stage1, `${stage0} -> ${stage1}`);
  // Keyboard focus reaches the banner on the Control Center too
  await page.goto(BASE + '/admin/#membership2'); await page.waitForSelector('.m2-head', { timeout: 15000 }).catch(() => null);
  let reached = false, outline = '';
  for (let i = 0; i < 80 && !reached; i++) { await page.keyboard.press('Tab'); const r = await page.evaluate(() => { const a = document.activeElement; return a && a.closest && a.closest('#gaia-beta-bar') ? getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth : ''; }); if (r) { reached = true; outline = r; } }
  ok('staff: banner links reachable by keyboard with a visible focus ring', reached && /solid 3px/.test(outline), outline);
  await shots(page, '09-control-center-owner-overview');

  ok('isolation: no browser request left loopback except Google Fonts', nonLoopbackRequests.every((h) => /^fonts\.(googleapis|gstatic)\.com$/.test(h)), [...new Set(nonLoopbackRequests)].join(',') || 'none');
  { const readEnv = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
    const sec = []; for (const f of ['/root/.config/gaia-membership-beta.env', '/root/.config/gaia-membership-staging-proxy.env', '/root/.config/gaia-membership-staging-operators.env', '/root/.config/gaia-membership-staging.env'])
      for (const [k, v] of Object.entries(readEnv(f))) { if (v && v.length >= 8 && /SECRET|TOKEN|KEY|PASSWORD|TOTP/.test(k)) sec.push(v); if (/DATABASE_URL/.test(k)) { try { const u = new URL(v); if (u.password) sec.push(decodeURIComponent(u.password)); } catch (e) {} } }
    let hits = 0; for (const b of bodies) for (const v of sec) if (b.includes(v)) hits++;
    ok(`secrets: ${bodies.length} browser responses (headers + text bodies) contain none of ${sec.length} secret values`, hits === 0, `${hits} matches`); }
  console.log('blocked hosts:', [...blocked].join(', ') || 'none'); console.log('page errors:', pageErrors.length, pageErrors.slice(0, 5).join(' | '));
  await browser.close();
  const fails = results.filter((r) => !r.pass).length; console.log(`\n${results.length - fails}/${results.length} checks passed`);
  fs.writeFileSync('/tmp/claude-0/-root/a5da27fe-d923-491d-8e0a-682f4311c849/scratchpad/beta-verify-results.json', JSON.stringify(results, null, 1));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('run error:', String(e.message).slice(0, 300)); process.exit(3); });
