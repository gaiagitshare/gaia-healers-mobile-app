import fs from 'fs';
import path from 'path';
import {
  fetchSubscriptions,
  contactProposals,
  subscriptionToProposal,
  sweep,
} from './membership/adapters/ghl-membership.js';
import { migrateStore } from './membership/ledger.js';
import { setSourceState, noteRun } from './membership/sources.js';

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, '.env');
const LEDGER_FILE = path.join(ROOT, 'data', 'member-entitlements.json');
const DRY_RUN = process.argv.includes('--dry-run');
const env = {};
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) env[match[1]] = match[2].trim();
}

const base = String(env.GHL_API_BASE_URL || '').replace(/\/+$/, '');
const locationId = String(env.GHL_LOCATION_ID || '');
const token = String(env.GHL_API_TOKEN || '');
if (!base || !locationId || !token) throw new Error('GHL membership reconciliation is not configured');

const headers = {
  Accept: 'application/json',
  Authorization: `Bearer ${token}`,
  Version: env.GHL_API_VERSION || '2021-07-28',
};

async function fetchPage({ limit, offset }) {
  const url = new URL(`${base}/payments/subscriptions`);
  url.searchParams.set('altId', locationId);
  url.searchParams.set('altType', 'location');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GHL subscriptions returned ${response.status}`);
  return response.json();
}

async function resolveCanonicalContact(subscription) {
  const mapped = subscriptionToProposal(subscription);
  if (!mapped.proposal) return { subscription, repaired: false };
  const originalId = String(subscription.contactId || '').trim();
  if (originalId) {
    const direct = await fetch(`${base}/contacts/${encodeURIComponent(originalId)}`, { headers });
    if (direct.ok) return { subscription, repaired: false };
    if (direct.status !== 400 && direct.status !== 404) {
      throw new Error(`GHL contact verification returned ${direct.status}`);
    }
  }
  const email = String(subscription.contactEmail || '').trim().toLowerCase();
  if (!email) throw new Error('Mapped membership has no resolvable GHL contact or email');
  const response = await fetch(`${base}/contacts/search`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page: 1, pageLimit: 100, locationId,
      filters: [{ field: 'email', operator: 'eq', value: email }],
    }),
  });
  if (!response.ok) throw new Error(`GHL contact search returned ${response.status}`);
  const payload = await response.json();
  const rows = payload.contacts || payload.data?.contacts || payload.data || [];
  const exact = (Array.isArray(rows) ? rows : []).filter(
    (contact) => String(contact.email || '').trim().toLowerCase() === email,
  );
  if (exact.length !== 1 || !exact[0].id) {
    throw new Error(`Mapped membership email resolved to ${exact.length} contacts`);
  }
  return { subscription: { ...subscription, contactId: String(exact[0].id) }, repaired: true };
}

function saveAtomic(store) {
  const temp = `${LEDGER_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, LEDGER_FILE);
  fs.chmodSync(LEDGER_FILE, 0o600);
}

const rawSubscriptions = await fetchSubscriptions(fetchPage, { pageSize: 100, maxPages: 100 });
if (!rawSubscriptions.length) throw new Error('GHL returned zero subscriptions; refusing absence reconciliation');
const resolved = await Promise.all(rawSubscriptions.map(resolveCanonicalContact));
const subscriptions = resolved.map((item) => item.subscription);

const converted = subscriptions.map((item) => subscriptionToProposal(item));
const proposals = contactProposals(subscriptions);
if (!proposals.length) throw new Error('No canonical Gaia memberships mapped; refusing absence reconciliation');

const original = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
const { store } = migrateStore(original);
const sourceState = DRY_RUN ? 'shadow' : 'active';
const promoted = setSourceState(store, 'ghl_membership', sourceState);
if (!promoted.ok) throw new Error(`Cannot set GHL membership source: ${promoted.reason}`);

const run = sweep(store, subscriptions, { now: new Date(), source: 'ghl_membership' });
if (!run.ok) throw new Error(`Membership sweep failed: ${run.reason}`);
noteRun(store, 'ghl_membership', DRY_RUN ? 'shadow_ok' : 'active_ok');

const terminal = [...run.results, ...run.absenceResults];
const summary = {
  ok: true,
  mode: sourceState,
  totalSubscriptions: subscriptions.length,
  mappedSubscriptions: converted.filter((item) => item.proposal).length,
  mappedContacts: proposals.length,
  repairedContactIds: resolved.filter((item) => item.repaired).length,
  applied: run.applied,
  shadow: run.shadow,
  absences: run.absences,
  duplicates: terminal.filter((item) => item.reason === 'duplicate_source_event').length,
  rejected: terminal.filter((item) => !item.ok && item.reason !== 'duplicate_source_event').length,
  unresolved: terminal.filter((item) => item.reason && String(item.reason).includes('identity')).length,
  byTier: proposals.reduce((out, item) => {
    const key = `${item.intent.key}:${item.intent.status}`;
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {}),
};

if (!DRY_RUN) {
  if (summary.rejected || summary.unresolved) {
    throw new Error(`Membership sweep has unsafe outcomes: ${JSON.stringify(summary)}`);
  }
  saveAtomic(store);
}
console.log(JSON.stringify(summary));
