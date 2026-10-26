#!/usr/bin/env node
// Membership 2.0 launch flag (admin). Usage (MEMBERSHIP_DATABASE_URL set):
//   node src/cli/launch.js show
//   node src/cli/launch.js set --stage INTERNAL_PILOT --reason "..." --actor <admin name> [--approval GO-2026-xx] [--cap N]
//   node src/cli/launch.js pilot-add|pilot-remove --person <uuid> --actor <admin name> [--note "..."]
// The environment ceiling MEMBERSHIP2_STAGE_CEILING (default OFF) always wins over the stored stage.
import { parseArgs } from 'node:util';
import { createPool } from '../db.js';
import { launchState, setLaunchStage, addPilotMember, removePilotMember } from '../launch.js';

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
  stage: { type: 'string' }, reason: { type: 'string' }, actor: { type: 'string' }, approval: { type: 'string' }, cap: { type: 'string' }, person: { type: 'string' }, note: { type: 'string' } } });
const pool = createPool();
try {
  const cmd = positionals[0] || 'show';
  const actor = { actorType: 'admin', actorId: a.actor || '' };
  if (cmd !== 'show' && !a.actor) throw new Error('--actor <admin name> is required');
  if (cmd === 'set') console.log(JSON.stringify(await setLaunchStage(pool, { stage: a.stage, reason: a.reason, approvalRef: a.approval || null, ...(a.cap ? { limitedCap: Number(a.cap) } : {}) }, actor)));
  if (cmd === 'pilot-add') await addPilotMember(pool, a.person, { note: a.note || null }, actor);
  if (cmd === 'pilot-remove') await removePilotMember(pool, a.person, actor);
  const st = await launchState(pool);
  const pilots = (await pool.query('SELECT count(*)::int n FROM pilot_members WHERE removed_at IS NULL')).rows[0].n;
  console.log(`stored ${st.stored} | environment ceiling ${st.ceiling} | EFFECTIVE ${st.effective} | limited cap ${st.limitedCap} | pilot members ${pilots}`);
  // The ceiling is read from THIS process's environment; the running API has its own (systemd unit).
  if (!String(process.env.MEMBERSHIP2_STAGE_CEILING || '').trim()) console.error('note: MEMBERSHIP2_STAGE_CEILING is not set in this shell, so EFFECTIVE assumes OFF; the running API uses the ceiling from its own unit environment and may differ.');
} catch (e) { console.error(e.message); process.exitCode = 2; } finally { await pool.end(); }
