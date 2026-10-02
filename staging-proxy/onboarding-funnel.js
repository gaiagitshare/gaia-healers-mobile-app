// Survey funnel: who reached the onboarding gate, which steps they saved, and
// whether they finished -- so drop-off per question can be measured.
// Stores only a hashed contact id, step keys, sources and timestamps; never
// answers, free text, names or emails.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SOURCES = ['visual', 'voice', 'text'];

export function hashContact(contactId) {
  return crypto.createHash('sha256').update('gaia-onboarding:' + String(contactId)).digest('hex').slice(0, 16);
}

export function createOnboardingFunnel({ file, now = () => Date.now(), log = (e) => console.log('[Gaia Onboarding]', e) } = {}) {
  let data = null;
  const load = () => {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
    if (!data.members || typeof data.members !== 'object') data.members = {};
    return data;
  };
  const persist = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date(now()).toISOString(), members: data.members }));
      fs.renameSync(tmp, file);
    } catch (_) { /* analytics only: never break the survey */ }
  };
  const entry = (contactId) => {
    const id = hashContact(contactId);
    const m = load().members;
    if (!m[id]) m[id] = { gatedAt: null, startedAt: null, completedAt: null, lastAt: null, steps: [], sources: {}, nextStep: null, failures: 0 };
    return [id, m[id]];
  };

  return {
    // GET status: a member saw the gate (incomplete) or passed it.
    gate(contactId, profile) {
      if (!contactId || !profile || !['complete', 'incomplete'].includes(profile.state)) return;
      // Only follow people who were gated: members finished before tracking stay out.
      if (profile.state === 'complete' && !load().members[hashContact(contactId)]) return;
      const [id, e] = entry(contactId);
      const t = now();
      if (profile.state === 'complete') {
        if (e.completedAt) return;
        e.completedAt = t;
      } else if (profile.state === 'incomplete') {
        const first = !e.gatedAt;
        if (first) e.gatedAt = t;
        if (!first && e.nextStep === (profile.nextStep || null)) return;
        e.nextStep = profile.nextStep || null;
        log({ event: first ? 'gated' : 'resumed', member: id, nextStep: e.nextStep });
      }
      e.lastAt = t;
      persist();
    },
    // A step was saved (or failed to save) from the visual survey, voice or text chat.
    step(contactId, stepKey, source, result) {
      if (!contactId || !stepKey) return;
      const [id, e] = entry(contactId);
      const t = now();
      const src = SOURCES.includes(source) ? source : 'visual';
      if (!e.gatedAt) e.gatedAt = t;
      if (!result) {
        e.failures += 1; e.lastAt = t; persist();
        log({ event: 'step_failed', member: id, stepKey, source: src });
        return;
      }
      const started = !e.startedAt;
      if (started) e.startedAt = t;
      if (!e.steps.includes(stepKey)) e.steps.push(stepKey);
      e.sources[src] = (e.sources[src] || 0) + 1;
      e.nextStep = result.nextStep || null;
      e.lastAt = t;
      const completed = result.state === 'complete' && !e.completedAt;
      if (completed) e.completedAt = t;
      persist();
      log({ event: started ? 'started' : 'step_saved', member: id, stepKey, source: src, nextStep: e.nextStep });
      if (completed) log({ event: 'completed', member: id, source: src, minutes: Math.round((t - e.startedAt) / 60000) });
    },
    snapshot: () => JSON.parse(JSON.stringify(load())),
  };
}

// Read-only summary. A member counts as dropped once idle for `idleHours`.
export function summarize(snapshot, { now = Date.now(), idleHours = 24 } = {}) {
  const members = Object.values((snapshot && snapshot.members) || {});
  const idleMs = idleHours * 3600000;
  const out = { gated: 0, started: 0, completed: 0, inProgress: 0, dropped: 0, neverStarted: 0, failures: 0, sources: {}, droppedAt: {}, stepReach: {}, medianMinutes: null };
  const durations = [];
  for (const e of members) {
    if (e.gatedAt) out.gated++;
    if (e.startedAt) out.started++;
    out.failures += e.failures || 0;
    for (const [s, n] of Object.entries(e.sources || {})) out.sources[s] = (out.sources[s] || 0) + n;
    for (const s of e.steps || []) out.stepReach[s] = (out.stepReach[s] || 0) + 1;
    if (e.completedAt) {
      out.completed++;
      if (e.startedAt) durations.push((e.completedAt - e.startedAt) / 60000);
      continue;
    }
    if (now - (e.lastAt || e.gatedAt || 0) < idleMs) { out.inProgress++; continue; }
    if (!e.startedAt) { out.neverStarted++; continue; }
    out.dropped++;
    const at = e.nextStep || 'unknown';
    out.droppedAt[at] = (out.droppedAt[at] || 0) + 1;
  }
  durations.sort((a, b) => a - b);
  if (durations.length) out.medianMinutes = Math.round(durations[Math.floor(durations.length / 2)] * 10) / 10;
  return out;
}

