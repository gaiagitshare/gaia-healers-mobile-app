/**
 * Boots server.js in-process for the GHL webhook-secret suites. Each suite is
 * its own node:test process, so each gets its own env (secrets are read once
 * at module load). Returns small helpers; no network beyond loopback.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OLD = 'old-courses-sync-secret-'.padEnd(48, 'o');
export const NEW = 'new-ghl-workflow-secret-'.padEnd(48, 'n');
export const NEW_BACKFILL = 'new-ghl-backfill-secret-'.padEnd(48, 'b');
export const WRONG = 'wrong-secret-'.padEnd(48, 'x');

export async function bootGhlSecretServer({ port, env = {} }) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-ghlsecret-'));
  fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
  process.chdir(workdir);
  for (const k of ['GHL_WORKFLOW_WEBHOOK_SECRET', 'GHL_WORKFLOW_WEBHOOK_SECRET_TRANSITION_UNTIL',
    'GHL_BACKFILL_SECRET', 'GHL_BACKFILL_SECRET_TRANSITION_UNTIL']) delete process.env[k];
  const teleFile = path.join(workdir, 'data', 'webhook-telemetry.json');
  Object.assign(process.env, {
    PORT: String(port), HOST: '127.0.0.1',
    COURSES_SYNC_SECRET: OLD, AUTH_SESSION_SECRET: OLD,
    MEMBER_ENTITLEMENTS_FILE: path.join(workdir, 'data', 'member-entitlements.json'),
    WEBHOOK_TELEMETRY_FILE: teleFile,
    GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
    GAIA_DISABLE_ALERT_TIMER: '1', MEMBERSHIP_FIXTURES: '', MEMBERSHIP_FIXTURE_KEY: '',
    ...env,
  });
  const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
  await new Promise((r) => setTimeout(r, 300));
  const base = `http://127.0.0.1:${port}`;

  // Authentication runs before body parsing on both routes, so a deliberately
  // invalid JSON body separates "authenticated" (400) from "refused" (403)
  // without touching the entitlement ledger.
  const post = async (route, headers) => (await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{not json',
  })).status;
  return {
    closeServer, teleFile,
    memberAccess: (secret) => post('/api/webhooks/ghl/member-access', { 'x-webhook-secret': secret }),
    backfill: (secret) => post('/api/webhooks/ghl/member-backfill', { 'x-backfill-secret': secret }),
    review: async (secret) => {
      const r = await fetch(base + '/api/entitlement-review', { headers: { 'x-webhook-secret': secret } });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    telemetry: () => { try { return JSON.parse(fs.readFileSync(teleFile, 'utf8')); } catch (_) { return {}; } },
  };
}

export const AUTHENTICATED = 400;
export const REFUSED = 403;
