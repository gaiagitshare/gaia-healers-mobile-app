#!/usr/bin/env node
/**
 * practitioner-profile-shape — what does Gaia Practitioners' `get_practitioner_profile`
 * actually return? Prints FIELD NAMES and types only (plus the status value),
 * never values, never tokens. One call, against the partner (not a paid model),
 * using the stored link of the contact given (or the only link, if one).
 *
 *   node tools/practitioner-profile-shape.mjs [--contact <id>] [--dry-run]
 *
 * Run from the live proxy directory so practitionersConfig() sees the service
 * env (or pass GAIA_PRACTITIONERS_MCP_URL). Last measured 4 Oct 2026; the
 * shape is recorded in docs/STAGING-PROXY.md and pinned by
 * test/practitioner-link-state.test.js (REAL_PROFILE).
 */
import { installPaidCallGuard } from './paid-call-guard.mjs';
import { practitionersConfig, readTokens, mcpCall, unwrapMcp } from '../practitioners-oauth.js';

const guard = installPaidCallGuard({ label: 'practitioner-profile-shape', planned: 1, tokensPerCall: 0,
  why: 'one get_practitioner_profile call to see the field names the partner returns' });
const argv = process.argv.slice(2);
const want = argv.includes('--contact') ? argv[argv.indexOf('--contact') + 1] : '';

const all = readTokens();
const ids = Object.keys(all);
const contactId = want || (ids.length === 1 ? ids[0] : '');
if (!contactId || !all[contactId]) {
  console.error(`no stored link${want ? ' for that contact' : ids.length ? ': pass --contact (' + ids.length + ' links stored)' : ''}`);
  process.exit(1);
}

const cfg = practitionersConfig(process.env);
const out = await mcpCall(cfg, all[contactId].access_token, 'get_practitioner_profile', {});
console.log('isError:', Boolean(out.isError));
const data = unwrapMcp(out);
const walk = (o, prefix = '') => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) { console.log(prefix || '(root)', ':', Array.isArray(o) ? 'array' : typeof o); return; }
  for (const k of Object.keys(o)) {
    const v = o[k]; const t = Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
    console.log(`${prefix}${k} : ${t}${/^(status|role|type|kind)$/i.test(k) ? ' = ' + JSON.stringify(v) : ''}`);
    if (t === 'object') walk(v, `${prefix}${k}.`);
  }
};
walk(data);
