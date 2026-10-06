const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'gaia-avatar.js'), 'utf8');
const block = src.slice(src.indexOf('const SUGGEST = ['), src.indexOf('function considerSuggestions'));
test('contextual suggestions are local, capped and remembered', () => {
  assert.match(src, /suggestedThisSession >= 2/, 'at most two a session');
  assert.match(src, /markSeen\(s\.key\)/, 'each at most once per device');
  assert.match(src, /!bubble\.hidden \|\| convoOpen \|\| pointing/, 'never over another bubble or a conversation');
  assert.doesNotMatch(block, /openChat\(['"`]|assist-send|startVoice/, 'no suggestion sends a message or starts voice');
  for (const chip of block.match(/chips: \[[^\]]*\]/g)) assert.doesNotMatch(chip, /'talk'/, 'no voice chip in a suggestion');
});
test('no suggestion claims Gaia reads reading values', () => {
  assert.doesNotMatch(block, /explain what changed|summari[sz]e/i);
});
