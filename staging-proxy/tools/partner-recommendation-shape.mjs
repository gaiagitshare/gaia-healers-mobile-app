#!/usr/bin/env node
/**
 * partner-recommendation-shape — what is INSIDE a Gaia Practitioners
 * `get_customer_recommendations` item? Prints KEY NAMES, types and array
 * lengths only: never values, names, text, ids or tokens. At most 3 partner
 * calls (list_customers, then up to 2 customers until one has recommendations).
 *
 *   node tools/partner-recommendation-shape.mjs [--contact <id>] [--dry-run]
 */
import { installPaidCallGuard } from './paid-call-guard.mjs';
import { practitionersConfig, readTokens, validAccessToken, mcpCall, unwrapMcp } from '../practitioners-oauth.js';

installPaidCallGuard({ label: 'partner-recommendation-shape', planned: 4, tokensPerCall: 0,
  why: 'structure (key names only) of one partner recommendation record' });
const argv = process.argv.slice(2);
const want = argv.includes('--contact') ? argv[argv.indexOf('--contact') + 1] : '';
const contactId = want || Object.keys(readTokens())[0];
const cfg = practitionersConfig(process.env);
const token = await validAccessToken(cfg, contactId);
const shape = (v, depth = 0) => {
  if (Array.isArray(v)) return depth > 5 ? 'array' : `array(${v.length})` + (v.length ? ' of ' + shape(v[0], depth + 1) : '');
  if (v && typeof v === 'object') return depth > 5 ? 'object' : '{ ' + Object.keys(v).map((k) => `${k}: ${shape(v[k], depth + 1)}`).join(', ') + ' }';
  if (typeof v === 'string') { try { const p = JSON.parse(v); if (p && typeof p === 'object') return 'json-string ' + shape(p, depth + 1); } catch { /* plain */ } return `string(${v.length})`; }
  return v === null ? 'null' : typeof v;
};
const list = unwrapMcp(await mcpCall(cfg, token, 'list_customers', {}));
const ids = (list?.customers || []).filter((c) => c.hasBioWellCard !== false).map((c) => c.id).slice(0, 2);
console.log('customers on this staging practice:', (list?.customers || []).length, '| trying', ids.length);
for (const id of ids) {
  const r = unwrapMcp(await mcpCall(cfg, token, 'get_customer_recommendations', { customerId: String(id) }));
  const recs = r?.recommendations || [];
  console.log('recommendation records:', recs.length);
  if (!recs.length) continue;
  console.log('record keys:', shape(recs[0]));
  console.log('scan_type values seen:', [...new Set(recs.map((x) => typeof x.scan_type === 'string' && x.scan_type.length < 30 ? x.scan_type : '(other)'))].join(', '));
  console.log('video_status values seen:', [...new Set(recs.map((x) => (typeof x.video_status === 'string' && x.video_status.length < 20 ? x.video_status : String(x.video_status === null ? 'null' : '(other)'))))].join(', '));
  break;
}
