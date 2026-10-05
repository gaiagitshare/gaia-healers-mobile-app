#!/usr/bin/env node
/**
 * USAGE REPORT — what Gaia Assist actually cost, from the accounting log.
 *
 * Read-only, offline. Reads data/assist-usage.jsonl and any rotated
 * assist-usage.jsonl.N(.gz) beside it, and prints totals by channel, provider,
 * model and session state. It makes NO network request: name resolution is
 * disabled before anything else runs, so even a bug could not reach a
 * provider.
 *
 * Every number is labelled by where it came from:
 *   REPORTED    the provider's own token counts (the raw records)
 *   ESTIMATED   dollars, computed from reported counts and the price book
 *               (assist-pricing.js). Partial where a modality was not reported.
 *   UNAVAILABLE no count, or no price on file for that model
 *
 *   node tools/assist-usage-report.mjs                  # everything on file
 *   node tools/assist-usage-report.mjs --today
 *   node tools/assist-usage-report.mjs --yesterday
 *   node tools/assist-usage-report.mjs --last 7         # days
 *   node tools/assist-usage-report.mjs --from 2026-10-01 --to 2026-10-07
 *   node tools/assist-usage-report.mjs --file other.jsonl
 *   node tools/assist-usage-report.mjs --json           # machine-readable
 *   node tools/assist-usage-report.mjs --yesterday --write-daily
 *                                   # also saves data/usage-reports/YYYY-MM-DD.txt
 *   node tools/assist-usage-report.mjs --alerts other.json
 *                                   # the incident ledger to summarise (default data/system-alerts.json)
 *
 * Before the alerts, a MEMBER LINKS line counts the member-results events in
 * the window (codes asked for, links confirmed, readings opened, links
 * revoked) from data/member-links.json's audit -- counts only, never an id
 * (--links other.json to point elsewhere).
 *
 * The report ends with the open SYSTEM ALERTS from the proxy's incident ledger
 * (counts and delivery counters only -- never an incident's evidence text), so
 * one daily file says both what Assist cost and what is still burning.
 */
import dns from 'node:dns';
dns.lookup = (host, opts, cb) => { const e = new Error('usage report is offline: refused ' + host); e.code = 'ENOTFOUND'; (typeof opts === 'function' ? opts : cb)(e); };

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { priceFor, priceById, costFromUsage } from '../assist-pricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };

// ── window ────────────────────────────────────────────────────────────────
const dayOf = (d) => d.toISOString().slice(0, 10);
const today = new Date();
let from = null; let to = null; let label = 'all records on file';
if (flag('--today')) { from = dayOf(today); to = from; label = `today (${from})`; }
else if (flag('--yesterday')) { const y = new Date(today.getTime() - 86400000); from = dayOf(y); to = from; label = `yesterday (${from})`; }
else if (value('--last')) { const n = Number(value('--last')); const s = new Date(today.getTime() - (n - 1) * 86400000); from = dayOf(s); to = dayOf(today); label = `last ${n} days (${from} to ${to})`; }
else if (value('--from') || value('--to')) { from = value('--from'); to = value('--to') || dayOf(today); label = `${from || 'start'} to ${to}`; }

// ── read ──────────────────────────────────────────────────────────────────
function sources() {
  if (value('--file')) return [value('--file')];
  const dir = path.join(root, 'data');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^assist-usage\.jsonl(\.\d+)?(\.gz)?$/.test(f)).map((f) => path.join(dir, f));
}
function readRecords(file) {
  let text = fs.readFileSync(file);
  if (file.endsWith('.gz')) text = zlib.gunzipSync(text);
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { out.push({ _malformed: true }); }
  }
  return out;
}
const files = sources();
let all = files.flatMap(readRecords);
const malformed = all.filter((r) => r._malformed).length;
all = all.filter((r) => !r._malformed && typeof r.at === 'string');
const inWindow = all.filter((r) => { const d = r.at.slice(0, 10); return (!from || d >= from) && (!to || d <= to); });

// ── aggregate ─────────────────────────────────────────────────────────────
const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const sum = (rows, k) => rows.reduce((a, r) => a + (num(r[k]) || 0), 0);
const reportedCount = (rows, k) => rows.filter((r) => num(r[k]) != null).length;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const p95 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

function cost(rows) {
  // Two figures: what was stored on the record (price in force when written)
  // and a recomputation from the raw counts under the price book as it is NOW.
  let stored = 0; let storedN = 0; let recomputed = 0; let recomputedN = 0; let partial = 0; let unpriced = 0;
  for (const r of rows) {
    if (num(r.estCostUsd) != null) { stored += r.estCostUsd; storedN += 1; }
    const entry = (r.priceList && priceById(r.priceList)) || priceFor(r.model, r.at);
    const c = costFromUsage(entry, r);
    if (c.usd == null) unpriced += 1;
    else { recomputed += c.usd; recomputedN += 1; if (c.basis === 'partial') partial += 1; }
  }
  return { stored, storedN, recomputed, recomputedN, partial, unpriced };
}

