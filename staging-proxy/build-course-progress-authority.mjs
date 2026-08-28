import crypto from 'node:crypto';
import fs from 'node:fs';

const SOURCE = '/root/gaia-staging-proxy/data/backfill-source.json';
const ALIASES = '/root/gaia-staging-proxy/data/course-authority-aliases.json';

function courseGroupKey(title = '') {
  let value = String(title).toLowerCase().trim();
  value = value.replace(/\(.*?(payment|installment|pay |month|st|nd|rd|th|recording|vip|zoom|in-person|virtual|online|recording|swag|free).*?\)/g, ' ');
  value = value.replace(/\b(payment|installment|1st|2nd|3rd|4th|st payment|nd payment|over \d+ months|recording|vip package|swag bag|second person|group)\b/g, ' ');
  value = value.replace(/^(events?\s*-\s*|learning\s*-\s*|in-person\s*-\s*|virtual\s*-\s*|online\s*-\s*)/g, ' ');
  value = value.replace(/(bio-well\s*\d\.\d.*?\+|device.*?\+)/g, ' ');
  return value.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
if (!String(source.builtFrom || '').includes('Course Progress CSV')) {
  throw new Error('Refusing unverified course source');
}
const current = JSON.parse(fs.readFileSync(ALIASES, 'utf8'));
const aliases = Array.isArray(current.aliases) ? [...current.aliases] : [];
const byKey = new Map(aliases.map((item) => [item.alias_key, item]));

const sourceCourses = Array.isArray(source.courses)
  ? source.courses
  : Object.keys(source.courses || {});
for (const title of sourceCourses) {
  const aliasKey = courseGroupKey(title);
  if (!aliasKey || byKey.has(aliasKey)) continue;
  const id = `lms-export:${crypto.createHash('sha256').update(aliasKey).digest('hex').slice(0, 16)}`;
  const item = {
    alias_key: aliasKey,
    alias_name: title,
    canonical_id: id,
    canonical_title: title,
    resolution_method: 'ghl_course_progress_export',
    in_products_or_catalog: false,
    provenance: `${source.builtFrom}; ${source.totalEntitlements} real enrollment rows, ${source.uniqueMembers} members`,
    technical_debt: false,
    pending_authoritative_sync: false,
    approved: true,
  };
  aliases.push(item);
  byKey.set(aliasKey, item);
}

const output = {
  version: 2,
  note: 'Approved course authority from the real GHL Course Progress export plus reviewed live aliases. The ledger is never authority.',
  generatedAt: new Date().toISOString(),
  sourceEvidence: {
    builtFrom: source.builtFrom,
    totalEntitlements: source.totalEntitlements,
    uniqueMembers: source.uniqueMembers,
    courseCount: sourceCourses.length,
  },
  aliases: aliases.sort((a, b) => String(a.alias_name).localeCompare(String(b.alias_name))),
};
const temp = `${ALIASES}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, ALIASES);
fs.chmodSync(ALIASES, 0o600);
console.log(JSON.stringify({ ok: true, aliases: output.aliases.length, sourceCourses: sourceCourses.length }));
