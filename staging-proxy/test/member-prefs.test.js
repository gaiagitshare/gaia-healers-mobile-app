/**
 * MEMBER PREFERENCES — a flat map of allowed booleans per member, kept on the
 * server so a phone and a laptop agree. Unknown keys and non-booleans never
 * reach the file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getPrefs, setPrefs, PREF_KEYS } = await import('../member-prefs.js');

test('defaults are false; only allowed boolean keys are stored; unknown keys are dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')); const file = path.join(dir, 'p.json');
  assert.deepEqual(getPrefs('c1', { file }), { next_level_collapsed: false });
  assert.deepEqual(setPrefs('c1', { next_level_collapsed: true, evil: '<script>', next_level_collapsed_x: true }, { file }), { next_level_collapsed: true });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw.c1).sort(), ['next_level_collapsed', 'updated_at']);
  assert.equal(setPrefs('c1', { next_level_collapsed: 'yes' }, { file }).next_level_collapsed, true, 'a string is not a boolean: ignored');
  assert.equal(setPrefs('c1', { next_level_collapsed: false }, { file }).next_level_collapsed, false);
  assert.equal(setPrefs('', { next_level_collapsed: true }, { file }), null, 'no member, nothing stored');
  assert.deepEqual(getPrefs('c2', { file }), { next_level_collapsed: false }, 'members do not see each other');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.ok(Object.keys(PREF_KEYS).length >= 1);
});

test('the app: Next level folds through the prefs route, empty cards fold to one line, Today carries the two numbers', () => {
  const read = (name) => { for (const base of ['../../', '../../gaia-healers-mobile-app-1/']) { try { return fs.readFileSync(new URL(base + name, import.meta.url), 'utf8'); } catch { /* next */ } } throw new Error(name + ' not found'); };
  const ui = read('gaia-membership-ui.js');
  assert.match(ui, /\/api\/member\/prefs/); assert.match(ui, /next_level_collapsed/); assert.match(ui, /data-next-toggle/);
  assert.doesNotMatch(ui, /localStorage/, 'kept on the server, not in the browser');
  const member = read('gaia-member.js');
  assert.match(member, /g-card--empty/);
  const panel = read('gaia-my-readings.js');
  assert.match(panel, /g-readings-nudge__nums/);
  const srv = read('staging-proxy/server.js');
  assert.match(srv, /url\.pathname === '\/api\/member\/prefs'/);
  assert.match(srv, /requireSessionMember\(req, res, origin\);\n      if \(!memberContext\) return;\n      const id = memberContext\.contactId/, 'signed-in members only, keyed by their own id');
});
