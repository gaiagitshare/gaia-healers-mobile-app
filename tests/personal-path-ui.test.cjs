// Personal Path in the app: calm, escaped, no AI, no upsell, provenance kept apart.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('gaia-path.js'), css = read('gaia-path.css'), avatar = read('gaia-avatar.js'), html = read('home.html');
const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the path is wired into the page and the practice view', () => {
  assert.match(html, /id="member-path"/); assert.match(html, /gaia-path\.js\?v=/); assert.match(html, /gaia-path\.css\?v=/);
  assert.match(read('gaia-practitioner.js'), /GaiaPath\.mountPractice\(root\.querySelector\('\[data-prac-recommend\]'\)/, 'only mounted for a linked Gaia member client');
});

test('everything from the server is escaped; nothing calls a model', () => {
  for (const f of ['it.title', 'it.reason', 'it.note', 'it.practitioner_name', 'it.lock.label', 'x.title']) assert.ok(js.includes('esc(' + f + ')'), f + ' is escaped');
  assert.doesNotMatch(code, /innerHTML\s*=\s*[^;]*\$\{(?!esc\()[a-z]+\.(title|reason|note)\}/i);
  assert.doesNotMatch(code, /api\/assist\/(chat|voice|tool)/, 'the path involves no AI');
});

test('calm: no upsell, guilt or warning language, no red states, no scores', () => {
  assert.doesNotMatch(code, /upgrade|don.t miss|hurry|only \d+ left|overdue|you haven.t|streak|points|%\s*complete/i);
  assert.doesNotMatch(css, /--g-danger|--g-warn|#e5715a|red/i, 'no warning colours for ordinary wellness steps');
  assert.match(js, /This is included with|lock\.label/); assert.match(js, /Show me a free option/);
});

test('provenance: "Recommended by your practitioner" only for practitioner_manual items', () => {
  const uses = js.match(/Recommended by your practitioner/g) || [];
  assert.ok(uses.length >= 1);
  assert.match(js, /const prac = it\.provenance\?\.source_type === 'practitioner_manual';/);
});

test('practitioner flow: preview before confirm, plain text only, matches are not recommendations', () => {
  assert.match(js, /data-gpath-confirm disabled/, 'confirm starts disabled until a preview');
  assert.match(js, /Suggested matches/); assert.match(js, /Not a recommendation until you choose and confirm one/);
  assert.match(js, /confirm: true/);
});

test('Gaia answers "What\'s next for me?" from the path, never a model', () => {
  assert.match(avatar, /pathnext: \{ label: 'What\\'s next for me\?'/);
  assert.match(avatar, /You're caught up\. You can explore today's energy check, continue learning, or ask me anything\./);
  assert.match(avatar, /window\.GaiaPath\.next\(\)/);
});

test('"I did this" only for self-guided steps; a service offers View service and Book instead', () => {
  assert.match(js, /it\.completion === 'member' && !it\.lock \? '<button type="button" class="gpath__quiet" data-path-do="done">I did this<\/button>'/);
  assert.match(js, /Book with \$\{esc\(it\.practitioner_name/);
  assert.match(js, /if \(how === 'done' && it\.completion !== 'member'\) return false;/);
});

test('Gaia explains only approved reasons and never reconstructs them', () => {
  assert.match(avatar, /Your practitioner's reason: “\$\{it\.reason\}”/);
  assert.match(avatar, /Your practitioner recommended this after reviewing your information\. I can open it for you, or help you contact them for more detail\./);
  for (const k of ['pathwhy', 'pathdone', 'pathafter', 'pathfree']) assert.match(avatar, new RegExp(k + ': \\{ label:'));
});
