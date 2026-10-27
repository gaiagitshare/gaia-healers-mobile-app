// Gaia Healers beta preview: "fictional data only" audit. Run with the staging env loaded:
//   set -a; . /root/.config/gaia-membership-staging.env; set +a; node beta-data-audit.mjs <results.md>
// 1. Recaptures every Control Center Membership 2.0 read endpoint and every Control Center screen as each demo operator,
//    and the member app (Membership, Home, Today, Shop, You) as each demo member, through http://127.0.0.1:8800.
// 2. Asserts that none of the real legacy contact ids, price ids, subscription ids or non-demo emails appear anywhere.
// 3. Recomputes every aggregate from the staging DB restricted to demo people and compares it with what the beta shows.
// Prints statuses and counts only (never secrets, never the real ids themselves).
import fs from 'node:fs'; import http from 'node:http'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/root/pw-test/node_modules/playwright-core');
const OUT = process.argv[2] || '/dev/stdout';
const BASE = 'http://127.0.0.1:8800'; const IP = '198.51.100.90';
const SRC = '/root/gaia-membership-staging-src/membership-service/src';
const { createPool } = await import(`${SRC}/db.js`);
const { legacyBlock } = await import(`${SRC}/billing-guard.js`);
const env = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const PW = env('/root/.config/gaia-membership-beta.env').BETA_PASSWORD;
const rows = []; const rec = (area, what, expected, got, pass) => { rows.push([area, what, expected, got, !!pass]); console.log(`${pass ? 'PASS' : 'FAIL'}  ${area} | ${what} | ${got}`); };
const pool = createPool(process.env.MEMBERSHIP_DATABASE_URL, { max: 2 });
const q = async (s, a) => (await pool.query(s, a)).rows;

// ---------- the real values that must never appear ----------
const realLegacy = await q("SELECT external_contact_id c, external_price_id p, external_subscription_id s FROM membership.legacy_memberships WHERE coalesce(external_contact_id,'') NOT LIKE 'fixture-%'");
const REAL = [...new Set(realLegacy.flatMap((r) => [r.c, r.p, r.s]).filter((x) => x && x.length >= 6))];
const DEMO_EMAIL = /@([a-z0-9-]+\.)*(invalid)$/i;
const COMPANY = /@(gaiahealers\.(com|app)|gaiapractitioners\.com)$/i;   // the company's own contact addresses, not customer data
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Placeholder addresses written into the app's own source (form hints such as an example address): not customer data.
const PLACEHOLDERS = new Set(fs.readdirSync('/root/gaia-membership-staging-app/web').filter((f) => /\.(js|html)$/.test(f))
  .flatMap((f) => fs.readFileSync('/root/gaia-membership-staging-app/web/' + f, 'utf8').match(EMAIL) || []));
function scan(text) {
  const realHits = REAL.filter((v) => text.includes(v)).length;
  const emails = text.match(EMAIL) || [];
  const cust = emails.filter((e) => !DEMO_EMAIL.test(e) && !COMPANY.test(e) && !PLACEHOLDERS.has(e));
  if (cust.length && process.env.SHOW_DOMAINS) console.log('  non-demo email domains:', [...new Set(cust.map((e) => e.split('@')[1] + ' (' + (e.split('@')[0].length) + '-char local part)'))].join(', '));
  return { realHits, customerEmails: cust.length, companyEmails: emails.filter((e) => COMPANY.test(e)).length, placeholders: emails.filter((e) => PLACEHOLDERS.has(e)).length };
}

// ---------- expected aggregates from demo people only (staging DB) ----------
const demoIds = (await q(`SELECT p.id FROM membership.persons p WHERE EXISTS (SELECT 1 FROM membership.person_identities i WHERE i.person_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM membership.person_identities i WHERE i.person_id = p.id AND NOT (i.external_id LIKE 'fixture-%' OR i.external_id LIKE '%.invalid'))`)).map((r) => r.id);
const E = {};
E.members = (await q(`SELECT pl.key plan, s.status, count(*)::int n FROM membership.subscriptions s JOIN membership.plan_versions v ON v.id = s.plan_version_id JOIN membership.plans pl ON pl.id = v.plan_id
  WHERE pl.owner_type = 'gaia' AND s.person_id = ANY($1) GROUP BY 1,2 ORDER BY 1,2`, [demoIds]));