function block(rows) {
  const ok = rows.filter((r) => !r.outcome || r.outcome === 'ok');
  const failed = rows.filter((r) => r.outcome && r.outcome !== 'ok');
  const input = rows.map((r) => num(r.input)).filter((v) => v != null);
  const c = cost(rows);
  return {
    records: rows.length, replies_or_sessions_ok: ok.length, failed_attempts: failed.length,
    usage_reported_on: reportedCount(rows, 'input'), usage_missing_on: rows.length - reportedCount(rows, 'input'),
    input_tokens: sum(rows, 'input'), cached_input_tokens: sum(rows, 'cachedInput'),
    cache_hit_pct: pct(sum(rows, 'cachedInput'), sum(rows, 'input')),
    cached_reported_on: reportedCount(rows, 'cachedInput'),
    output_tokens: sum(rows, 'output'), reasoning_tokens: sum(rows, 'reasoning'), reasoning_reported_on: reportedCount(rows, 'reasoning'),
    text_in: sum(rows, 'textIn'), audio_in: sum(rows, 'audioIn'), text_out: sum(rows, 'textOut'), audio_out: sum(rows, 'audioOut'),
    modality_reported_on: reportedCount(rows, 'audioIn'),
    avg_input_per_record: input.length ? Math.round(sum(rows, 'input') / input.length) : null,
    median_input: median(input), p95_input: p95(input),
    turns: sum(rows, 'turns'), seconds: sum(rows, 'seconds'),
    est_cost_usd_stored: c.storedN ? +c.stored.toFixed(4) : null, est_cost_records_stored: c.storedN,
    est_cost_usd_recomputed: c.recomputedN ? +c.recomputed.toFixed(4) : null, est_cost_records_recomputed: c.recomputedN,
    est_cost_partial_records: c.partial, unpriced_records: c.unpriced,
    avg_cost_per_record: c.recomputedN ? +(c.recomputed / c.recomputedN).toFixed(6) : null,
    avg_cost_per_turn: (c.recomputedN && sum(rows, 'turns')) ? +(c.recomputed / sum(rows, 'turns')).toFixed(6) : null,
    errors: Object.fromEntries(Object.entries(failed.reduce((m, r) => { const k = r.error || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {}))),
  };
}
const groupBy = (rows, k) => Object.fromEntries([...new Set(rows.map((r) => r[k] || '(none)'))].sort().map((v) => [v, block(rows.filter((r) => (r[k] || '(none)') === v))]));

const report = {
  generatedAt: new Date().toISOString(),
  window: label, from, to,
  files: files.map((f) => path.relative(root, f)),
  records_on_file: all.length, records_in_window: inWindow.length, malformed_lines: malformed,
  first: inWindow.length ? inWindow.map((r) => r.at).sort()[0] : null,
  last: inWindow.length ? inWindow.map((r) => r.at).sort().pop() : null,
  total: block(inWindow),
  by_channel: groupBy(inWindow, 'channel'),
  by_provider_model: groupBy(inWindow.map((r) => ({ ...r, pm: `${r.provider}/${r.model}` + (r.account != null ? `#account${r.account}` : '') })), 'pm'),
  by_state: groupBy(inWindow, 'state'),
  legend: {
    REPORTED: 'token counts and turns/seconds come from the provider or the relay, as recorded',
    ESTIMATED: 'est_cost_* are computed from reported counts and assist-pricing.js; "partial" means a priced modality was not reported and was taken as zero',
    UNAVAILABLE: 'usage_missing_on counts records with no input count; unpriced_records have no price entry for their model',
  },
};

// ── member links (offline: the audit in the link store) ───────────────────
// Counts of events inside the window and the standing totals. The audit rows
// carry member and customer ids; none of them is read into the report.
function memberLinks() {
  const file = value('--links') || path.join(root, 'data', 'member-links.json');
  const rel = path.isAbsolute(file) && file.startsWith(root) ? path.relative(root, file) : file;
  if (!fs.existsSync(file)) return { file: rel, available: false, reason: 'no link store on file' };
  let store;
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { file: rel, available: false, reason: 'unreadable: ' + String(e.message || e).slice(0, 80) }; }
  const rows = Array.isArray(store?.audit) ? store.audit : [];
  const inside = rows.filter((r) => { const d = String(r?.at || '').slice(0, 10); return (!from || d >= from) && (!to || d <= to); });
  const count = (ev) => inside.filter((r) => r?.event === ev).length;
  const links = Object.values(store?.links || {});
  return {
    file: rel, available: true,
    in_window: { codes_issued: count('consent_code_issued'), links_confirmed: count('link_confirmed'), readings_opened: count('reading_opened'), links_revoked: count('link_revoked'), guides_read: count('guides_read') },
    standing: { confirmed: links.filter((l) => l?.status === 'confirmed').length, revoked: links.filter((l) => l?.status === 'revoked').length,
      confirmed_and_opened: links.filter((l) => l?.status === 'confirmed' && l?.seen_scanned_at).length },
  };
}

