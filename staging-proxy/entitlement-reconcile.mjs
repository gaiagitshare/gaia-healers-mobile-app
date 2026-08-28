// Entitlement reconciler for MEMBERSHIP/COURSE — the SAME proven pattern as the
// Event reconciler (reconcile-live.mjs): poll real completed GHL orders, resolve
// the purchased PRODUCT, and let the hardened member-access endpoint grant the
// mapped entitlement from an explicit product mapping. The product decides the
// entitlement; nothing is dictated by a payload. Idempotent, whitelist-only.
import fs from 'fs';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 3);
const env = {};
for (const l of fs.readFileSync('/root/gaia-staging-proxy/.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const base = (env.GHL_API_BASE_URL || '').replace(/\/+$/, ''), token = (env.GHL_API_TOKEN || '').trim(), loc = (env.GHL_LOCATION_ID || '').trim(), version = (env.GHL_API_VERSION || '2021-07-28').trim();
const SECRET = (env.GHL_WORKFLOW_WEBHOOK_SECRET || env.COURSES_SYNC_SECRET || '').trim();
const PORT = (env.PORT || '8787').trim();
const MA_URL = `http://127.0.0.1:${PORT}/api/webhooks/ghl/member-access`;
const MAP_FILE = env.ENTITLEMENT_MAP_FILE || '/root/gaia-staging-proxy/data/entitlement-product-mappings.json';
const GH = { Accept: 'application/json', Authorization: `Bearer ${token}`, Version: version };
const L = encodeURIComponent(loc); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
async function gget(p, tries = 6) { for (let i = 0; i < tries; i++) { try { const r = await fetch(base + p, { headers: GH }); if (r.status === 429 || r.status >= 500) { await sleep(600 * (i + 1)); continue; } if (!r.ok) return { __status: r.status }; return await r.json(); } catch (e) { await sleep(500 * (i + 1)); } } return { __failed: true }; }
function mappedProducts() { try { return new Set(Object.keys(JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')).products || {})); } catch (_) { return new Set(); } }
async function post(body) { try { const r = await fetch(MA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; } catch (e) { return { status: 0, json: { error: String(e) } }; } }
(async () => {
  const MAP = mappedProducts();
  if (!MAP.size) { console.log(`${stamp()} ENT-RECONCILE: no entitlement product mappings; nothing to do`); return; }
  const cutoff = Date.now() - LOOKBACK_DAYS * 86400000;
  // recent completed orders
  let off = 0, total = Infinity; const recent = [];
  while (off < total) { const j = await gget(`/payments/orders?altId=${L}&altType=location&limit=100&offset=${off}`); if (typeof j.totalCount === 'number') total = j.totalCount; const b = (j.data || []); if (!b.length) break;
    for (const o of b) { const t = Date.parse(o.createdAt || o.updatedAt || ''); if ((o.status || o.paymentStatus) === 'completed' && Number.isFinite(t) && t >= cutoff) recent.push(o._id || o.id); }
    off += b.length; if (b.length < 100) break; }
  // details -> only orders that contain a mapped entitlement product
  let granted = 0, noop = 0, failed = 0; const seen = new Set();
  for (const oid of [...new Set(recent)]) {
    const d = await gget(`/payments/orders/${oid}?altId=${L}&altType=location`);
    if (!d || d.__failed || d.__status) { failed++; continue; }
    const items = d.items || []; const pids = [...new Set(items.map((it) => (it.product && it.product._id) || it.productId).filter(Boolean))];
    if (!pids.some((p) => MAP.has(p))) continue;                     // whitelist-only: skip unmapped
    const snap = d.contactSnapshot || {}; const contactId = d.contactId || snap.id || '';
    if (!contactId) { failed++; continue; }
    // Send EVIDENCE ONLY. The endpoint re-resolves order -> product -> mapping.
    const r = await post({ contactId, order_id: oid });
    if (r.json && r.json.applied) granted++; else if (r.json && (r.json.duplicate || r.json.reason === 'no_mapped_product')) noop++; else failed++;
    seen.add(oid);
  }
  // refund pass: refunded transactions for mapped-product orders -> revoke
  let refunded = 0;
  let toff = 0, ttot = Infinity;
  while (toff < ttot) { const j = await gget(`/payments/transactions?altId=${L}&altType=location&limit=100&offset=${toff}`); if (typeof j.totalCount === 'number') ttot = j.totalCount; const b = (j.data || []); if (!b.length) break;
    for (const tx of b) { const t = Date.parse(tx.createdAt || tx.updatedAt || ''); if (!(Number.isFinite(t) && t >= cutoff)) continue;
      const isRef = (tx.status === 'refunded') || (Number(tx.amountRefunded || 0) > 0);
      if (!isRef || !tx.entityId) continue;
      const d = await gget(`/payments/orders/${tx.entityId}?altId=${L}&altType=location`);
      const pids = [...new Set(((d && d.items) || []).map((it) => (it.product && it.product._id) || it.productId).filter(Boolean))];
      if (!pids.some((p) => MAP.has(p))) continue;
      const contactId = (d && d.contactId) || (d && d.contactSnapshot && d.contactSnapshot.id) || tx.contactId || '';
      if (!contactId) continue;
      const r = await post({ contactId, order_id: tx.entityId, refunded: true, type: 'payment_refunded' });
      if (r.json && r.json.applied) refunded++;
    }
    toff += b.length; if (b.length < 100) break; }
  console.log(`${stamp()} ENT-RECONCILE ok: mapped_orders_scanned=${seen.size} granted=${granted} noop=${noop} refunded_applied=${refunded} failed=${failed}`);
})();