E.mrrCents = Number((await q(`SELECT COALESCE(sum(CASE s.billing_interval WHEN 'month' THEN pr.amount_cents WHEN 'year' THEN pr.amount_cents / 12.0 ELSE 0 END),0)::bigint c
  FROM membership.subscriptions s JOIN membership.plan_versions v ON v.id = s.plan_version_id JOIN membership.plans pl ON pl.id = v.plan_id
  JOIN membership.plan_version_prices pr ON pr.plan_version_id = v.id AND pr.billing_interval = s.billing_interval
  WHERE pl.owner_type = 'gaia' AND s.provider IN ('stripe','manual') AND s.source <> 'legacy_import' AND s.status IN ('active','past_due') AND s.person_id = ANY($1)`, [demoIds]))[0].c);
const wal = (await q(`SELECT count(*)::int wallets, COALESCE(sum(granted_balance),0)::int granted, COALESCE(sum(goodwill_balance),0)::int goodwill, COALESCE(sum(purchased_balance),0)::int purchased,
  COALESCE(sum(legacy_balance),0)::int legacy FROM membership.coin_wallets WHERE person_id = ANY($1)`, [demoIds]))[0];
E.coinsOutstanding = wal.granted + wal.goodwill + wal.purchased + wal.legacy; E.wallets = wal;
E.pendingRequests = (await q(`SELECT count(*)::int n FROM membership.admin_action_requests WHERE status = 'pending' AND (params->>'personId' IS NULL OR (params->>'personId')::text = ANY($1::text[]))`, [demoIds.map(String)]))[0].n;
E.openRefundReviews = (await q(`SELECT count(*)::int n FROM membership.coin_refund_reviews WHERE status = 'open' AND person_id = ANY($1)`, [demoIds]))[0].n;
const demoLegacy = await q("SELECT * FROM membership.legacy_memberships WHERE external_contact_id LIKE 'fixture-%'");
E.legacyByState = demoLegacy.reduce((a, r) => { const b = legacyBlock(r); const s = !b ? 'ended' : b.kind === 'migration_required' ? 'active' : 'under_review'; a[s] = (a[s] || 0) + 1; return a; }, {});
E.legacyTotal = demoLegacy.length;
E.lastSeen = demoLegacy.map((r) => r.last_seen_at).sort((a, b) => a - b).pop();
const sortKV = (o) => JSON.stringify(Object.fromEntries(Object.entries(o || {}).sort()));
const sortM = (a) => JSON.stringify((a || []).map((x) => [x.plan, x.status, x.n]).sort());

