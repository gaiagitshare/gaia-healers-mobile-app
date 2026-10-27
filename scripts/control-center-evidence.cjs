#!/usr/bin/env node
/**
 * Control Center Membership 2.0: repeatable screenshot evidence on a LOOPBACK staging stack.
 * Contract: docs/membership/CONTROL-CENTER.md §7.
 *
 *   node scripts/control-center-evidence.cjs --env-file <path> [--base http://127.0.0.1:8799] [--out <dir>] [--dry-run] [--max-writes N]
 *   node scripts/control-center-evidence.cjs --env-file <path> --rotate-initial-passwords
 *
 * Safety:
 *   - loopback only: --base must be http://127.0.0.1|localhost|[::1]; every browser request to any
 *     other host is aborted (fonts included), and the script makes no other network call;
 *   - credentials come from the env file named on the command line (GAIA_ADMIN_PASSWORD and
 *     OPERATOR_{OWNER,FINANCE,SUPPORT}_{EMAIL,PASSWORD,TOTP_SECRET}); they are never printed or logged;
 *   - hard cap on writes (every non-GET request to /api/admin/membership2/* other than login/logout):
 *     the plan is stated first, a plan above the cap (default 6) refuses (exit 2), and a write past
 *     the cap at run time is aborted in the browser and ends the run. --dry-run prints the plan only.
 *   - fixture people only (the default person is a fixture.invalid address), small amounts.
 *
 * Writes in the evidence run (6): support +50 goodwill (executed); support +600 (refused: needs
 * finance); finance +600 (sent for approval, left pending); finance $1.00 refund request; owner
 * approves the refund (billing not connected: not executed); owner runs it again (still not executed).
 * --rotate-initial-passwords (3 writes): each fixture operator changes the initial password through
 * the first-sign-in screen; the env file is rewritten in place (0600) with the new passwords.
 *
 * Needs Playwright (PLAYWRIGHT_PATH, default /root/.viewport-shots/node_modules/playwright).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const BASE = arg('--base', 'http://127.0.0.1:8799');
const ENV_FILE = arg('--env-file');
const OUT = arg('--out', path.join(__dirname, '..', 'docs', 'membership', 'control-center-evidence'));
const CAP = Number(arg('--max-writes', '6'));
const ROTATE = flag('--rotate-initial-passwords');
const DRY = flag('--dry-run');
const PERSON_EMAIL = arg('--person', 'fixture-silver-monthly@fixture.invalid');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
let baseUrl;
try { baseUrl = new URL(BASE); } catch { die('--base is not a URL'); }
if (baseUrl.protocol !== 'http:' || !LOOPBACK.has(baseUrl.hostname)) die('refusing: --base must be a loopback http URL (127.0.0.1, localhost or [::1])');
if (!/@[^@]*\.invalid$/.test(PERSON_EMAIL)) die('refusing: --person must be a fixture address ending in .invalid');
if (!Number.isInteger(CAP) || CAP < 0) die('--max-writes must be a whole number');

const PLAN = ROTATE
  ? ['support: change initial password', 'finance: change initial password', 'owner: change initial password']
  : ['support: +50 goodwill coins (direct)', 'support: +600 goodwill coins (refused, needs finance)', 'finance: +600 goodwill coins (sent for approval)',
    'finance: $1.00 refund request', 'owner: approve the refund (billing not connected)', 'owner: execute the refund again (still not connected)'];
console.log(`plan: ${PLAN.length} write(s), cap ${CAP}${DRY ? ' (dry run: nothing is sent)' : ''}`);
PLAN.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
if (PLAN.length > CAP) die(`refusing: the plan needs ${PLAN.length} writes, above the cap of ${CAP} (raise it only with --max-writes N, for one run, after approval)`);
if (DRY) process.exit(0);
if (!ENV_FILE) die('--env-file <path> is required');

function readEnv(file) {
  const out = {};
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim());
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}
const ENV = readEnv(ENV_FILE);
for (const k of ['GAIA_ADMIN_PASSWORD', ...['OWNER', 'FINANCE', 'SUPPORT'].flatMap((w) => [`OPERATOR_${w}_EMAIL`, `OPERATOR_${w}_PASSWORD`, `OPERATOR_${w}_TOTP_SECRET`])]) {
  if (!ENV[k]) die(`the env file has no ${k}`);
}

function b32(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totp(secret, t = Date.now()) { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = crypto.createHmac('sha1', b32(secret)).update(c).digest(); const o = h[h.length - 1] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); }

const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/root/.viewport-shots/node_modules/playwright');

let writes = 0, capHit = false;
const shots = [];
const log = [];
let encoder = null;   // a blank page that turns PNG into WebP with the browser's own encoder (no extra tools)

async function shot(page, name) {
  await page.waitForTimeout(250);
  for (const [w, h] of [[1280, 800], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(150);
    const png = await page.screenshot({ type: 'png' });
    const b64 = await encoder.evaluate(async (data) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.6).split(',')[1];
    }, png.toString('base64'));
    const f = `${name}-${w}.webp`; fs.writeFileSync(path.join(OUT, f), Buffer.from(b64, 'base64')); shots.push(f);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function context(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (!LOOPBACK.has(u.hostname)) return r.abort();
    const m = r.request().method();
    if (m !== 'GET' && u.pathname.startsWith('/api/admin/membership2/') && !/\/(login|logout)$/.test(u.pathname)) {
      if (writes >= CAP) { capHit = true; return r.abort(); }
      writes++;
    }
    return r.continue();
  });
  const lr = await ctx.request.post(BASE + '/api/admin/login', { data: { password: ENV.GAIA_ADMIN_PASSWORD }, headers: { origin: BASE } });
  if (!(await lr.json()).ok) throw new Error('console sign-in failed');
  // The console boots from its Event-Manager token; on staging the gaia_admin cookie is the session, so a placeholder suffices.
  await ctx.addInitScript(() => { try { localStorage.setItem('gha_token', 'staging-cookie-session'); } catch (e) { /* none */ } });
  return ctx;
}
async function operatorLogin(page, who, { expectPasswordScreen = false } = {}) {
  await page.goto(BASE + '/#membership2'); await page.waitForSelector('#m2em');
  await page.fill('#m2em', ENV[`OPERATOR_${who}_EMAIL`]); await page.fill('#m2pw', ENV[`OPERATOR_${who}_PASSWORD`]);
  await page.fill('#m2code', totp(ENV[`OPERATOR_${who}_TOTP_SECRET`]));
  await page.click('form.m2-signin button[type=submit]');
  await page.waitForSelector(expectPasswordScreen ? '#m2pwcur' : '.m2-head', { timeout: 10000 });
}
const dlg = (page) => page.locator('.m2-dlg');
async function openPerson(page) {
  await page.click('#m2s-members'); await page.fill('#m2q', PERSON_EMAIL.split('@')[0]); await page.click('form.m2-searchbar button');
  await page.waitForSelector('.m2-results table');
  await page.getByRole('button', { name: PERSON_EMAIL }).click(); await page.waitForSelector('#m2p-identities');
}
async function credit(page, coins, reason) {
  await page.click('#m2p-coins'); await page.getByRole('button', { name: 'Credit coins', exact: true }).first().click();
  await page.fill('#m2f-coins', String(coins)); await page.fill('#m2f-reason', reason);
}
async function msg(page) { return (await page.locator('.m2-dlg__msg').textContent()) || ''; }

