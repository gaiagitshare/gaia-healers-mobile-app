#!/usr/bin/env node
/**
 * partner-member-recs-shape — what does the partner's member tool
 * `get_my_recommendations` look like? Prints the tool definition (description,
 * input/output schema) and, for ONE linked member, the response STRUCTURE only:
 * key names, types, counts, enum-like values, link hosts and path shapes.
 * Never summaries, names, ids or reading data. At most 3 partner calls
 * (member token, tools/list, one tool call). Not a paid model.
 *
 *   node tools/partner-member-recs-shape.mjs [--member <gaiaMemberId>] [--dry-run]
 */
import { installPaidCallGuard } from './paid-call-guard.mjs';
import { practitionersConfig } from '../practitioners-oauth.js';
import { memberToken, memberBackend } from '../member-link.js';
import fs from 'node:fs';

installPaidCallGuard({ label: 'partner-member-recs-shape', planned: 3, tokensPerCall: 0,
  why: 'structure of get_my_recommendations for one linked member (no content)' });
const argv = process.argv.slice(2);
const links = JSON.parse(fs.readFileSync(process.env.GAIA_MEMBER_LINK_FILE || 'data/member-links.json', 'utf8')).links || {};
const member = (argv.includes('--member') ? argv[argv.indexOf('--member') + 1] : '') || Object.keys(links).find((k) => links[k].status === 'confirmed');
if (!member) { console.error('no confirmed link'); process.exit(1); }
const cfg0 = practitionersConfig(process.env);
const url = `${memberBackend(cfg0, process.env)}/api/member-mcp`;
console.log('partner environment:', cfg0.environment, '| member backend host:', new URL(url).host);
const token = await memberToken(cfg0, member);
const rpc = async (method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const t = await r.text(); return { status: r.status, json: JSON.parse(t.includes('data:') ? t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() : t) };
};
const list = await rpc('tools/list', {});
const tool = (list.json?.result?.tools || []).find((t) => t.name === 'get_my_recommendations');
console.log('member tools:', (list.json?.result?.tools || []).map((t) => t.name).join(', '));
console.log('DEFINITION:', JSON.stringify(tool, null, 1));
const out = await rpc('tools/call', { name: 'get_my_recommendations', arguments: {} });
const res = out.json?.result; let data = res;
try { const txt = res?.content?.find((c) => c.type === 'text')?.text; if (txt) data = JSON.parse(txt); } catch { /* keep */ }
const hosts = new Set(), shapes = new Set(), enums = {};
const shape = (v, key = '', depth = 0) => {
  if (Array.isArray(v)) return `array(${v.length})` + (v.length ? ' of ' + shape(v[0], key, depth + 1) : '');
  if (v && typeof v === 'object') return depth > 6 ? 'object' : '{ ' + Object.keys(v).map((k) => `${k}: ${shape(v[k], k, depth + 1)}`).join(', ') + ' }';
  if (typeof v === 'string') {
    if (/^https?:\/\//.test(v)) { try { const u = new URL(v); hosts.add(u.protocol + '//' + u.host); shapes.add(u.pathname.replace(/[0-9a-f]{8,}|\d+/gi, ':id') + (u.search ? '?<query keys: ' + [...u.searchParams.keys()].join(',') + '>' : '')); } catch {} return 'url';
    }
    if (/^(type|kind|status|state|item_type|category|approval_status)$/i.test(key) && v.length < 30) { (enums[key] ||= new Set()).add(v); }
    return `string(${v.length})`;
  }
  return v === null ? 'null' : typeof v;
};
// Count recommendations and items everywhere, with structure only.
const walkAll = (v, key = '') => { if (Array.isArray(v)) v.forEach((x) => walkAll(x, key)); else if (v && typeof v === 'object') for (const k of Object.keys(v)) walkAll(v[k], k); else shape(v, key); };
walkAll(data);
console.log('http:', out.status, '| isError:', Boolean(res?.isError), '| top-level:', shape(data).slice(0, 2000));
console.log('enum-like values:', JSON.stringify(Object.fromEntries(Object.entries(enums).map(([k, s]) => [k, [...s]]))));
console.log('link hosts:', [...hosts].join(', ') || '(none)'); console.log('link path shapes:', [...shapes].join(' | ') || '(none)');
