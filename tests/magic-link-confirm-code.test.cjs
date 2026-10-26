// Magic-link device binding (audit S4): the waiting screen must show the
// confirmation code the proxy returns, so a member whose link opens in another
// browser (iOS installed app vs Safari) can type it there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'gaia-ui.js'), 'utf8');

function loadCodeHtml() {
  const start = src.indexOf('function magicConfirmCodeHtml(');
  assert.ok(start > -1, 'magicConfirmCodeHtml exists');
  const end = src.indexOf('\n    }\n', start);
  return new Function(`${src.slice(start, end + 6)}; return magicConfirmCodeHtml;`)();
}

test('the waiting screen renders the 6-digit code', () => {
  const html = loadCodeHtml()('042917');
  assert.match(html, /data-magic-confirm-code/);
  assert.match(html, /042 917/);
  assert.match(html, /another browser or device/);
});

test('no code (older proxy) or a malformed one renders nothing, and markup cannot be injected', () => {
  const render = loadCodeHtml();
  assert.equal(render(undefined), '');
  assert.equal(render(''), '');
  assert.equal(render('12345'), '');
  assert.equal(render('<img src=x onerror=alert(1)>123456'.slice(0, 40)), '');
  assert.ok(!render('<b>123456</b>').includes('<b>'));
});

test('the sent message includes the code and polling understands awaiting_code', () => {
  assert.match(src, /magicConfirmCodeHtml\(payload\.confirmCode\)/);
  assert.match(src, /d\.status === 'awaiting_code'/);
});