// ── system alerts (offline: the ledger the proxy's sweep maintains) ───────
// Keys, severities and counters only. `evidence`, `title`, `why` and
// `affected` can name a member and never enter the report.
function systemAlerts() {
  const file = value('--alerts') || path.join(root, 'data', 'system-alerts.json');
  const rel = path.isAbsolute(file) && file.startsWith(root) ? path.relative(root, file) : file;
  if (!fs.existsSync(file)) return { file: rel, available: false, reason: 'no incident ledger on file' };
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { file: rel, available: false, reason: 'unreadable: ' + String(e.message || e).slice(0, 80) }; }
  const incidents = Array.isArray(ledger?.incidents) ? ledger.incidents : [];
  const tally = (state) => incidents.filter((i) => (i?.state || 'open') === state).reduce((m, i) => { const k = i?.severity || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const now = Date.now();
  const open = incidents.filter((i) => (i?.state || 'open') !== 'resolved').map((i) => {
    const n = i?.notified || {};
    const first = Date.parse(i?.firstDetectedAt || '') || null;
    return {
      key: String(i?.key || ''), subsystem: String(i?.subsystem || ''), severity: String(i?.severity || 'unknown'),
      occurrences: Number(i?.occurrences) || 0,
      first_detected: i?.firstDetectedAt || null, last_detected: i?.lastDetectedAt || null,
      age_days: first ? Math.round((now - first) / 864000) / 100 : null,
      delivery: { attempts: Number(n.attempts) || 0, sent_at: n.sentAt || null, last_error: n.lastError ? String(n.lastError).slice(0, 60) : null },
    };
  }).sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1) || b.occurrences - a.occurrences);
  const undelivered = open.filter((i) => i.delivery.attempts > 0 && !i.delivery.sent_at);
  return {
    file: rel, available: true, updated_at: ledger?.updatedAt || null,
    open: tally('open'), resolved: tally('resolved'), open_incidents: open,
    delivery_failing: undelivered.length ? `${undelivered.length} open incident(s) have delivery attempts but were never sent (${[...new Set(undelivered.map((i) => i.delivery.last_error || 'no error recorded'))].join('; ')}). The sweep retries every minute; set ALERT_CONTACT_ID or resolve them.` : null,
  };
}
report.member_links = memberLinks();
report.system_alerts = systemAlerts();

