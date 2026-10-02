#!/usr/bin/env node
/**
 * Where do members stop in the mandatory onboarding survey?
 *
 * Read-only. Reads data/onboarding-funnel.json (hashed ids and step keys only)
 * and prints the funnel: gated, started, finished, and where idle members stopped.
 *   node /root/gaia-staging-proxy/tools/onboarding-report.mjs [--idle-hours 24] [--json] [--file path]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../onboarding-funnel.js';
import { STEPS } from '../gaia-onboarding.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const idleHours = Number(args[args.indexOf('--idle-hours') + 1]) || 24;
const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : path.join(here, '..', 'data', 'onboarding-funnel.json');
let snapshot = { members: {} };
try { snapshot = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.error('No funnel data yet at ' + file); }
const s = summarize(snapshot, { idleHours });
if (args.includes('--json')) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }

const pct = (n, d) => d ? Math.round((n / d) * 100) + '%' : '-';
console.log(`Onboarding funnel (dropped = idle ${idleHours}h+; data updated ${snapshot.updatedAt || "never"})\n`);
console.log(`  Reached the gate   ${s.gated}`);
console.log(`  Never started      ${s.neverStarted}`);
console.log(`  Started            ${s.started}  (${pct(s.started, s.gated)} of gated)`);
console.log(`  Finished           ${s.completed}  (${pct(s.completed, s.started)} of started)${s.medianMinutes != null ? `, median ${s.medianMinutes} min` : ''}`);
console.log(`  In progress        ${s.inProgress}`);
console.log(`  Dropped            ${s.dropped}`);
console.log(`  Save failures      ${s.failures}`);
console.log(`  Saves by source    ${Object.entries(s.sources).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}\n`);
console.log('  Step                        reached  stopped here');
for (const st of STEPS) {
  const reached = s.stepReach[st.key] || 0, stopped = s.droppedAt[st.key] || 0;
  console.log(`  ${st.key.padEnd(26)}  ${String(reached).padStart(7)}  ${String(stopped).padStart(12)}`);
}
