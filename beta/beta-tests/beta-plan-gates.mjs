// Gaia Healers beta preview: per-tier app access matrix. Run with the staging env loaded:
//   set -a; . /root/.config/gaia-membership-staging.env; set +a; node beta-plan-gates.mjs <matrix.md> [shots-dir]
// For each demo member (Free, Standard, Professional, Inner Circle) at 1440 and 390, every mapped gate in the app is read
// from the rendered screens and compared with the plan's catalog entitlements, computed independently from the staging DB
// (plan_version_entitlements of the member's subscription, or the no-payment plan without one). Prints statuses only.
import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/root/pw-test/node_modules/playwright-core');
const OUT = process.argv[2] || '/dev/stdout'; const SHOTS = process.argv[3] || null;
const BASE = 'http://127.0.0.1:8800';
const SRC = '/root/gaia-membership-staging-src/membership-service/src';
const { createPool } = await import(`${SRC}/db.js`);
const PW = (/^BETA_PASSWORD=(.*)$/m.exec(fs.readFileSync('/root/.config/gaia-membership-beta.env', 'utf8')) || [])[1];
const pool = createPool(process.env.MEMBERSHIP_DATABASE_URL, { max: 2 });
const q = async (s, a) => (await pool.query(s, a)).rows;

// ---------- catalog from the DB (independent of the beta server) ----------
const plans = await q(`SELECT p.key, p.name, p.rank, v.id vid FROM membership.plans p JOIN LATERAL (SELECT * FROM membership.plan_versions WHERE plan_id = p.id AND status = 'published' AND NOT is_legacy ORDER BY version DESC LIMIT 1) v ON true
  WHERE p.owner_type = 'gaia' AND p.status = 'active' ORDER BY p.rank`);
for (const p of plans) p.ents = Object.fromEntries((await q(`SELECT e.entitlement_key k, e.value v FROM membership.plan_version_entitlements e WHERE e.plan_version_id = $1 AND e.value <> 'false'::jsonb`, [p.vid])).map((r) => [r.k, r.v]));
const label = Object.fromEntries((await q('SELECT key, description FROM membership.entitlement_definitions WHERE owner_practitioner_id IS NULL')).map((r) => [r.key, r.description]));
const lowest = {}; for (const p of plans) for (const k of Object.keys(p.ents)) if (!(k in lowest)) lowest[k] = p.name;
async function expected(contact) {
  const r = (await q(`SELECT pl.key FROM membership.person_identities i JOIN membership.subscriptions s ON s.person_id = i.person_id JOIN membership.plan_versions v ON v.id = s.plan_version_id
    JOIN membership.plans pl ON pl.id = v.plan_id WHERE i.platform = 'ghl' AND i.external_id = $1 AND s.status IN ('active','trialing','past_due') LIMIT 1`, [contact]))[0];
  const at = r ? plans.findIndex((p) => p.key === r.key) : 0;
  return { plan: plans[at], at, hasPlan: Boolean(r), keys: new Set(Object.keys(plans[at].ents)), next: plans[at + 1] || null };
}

const rows = [];   // [tier, width, gate, expected, got, pass]
const rec = (tier, w, gate, exp, got, pass) => { rows.push([tier, w, gate, exp, got, !!pass]); if (!pass) console.log(`FAIL ${tier} ${w} ${gate} | expected ${exp} | got ${got}`); };
const browser = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1148/chrome-linux/chrome' });
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const TIERS_ALL = [['free', 'Free member', 'fixture-beta-demo-free'], ['standard', 'Standard member', 'fixture-beta-demo-standard'],
  ['professional', 'Professional member', 'fixture-beta-demo-professional'], ['innercircle', 'Inner Circle member', 'fixture-beta-demo-inner-circle']];
