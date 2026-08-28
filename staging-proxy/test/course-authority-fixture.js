import fs from 'node:fs';
import path from 'node:path';

export function installCourseAuthority(workdir, ids) {
  const authorityFile = path.join(workdir, 'data', 'course-authority.json');
  const aliasFile = path.join(workdir, 'data', 'course-authority-aliases.json');
  const courses = [...new Set(ids)].map((id) => ({ id, title: id, groupKey: id.toLowerCase() }));
  fs.writeFileSync(authorityFile, JSON.stringify({ version: 1, courses, ambiguous_keys: {} }));
  fs.writeFileSync(aliasFile, JSON.stringify({ version: 1, aliases: [] }));
  process.env.COURSE_AUTHORITY_FILE = authorityFile;
  process.env.COURSE_ALIAS_FILE = aliasFile;
}
