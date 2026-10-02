import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOnboardingFunnel, summarize, hashContact } from '../onboarding-funnel.js';

const H = 3600000;
function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-')), 'f.json');
  let t = 1_000_000;
  const events = [];
  const f = createOnboardingFunnel({ file, now: () => t, log: (e) => events.push(e) });
  return { file, f, events, tick: (ms) => { t += ms; }, at: () => t };
}

test('tracks gated, started, each step and completed without storing answers or ids', () => {
  const { file, f, events, tick } = setup();
  f.gate('c1', { state: 'incomplete', nextStep: 'primary_interests' });
  tick(1000); f.step('c1', 'primary_interests', 'visual', { state: 'incomplete', nextStep: 'why_join' });
  tick(1000); f.step('c1', 'why_join', 'voice', { state: 'incomplete', nextStep: 'final_notes' });
  tick(60000); f.step('c1', 'final_notes', 'text', { state: 'complete', nextStep: null });
  assert.deepEqual(events.map(e => e.event), ['gated', 'started', 'step_saved', 'step_saved', 'completed']);
  assert.ok(events.every(e => e.member === hashContact('c1')));
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('c1"') && !raw.includes('Living'), 'no raw id or answer text on disk');
  const e = JSON.parse(raw).members[hashContact('c1')];
  assert.deepEqual(e.steps, ['primary_interests', 'why_join', 'final_notes']);
  assert.deepEqual(e.sources, { visual: 1, voice: 1, text: 1 });
});

test('summary finds where idle members stopped and keeps recent ones in progress', () => {
  const { f, tick, at } = setup();
  f.gate('a', { state: 'incomplete', nextStep: 'primary_interests' });           // never starts
  f.gate('b', { state: 'incomplete', nextStep: 'primary_interests' });
  f.step('b', 'primary_interests', 'visual', { state: 'incomplete', nextStep: 'business_length' }); // drops
  f.step('c', 'primary_interests', 'visual', { state: 'incomplete', nextStep: 'why_join' });
  f.step('c', 'why_join', 'visual', { state: 'complete', nextStep: null });       // finishes
  tick(25 * H);
  f.step('d', 'primary_interests', 'visual', { state: 'incomplete', nextStep: 'why_join' }); // fresh
  f.step('b', 'business_length', 'visual', null);                                  // failed save
  const s = summarize(f.snapshot(), { now: at() + 1000 });
  assert.equal(s.gated, 4);
  assert.equal(s.started, 3);
  assert.equal(s.completed, 1);
  assert.equal(s.neverStarted, 1);
  assert.equal(s.inProgress, 2);  // d, and b whose failed retry was just now
  assert.equal(s.failures, 1);
  assert.equal(s.stepReach.primary_interests, 3);
  const later = summarize(f.snapshot(), { now: at() + 25 * H });
  assert.equal(later.dropped, 2);
  assert.deepEqual(later.droppedAt, { business_length: 1, why_join: 1 });
});

test('a resumed GET logs once per new position; finished-before-tracking members are ignored', () => {
  const { f, events } = setup();
  f.gate('old', { state: 'complete' });
  assert.deepEqual(f.snapshot().members, {});
  f.gate('x', { state: 'incomplete', nextStep: 'why_join' });
  f.gate('x', { state: 'incomplete', nextStep: 'why_join' });
  f.gate('x', { state: 'incomplete', nextStep: 'water' });
  f.gate('x', { state: 'unavailable' });
  assert.deepEqual(events.map(e => e.event), ['gated', 'resumed']);
  f.gate('x', { state: 'complete' });
  assert.equal(summarize(f.snapshot()).completed, 1);
});

test('a broken data file or unwritable path never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-'));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  const f = createOnboardingFunnel({ file: path.join(dir, 'bad.json'), log: () => {} });
  f.step('c', 'primary_interests', 'visual', { state: 'incomplete', nextStep: 'why_join' });
  const g = createOnboardingFunnel({ file: path.join(dir, 'bad.json', 'sub', 'f.json'), log: () => {} }); // parent is a file
  assert.doesNotThrow(() => g.gate('c', { state: 'incomplete', nextStep: 'why_join' }));
});
