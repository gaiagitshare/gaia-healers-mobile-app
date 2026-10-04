#!/usr/bin/env node
/**
 * MEMBER FLOW CHECK — the whole member-results path, offline, end to end.
 *
 * Boots a fake Gaia Practitioners backend on 127.0.0.1 (their contract as
 * built on staging, 4 Oct 2026), then walks exactly what the app does:
 * ask for a code -> their server redeems it -> readings (summary, series,
 * latest, trend) -> newest-reading tracking (status, nudge, seen) ->
 * preferences (fold, reset) -> what the practitioner sees (linked clients)
 * -> the member stops sharing -> their server is told.
 *
 * Nothing leaves this machine: temp files for the link and preference
 * stores, a loopback server for the partner, and the paid-call guard
 * installed with zero planned calls so a mistake could not reach a real
 * host. No model, no key, nothing billed.
 *
 *   node tools/member-flow-check.mjs          # PASS/FAIL per step, exit 0/1
 *   node tools/member-flow-check.mjs --json
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPaidCallGuard } from './paid-call-guard.mjs';

installPaidCallGuard({ label: 'member-flow-check', planned: 0, why: 'offline: every request goes to a loopback fake' });

const ml = await import('../member-link.js');
const prefs = await import('../member-prefs.js');

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const steps = [];
const step = (name, ok, detail = '') => { steps.push({ name, ok: Boolean(ok), detail }); if (!json) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

// ── the fake partner: member-token, member-only MCP, link status/unlink ──
const seen = { tokens: 0, tools: [], unlinks: 0 };
const SCAN = { exp_id: 1, scanned_at: '2026-06-14T14:49:28Z', values: { stress: 3.9, energy: 54, chakras: [{ name: 'Root', value: 6.1, align: 1 }, { name: 'Heart', value: 8.4, align: 0 }, { name: 'Crown', value: 5.2, align: 0 }], organs: [{ name: 'Liver', disbalance: 2.4 }], meridians: [], systems: [] } };
const points = []; for (let i = 0; i < 30; i++) points.push({ scanned_at: `2026-0${1 + (i % 6)}-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z`, energy: 50 + i, stress: 2 + i / 10 });
const partner = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/gaia/member-token') { seen.tokens++; return send(200, { token: 'mt', expires_in: 3600 }); }
    if (req.url.startsWith('/api/gaia/member-links/') && req.method === 'DELETE') { seen.unlinks++; return send(200, { ok: true }); }
    if (req.url === '/api/member-mcp') {
      const rpc = JSON.parse(body || '{}');
      if (rpc.method === 'tools/list') return send(200, { jsonrpc: '2.0', id: rpc.id, result: { tools: ['get_my_profile', 'get_my_latest_scan', 'get_my_scan_trend', 'get_my_before_after', 'list_my_shared_files'].map((n) => ({ name: n })) } });
      const name = rpc.params?.name; seen.tools.push(name);
      const text = (o) => send(200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
      if (name === 'get_my_profile') return text({ practitioner: { id: 'p-77', name: 'Dr Loop', specialty: 'Bio-Well' }, member: { linked_at: '2026-06-01T00:00:00Z' } });
      if (name === 'get_my_latest_scan') return text({ scan: SCAN, scanCount: 31 });
      if (name === 'get_my_scan_trend') return text({ scanCount: 31, points, summary: { energy: { min: 40, max: 80, avg: 60, latest: 54 }, stress: { min: 2, max: 5, avg: 3, latest: 3.9 } }, organTrends: [], flags: [{ category: 'organs', name: 'Liver', direction: 'worsening', severity: 'high', delta: 4 }] });
      if (name === 'get_my_before_after') return text({ comparisons: [{ basis: 'consecutive sessions', from: '2026-05-01', to: '2026-06-14', stress_change: -0.4, energy_change: 3.2, biggest_changes: [] }] });
      if (name === 'list_my_shared_files') return text({ files: [{ id: 'f1', name: 'Plan.pdf', uploaded_at: '2026-06-02', download_url: 'https://127.0.0.1/x', pinned: true }, { id: 'f2', name: 'Notes.pdf', uploaded_at: '2026-06-03' }] });
      return text({});
    }
    send(404, { error: 'nope' });
  });
});
await new Promise((r) => partner.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${partner.address().port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-flow-'));
const file = path.join(dir, 'links.json'), pfile = path.join(dir, 'prefs.json');
const env = { GAIA_PRACTITIONERS_MEMBER_API_KEY: 'offline-fake', GAIA_PRACTITIONERS_MEMBER_BACKEND: base };
const cfg = { environment: 'staging', base, mcpUrl: `${base}/api/mcp`, clientId: 'x', clientSecret: 'y' };
const MEMBER = 'member-flow-1';

try {
  // 1. the member asks for a code (that is the consent)
  const code = ml.mintCode(MEMBER, { file });
  step('member asks for a code', /^[A-Z0-9]{8}$/.test(code.code) && code.consent_recorded_at, code.code.replace(/./g, '•'));
  step('status shows a live code, not linked', (() => { const s = ml.linkStatus(MEMBER, { file }); return s.code_active && !s.linked; })());
  // 2. their server redeems it
  const red = ml.redeemCode(code.code.toLowerCase(), { customer_id: 'c-1', practitioner_id: 'p-77', practitioner_name: 'Dr Loop' }, { file });
  step('their server redeems it (case-insensitive, single use)', red.gaia_member_id === MEMBER && red.status === 'confirmed');
  let dup = null; try { ml.redeemCode(code.code, { customer_id: 'c-2', practitioner_id: 'p-1' }, { file }); } catch (e) { dup = e.code; }
  step('the same code cannot be used twice', dup === 'code_invalid' || dup === 'already_linked', String(dup));
  // 3. readings
  ml._resetServerTokenForTest();
  const r = await ml.memberReadings(cfg, MEMBER, { env, fetchImpl: fetch, file });
  step('readings: latest scan with values', r.latest?.energy === 54 && r.latest?.stress === 3.9 && r.latest.chakras.length === 3);
  step('readings: summary written by rules', typeof r.summary?.headline === 'string' && r.summary.lines.some((l) => /not a diagnosis/.test(l)) && r.summary.lines.some((l) => /Dr Loop/.test(l)), r.summary?.headline);
  step('readings: series for the sparkline (24 newest, dated)', r.series.length === 24 && r.series.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.d)));
  step('readings: trend with flagged areas', r.trend?.flagged?.[0]?.name === 'Liver');
  step('readings: read-this-first document comes first', r.files[0]?.first === true && r.files[0].name === 'Plan.pdf');
  step('readings: one member token, five tools', seen.tokens === 1 && seen.tools.length === 5, `${seen.tokens} token, ${seen.tools.length} tools`);
  // 4. newest-reading tracking
  ml.rememberLatest(MEMBER, r.latest.scanned_at, { file });
  step('a newer reading than opened -> nudge and dot', ml.linkStatus(MEMBER, { file }).new_reading === true);
  ml.markSeen(MEMBER, r.latest.scanned_at, { file });
  step('opened on screen -> nudge and dot go', ml.linkStatus(MEMBER, { file }).new_reading === false);
  const before = seen.tools.length;
  await ml.refreshLatest(cfg, MEMBER, { env, fetchImpl: fetch, file, now: Date.now() });
  step('status refresh inside six hours makes no partner call', seen.tools.length === before);
  await ml.refreshLatest(cfg, MEMBER, { env, fetchImpl: fetch, file, now: Date.now() + ml.LATEST_CHECK_TTL_MS + 1000 });
  step('after six hours: exactly one latest-scan call', seen.tools.length === before + 1 && seen.tools.at(-1) === 'get_my_latest_scan');
  // 5. preferences
  const p1 = prefs.setPrefs(MEMBER, { readings_explainer_collapsed: true, evil: true }, { file: pfile });
  step('fold the explainer -> kept on the server, unknown keys dropped', p1.readings_explainer_collapsed === true && !('evil' in p1));
  const cleared = {}; for (const k of Object.keys(prefs.PREF_KEYS)) cleared[k] = false;
  step('show hidden cards again -> all false', Object.values(prefs.setPrefs(MEMBER, cleared, { file: pfile })).every((v) => v === false));
  // 6. the practitioner's side
  const mine = ml.linksForPractitioner('p-77', file);
  step('practitioner sees this client shares, and has opened', mine.length === 1 && mine[0].customer_id === 'c-1' && mine[0].opened === true && !('gaia_member_id' in mine[0]));
  step('another practitioner sees nothing', ml.linksForPractitioner('p-1', file).length === 0);
  // 7. the member stops sharing
  const rv = ml.revokeLink({ memberId: MEMBER }, 'member', { file });
  await ml.notifyPartnerUnlink(cfg, { memberId: MEMBER, customerId: rv.customer_id }, { env, fetchImpl: fetch });
  step('stop sharing: revoked locally, their server told', rv.revoked === true && seen.unlinks === 1 && !ml.linkFor(MEMBER, file));
  let after = null; try { await ml.memberReadings(cfg, MEMBER, { env, fetchImpl: fetch, file }); } catch (e) { after = e.code; }
  step('readings refuse after unlink', after === 'member_not_linked', String(after));
} catch (e) {
  step('unexpected error', false, String(e && e.stack || e).slice(0, 300));
} finally {
  partner.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
const failed = steps.filter((s) => !s.ok).length;
if (json) console.log(JSON.stringify({ ok: failed === 0, steps }, null, 2));
else console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} — ${steps.length} steps, offline, nothing billed`);
process.exit(failed === 0 ? 0 : 1);
