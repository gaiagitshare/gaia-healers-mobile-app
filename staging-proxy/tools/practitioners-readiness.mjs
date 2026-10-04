#!/usr/bin/env node
/**
 * GAIA PRACTITIONERS — is the integration configured, and for which environment?
 *
 * Reads the proxy .env (never prints a secret: only whether each value is set),
 * reports the environment the config points at and anything that cannot be
 * right. With --probe it also makes three plain HTTPS GETs against the
 * configured host -- OAuth metadata, the MCP docs page, the MCP endpoint
 * without a token (401 expected) -- to say whether that environment is
 * actually serving. No API key, no model, nothing billed.
 *
 *   node tools/practitioners-readiness.mjs              # config only
 *   node tools/practitioners-readiness.mjs --probe      # + the three GETs
 *   node tools/practitioners-readiness.mjs --env <file> # another .env
 *   node tools/practitioners-readiness.mjs --json
 *
 * Exit 0 = ready for the configured environment; 1 = not ready (reasons printed).
 */
import fs from 'node:fs';
import { practitionersConfig, PRACTITIONERS_HOSTS } from '../practitioners-oauth.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const envPath = value('--env') || '/root/gaia-staging-proxy/.env';
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const s = line.trim();
  if (s && !s.startsWith('#') && s.includes('=')) { const i = s.indexOf('='); env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
}
const cfg = practitionersConfig(env);
const report = {
  environment: cfg.environment, enabled: cfg.enabled, base: cfg.base, mcpUrl: cfg.mcpUrl,
  redirectUri: cfg.redirectUri, scope: cfg.scope,
  clientId: cfg.clientId ? 'set' : 'MISSING', clientSecret: cfg.clientSecret ? 'set' : 'MISSING',
  knownHosts: PRACTITIONERS_HOSTS,
  problems: [...cfg.warnings],
  probe: null,
};
if (!env.GAIA_PRACTITIONERS_ENABLED) report.problems.push('GAIA_PRACTITIONERS_ENABLED is not set');
else if (env.GAIA_PRACTITIONERS_ENABLED !== 'true') report.problems.push('GAIA_PRACTITIONERS_ENABLED is not "true"');
if (!cfg.base) report.problems.push('no host: set GAIA_PRACTITIONERS_ENV=staging|production or GAIA_PRACTITIONERS_OAUTH_BASE');
if (!cfg.clientId) report.problems.push('GAIA_PRACTITIONERS_CLIENT_ID missing (register Gaia Assist on that environment)');
if (!cfg.clientSecret) report.problems.push('GAIA_PRACTITIONERS_CLIENT_SECRET missing');
if (!/^https:\/\/api\.gaiahealers\.app\/api\/practitioners\/callback$/.test(cfg.redirectUri)) report.problems.push('GAIA_PRACTITIONERS_REDIRECT_URI is not https://api.gaiahealers.app/api/practitioners/callback');

async function get(url, accept = 'application/json') {
  try {
    const r = await fetch(url, { headers: { Accept: accept }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    return { status: r.status, type: r.headers.get('content-type') || '', body: r.status === 200 ? (await r.text()).slice(0, 2000) : '' };
  } catch (e) { return { status: 0, error: String(e.message || e).slice(0, 80) }; }
}
if (flag('--probe') && cfg.base) {
  const meta = await get(`${cfg.base}/.well-known/oauth-authorization-server`);
  const docs = await get(`${cfg.base}/docs/mcp`, 'text/html');
  const mcp = await get(cfg.mcpUrl);
  let metaOk = false, issuer = null;
  try { const j = JSON.parse(meta.body || '{}'); issuer = j.issuer || null; metaOk = Boolean(j.authorization_endpoint && j.token_endpoint); } catch { /* not json */ }
  report.probe = {
    oauthMetadata: { status: meta.status, ok: metaOk, issuer },
    docs: { status: docs.status, ok: docs.status === 200 },
    mcpWithoutToken: { status: mcp.status, ok: mcp.status === 401 },
  };
  if (!metaOk) report.problems.push(`${cfg.base} serves no OAuth metadata (HTTP ${meta.status}) — this environment is not live yet`);
  if (mcp.status !== 401) report.problems.push(`${cfg.mcpUrl} answered HTTP ${mcp.status || 'error'} without a token (expected 401)`);
  if (issuer && cfg.base && issuer.replace(/\/+$/, '') !== cfg.base) report.problems.push(`OAuth issuer ${issuer} differs from the configured base`);
}
report.ready = report.problems.length === 0;
if (flag('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`GAIA PRACTITIONERS — ${report.ready ? 'READY' : 'NOT READY'} (${report.environment || 'no environment'})`);
  console.log(`  enabled ${report.enabled}  base ${report.base || '(none)'}  mcp ${report.mcpUrl || '(none)'}`);
  console.log(`  client id ${report.clientId}  client secret ${report.clientSecret}  redirect ${report.redirectUri || '(none)'}  scope ${report.scope}`);
  if (report.probe) console.log(`  probe: metadata ${report.probe.oauthMetadata.status}${report.probe.oauthMetadata.ok ? ' ok' : ''}  docs ${report.probe.docs.status}  mcp-without-token ${report.probe.mcpWithoutToken.status}`);
  for (const p of report.problems) console.log(`  - ${p}`);
}
process.exit(report.ready ? 0 : 1);