async function rotate(browser) {
  const next = { ...ENV };
  for (const who of ['SUPPORT', 'FINANCE', 'OWNER']) {
    const ctx = await context(browser); const page = await ctx.newPage();
    await operatorLogin(page, who, { expectPasswordScreen: true });
    if (who === 'SUPPORT') await shot(page, '02b-first-signin-change-password');
    const pw = crypto.randomBytes(18).toString('base64url');
    await page.fill('#m2pwcur', ENV[`OPERATOR_${who}_PASSWORD`]); await page.fill('#m2pwnew', pw); await page.fill('#m2pwagain', pw);
    await page.click('form.m2-signin button[type=submit]');
    await page.waitForSelector('.m2-head', { timeout: 10000 });
    next[`OPERATOR_${who}_PASSWORD`] = pw;
    log.push(`${who.toLowerCase()}: initial password changed`);
    await ctx.close();
  }
  // Rewrite the env file in place, keeping every other line; never printed.
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n').map((l) => {
    const m = /^(OPERATOR_(?:SUPPORT|FINANCE|OWNER)_PASSWORD)=/.exec(l.trim());
    return m ? `${m[1]}=${next[m[1]]}` : l;
  });
  const tmp = ENV_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 }); fs.renameSync(tmp, ENV_FILE);
  log.push('env file updated (0600)');
}

