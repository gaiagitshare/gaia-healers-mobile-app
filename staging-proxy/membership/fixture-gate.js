/**
 * Fixture delivery gate.
 *
 * Synthetic profiles are only reachable when THREE independent things are true
 * at once: the process opted in, a fixture key is configured, and the caller
 * holds a session that was explicitly minted with fixture authority. A query
 * parameter on its own is inert — on production, where the flag is unset, every
 * function here returns the same answer it would if the file did not exist.
 *
 * Nothing in this module can write. It reads the in-memory fixture store built
 * per request; the production ledger is never opened, let alone modified.
 */

import crypto from 'node:crypto';
import { buildFixtures } from './fixtures.js';

const flagOn = () => String(process.env.MEMBERSHIP_FIXTURES || '').trim() === '1';
const fixtureKey = () => String(process.env.MEMBERSHIP_FIXTURE_KEY || '').trim();

/** Fixtures can only ever be served when the process is configured for them. */
export function fixturesAvailable() {
  return flagOn() && fixtureKey().length >= 32;
}

/** Constant-time comparison of the dev key used to mint a fixture session. */
export function fixtureKeyMatches(supplied) {
  const expected = fixtureKey();
  if (!fixturesAvailable()) return false;
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Whether this request may see fixtures.
 *
 * `session` is the RAW signed session payload, not the normalised member: the
 * authority lives on the session itself, so it cannot be spoofed by a header or
 * a query string, and it disappears the moment the flag is off.
 */
export function fixtureAccessGranted(session) {
  return fixturesAvailable() && session?.fixtureAccess === true;
}

/** The fixture id this request is asking for, if it is allowed to ask. */
export function requestedFixtureId(session, url) {
  if (!fixtureAccessGranted(session)) return null;
  const requested = String(url?.searchParams?.get('fixture') || '').trim();
  const id = requested || String(session.fixture || '').trim();
  if (!id) return null;
  return id.startsWith('fixture-') ? id : `fixture-${id}`;
}

/** All available fixture ids, for a dev switcher. Empty unless enabled. */
export function fixtureIds() {
  if (!fixturesAvailable()) return [];
  return buildFixtures({ now: Date.now() }).ids;
}

/**
 * The resolver inputs for one fixture profile, or null.
 *
 * Built fresh against the current clock so relative dates ("expires in 14
 * days", "observed 30 days ago") stay meaningful whenever they are viewed.
 */
export function fixtureProfile(id, { now = Date.now() } = {}) {
  if (!fixturesAvailable() || !id) return null;
  const { store, subscriptionsByContact } = buildFixtures({ now });
  const record = store.contacts[id];
  if (!record) return null;
  return {
    id,
    record,
    subscriptions: subscriptionsByContact[id] || [],
    tags: record.tags || [],
  };
}
