#!/usr/bin/env node
/**
 * partner-tools-catalog — what tools does Gaia Practitioners' MCP offer, with
 * their own descriptions and input schemas? One `tools/list` (plus at most one
 * token refresh) against the partner (not a paid model). Reads tool
 * DEFINITIONS only: no customer, scan or practice data is requested.
 *
 *   node tools/partner-tools-catalog.mjs [--contact <id>] [--save <file>] [--dry-run]
 */
import { installPaidCallGuard } from './paid-call-guard.mjs';
import { practitionersConfig, readTokens, validAccessToken } from '../practitioners-oauth.js';

installPaidCallGuard({ label: 'partner-tools-catalog', planned: 2, tokensPerCall: 0,
  why: 'one tools/list (and at most one token refresh) to read the partner tool definitions' });
const argv = process.argv.slice(2);
const want = argv.includes('--contact') ? argv[argv.indexOf('--contact') + 1] : '';
const ids = Object.keys(readTokens());
const contactId = want || ids[0];
if (!contactId) { console.error('no stored practitioner link'); process.exit(1); }
const cfg = practitionersConfig(process.env);
console.log('environment:', cfg.environment);
const token = await validAccessToken(cfg, contactId);
const r = await fetch(cfg.mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), signal: AbortSignal.timeout(20000) });
const txt = await r.text();
const json = JSON.parse(txt.includes('data:') ? txt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() : txt);
const tools = json?.result?.tools || [];
// --save <file>: the raw tool definitions (names, descriptions, schemas; no customer data)
if (argv.includes('--save')) { (await import('node:fs')).writeFileSync(argv[argv.indexOf('--save') + 1], JSON.stringify(tools, null, 1)); }
console.log('tools:', tools.length);
for (const t of tools) {
  console.log('\n## ' + t.name);
  if (t.description) console.log(t.description);
  const props = t.inputSchema?.properties || {};
  for (const [k, v] of Object.entries(props)) console.log(`  - ${k}: ${v.type || ''}${v.enum ? ' ' + JSON.stringify(v.enum) : ''}${v.description ? ' — ' + v.description : ''}${(t.inputSchema.required || []).includes(k) ? ' (required)' : ''}`);
  if (t.annotations) console.log('  annotations:', JSON.stringify(t.annotations));
  if (t.outputSchema) console.log('  outputSchema keys:', Object.keys(t.outputSchema.properties || {}).join(', '));
}