// ---------- raw HTTP helper ----------
function get(path, cookie, method = 'GET', body = null, extra = {}) {
  return new Promise((resolve) => {
    const h = { host: '127.0.0.1:8800', 'x-real-ip': IP, origin: BASE, ...(cookie ? { cookie } : {}), ...extra };
    if (body) { h['content-type'] = 'application/x-www-form-urlencoded'; h['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ host: '127.0.0.1', port: 8800, method, path, headers: h }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') })); });
    r.on('error', () => resolve({ status: 0, headers: {}, text: '' })); r.end(body);
  });
}
const jar = (r, base = {}) => { const o = { ...base }; for (const c of [].concat(r.headers['set-cookie'] || [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) o[k] = v; else delete o[k]; } return o; };
const ck = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('; ');
const login = await get('/login', null, 'POST', 'password=' + encodeURIComponent(PW));
const beta = jar(login);
rec('setup', 'beta sign-in', '303', String(login.status), login.status === 303 && beta.gaia_beta);

// ---------- 1. APIs as each demo operator ----------
const READS = ['status', 'me', 'overview', 'persons', 'persons?q=fixture', 'persons?q=', 'plans', 'payments', 'coins', 'legacy', 'legacy?state=active', 'legacy?state=under_review', 'legacy?state=ended',
  'migration-offers', 'reconciliation', 'refund-reviews', 'refund-reviews?status=all', 'dead-letters', 'audit', 'audit?limit=200', 'health', 'launch', 'requests', 'requests?status=pending'];
let totalApi = 0;
for (const role of ['support', 'finance', 'owner']) {
  const e = await get(`/enter/staff/${role}`, ck(beta), 'POST');
  const c = jar(e, beta);
  rec(`api ${role}`, `sign in as Demo ${role}`, '303 to /admin/', `${e.status} ${e.headers.location || ''}`, e.status === 303 && /\/admin\//.test(e.headers.location || ''));
  const paths = [...READS, ...demoIds.map((id) => `persons/${id}`), 'persons/00000000-0000-4000-8000-000000000001'];
  let real = 0, cust = 0, ok200 = 0, forb = 0;
  const bodies = {};
  for (const p of paths) {
    const r = await get('/api/admin/membership2/' + p, ck(c)); totalApi++;
    const s = scan(r.text + JSON.stringify(r.headers)); real += s.realHits; cust += s.customerEmails; if (r.status === 200) ok200++; if (r.status === 403) forb++;
    try { bodies[p] = JSON.parse(r.text); } catch { bodies[p] = {}; }
  }
  rec(`api ${role}`, `${paths.length} Membership 2.0 reads (every read endpoint, filters, each demo person, one unknown id)`, `0 real ids (of ${REAL.length}), 0 customer emails`,
    `${ok200} × 200, ${forb} × 403 (role), ${real} real-id hits, ${cust} customer emails`, real === 0 && cust === 0);
  const unknown = bodies['persons/00000000-0000-4000-8000-000000000001'];
  rec(`api ${role}`, 'person detail for a non-demo id', 'refused', unknown?.code || unknown?.ok, unknown?.ok === false);
  const o = bodies.overview;
  if (o && o.ok !== false && o.members) {
    rec(`aggregate ${role}`, 'overview.members (by plan and status)', sortM(E.members), sortM(o.members), sortM(o.members) === sortM(E.members));
    rec(`aggregate ${role}`, 'overview.mrrCents', String(E.mrrCents), String(o.mrrCents), Number(o.mrrCents) === E.mrrCents);
    rec(`aggregate ${role}`, 'overview.coinsOutstanding', String(E.coinsOutstanding), String(o.coinsOutstanding), Number(o.coinsOutstanding) === E.coinsOutstanding);
    rec(`aggregate ${role}`, 'overview.pendingRequests', String(E.pendingRequests), String(o.pendingRequests), Number(o.pendingRequests) === E.pendingRequests);
    rec(`aggregate ${role}`, 'overview.openRefundReviews', String(E.openRefundReviews), String(o.openRefundReviews), Number(o.openRefundReviews) === E.openRefundReviews);
    rec(`aggregate ${role}`, 'overview.legacyByState', sortKV(E.legacyByState), sortKV(o.legacyByState), sortKV(o.legacyByState) === sortKV(E.legacyByState));
    rec(`aggregate ${role}`, 'overview.openAlerts and lastReconciliation', 'blanked (Demo data only)', `${o.openAlerts} / ${JSON.stringify(o.lastReconciliation)}`, o.openAlerts == null && /Demo data only/.test(JSON.stringify(o.lastReconciliation)));
  } else rec(`aggregate ${role}`, 'overview', 'demo aggregates, or 403 for this role', `status ${o?.code || o?.ok}`, o?.ok === false);
  const l = bodies.legacy;
  if (l && Array.isArray(l.items)) {
    rec(`aggregate ${role}`, 'legacy.total and rows', `${E.legacyTotal} demo rows`, `${l.total} / ${l.items.length}`, l.total === E.legacyTotal && l.items.length === E.legacyTotal && l.items.every((x) => /^fixture-/.test(x.external_contact_id || '')));
    rec(`aggregate ${role}`, 'legacy.freshness', `lastSeenAt = demo max; lastRun blanked`, `${l.freshness?.lastSeenAt === (E.lastSeen && E.lastSeen.toISOString()) ? 'demo max' : 'OTHER'} / lastRun ${l.freshness?.lastRun}`,
      l.freshness?.lastSeenAt === (E.lastSeen && E.lastSeen.toISOString()) && l.freshness?.lastRun == null);
  }
  const cn = bodies.coins;
  if (cn && cn.totals) rec(`aggregate ${role}`, 'coins.totals (wallets, granted, goodwill, purchased, legacy)', sortKV(E.wallets), sortKV(cn.totals), sortKV(cn.totals) === sortKV(E.wallets));
  const hl = bodies.health;
  if (hl && hl.ok !== false) rec(`aggregate ${role}`, 'health counters', 'webhook backlog and held coins blanked; mirror age from demo rows', `${hl.webhookBacklog} / ${hl.heldCoinOperations} / age ${hl.legacyMirrorAgeSeconds}`,
    hl.webhookBacklog === 'Demo data only' && hl.heldCoinOperations === 'Demo data only' && Math.abs(hl.legacyMirrorAgeSeconds - Math.round((Date.now() - E.lastSeen) / 1000)) < 300);
  const rc = bodies.reconciliation; if (rc && rc.ok !== false) rec(`aggregate ${role}`, 'reconciliation runs and alerts', 'blanked', `${rc.runs?.length} runs, ${rc.openAlerts?.length} alerts`, rc.runs?.length === 0 && rc.openAlerts?.length === 0);
  const dl = bodies['dead-letters']; if (dl && dl.ok !== false) rec(`aggregate ${role}`, 'dead letters', 'webhooks blanked; GHL rows demo only', `${dl.webhooks?.length} webhooks, ${dl.ghl?.length} ghl`, dl.webhooks?.length === 0);
  const au = bodies['audit?limit=200']; if (au && Array.isArray(au.items)) {
    const bad = au.items.filter((a) => !(/^operator:[0-9a-f-]{36}$|^beta-demo-setup$|^cli:beta-setup$|^beta-setup$/.test(a.actor_id || '') || (/^person:/.test(a.actor_id || '') && demoIds.includes(String(a.actor_id).slice(7))) || demoIds.includes(String(a.entity_id || ''))));
    rec(`aggregate ${role}`, 'audit rows', 'only demo actors / demo people', `${au.items.length} rows, ${bad.length} non-demo`, bad.length === 0);
  }
  const la = bodies.launch; if (la && Array.isArray(la.pilots)) rec(`aggregate ${role}`, 'launch.pilots', 'demo people only', `${la.pilots.length} pilots`, la.pilots.every((p) => demoIds.includes(p.person_id)));
}

// ---------- 2. pages ----------
const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1148/chrome-linux/chrome' });
async function context() {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'X-Real-IP': IP } });
  await c.route('**/*', (r) => { const h = new URL(r.request().url()).hostname; return ['127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(h) ? r.continue() : r.abort(); });
  const p = await c.newPage(); const texts = []; let errors = 0;
  p.on('pageerror', () => { errors++; });
  p.on('response', async (r) => { try { if (new URL(r.url()).hostname !== '127.0.0.1') return; const ct = r.headers()['content-type'] || ''; if (/json|text|javascript/.test(ct)) texts.push(await r.text()); } catch { /* none */ } });
  await p.goto(BASE + '/'); await p.fill('#pw', PW); await p.click('button[type=submit]'); await p.waitForURL(/choose/);
  return { c, p, texts, errs: () => errors };
}
for (const [key, label] of [['free', 'free member'], ['pilot', 'pilot member'], ['silver', 'legacy silver member'], ['standard', 'standard member'], ['professional', 'professional member'], ['inner-circle', 'inner circle member']]) {
  const { c, p, texts, errs } = await context();
  await p.getByRole('button', { name: `Look around as the ${label}` }).click(); await p.waitForSelector('.g-m2__sec', { timeout: 15000 }).catch(() => null); await p.waitForTimeout(1200);
  let all = await p.content() + await p.locator('body').innerText();
  for (const v of ['home', 'today', 'energy', 'academy', 'community', 'store', 'profile']) { await p.goto(`${BASE}/app/home.html?view=${v}`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(2500); all += await p.content() + await p.locator('body').innerText(); }
  const s = scan(all + texts.join('\n'));
  const who = await p.evaluate(async () => (await (await fetch('/api/auth/session', { credentials: 'include' })).json()).member?.contactId || '');
  rec(`pages member ${key}`, 'Membership, Home, Today, Energy, Academy, Community, Shop, You (page text, HTML and every API response behind them)', '0 real ids, 0 customer emails; signed in as the demo member',
    `${who}; ${texts.length} responses; ${s.realHits} real-id hits; ${s.customerEmails} customer emails; ${s.companyEmails} company contact addresses; ${s.placeholders} placeholder addresses from the app's own source (${PLACEHOLDERS.size} distinct); ${errs()} page errors`, s.realHits === 0 && s.customerEmails === 0 && who === `fixture-beta-demo-${key}`);
  await c.close();
}
for (const role of ['support', 'finance', 'owner']) {
  const { c, p, texts } = await context();
  await p.getByRole('button', { name: `Open the Control Center as ${role}` }).click(); await p.waitForSelector('.m2-head', { timeout: 20000 }).catch(() => null);
  let all = ''; let screens = 0;
  for (const scr of ['overview', 'members', 'payments', 'coins', 'legacy', 'requests', 'reconciliation', 'audit', 'health', 'launch']) {
    const t = p.locator('#m2s-' + scr); if (!(await t.count())) continue;
    await t.click(); await p.waitForTimeout(1300); screens++;
    if (scr === 'members') { await p.fill('#m2q', 'fixture'); await p.click('form.m2-searchbar button'); await p.waitForTimeout(1200); }
    all += await p.content() + await p.locator('body').innerText();
    if (role === 'owner' && ['overview', 'legacy', 'coins', 'health'].includes(scr)) await p.screenshot({ path: `/root/audits/beta-screens/11-demo-only-${scr}-desktop-1440.png` });
  }
  const s = scan(all + texts.join('\n'));
  const label = /Demo data only/.test(all);
  rec(`pages staff ${role}`, `${screens} Control Center Membership 2.0 screens (text, HTML, API responses)`, '0 real ids, 0 customer emails; "Demo data only" shown', `${s.realHits} real-id hits; ${s.customerEmails} customer emails; label ${label ? 'shown' : 'missing'}`,
    s.realHits === 0 && s.customerEmails === 0 && label);
  if (role === 'owner') {
    await p.locator('#m2s-overview').click(); await p.waitForTimeout(1200);
    const alerts = await p.evaluate(() => [...document.querySelectorAll('.m2-stat')].map((x) => x.innerText.replace(/\s+/g, ' ')).join(' | '));
    rec('pages staff owner', 'Overview stat tiles', '"Open alerts" shows Demo data only; others are demo-derived numbers', alerts.slice(0, 200), /Demo data only Open alerts/i.test(alerts));
  }
  await c.close();
}
await browser.close(); await pool.end();
const pass = rows.filter((r) => r[4]).length; console.log(`\n${pass}/${rows.length} data-audit checks passed (${totalApi} API reads)`);
const esc = (s) => String(s).replace(/\|/g, '\\|');
fs.writeFileSync(OUT, ['| # | Area | Check | Expected (from demo rows only) | Result | Status |', '|---|---|---|---|---|---|', ...rows.map((r, i) => `| ${i + 1} | ${esc(r[0])} | ${esc(r[1])} | ${esc(r[2])} | ${esc(r[3])} | ${r[4] ? 'PASS' : 'FAIL'} |`)].join('\n') + '\n');
process.exit(pass === rows.length ? 0 : 1);
