#!/usr/bin/env node
/**
 * partner-recs-qa — staging acceptance of the approved-recommendations
 * integration through the REAL code path (partner-recs.js approvedForMember),
 * in staging mode only. Prints counts, kept field names and link shapes;
 * never titles, summaries or ids. Also checks the partner refuses a token for
 * a member who is not linked. At most 3 partner calls. Not a paid model.
 *
 *   GAIA_PARTNER_RECS=staging GAIA_DEPLOYMENT=staging node tools/partner-recs-qa.mjs [--dry-run]
 */
import { installPaidCallGuard } from './paid-call-guard.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
installPaidCallGuard({ label: 'partner-recs-qa', planned: 3, tokensPerCall: 0, why: 'one member read through the integration + one refused token' });
process.env.GAIA_PARTNER_RECS_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prqa-')), 'cache.json');
const { practitionersConfig } = await import('../practitioners-oauth.js');
const { approvedForMember, partnerRecsGate } = await import('../partner-recs.js');
const { memberToken } = await import('../member-link.js');
const cfg = practitionersConfig(process.env);
console.log('gate:', JSON.stringify(partnerRecsGate(process.env, cfg.environment)));
const links = JSON.parse(fs.readFileSync(process.env.GAIA_MEMBER_LINK_FILE || 'data/member-links.json', 'utf8')).links || {};
const member = Object.keys(links).find((k) => links[k].status === 'confirmed');
const logs = [];
const r = await approvedForMember(cfg, member, { log: (m, o) => logs.push(m + ' ' + JSON.stringify(o)) });
console.log('state:', r.state, '| items kept:', r.items.length, '|', logs.join(' | '));
console.log('kept field names:', [...new Set(r.items.flatMap((i) => Object.keys(i)))].sort().join(', '));
console.log('types:', JSON.stringify(r.items.reduce((a, i) => ({ ...a, [i.type]: (a[i.type] || 0) + 1 }), {})), '| with summary:', r.items.filter((i) => i.summary).length, '| approved_at set:', r.items.filter((i) => i.approved_at).length);
console.log('actions:', [...new Set(r.items.map((i) => `${i.action.label} ${new URL(i.action.url).host}${new URL(i.action.url).pathname}?${[...new URL(i.action.url).searchParams.keys()].join('&')}`))].join(' | '));
try { await memberToken(cfg, 'not-a-linked-member-qa-' + Date.now()); console.log('UNLINKED TOKEN: issued (partner did not refuse)'); }
catch (e) { console.log('unlinked member token: refused (' + (e.code || e.status || e.message).toString().slice(0, 60) + ')'); }
