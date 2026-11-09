/* Brand guard — the customer-facing brand is "Gaia Healers".
 *
 * Fails when customer-facing copy (HTML text/attributes, JS strings that reach
 * the DOM / notifications / emails, Python strings, manifest and JSON display
 * values, store copy) names the platform as a bare "Gaia".
 *
 * Allowed without listing: "Gaia Healers", code comments, console/log lines,
 * docstrings, identifiers (GaiaUI, gaia-*.js, data-gaia-*, GAIA_*).
 * Allowed only through scripts/brand-allowlist.json: proper names that are not
 * the platform — Gaia Practitioners (partner platform), Gaia Assist and the
 * "Gaia" assistant character (Ask Gaia, Talk to Gaia, Gaia is thinking…), and
 * a few named features / technical values, each with its reason.
 *
 * The classifier is scripts/brand-audit.mjs; run it with --csv for the full
 * inventory. If this test fails on new copy: write "Gaia Healers", or — if the
 * "Gaia" is really the assistant character or another proper name — add the
 * narrowest phrase to the allowlist with a reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/brand-audit.mjs');

test('no customer-facing copy names the platform as a bare "Gaia"', async () => {
  const { scan } = await load();
  const bad = scan().filter((r) => r.cls === 'REPLACE');
  assert.deepEqual(bad.map((r) => `${r.file}:${r.line}  ${r.snippet}`), [],
    'write "Gaia Healers" (or allowlist a genuine proper name in scripts/brand-allowlist.json)');
});

test('the classifier catches a planted regression and leaves proper names and code alone', async () => {
  const { scan } = await load();
  const files = ['plant.html', 'plant.js', 'plant.webmanifest'];
  const sources = {
    'plant.html': '<title>Welcome to Gaia</title><p>Ask Gaia anything</p><img alt="Gaia logo" class="gaia-x">'
      + '<!-- Gaia comment --><p>Gaia Healers and Gaia Practitioners</p>',
    'plant.js': "// Gaia owns this\nconst a = 'Join Gaia today'; console.log('[Gaia] boot'); window.GaiaUI = 1;\n"
      + "const b = `Hi, I'm Gaia. ${x} Your Gaia account`; const c = /Gaia/;",
    'plant.webmanifest': '{"name": "Gaia", "short_name": "Gaia Healers", "id": "Gaia"}',
  };
  const out = scan({ files, sources });
  const of = (file, cls) => out.filter((r) => r.file === file && r.cls === cls).map((r) => r.snippet);
  assert.equal(of('plant.html', 'REPLACE').length, 2, 'title + alt text: ' + JSON.stringify(of('plant.html', 'REPLACE')));
  assert.equal(of('plant.html', 'KEEP_PROPER_NAME').length, 2, 'Ask Gaia + Gaia Practitioners');
  assert.equal(of('plant.html', 'OK_BRAND').length, 1);
  assert.equal(of('plant.html', 'TECHNICAL').length, 1, 'the HTML comment');
  assert.equal(of('plant.js', 'REPLACE').length, 2, 'Join Gaia today + Your Gaia account: ' + JSON.stringify(of('plant.js', 'REPLACE')));
  assert.equal(of('plant.js', 'KEEP_PROPER_NAME').length, 1, "Hi, I'm Gaia");
  assert.equal(of('plant.js', 'TECHNICAL').length, 3, 'comment, console line, regex (code identifiers are never extracted)');
  assert.equal(of('plant.webmanifest', 'REPLACE').length, 1, 'manifest name');
  assert.equal(of('plant.webmanifest', 'OK_BRAND').length, 1);
});

test('every allowlist entry is still needed (no stale exemptions)', async () => {
  const { scan, loadAllowlist } = await load();
  const used = new Set(scan().filter((r) => r.cls !== 'REPLACE').map((r) => r.reason));
  const stale = loadAllowlist().filter((e) => !used.has(e.reason)).map((e) => e.pattern);
  assert.deepEqual(stale, [], 'remove allowlist entries that no longer match anything');
});

test('the manifest and page titles carry the full brand', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const root = path.join(__dirname, '..');
  const mf = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.match(mf.name, /^Gaia Healers\b/);
  assert.match(mf.short_name, /^Gaia Healers$/);
  for (const f of ['index.html', 'home.html', 'profile.html', 'academy.html', 'community.html', 'biowell.html']) {
    const html = fs.readFileSync(path.join(root, f), 'utf8');
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    assert.match(title, /Gaia Healers/, `${f} <title>`);
  }
});