const TIERS = TIERS_ALL.filter((t) => !ONLY || ONLY.includes(t[0]));
let ipn = 120;
for (const [w, h, label2] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
  for (const [tier, title, contact] of TIERS) {
    const E = await expected(contact);
    const c = await browser.newContext({ viewport: { width: w, height: h }, extraHTTPHeaders: { 'X-Real-IP': `198.51.100.${ipn++}` } });
    let left = 0; const leftHosts = new Set();
    await c.route('**/*', (r) => { const host = new URL(r.request().url()).hostname; if (['127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(host)) return r.continue(); left++; leftHosts.add(host); return r.abort(); });
    const p = await c.newPage(); let errors = 0; const errMsgs = []; p.on('pageerror', (e) => { errors++; errMsgs.push(String(e.message).slice(0, 120)); });
    await p.goto(BASE + '/'); await p.fill('#pw', PW); await p.click('button[type=submit]'); await p.waitForURL(/choose/);
    await p.getByRole('button', { name: `Look around as the ${title.toLowerCase()}` }).click();
    await p.waitForSelector('.g-m2__access', { timeout: 20000 }).catch(() => null); await p.waitForTimeout(1200);
    const T = (s) => s.replace(/\s+/g, ' ').trim();
    const name = E.plan.name;

    // G1 Membership 2.0 panel
    const inc = await p.$$eval('.g-m2__acc--in .g-m2__acc-item > span', (a) => a.map((x) => x.childNodes[0] ? x.childNodes[0].textContent.trim() : x.textContent.trim()));
    const incWant = Object.entries(E.plan.ents).map(([k, v]) => (typeof v === 'number' && /^percent off /i.test(label[k]) ? `${v}% off ${label[k].replace(/^percent off /i, '')}` : label[k]));
    const coinsLine = inc.filter((x) => /coins every month/.test(x));
    const incGot = inc.filter((x) => !/coins every month/.test(x));
    rec(tier, w, 'Membership: "Included in your plan" = catalog', `${incWant.length} benefits`, `${incGot.length}`, incGot.length === incWant.length && incWant.every((x) => incGot.includes(x)));
    const lockedGot = await p.$$eval('.g-m2__acc-item.is-locked', (a) => a.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
    const lockedWant = E.next ? [...new Set(plans.slice(E.at + 1).flatMap((pp) => Object.keys(pp.ents)))].filter((k) => !E.keys.has(k)) : [];
    rec(tier, w, 'Membership: "Not in your plan", each "Unlocks with <lowest tier>"', `${lockedWant.length} locked`, `${lockedGot.length}`,
      lockedGot.length === lockedWant.length && lockedWant.every((k) => lockedGot.some((t) => t.startsWith(label[k]) && t.endsWith('Unlocks with ' + lowest[k]))));
    if (!E.next) rec(tier, w, 'Membership: top tier message', 'You have everything Gaia Healers membership includes.', (await p.locator('.g-m2__acc-done').count()) ? 'shown' : 'missing', (await p.locator('.g-m2__acc-done').count()) === 1);
    const coins = Number((plans[E.at] && (await q('SELECT monthly_coin_grant c FROM membership.plan_versions WHERE id = $1', [E.plan.vid]))[0].c) || 0);
    rec(tier, w, 'Membership: monthly coins', coins ? `${coins.toLocaleString('en-US')} coins every month` : 'none', coinsLine[0] || 'none', coins ? (coinsLine[0] || '').startsWith(coins.toLocaleString('en-US') + ' coins every month') : !coinsLine.length);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/12-tier-${tier}-membership-${label2}-${w}.png` });

    // G2-G4 You: Member Pass, My Access, Next Level
    await p.goto(BASE + '/app/home.html?view=profile', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2600);
    const you = T(await p.locator('[data-screen="profile"]').innerText().catch(() => ''));
    const passOk = E.hasPlan ? (await p.locator('.g-pass__title').first().innerText().catch(() => '')).trim() === name : /You are on the free plan/.test(you);
    rec(tier, w, 'You: Member Pass', E.hasPlan ? name : 'You are on the free plan', (await p.locator('.g-pass__title').first().innerText().catch(() => '?')).trim(), passOk);
    const nCourses = [...E.keys].filter((k) => /^(courses|certification)\./.test(k)).length; const nSoft = [...E.keys].filter((k) => /^software\./.test(k)).length;
    const access = await p.evaluate(async () => (await (await fetch('/api/member/access', { credentials: 'include' })).json()));
    const ofType = (t) => (access.entitlements || []).filter((e) => e.type === t && e.status === 'active');
    rec(tier, w, 'You › My Access: Courses (courses.* + certification.*)', String(nCourses), String(ofType('course_access').length), ofType('course_access').length === nCourses);
    rec(tier, w, 'You › My Access: Software (software.*)', String(nSoft), String(ofType('device_software').length), ofType('device_software').length === nSoft);
    const dir = E.keys.has('listing.featured') ? 'Level 1' : E.keys.has('listing.directory') ? 'Level 3' : 'Not listed';
    rec(tier, w, 'You › My Access: Directory (listing.directory / listing.featured)', dir, ofType('directory_level').map((e) => 'Level ' + e.value.level).join(',') || 'Not listed', (ofType('directory_level').map((e) => 'Level ' + e.value.level)[0] || 'Not listed') === dir);
    rec(tier, w, 'You › My Access: Practice / CRM (crm.ghl_subaccount)', E.keys.has('crm.ghl_subaccount') ? 'Full GHL subaccount' : 'none', ofType('crm_access').map((e) => e.value.level).join(',') || 'none', (ofType('crm_access').length === 1) === E.keys.has('crm.ghl_subaccount'));
    const pct = E.plan.ents['discount.certifications_pct'];
    rec(tier, w, 'You › My Access: Discounts (discount.certifications_pct)', pct ? `${pct}% off certifications` : 'none', ofType('discount').map((e) => `${e.value.percent}% ${e.value.scope}`).join(',') || 'none', pct ? ofType('discount')[0]?.value?.percent === pct : !ofType('discount').length);
    const cpWant = [...E.keys].filter((k) => /^(support\.|perk\.|community\.state_of_union_calls$|community\.newsletter$|listing\.badge\.)/.test(k)).map((k) => label[k]).sort();
    const cpGot = ofType('calls_perks').map((e) => e.value.name).sort();
    rec(tier, w, 'You › My Access: Calls & Perks (support.*, perk.*, calls, newsletter, badge)', cpWant.join(' | ') || 'none', cpGot.join(' | ') || 'none', JSON.stringify(cpGot) === JSON.stringify(cpWant));
    await p.locator('[data-ma-toggle="calls_perks"]').click().catch(() => {});
    const cpRows = await p.$$eval('#ma-panel-calls_perks .g-ma-item__name', (a) => a.map((x) => x.textContent.trim()).sort()).catch(() => []);
    const cpCalls = [...E.keys].filter((k) => /^(support\.inner_circle_call_monthly|support\.group_coaching_monthly|community\.state_of_union_calls)$/.test(k)).length;
    const cpPl = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
    const cpSumWant = [cpCalls && cpPl(cpCalls, 'call'), cpWant.length - cpCalls && cpPl(cpWant.length - cpCalls, 'perk')].filter(Boolean).join(' · ');
    const cpSumGot = (await p.locator('[data-ma-toggle="calls_perks"] .g-ma-row__value').first().innerText().catch(() => '')).trim();
    rec(tier, w, 'You › My Access: Calls & Perks summary', cpSumWant, cpSumGot || 'none', cpSumGot === cpSumWant);
    const cpGroups = await p.$$eval('#ma-panel-calls_perks .g-ma-list > li', (a) => { let g = null; return a.map((li) => li.classList.contains('gaia-beta-cp-head') ? (g = li.textContent.trim(), 'H:' + g) : g + ':' + li.querySelector('.g-ma-item__name').textContent.trim()); }).catch(() => []);
    const cpIsCall = (k) => /^(support\.inner_circle_call_monthly|support\.group_coaching_monthly|community\.state_of_union_calls)$/.test(k);
    const cpKeys = [...E.keys].filter((k) => /^(support\.|perk\.|community\.state_of_union_calls$|community\.newsletter$|listing\.badge\.)/.test(k));
    const cpGroupsWant = ['Calls', 'Perks'].filter((g) => cpKeys.some((k) => cpIsCall(k) === (g === 'Calls')));
    const heads = cpGroups.filter((x) => x.startsWith('H:')).map((x) => x.slice(2));
    const misplaced = cpGroups.filter((x) => !x.startsWith('H:')).filter((x) => { const [g, ...n] = x.split(':'); const k = cpKeys.find((kk) => label[kk] === n.join(':')); return !k || (cpIsCall(k) ? 'Calls' : 'Perks') !== g; });
    rec(tier, w, 'You › My Access: Calls & Perks headings, each row under its heading', cpGroupsWant.join(' then '), `${heads.join(' then ') || 'none'}${misplaced.length ? '; misplaced: ' + misplaced.join(', ') : ''}`, JSON.stringify(heads) === JSON.stringify(cpGroupsWant) && !misplaced.length);
    const cpStatus = await p.$$eval('#ma-panel-calls_perks .g-ma-item__status', (a) => [...new Set(a.map((x) => x.textContent.trim()))]).catch(() => []);
    rec(tier, w, 'You › My Access: Calls & Perks rows say "Included"', 'Included', cpStatus.join(',') || 'none', cpStatus.length === 1 && cpStatus[0] === 'Included');
    rec(tier, w, 'You › My Access: Calls & Perks row lists every benefit', `${cpWant.length} rows`, `${cpRows.length} rows`, JSON.stringify(cpRows) === JSON.stringify(cpWant));
    const shown = (t) => new RegExp(t).test(you);
    rec(tier, w, 'You › My Access rows rendered', 'Courses / Software rows when included', `${shown('Courses') ? 'Courses ' : ''}${shown('Software') ? 'Software' : ''}`.trim() || 'none', (!nCourses || shown('Courses')) && (!nSoft || shown('Software')));
    const nl = await p.locator('[data-next-level] .g-next__title').first().innerText().catch(() => '');
    rec(tier, w, 'You: Next Level', E.next ? E.next.name : 'none (top tier)', nl.trim() || 'none', E.next ? nl.trim() === E.next.name : !nl);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/12-tier-${tier}-you-${label2}-${w}.png` });

    // G5 Store › Membership
    await p.goto(BASE + '/app/home.html?view=store&tab=membership', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2200);
    const cards = await p.$$eval('#store-memberships .g-tier, #store-memberships article', (a) => a.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    const cur = cards.filter((t) => /Current plan/.test(t));
    rec(tier, w, 'Store › Membership: current plan card', name, cur.map((t) => plans.find((pp) => t.startsWith(pp.name) || t.includes(pp.name + ' '))?.name || '?').join(',') || 'none', cur.length === 1 && cur[0].includes(name));
    rec(tier, w, 'Store › Membership: "Your access" Calls & Perks summary', 'Calls & Perks ' + cpSumWant, (cur[0] || '').match(/Calls & Perks ?[^A-Z]*/)?.[0]?.trim() || 'none', (cur[0] || '').includes('Calls & Perks') && (cur[0] || '').replace(/Calls & Perks\s*/, 'Calls & Perks ').includes('Calls & Perks ' + cpSumWant));
    const chooses = await p.$$eval('#store-memberships a, #store-memberships button', (a) => a.map((x) => x.textContent.trim()).filter((t) => /^Choose /.test(t)));
    const wantChoose = plans.slice(E.at + 1).map((pp) => 'Choose ' + pp.name);
    rec(tier, w, 'Store › Membership: upgrade buttons', wantChoose.join(', ') || 'none', chooses.join(', ') || 'none', JSON.stringify(chooses) === JSON.stringify(wantChoose));
    const hrefs = await p.$$eval('#store-memberships a[href]', (a) => a.map((x) => x.getAttribute('href')));
    rec(tier, w, 'Store › Membership: checkout links stay in the beta', 'all /beta/simulated', `${hrefs.filter((x) => /^https?:/i.test(x) && !/gaiahealers\.app\/home|^\/|home\.html/.test(x)).length} external`, !hrefs.some((x) => /join\.gaiahealers\.com|checkout|paypal/i.test(x)));
    if (SHOTS && w === 1440) await p.screenshot({ path: `${SHOTS}/12-tier-${tier}-store-${label2}-${w}.png` });

    // G6 Academy
    await p.goto(BASE + '/app/home.html?view=academy', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2600);
    const cardsA = await p.$$eval('#member-academy .g-access', (a) => a.map((x) => ({ name: (x.querySelector('.g-access__name') || {}).textContent || '', locked: x.classList.contains('g-access--locked'), text: x.innerText.replace(/\s+/g, ' ') })));
    const courseKeys = [...new Set(plans.flatMap((pp) => Object.keys(pp.ents)))].filter((k) => /^(courses|certification)\./.test(k));
    let okA = 0; const badA = [];
    const synced = await p.$$eval('#member-academy .g-sync', (a) => a.map((x) => x.getAttribute('data-course')));
    for (const k of courseKeys) {
      const cA = cardsA.find((x) => x.name.trim() === label[k]);
      const fine = E.keys.has(k) ? synced.includes('beta-demo-' + k) && !(cA && cA.locked) : Boolean(cA && cA.locked && cA.text.toLowerCase().includes(('With ' + lowest[k]).toLowerCase()));
      if (fine) okA++; else badA.push(label[k]);
    }
    rec(tier, w, `Academy: ${courseKeys.length} courses/certifications in "Your courses" or locked "With <lowest tier>"`, `${courseKeys.length} correct`, `${okA} correct${badA.length ? ' (wrong: ' + badA.join('; ') + ')' : ''}`, okA === courseKeys.length);
    const clipped = await p.$$eval('#member-academy .g-access__tags .g-chip', (a) => a.filter((c) => c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1).map((c) => c.textContent.trim()));
    rec(tier, w, 'Academy: no plan label is cut off', '0 clipped', `${clipped.length} clipped${clipped.length ? ' (' + clipped.join('; ') + ')' : ''}`, clipped.length === 0);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/12-tier-${tier}-academy-${label2}-${w}.png` });
    const locked = p.locator('#member-academy .g-access--locked').first();
    if (await locked.count()) {
      await locked.click(); await p.waitForTimeout(1500);
      const choose = p.locator('#store-memberships a, #store-memberships button', { hasText: /^Choose / }).first();
      let target = p;
      if (await choose.count()) {
        const pop = c.waitForEvent('page', { timeout: 4000 }).catch(() => null);
        await choose.click(); const np = await pop; if (np) { target = np; await np.waitForLoadState('domcontentloaded').catch(() => {}); } await p.waitForTimeout(1000);
      }
      const at = new URL(target.url()).pathname;
      rec(tier, w, 'Academy locked card → Store → Choose → simulated upgrade', '/beta/simulated, no payment', at, at === '/beta/simulated' && /No payment or change was made/.test(await target.locator('body').innerText().catch(() => '')));
      if (target !== p) await target.close();
    }

    // G7 Community
    await p.goto(BASE + '/app/home.html?view=community', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(3000);
    const comm = await p.$$eval('#community-body .g-access', (a) => a.map((x) => ({ name: (x.querySelector('.g-access__name') || {}).textContent || '', locked: x.classList.contains('g-access--locked'), text: x.innerText.replace(/\s+/g, ' ') })));
    const ic = comm.find((x) => x.name.trim() === label['community.inner_circle_channel']);
    const icWant = E.keys.has('community.inner_circle_channel') ? 'open' : 'locked, Included with ' + lowest['community.inner_circle_channel'];
    rec(tier, w, 'Community: inner-circle channel (community.inner_circle_channel)', icWant, ic ? (ic.locked ? 'locked' + (ic.text.includes('Included with ' + lowest['community.inner_circle_channel']) ? ', Included with ' + lowest['community.inner_circle_channel'] : '') : 'open') : 'missing',
      ic && (E.keys.has('community.inner_circle_channel') ? !ic.locked : ic.locked && ic.text.includes('Included with ' + lowest['community.inner_circle_channel'])));
    const all = comm.find((x) => /All Gaia Healers/.test(x.name));
    rec(tier, w, 'Community: All Gaia Healers (community.access)', E.keys.has('community.access') ? 'open' : 'locked', all ? (all.locked ? 'locked' : 'open') : 'missing', all && all.locked === !E.keys.has('community.access'));
    const partner = comm.filter((x) => /Bio-Well|BioPulsar|BioTekna|ASEA|BrainTap|LifeWave|Golden/i.test(x.name) && x.locked);
    rec(tier, w, 'Community: unmapped partner circles not shown as locked', '0', String(partner.length), partner.length === 0);
    if (SHOTS && w === 1440) await p.screenshot({ path: `${SHOTS}/12-tier-${tier}-community-${label2}-${w}.png` });
    rec(tier, w, 'No request left loopback (fonts allowed; public Shopify product images blocked by the test) and no page errors', '0 other hosts / 0 errors', `${left} (${[...leftHosts].join(',') || 'none'}) / ${errors}${errMsgs.length ? ' (' + errMsgs.join('; ') + ')' : ''}`, [...leftHosts].every((x) => /(^|\.)cdn\.shopify\.com$/.test(x)) && errors === 0);
    await c.close();
  }
}
await browser.close(); await pool.end();
const pass = rows.filter((r) => r[5]).length; console.log(`${pass}/${rows.length} plan-gate checks passed`);
const esc = (s) => String(s).replace(/\|/g, '\\|');
fs.writeFileSync(OUT, ['| Tier | Width | Gate (catalog key) | Expected from the catalog | Shown | Status |', '|---|---|---|---|---|---|', ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${esc(r[2])} | ${esc(r[3])} | ${esc(r[4])} | ${r[5] ? 'PASS' : 'FAIL'} |`)].join('\n') + '\n');
process.exit(pass === rows.length ? 0 : 1);
