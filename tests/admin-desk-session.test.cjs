/**
 * Registered desk devices stay signed in (PR 1, audit S1).
 *
 * Door / check-in desks reach the Event Manager through Gaia Healers Admin ->
 * Events (the official entry point). Once the Control Center stopped treating
 * every Event login as an administrator, /api/admin/session answers
 * role 'event_staff' for those logins. The shell must then show Events only and
 * must NEVER clear the shared 'token' on a 401: that key is the Event iframe's
 * session, and clearing it would log every desk out on the event day.
 *
 * Source checks only (no browser, no network). A mocked-API Playwright run of
 * the same behaviour is described in the PR.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'admin', 'gadmin.js'), 'utf8');

test('the shell reads the event_staff role from the session answer', () => {
  assert.match(src, /ROLE = d\.role === 'event_staff' \? 'event_staff' : 'admin';/);
});

test('event staff see Events only', () => {
  assert.match(src, /function allowed\(v\) \{ return ROLE !== 'event_staff' \|\| v === 'events'; \}/);
  assert.match(src, /ROLE === 'event_staff' \? '' : '.*id="alertbtn"/, 'no System Alerts button (and no alert polling) for desks');
});

test('a 401 for event staff never clears the token or shows the login screen', () => {
  const i = src.indexOf("if (r.status === 401 && ROLE === 'event_staff') return { ok: false, __401: true };");
  const j = src.indexOf("if (r.status === 401) { setToken('');");
  assert.ok(i > 0, 'event_staff 401 branch exists');
  assert.ok(j > i, 'and runs before the branch that clears the token');
});

test('the cache-busting version moved with the change', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  assert.match(html, /gadmin\.js\?v=(\d+)/);
  assert.ok(Number(html.match(/gadmin\.js\?v=(\d+)/)[1]) >= 27);
});
