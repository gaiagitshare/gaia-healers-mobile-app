import fs from 'node:fs';
import path from 'node:path';

export function installCourseAuthority(workdir, ids) {
  const authorityFile = path.join(workdir, 'data', 'course-authority.json');
  const aliasFile = path.join(workdir, 'data', 'course-authority-aliases.json');
  // Accepts either a bare id or { id, title } — some scenarios turn on the
  // human name (an id-keyed grant revoked by name only), so the title has to be
  // settable rather than always echoing the id.
  const seen = new Set();
  const courses = [];
  for (const entry of ids) {
    const id = typeof entry === 'string' ? entry : entry.id;
    const title = typeof entry === 'string' ? entry : (entry.title || entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    courses.push({ id, title, groupKey: String(title).toLowerCase() });
  }
  fs.writeFileSync(authorityFile, JSON.stringify({ version: 1, courses, ambiguous_keys: {} }));
  fs.writeFileSync(aliasFile, JSON.stringify({ version: 1, aliases: [] }));
  process.env.COURSE_AUTHORITY_FILE = authorityFile;
  process.env.COURSE_ALIAS_FILE = aliasFile;
}
