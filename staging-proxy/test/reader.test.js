import test from 'node:test';
import assert from 'node:assert/strict';
import { allowed, sanitize, parseFeed, decodeEntities, ALLOWED_HOSTS } from '../membership/reader.js';

/* The reader fetches a remote URL on the server's behalf, so the allowlist is
 * the whole security boundary: it is what stops it becoming an open proxy into
 * the VPS's own network. These tests guard that boundary, not the formatting. */
test('only Gaia hosts are readable', () => {
  assert.ok(allowed('https://gaiahealers.com/pages/x'));
  assert.ok(allowed('https://www.gaiahealers.com/blogs/news'));
  for (const bad of [
    'https://evil.example.com/',
    'http://169.254.169.254/latest/meta-data/',   // cloud metadata
    'http://127.0.0.1:8787/api/events',           // the proxy itself
    'http://localhost/',
    'file:///etc/passwd',
    'https://gaiahealers.com.evil.com/',          // suffix confusion
    'https://notgaiahealers.com/',
  ]) assert.equal(allowed(bad), false, bad + ' must be refused');
});

test('allowlist is not accidentally broad', () => {
  assert.deepEqual([...ALLOWED_HOSTS].sort(), ['gaiahealers.com', 'www.gaiahealers.com']);
});

test('sanitize removes every script vector', () => {
  const dirty = '<p onclick="steal()">hi</p><script>bad()</script>'
    + '<a href="javascript:bad()">x</a><iframe src="//evil"></iframe>'
    + '<form action="/x"><input name="card"></form><img src=x onerror="bad()">';
  const clean = sanitize(dirty, 'https://gaiahealers.com/pages/x');
  for (const vector of ['<script', 'onclick', 'onerror', 'javascript:', '<iframe', '<form', '<input']) {
    assert.ok(!clean.toLowerCase().includes(vector), 'leaked: ' + vector);
  }
  assert.ok(clean.includes('hi'), 'text content should survive');
});

test('sanitize makes links absolute and safe to open', () => {
  const clean = sanitize('<a href="/pages/about">About</a>', 'https://gaiahealers.com/blogs/news');
  assert.ok(clean.includes('https://gaiahealers.com/pages/about'));
  assert.ok(clean.includes('rel="noopener noreferrer"'));
});

test('parseFeed reads Shopify atom entries', () => {
  const feed = '<feed><entry><title>One</title><link href="https://gaiahealers.com/a"/>'
    + '<summary>First</summary></entry><entry><title>Two &amp; more</title>'
    + '<link href="https://gaiahealers.com/b"/></entry></feed>';
  const items = parseFeed(feed);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'One');
  assert.equal(items[1].title, 'Two & more', 'entities should be decoded');
  assert.equal(items[0].url, 'https://gaiahealers.com/a');
});

test('decodeEntities handles named, decimal and hex forms', () => {
  assert.equal(decodeEntities('Rest &amp; Recovery'), 'Rest & Recovery');
  assert.equal(decodeEntities('Here&#8217;s why'), 'Here’s why');
  assert.equal(decodeEntities('caf&#xE9;'), 'café');
  assert.equal(decodeEntities('&notareal; stays'), '&notareal; stays');
  assert.equal(decodeEntities('&#999999999999;'), '&#999999999999;', 'out of range is left alone');
});

test('sanitize drops head-only tags that leak into Shopify page bodies', () => {
  const clean = sanitize('<meta charset="UTF-8"><link rel="x"><title>t</title><p>Real text</p>',
    'https://gaiahealers.com/pages/x');
  for (const leak of ['<meta', '<link', '<title']) {
    assert.ok(!clean.toLowerCase().includes(leak), 'leaked: ' + leak);
  }
  assert.ok(clean.includes('Real text'));
});
