/**
 * PRIVACY: what practitioner data leaves for the AI provider (6 Oct 2026).
 *
 * Every practitioner tool is run against a fake partner whose answers carry
 * unique planted values -- reading numbers, percentages, severities, scan ids
 * and dates, DOB, sex, phone, email, address, Bio-Well card ids, file names,
 * session notes, trend and before/after numbers. The test then asserts:
 *   - none of them is in the MODEL copy (what the page hands the provider);
 *   - the PAGE copy still carries what the authorised Practice screen shows;
 *   - a practitioner tool with no explicit model view fails closed.
 * Also: partner AI recommendations are a disabled source -- no partner call,
 * nothing in the prompt -- unless GAIA_PARTNER_AI_RECOMMENDATIONS=on.
 * No network, no paid model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOOLS, runTool, modelView, _setMcpReaderForTest, scanNarrationEnabled } from '../assist-tools.js';
import * as ml from '../member-link.js';

// Planted values: each appears in the fake partner data and must never reach the model.
const S = {
  energy: 91.37, stress: 8.765, chakra: 6.543, align: 77.71, disb: 33.37, disb2: 44.44, delta: 67.89, before: 12.34, after: 56.78,
  trendMin: 41.11, trendMax: 82.22, trendAvg: 61.61, scanDate: '2001-02-03', scanId: 'EXP-SENTINEL-913', bioId: 'BIO-SENTINEL-552',
  dob: '1911-11-11', sex: 'SENTINEL_SEX', phone: '+1-555-0199-77', email: 'leak@sentinel.test', address: '1 Sentinel Way', city: 'Sentinelville',
  file: 'SENTINEL-liver-report.pdf', note: 'SENTINEL_SESSION_NOTE', severity: 'high', guide: 'SENTINEL_GUIDE_TEXT',
};
const CLIENT = { id: 4242, name: 'Client Sentinel' };

const labeled = {
  stress: S.stress, energy: S.energy,
  chakras: [{ index: 0, name: 'Muladhara', value: S.chakra, align: S.align, asymmetry: 3.21 }],
  organs: [{ index: 0, name: 'Liver', left: 1, right: 2, disbalance: S.disb }],
  meridians: [], systems: [{ index: 0, name: 'Lymphatic System', disbalance: S.disb2 }],
};
const FAKE = {
  list_customers: { count: 1, customers: [{ ...CLIENT, email: S.email, bio_id: S.bioId, hasBioWellCard: true }] },
  search_customers: { count: 1, customers: [{ ...CLIENT, email: S.email, bio_id: S.bioId, hasBioWellCard: true }] },
  get_customer: { ...CLIENT, firstname: 'Client', lastname: 'Sentinel', email: S.email, phone: S.phone, sex: S.sex, dob: S.dob, address: S.address, city: S.city, state: 'SS', country: 'SC', bio_id: S.bioId, hasBioWellCard: true },
  get_customer_scan: { customer: { ...CLIENT, email: S.email, bio_id: S.bioId }, scans: [{ exp_id: S.scanId, scanned_at: S.scanDate + 'T10:00:00Z', labeled, values: labeled }] },
  get_scan_trend: { customer: { ...CLIENT, bio_id: S.bioId }, scanCount: 9,
    summary: { energy: { min: S.trendMin, max: S.trendMax, avg: S.trendAvg, latest: S.energy }, stress: { min: 1.11, max: S.stress, avg: 2.22, latest: S.stress } },
    organTrends: [{ category: 'organs', name: 'Liver', delta: S.delta, latest: S.disb, direction: 'worsening', flagged: true, flagReason: 'disbalance_high', severity: S.severity }],
    flags: [{ category: 'organs', name: 'Liver', delta: S.delta, latest: S.disb, direction: 'worsening', flagged: true, flagReason: 'disbalance_high', severity: S.severity }] },
  compare_protocol_before_after: { customer: CLIENT, comparisons: [{ source: 'comment', protocol: 'P', before: { exp_id: S.scanId, date: S.scanDate, comment: S.note }, after: { date: '2001-03-04' },
    deltas: { stress: S.delta, energy: S.delta, disbalance: [{ category: 'organs', name: 'Liver', before: S.before, after: S.after, delta: S.delta }] } }] },
  get_customer_files: { count: 1, files: [{ id: 1, filename: S.file, type: 'pdf', size: 1, created_at: S.scanDate }] },
  list_flagged_customers: { count: 1, flaggedCustomers: [{ customer: { ...CLIENT, bio_id: S.bioId }, latestScan: { exp_id: S.scanId, scanned_at: S.scanDate },
    flags: [{ type: 'disbalance_high', name: 'Liver', category: 'organs', value: S.disb, severity: S.severity }] }] },
  list_services: { count: 1, services: [{ id: 7, name: 'Lymphatic massage', price: 90, attributes: 'Liver, Kidneys', systems: 'Lymphatic System', duration: 60 }] },
  suggest_follow_ups: { count: 1, suggestions: [{ customer: { ...CLIENT, bio_id: S.bioId }, flags: [{ name: 'Liver', severity: S.severity, value: S.disb }], lastAppointment: '2026-09-01', typicalCadenceDays: 30, suggestedFollowUp: { start: '2026-10-01', end: '2026-10-08' } }] },
  get_customer_recommendations: { count: 1, recommendations: [{ id: 1, scan_type: 'full', scan_id: S.scanId, recommendations: { text: S.guide }, script: S.guide, created_at: S.scanDate }] },
};
const PRACTITIONER = { contactId: 'C-prac', isPractitioner: true };
const ARGS = { clientId: String(CLIENT.id), query: 'Sentinel', selectScans: true };

// Everything planted, as it could appear in JSON (numbers in any rounding the tools use).
const forbidden = () => {
  const out = [S.scanDate, S.scanId, S.bioId, S.dob, S.sex, S.phone, S.email, S.address, S.city, S.file, S.note, S.guide, '"high"', 'severity', 'disbalance', 'date_of_birth'];
  for (const n of [S.energy, S.stress, S.chakra, S.align, S.disb, S.disb2, S.delta, S.before, S.after, S.trendMin, S.trendMax, S.trendAvg]) {
    out.push(String(n), n.toFixed(1), n.toFixed(2), String(Math.round(n)) === '91' ? '91' : n.toFixed(1));
  }
  return [...new Set(out)];
};

async function runAll(env = {}) {
  _setMcpReaderForTest(async (tool) => structuredClone(FAKE[tool] ?? {}));
  const out = {};
  try {
    for (const t of TOOLS.filter((x) => x.role === 'practitioner' && x.where === 'server')) {
      const result = await runTool(t.name, ARGS, PRACTITIONER);
      out[t.name] = { result, model: modelView(t.name, result, env) };
    }
  } finally { _setMcpReaderForTest(null); }
  return out;
}

test('no planted sensitive value from any practitioner tool reaches the model copy', async () => {
  assert.equal(scanNarrationEnabled({}), false);
  const all = await runAll({});
  const names = Object.keys(all);
  assert.ok(names.length >= 10, `every practitioner tool ran (${names.join(', ')})`);
  for (const [name, { model }] of Object.entries(all)) {
    const s = JSON.stringify(model);
    for (const bad of forbidden()) assert.ok(!s.includes(bad), `${name} leaks ${bad} to the model: ${s}`);
  }
});

test('the model still gets what it needs: who, counts, and flagged area names', async () => {
  const all = await runAll({});
  assert.deepEqual(all.practitioner_list_clients.model.clients, [{ id: '4242', name: 'Client Sentinel' }]);
  assert.deepEqual(all.practitioner_find_client.model.clients, [{ id: '4242', name: 'Client Sentinel' }]);
  assert.equal(all.practitioner_get_client.model.name, 'Client Sentinel');
  assert.deepEqual(all.practitioner_flagged_clients.model.clients[0].flagged, ['Liver (organ) — flagged']);
  assert.deepEqual(all.practitioner_suggested_services.model.flagged, ['Liver (organ) — flagged']);
  assert.deepEqual(all.practitioner_suggested_services.model.services, [{ id: '7', name: 'Lymphatic massage', covers: ['Liver'] }]);
  assert.deepEqual(all.practitioner_follow_ups.model.suggestions[0].flagged_areas, ['Liver']);
  assert.equal(all.practitioner_client_files.model.count, 1);
  assert.equal(all.practitioner_client_latest_scan.model.opened, true);
});

test('the authorised Practice screen (page copy) keeps the detail', async () => {
  const all = await runAll({});
  const page = (n) => JSON.stringify(all[n].result);
  assert.ok(page('practitioner_get_client').includes(S.dob), 'DOB stays on the practitioner screen');
  assert.ok(page('practitioner_flagged_clients').includes(S.disb.toFixed(1)), 'values stay on the practitioner screen');
  assert.ok(page('practitioner_client_latest_scan').includes(String(Number(S.stress.toFixed(2)))), 'readings stay on the practitioner screen');
  assert.ok(page('practitioner_client_files').includes(S.file));
});

test('a practitioner tool without an explicit model view fails closed', () => {
  const v = modelView('practitioner_some_future_tool', { secret: S.dob, value: S.disb }, {});
  assert.equal(JSON.stringify(v).includes(S.dob), false);
  assert.match(v.note, /on the practitioner's screen/);
  assert.deepEqual(modelView('navigate', { screen: 'today' }, {}), { screen: 'today' }, 'non-practitioner tools are unchanged');
});

test('partner AI recommendations are a disabled source: no partner call, nothing to the model', async () => {
  assert.equal(ml.partnerAiRecommendationsEnabled({}), false);
  assert.equal(ml.partnerAiRecommendationsEnabled({ GAIA_PARTNER_AI_RECOMMENDATIONS: 'true' }), false, 'only the exact value "on"');
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify(FAKE.get_customer_recommendations)); };
  assert.equal(await ml.memberGuides({}, 'any-member', { env: { GAIA_PRACTITIONERS_MEMBER_API_KEY: 'k' }, fetchImpl }), null);
  assert.equal(calls, 0, 'no partner call while disabled');
  const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const i = srv.indexOf('if (!partnerAiRecommendationsEnabled()) {');
  assert.ok(i > 0 && i < srv.indexOf('const text = await memberGuidesCached(cid);'), 'the prompt checks the switch before any guide is read');
});

test('the tool route still hands the model the model copy', () => {
  const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(srv, /sendJson\(res, 200, \{ ok: true, name, result, model: modelView\(name, result\) \}/);
});
