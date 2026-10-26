#!/usr/bin/env node
/**
 * GHL setup spec + dry-run diff (READ-ONLY, makes no network call).
 *
 *   node src/cli/ghl-setup-report.js --spec           # the GHL admin spec only (no database)
 *   node src/cli/ghl-setup-report.js                  # spec + what Membership 2.0 would write, from the legacy mirror
 *     [--json] [--show-ids]                           # contact ids are masked unless --show-ids
 *
 * Environment: MEMBERSHIP_DATABASE_URL (loopback only) for the diff. No GHL
 * token is read and no GHL client is created: the data comes from the
 * existing read-only legacy import in the database. Nothing is written.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPool as defaultCreatePool } from '../db.js';
import { GHL_FIELDS, WORKFLOW_CHANGES, allTagNames, planLegacyGhlWrites } from '../providers/ghl/setup-spec.js';

const LABEL = 'ghl-setup-report';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function main(argv = process.argv.slice(2), { env = process.env, createPool = defaultCreatePool, now = new Date(),
  out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n') } = {}) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, options: { spec: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, 'show-ids': { type: 'boolean', default: false } } }).values;
  } catch (e) { err(`[${LABEL}] ${e.message}`); return 2; }
  const tags = allTagNames();
  let report = null;
  if (!a.spec) {
    if (!env.MEMBERSHIP_DATABASE_URL) { err(`[${LABEL}] REFUSED: the diff needs MEMBERSHIP_DATABASE_URL (or pass --spec)`); return 2; }
    if (!LOOPBACK.has(new URL(env.MEMBERSHIP_DATABASE_URL).hostname)) { err(`[${LABEL}] REFUSED: loopback database only`); return 2; }
    const pool = createPool(env.MEMBERSHIP_DATABASE_URL, { max: 2 });
    try { report = await planLegacyGhlWrites(pool, { now, showIds: a['show-ids'] }); } finally { await pool.end().catch(() => {}); }
  }
  if (a.json) { out(JSON.stringify({ fields: GHL_FIELDS, tags, workflows: WORKFLOW_CHANGES, report }, null, 1)); return 0; }

  out(`[${LABEL}] GHL custom fields to create (contact fields; key must read contact.<key>; never created by code):`);
  for (const f of GHL_FIELDS) out(`  ${f.key.padEnd(34)} "${f.name}"  ${f.type}  values: ${f.values.join(' | ')}  (${f.note})`);
  out(`[${LABEL}] tags Membership 2.0 may write (gaia-m: prefix only; ahc-* and every other tag are never touched):`);
  for (const [group, list] of Object.entries(tags)) out(`  ${group.padEnd(8)} ${list.join(', ')}`);
  out(`[${LABEL}] workflow changes for the GHL admin (none are made by code):`);
  for (const w of WORKFLOW_CHANGES) out(`  ${w.id} [${w.when}] ${w.what}`);
  if (report) {
    const s = report.summary;
    out(`[${LABEL}] dry-run diff from the legacy mirror (baseline: ${report.baseline}):`);
    out(`  rows ${s.rows}; contacts ${s.contacts}; rows without contact id ${s.noContactId}; contacts with a legacy tag ${s.legacyTagged}; held (unknown status) ${s.held}`);
    out(`  live unclassified (unmapped / ambiguous) ${s.unclassified}; live PayPal ${s.paypal}; ended rows ${s.ended}; needs review ${s.needsReview}`);
    out(`  tag additions: ${Object.entries(s.tagAdds).map(([t, n]) => `${t} x${n}`).join(', ') || 'none'}`);
    out(`  field values: ${Object.entries(s.fieldSets).map(([t, n]) => `${t} x${n}`).join(', ') || 'none'}`);
    for (const c of report.contacts) {
      out(`  contact ${c.contact}${c.linkedPerson ? '' : ' (no Gaia person yet)'}: +${c.addTags.join(' +') || ' nothing'}${c.holdTags.length ? `; hold ${c.holdTags.join(',')}` : ''}${c.setFields.length ? `; set ${c.setFields.join(', ')}` : ''}`);
      for (const n of c.notes) out(`      ${n}`);
    }
    out(`[${LABEL}] nothing was written; no GHL request was made.`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`[${LABEL}] ${e.message}\n`); process.exitCode = 3; });
}
