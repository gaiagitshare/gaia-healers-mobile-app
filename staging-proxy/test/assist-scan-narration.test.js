/**
 * SCAN NARRATION OFF (HIPAA gap, 4 Oct 2026): a scan tool's full result still
 * reaches the Practice card, but the model is told only that the reading is
 * on screen -- until a BAA-covered provider exists (GAIA_SCAN_NARRATION=on).
 * Also pins the My readings panel wiring in the app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { modelView, SCAN_TOOLS, scanNarrationEnabled } from '../assist-tools.js';
import { readApp } from './_app-present.js';

const FULL = { found: true, client: { id: '474', name: 'Client Name' }, scans_on_file: 12, latest: { scanned_at: '2026-09-24', stress: 3.9, energy: 54, chakras: [{ name: 'Root', value: 4.1, alignment: -1 }], most_out_of_balance: [{ area: 'organ', name: 'Liver', disbalance: 2 }] } };

test('with narration off, the model view of a scan result carries no values; the page result is untouched', () => {
  assert.equal(scanNarrationEnabled({}), false);
  for (const name of SCAN_TOOLS) {
    const v = modelView(name, FULL, {});
    assert.equal(v.opened, true); assert.deepEqual(v.client, FULL.client); assert.equal(v.scans_on_file, 12);
    assert.match(v.note, /Do not read out/);
    const s = JSON.stringify(v);
    assert.ok(!/3\.9|54|Root|Liver|latest|energy|stress/.test(s), `values leaked to the model for ${name}: ${s}`);
  }
  assert.deepEqual(modelView('practitioner_client_latest_scan', { found: false, reason: 'none' }, {}), { found: false, reason: 'none' }, 'a "nothing on file" answer passes through');
  assert.deepEqual(modelView('practitioner_list_clients', { count: 1, clients: [] }, {}), { count: 1, clients: [] }, 'non-scan tools are unchanged');
  assert.deepEqual(modelView('practitioner_client_latest_scan', FULL, { GAIA_SCAN_NARRATION: 'on' }), FULL, 'the switch restores narration');
});

test('the tool route sends `model` beside `result`, and the voice page hands the model `model`', () => {
  const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(srv, /sendJson\(res, 200, \{ ok: true, name, result, model: modelView\(name, result\) \}/);
  const voice = readApp('gaia-realtime-voice.js');
  assert.match(voice, /data: body\.model !== undefined \? body\.model : body\.result/);
  assert.match(voice, /data: body\.result \},/, 'the card still gets the full result');
});

test('My readings panel: present in the profile screen, script loaded, talks only to the link/readings routes, no AI', () => {
  const html = readApp('home.html');
  assert.match(html, /id="member-readings"[^>]*hidden/);
  assert.match(html, /gaia-my-readings\.js/);
  const js = readApp('gaia-my-readings.js');
  for (const route of ['/api/practitioners/member-link/status', '/api/practitioners/member-link/code', '/api/practitioners/member-link/unlink', '/api/practitioners/my-readings']) assert.ok(js.includes(route), route);
  assert.doesNotMatch(js, /api\/assist\/(chat|voice|tool)/, 'phase 1 involves no model');
  assert.match(js, /You can stop sharing at any time/);
  assert.match(js, /not a diagnosis/);
  assert.match(js, /credentials: 'include'/);
  assert.doesNotMatch(js, /localStorage|sessionStorage/, 'nothing cached in the browser');
});
