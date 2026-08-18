/**
 * The practice journal.
 *
 * It keeps a person's daily energy history — which centre asked for attention,
 * whether they kept the practice, and a private note. That is reflective
 * wellness data about someone's inner life, so the test that matters most here
 * is the one asserting it never leaves their device.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appTest, readApp } from './_app-present.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readApp('gaia-practice.js');

/** Boot the module against a minimal DOM and an in-memory localStorage. */
function boot({ now = new Date('2026-08-18T12:00:00') } = {}) {
  const store = new Map();
  const listeners = new Map();
  const node = () => ({
    innerHTML: '', textContent: '', dataset: {}, style: {},
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], prepend() {}, after() {}, remove() {},
    classList: { add() {}, remove() {} },
  });
  const doc = {
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => node(),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent: () => true,
  };
  const sandbox = {
    document: doc,
    window: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    CustomEvent: class { constructor(t, i) { this.type = t; Object.assign(this, i); } },
    console,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } },
    JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, setTimeout, clearTimeout,
  };
  sandbox.window.GaiaPractice = undefined;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'gaia-practice.js' });
  return { api: sandbox.window.GaiaPractice, store, listeners, sandbox };
}

const KEY = 'gaia:practice:v1';

appTest('the journal never sends anything anywhere', () => {
  // No endpoint, no beacon, no image ping. A private reflection has nowhere to
  // go by construction, not by policy.
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'new Image', 'axios', 'WebSocket']) {
    assert.ok(!SOURCE.includes(forbidden), `the journal must not contain ${forbidden}`);
  }
  assert.ok(!/https?:\/\//.test(SOURCE.replace(/^\s*\*.*$/gm, '')), 'no URL in the code');
});

appTest('visiting records the day — no button to press', () => {
  const { api, store } = boot();
  api.observe('Throat', '#3E9FF0');
  const data = JSON.parse(store.get(KEY));
  const today = Object.keys(data)[0];
  assert.equal(today, '2026-08-18');
  assert.equal(data[today].chakra, 'throat');
  assert.equal(data[today].colour, '#3E9FF0');
  assert.equal(data[today].done, undefined, 'recording a day is not claiming the practice was kept');
});

appTest('every centre name maps to a known key, and nonsense maps to none', () => {
  const { api, store } = boot();
  const cases = [['Root', 'root'], ['Sacral', 'sacral'], ['Solar plexus', 'solar'],
    ['Heart', 'heart'], ['Throat', 'throat'], ['Third eye', 'third-eye'], ['Crown', 'crown']];
  for (const [label, key] of cases) {
    store.clear();
    api.observe(label, '#fff');
    assert.equal(JSON.parse(store.get(KEY))['2026-08-18'].chakra, key);
  }
  store.clear();
  api.observe('Not a centre', '#fff');
  assert.equal(store.get(KEY), undefined, 'an unrecognised centre records nothing rather than guessing');
});

appTest('a streak counts consecutive kept days, and today not yet marked does not break it', () => {
  const { api, store } = boot();
  // yesterday and the day before were kept; today has not been marked yet
  store.set(KEY, JSON.stringify({
    '2026-08-15': { chakra: 'root', done: true },
    '2026-08-16': { chakra: 'heart', done: true },
    '2026-08-17': { chakra: 'throat', done: true },
    '2026-08-18': { chakra: 'crown' },
  }));
  assert.equal(api.streak(), 3, 'an unfinished today must not read as a broken run');

  // a genuine gap does break it
  store.set(KEY, JSON.stringify({
    '2026-08-14': { done: true }, '2026-08-16': { done: true }, '2026-08-17': { done: true },
  }));
  assert.equal(api.streak(), 3 - 1, 'the run stops at the missing day');
});

appTest('an empty journal has a streak of zero rather than throwing', () => {
  const { api } = boot();
  assert.equal(api.streak(), 0);
  assert.equal(api.recurring(), null);
});

appTest('the recurring centre is the one that has come up most', () => {
  const { api, store } = boot();
  store.set(KEY, JSON.stringify({
    a: { chakra: 'heart' }, b: { chakra: 'heart' }, c: { chakra: 'heart' },
    d: { chakra: 'root' }, e: { chakra: 'crown' },
  }));
  const often = api.recurring();
  assert.equal(often.key, 'heart');
  assert.equal(often.count, 3);
  assert.equal(often.label, 'Heart');
});

appTest('third-eye reads as a phrase a person would say', () => {
  const { api, store } = boot();
  store.set(KEY, JSON.stringify({ a: { chakra: 'third-eye' } }));
  assert.equal(api.recurring().label, 'Third eye');
});

appTest('a day is recorded against the local date, not UTC', () => {
  // Late evening in a timezone ahead of UTC would otherwise file the entry
  // under tomorrow, and a journal that disagrees with the calendar on the wall
  // is worse than no journal.
  const { api, store } = boot({ now: new Date('2026-08-18T23:30:00') });
  api.observe('Heart', '#46A758');
  assert.ok(Object.keys(JSON.parse(store.get(KEY))).includes('2026-08-18'));
});

appTest('a full or unavailable localStorage degrades quietly', () => {
  const { sandbox } = boot();
  sandbox.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  // Private browsing must not take the whole panel down with it.
  assert.doesNotThrow(() => sandbox.window.GaiaPractice.observe('Heart', '#46A758'));
  assert.doesNotThrow(() => sandbox.window.GaiaPractice.streak());
});

appTest('corrupt stored data is treated as empty rather than crashing the panel', () => {
  const { api, store } = boot();
  store.set(KEY, 'not json at all {{{');
  // Compared by keys rather than deepEqual: the object comes back from inside
  // the VM realm, so its prototype differs from this one's and a strict
  // structural comparison fails on identity rather than on content.
  assert.deepEqual(Object.keys(api.read()), []);
  assert.equal(api.streak(), 0);
  assert.equal(api.recurring(), null);
});

appTest('the journal listens for the wellness panel rather than owning it', () => {
  const { listeners } = boot();
  assert.ok(listeners.has('gaia:wellness-rendered'),
    'it follows the panel it lives in, so the wellness file need not know it exists');
});

appTest('the wellness panel emits what the journal needs', () => {
  const wellness = fs.readFileSync(path.join(appRoot, 'gaia-wellness.js'), 'utf8');
  assert.ok(wellness.includes("'gaia:wellness-rendered'"), 'the event is dispatched');
  assert.ok(/data-practice-host/.test(wellness), 'and a host element exists to draw into');
});