// ── print ─────────────────────────────────────────────────────────────────
function fmt(n) { return n == null ? 'unavailable' : (typeof n === 'number' ? n.toLocaleString('en-US') : String(n)); }
function renderBlock(name, b) {
  const L = [];
  L.push(`${name}`);
  L.push(`  records ${fmt(b.records)}  (ok ${fmt(b.replies_or_sessions_ok)}, failed attempts ${fmt(b.failed_attempts)})   usage reported on ${fmt(b.usage_reported_on)}, missing on ${fmt(b.usage_missing_on)}`);
  L.push(`  REPORTED  input ${fmt(b.input_tokens)}   cached ${fmt(b.cached_input_tokens)} (${b.cache_hit_pct} of input; reported on ${fmt(b.cached_reported_on)})   output ${fmt(b.output_tokens)}   reasoning ${fmt(b.reasoning_tokens)} (reported on ${fmt(b.reasoning_reported_on)})`);
  L.push(`  REPORTED  text in ${fmt(b.text_in)}  audio in ${fmt(b.audio_in)}  text out ${fmt(b.text_out)}  audio out ${fmt(b.audio_out)}   (modality split reported on ${fmt(b.modality_reported_on)})`);
  L.push(`  REPORTED  per record: avg input ${fmt(b.avg_input_per_record)}  median ${fmt(b.median_input)}  p95 ${fmt(b.p95_input)}   turns ${fmt(b.turns)}  seconds ${fmt(b.seconds)}`);
  L.push(`  ESTIMATED cost: stored $${fmt(b.est_cost_usd_stored)} (${fmt(b.est_cost_records_stored)} rec)   recomputed under current price book $${fmt(b.est_cost_usd_recomputed)} (${fmt(b.est_cost_records_recomputed)} rec, ${fmt(b.est_cost_partial_records)} partial)   avg/record $${fmt(b.avg_cost_per_record)}  avg/turn $${fmt(b.avg_cost_per_turn)}`);
  L.push(`  UNAVAILABLE pricing on ${fmt(b.unpriced_records)} records` + (Object.keys(b.errors).length ? `   errors: ${JSON.stringify(b.errors)}` : ''));
  return L.join('\n');
}
function renderText() {
  const L = [];
  L.push(`GAIA ASSIST USAGE — ${report.window}`);
  L.push(`generated ${report.generatedAt}   files: ${report.files.join(', ') || '(none)'}`);
  L.push(`records on file ${fmt(report.records_on_file)}, in window ${fmt(report.records_in_window)}, malformed lines ${fmt(report.malformed_lines)}` + (report.first ? `   first ${report.first}  last ${report.last}` : ''));
  if (!report.records_in_window) { L.push('\nNo records in this window. (Zero real records is a valid result; nothing is estimated from nothing.)'); L.push(''); L.push(renderLinks(report.member_links)); L.push(''); L.push(renderAlerts(report.system_alerts)); return L.join('\n'); }
  L.push(''); L.push(renderBlock('TOTAL', report.total));
  for (const [title, groups] of [['BY CHANNEL', report.by_channel], ['BY PROVIDER / MODEL', report.by_provider_model], ['BY SESSION STATE', report.by_state]]) {
    L.push(''); L.push(`== ${title} ==`);
    for (const [k, b] of Object.entries(groups)) { L.push(renderBlock(k, b)); }
  }
  L.push(''); L.push('REPORTED = provider-reported counts. ESTIMATED = computed from counts and assist-pricing.js (never exact). UNAVAILABLE = not reported / no price on file.');
  L.push(''); L.push(renderLinks(report.member_links));
  L.push(''); L.push(renderAlerts(report.system_alerts));
  return L.join('\n');
}
function renderLinks(m) {
  const L = [];
  L.push(`== MEMBER LINKS (offline, ${m.file}) ==`);
  if (!m.available) { L.push(`  UNAVAILABLE: ${m.reason}`); return L.join('\n'); }
  const w = m.in_window, s = m.standing;
  L.push(`  in window: ${fmt(w.codes_issued)} codes asked for, ${fmt(w.links_confirmed)} links confirmed, ${fmt(w.readings_opened)} readings opened, ${fmt(w.links_revoked)} links revoked, ${fmt(w.guides_read || 0)} guide reads for Gaia Assist`);
  L.push(`  standing:  ${fmt(s.confirmed)} members sharing (${fmt(s.confirmed_and_opened)} have opened their readings), ${fmt(s.revoked)} stopped`);
  return L.join('\n');
}
function renderAlerts(a) {
  const L = [];
  L.push(`== SYSTEM ALERTS (offline, ${a.file}) ==`);
  if (!a.available) { L.push(`  UNAVAILABLE: ${a.reason}`); return L.join('\n'); }
  const tally = (t) => Object.entries(t).sort().map(([k, v]) => `${fmt(v)} ${k}`).join(', ') || 'none';
  L.push(`  ledger updated ${a.updated_at || 'unknown'}   open: ${tally(a.open)}   resolved: ${tally(a.resolved)}`);
  for (const i of a.open_incidents) {
    const d = i.delivery;
    L.push(`  ${i.severity.padEnd(8)} ${i.key}  [${i.subsystem}]  seen ${fmt(i.occurrences)}x since ${(i.first_detected || '?').slice(0, 10)} (${i.age_days == null ? '?' : i.age_days + ' d'}), last ${(i.last_detected || '?').slice(0, 16)}Z;  delivery attempts ${fmt(d.attempts)}, ${d.sent_at ? 'sent ' + d.sent_at.slice(0, 16) + 'Z' : 'never sent' + (d.last_error ? ' (' + d.last_error + ')' : '')}`);
  }
  if (!a.open_incidents.length) L.push('  no open incidents');
  if (a.delivery_failing) L.push(`  NOTE: ${a.delivery_failing}`);
  return L.join('\n');
}

const text = renderText();
if (flag('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else process.stdout.write(text + '\n');
if (flag('--write-daily')) {
  const day = to || dayOf(today);
  const dir = path.join(root, 'data', 'usage-reports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${day}.txt`), text + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stderr.write(`wrote data/usage-reports/${day}.txt and .json\n`);
}
