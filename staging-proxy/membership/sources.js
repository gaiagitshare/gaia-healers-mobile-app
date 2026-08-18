/**
 * Source registry — who is allowed to tell Gaia anything, and how much of it
 * we currently believe.
 *
 * Two properties decide how a source's data is read:
 *
 *   mode  — `snapshot` sources hand over a complete authoritative set for a
 *           scope, so something MISSING from the set is evidence it is gone.
 *           `event` sources push individual facts, so silence means nothing
 *           whatsoever. Collapsing these would make a dropped webhook
 *           indistinguishable from a cancellation.
 *
 *   state — `disabled` ignores the source entirely, `shadow` runs the whole
 *           pipeline but stops before the ledger, `active` applies.
 *
 * Everything here is configuration about trust, never about authorization
 * itself: which price id means Diamond stays in reviewed code.
 */

const SOURCE_MODES = ['snapshot', 'event'];
const SOURCE_STATES = ['disabled', 'shadow', 'active'];

/**
 * Seed registry. GHL and Shopify ship DISABLED — this phase builds the
 * foundation and connects nothing. Promotion is a deliberate, audited act.
 */
function defaultSources() {
  return {
    admin: {
      key: 'admin',
      label: 'Admin / Manual',
      mode: 'event',
      state: 'active',
      locked: true,
      description: 'An operator acting in the Membership Control Center. Always active: it is how the system is run.',
    },
    ghl_membership: {
      key: 'ghl_membership',
      label: 'GHL Memberships',
      mode: 'snapshot',
      state: 'disabled',
      description: 'Pulls the Payments subscriptions list and reconciles it against the canonical billing map.',
    },
    ghl_course: {
      key: 'ghl_course',
      label: 'GHL Courses & Communities',
      mode: 'event',
      state: 'disabled',
      description: 'Receives course and community grants pushed by workflow webhooks. GHL exposes no API to read these back.',
    },
    shopify: {
      key: 'shopify',
      label: 'Shopify',
      mode: 'event',
      state: 'disabled',
      description: 'Device purchases and refunds arriving as order webhooks.',
    },
    vendor: {
      key: 'vendor',
      label: 'Vendor Licences',
      mode: 'event',
      state: 'disabled',
      description: 'Device software licences issued and expired by device vendors.',
    },
  };
}

const clean = (value, max = 120) => String(value ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);

function normalizeSources(stored) {
  const base = defaultSources();
  if (!stored || typeof stored !== 'object') return base;
  for (const key of Object.keys(base)) {
    const saved = stored[key];
    if (!saved || typeof saved !== 'object') continue;
    // Only the operational fields are storable. Mode is a property of what the
    // external system can actually do, so it is not operator-editable.
    if (SOURCE_STATES.includes(saved.state) && !base[key].locked) base[key].state = saved.state;
    base[key].lastObservedAt = saved.lastObservedAt || null;
    base[key].lastRunAt = saved.lastRunAt || null;
    base[key].lastRunOutcome = clean(saved.lastRunOutcome, 40) || null;
    base[key].counters = {
      applied: Number(saved.counters?.applied) || 0,
      shadow: Number(saved.counters?.shadow) || 0,
      rejected: Number(saved.counters?.rejected) || 0,
      unresolved: Number(saved.counters?.unresolved) || 0,
      lowConfidence: Number(saved.counters?.lowConfidence) || 0,
    };
  }
  return base;
}

function sourceRegistry(store) {
  if (!store.sources || typeof store.sources !== 'object') store.sources = defaultSources();
  else store.sources = normalizeSources(store.sources);
  return store.sources;
}

function getSource(store, key) {
  return sourceRegistry(store)[clean(key, 40)] || null;
}

/** Change a source's state. Refuses unknown sources and locked ones. */
function setSourceState(store, key, state, { now = new Date() } = {}) {
  const source = getSource(store, key);
  if (!source) return { ok: false, reason: 'unknown_source' };
  if (source.locked) return { ok: false, reason: 'source_is_locked' };
  if (!SOURCE_STATES.includes(state)) return { ok: false, reason: 'unknown_state' };
  const from = source.state;
  source.state = state;
  source.stateChangedAt = now.toISOString();
  return { ok: true, source, from, to: state };
}

/** Record the outcome of one proposal against its source's counters. */
function noteOutcome(store, key, outcome, { now = new Date(), lowConfidence = false } = {}) {
  const source = getSource(store, key);
  if (!source) return null;
  if (!source.counters) source.counters = { applied: 0, shadow: 0, rejected: 0, unresolved: 0, lowConfidence: 0 };
  if (source.counters[outcome] !== undefined) source.counters[outcome] += 1;
  if (lowConfidence) source.counters.lowConfidence += 1;
  source.lastObservedAt = now.toISOString();
  return source;
}

function noteRun(store, key, outcome, { now = new Date() } = {}) {
  const source = getSource(store, key);
  if (!source) return null;
  source.lastRunAt = now.toISOString();
  source.lastRunOutcome = clean(outcome, 40);
  return source;
}

/**
 * Mapping health: which sources can actually do anything useful right now.
 * A source in shadow with no mappings configured is worth surfacing before
 * someone promotes it and wonders why nothing happens.
 */
function sourceSummary(store) {
  const registry = sourceRegistry(store);
  return Object.values(registry).map((source) => ({
    key: source.key,
    label: source.label,
    mode: source.mode,
    state: source.state,
    locked: Boolean(source.locked),
    description: source.description,
    lastObservedAt: source.lastObservedAt || null,
    lastRunAt: source.lastRunAt || null,
    lastRunOutcome: source.lastRunOutcome || null,
    counters: source.counters || { applied: 0, shadow: 0, rejected: 0, unresolved: 0, lowConfidence: 0 },
  }));
}

export {
  SOURCE_MODES,
  SOURCE_STATES,
  defaultSources,
  normalizeSources,
  sourceRegistry,
  getSource,
  setSourceState,
  noteOutcome,
  noteRun,
  sourceSummary,
};
