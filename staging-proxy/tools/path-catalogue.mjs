#!/usr/bin/env node
/**
 * path-catalogue — review the Personal Path catalogue. Local file edits only:
 * no network, no model.
 *
 *   node tools/path-catalogue.mjs list
 *   node tools/path-catalogue.mjs show <id>
 *   node tools/path-catalogue.mjs approve <id> --reviewer <contactId> [--note "..."]
 *   node tools/path-catalogue.mjs reject  <id> --reviewer <contactId> --note "why"
 *   node tools/path-catalogue.mjs retire  <id> --reviewer <contactId>
 *
 * Reviewers are an authorized ROLE, not a name in code: GAIA_PATH_REVIEWERS is
 * a comma-separated list of contact ids allowed to approve. An entry's author
 * (created_by) cannot approve it. Approval is recorded AT the entry's current
 * version, so any later edit (version bump) needs approval again. Every
 * action is appended to data/path-catalogue-audit.jsonl. The catalogue file is
 * GAIA_PATH_CATALOGUE_FILE or the repo's path-catalogue.json; commit the
 * change so the approval travels with the code.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CATALOGUE_FILE, servable } from '../personal-path.js';

const file = process.env.GAIA_PATH_CATALOGUE_FILE || CATALOGUE_FILE;
const audit = process.env.GAIA_PATH_CATALOGUE_AUDIT || path.join(process.cwd(), 'data', 'path-catalogue-audit.jsonl');
const [cmd, id] = process.argv.slice(2);
const arg = (k) => { const a = process.argv.indexOf('--' + k); return a > 0 ? process.argv[a + 1] : ''; };
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const entry = id ? raw.entries.find((e) => e.id === id) : null;
const reviewers = String(process.env.GAIA_PATH_REVIEWERS || '').split(',').map((s) => s.trim()).filter(Boolean);

function save(action, extra = {}) {
  raw.version = (Number(raw.version) || 0) + 1;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  const row = { at: new Date().toISOString(), actor: arg('reviewer'), role: 'path_reviewer', action, id, version: entry.version,
    hash: crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16), ...extra };
  fs.mkdirSync(path.dirname(audit), { recursive: true });
  fs.appendFileSync(audit, JSON.stringify(row) + '\n');
  console.log(`${action}: ${id} v${entry.version} (catalogue v${raw.version})`);
}
function reviewer() {
  const who = arg('reviewer');
  if (!who || !reviewers.includes(who)) { console.error('refused: --reviewer must be one of GAIA_PATH_REVIEWERS'); process.exit(2); }
  if (entry.created_by && entry.created_by === who) { console.error('refused: the author cannot approve their own entry'); process.exit(2); }
  return who;
}

if (cmd === 'list') {
  for (const e of raw.entries) console.log(`${servable(e) ? 'SERVED ' : '       '} ${e.id.padEnd(26)} ${e.kind.padEnd(8)} v${e.version} ${e.status}${e.active ? '' : ' (inactive)'}  ${e.title}`);
} else if (!entry) {
  console.error('usage: list | show <id> | approve|reject|retire <id> --reviewer <contactId>'); process.exit(1);
} else if (cmd === 'show') {
  console.log(JSON.stringify(entry, null, 2));
} else if (cmd === 'approve') {
  const who = reviewer();
  if (!Array.isArray(entry.sources) || !entry.sources.length) { console.error('refused: an entry without a source cannot be approved'); process.exit(2); }
  if (entry.source_type === 'partner_ai') { console.error('refused: partner AI output is a disabled source'); process.exit(2); }
  entry.status = 'approved'; entry.approval = { by: who, role: 'path_reviewer', at: new Date().toISOString(), version: entry.version, note: arg('note') || undefined };
  save('approve');
} else if (cmd === 'reject') {
  reviewer(); entry.status = 'rejected'; entry.approval = null; save('reject', { note: arg('note') });
} else if (cmd === 'retire') {
  reviewer(); entry.active = false; entry.status = 'retired'; save('retire');
} else { console.error('unknown command'); process.exit(1); }