async function evidence(browser) {
  // ---- status gating ----
  const g = await context(browser); const gp = await g.newPage();
  let m2calls = 0;
  await gp.route('**/api/admin/membership2/**', (r) => { m2calls++; return r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false,"reason":"unknown_admin_route"}' }); });
  await gp.goto(BASE + '/'); await gp.waitForSelector('.side');
  log.push('gating OFF (simulated 404): menu item ' + (await gp.locator('[data-nav="membership2"]').count()) + ', banner ' + (await gp.locator('.envbanner').count()) + ', membership2 requests ' + m2calls);
  await shot(gp, '01a-gating-off-simulated');
  await gp.unroute('**/api/admin/membership2/**'); await gp.reload(); await gp.waitForSelector('[data-nav="membership2"]');
  log.push('gating ON (real staging): menu item ' + (await gp.locator('[data-nav="membership2"]').count()) + ', banner ' + (await gp.locator('.envbanner').count()));
  await gp.keyboard.press('Tab'); await gp.keyboard.press('Tab');
  await shot(gp, '01b-gating-on-banner-keyboard');
  await g.close();

  // ---- support ----
  const s = await context(browser); const sp = await s.newPage();
  await sp.goto(BASE + '/#membership2'); await sp.waitForSelector('#m2em'); await shot(sp, '02-operator-signin');
  await operatorLogin(sp, 'SUPPORT'); await sp.waitForSelector('.m2-stats'); await shot(sp, '03-overview-support');
  await openPerson(sp); await shot(sp, '05-person-detail');
  await credit(sp, 50, 'Evidence run: goodwill for a staging test'); await shot(sp, '07-credit-50-dialog');
  await dlg(sp).locator('button[type=submit]').click(); await sp.waitForSelector('.m2-dlg', { state: 'detached', timeout: 10000 });
  log.push('support +50: executed');
  await sp.waitForTimeout(600); await shot(sp, '08-credit-50-executed-goodwill-bucket');
  await credit(sp, 600, 'Evidence run: above the support limit');
  await dlg(sp).locator('button[type=submit]').click(); await sp.waitForFunction(() => /role|Refused|approval/.test((document.querySelector('.m2-dlg__msg') || {}).textContent || ''), null, { timeout: 10000 });
  log.push('support +600: ' + (await msg(sp)));
  await shot(sp, '09-forbidden-required-role');
  await dlg(sp).getByRole('button', { name: 'Cancel' }).click();
  await sp.click('#m2s-launch'); await sp.waitForSelector('text=Pilot list'); await shot(sp, '10-launch-names-not-ids');
  await s.close();

  // ---- finance ----
  const f = await context(browser); const fp = await f.newPage();
  await operatorLogin(fp, 'FINANCE');
  await openPerson(fp);
  await credit(fp, 600, 'Evidence run: larger goodwill, needs approval');
  await dlg(fp).locator('button[type=submit]').click(); await fp.waitForSelector('.m2-dlg__msg.is-final', { timeout: 10000 });
  log.push('finance +600: ' + (await msg(fp)));
  await dlg(fp).getByRole('button', { name: 'Close' }).click();
  await fp.click('#m2s-payments'); await fp.waitForSelector('.m2-table'); await shot(fp, '11-payments-source-badges');
  await fp.getByRole('button', { name: 'Refund', exact: true }).first().click();
  await fp.fill('#m2f-dollars', '1.00'); await fp.fill('#m2f-reason', 'Evidence run: partial refund test (staging)');
  await shot(fp, '12-refund-dialog');
  await dlg(fp).locator('button[type=submit]').click(); await fp.waitForSelector('.m2-dlg__msg.is-final', { timeout: 10000 });
  log.push('finance refund $1: ' + (await msg(fp)));
  await dlg(fp).getByRole('button', { name: 'Close' }).click();
  await fp.click('#m2s-requests'); await fp.waitForSelector('.m2-req'); await shot(fp, '13-requests-requester-waiting');
  await f.close();

  // ---- owner ----
  const o = await context(browser); const op = await o.newPage();
  await operatorLogin(op, 'OWNER');
  await op.click('#m2s-requests'); await op.waitForSelector('.m2-req'); await shot(op, '14-requests-owner-member-emails');
  const refundCard = op.locator('article.m2-req', { hasText: 'Refund a payment' }).filter({ hasText: '$1.00' }).filter({ has: op.getByRole('button', { name: 'Approve', exact: true }) }).first();
  await refundCard.getByRole('button', { name: 'Approve', exact: true }).click();
  await op.fill('#m2f-reason', 'Evidence run: approve refund (no Stripe)'); await shot(op, '15-approve-dialog');
  await dlg(op).locator('button[type=submit]').click(); await op.waitForSelector('.m2-dlg__msg.is-final', { timeout: 10000 });
  log.push('owner approve refund: ' + (await msg(op)));
  await shot(op, '16-refund-approved-not-executed');
  await dlg(op).getByRole('button', { name: 'Close' }).click();
  await op.click('#m2s-overview'); await op.click('#m2s-requests'); await op.waitForSelector('text=Execute again');
  await shot(op, '17-requests-execute-again');
  await op.getByRole('button', { name: 'Execute again', exact: true }).first().click();
  await op.fill('#m2f-reason', 'Evidence run: explicit retry, billing still off');
  await dlg(op).locator('button[type=submit]').click(); await op.waitForSelector('.m2-dlg__msg.is-final', { timeout: 10000 });
  log.push('owner execute again: ' + (await msg(op)));
  await shot(op, '18-execute-again-result');
  await dlg(op).getByRole('button', { name: 'Close' }).click();
  await openPerson(op); await op.click('#m2p-coins'); await op.waitForSelector('text=Wallet'); await shot(op, '19-person-coins-goodwill');
  await op.click('#m2s-audit'); await op.waitForSelector('.m2-table'); await shot(op, '20-audit-reasons-names');
  await op.click('#m2s-health'); await op.waitForSelector('.m2-kv'); await shot(op, '21-health-environment');
  await o.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  let failed = false;
  try {
    const ectx = await browser.newContext(); await ectx.route('**/*', (r) => r.abort()); encoder = await ectx.newPage();
    if (ROTATE) await rotate(browser); else await evidence(browser);
  } catch (e) {
    failed = true;
    log.push('ERROR ' + String(e.message || e).split('\n')[0].replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]'));
  } finally {
    await browser.close();
    log.forEach((l) => console.log(l));
    console.log(`writes ${writes} of cap ${CAP}${capHit ? ' (CAP REACHED: a write was aborted)' : ''}; screenshots ${shots.length}`);
    process.exitCode = failed || capHit ? 1 : 0;
  }
})();
