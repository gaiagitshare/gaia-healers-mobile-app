#!/usr/bin/env node
// Control Center operators (owner only). MEMBERSHIP_DATABASE_URL and MEMBERSHIP_OPERATOR_KEY set.
//   node src/cli/operators.js create --email a@b --name "Display Name" --role viewer|support|finance|owner --actor <owner name>
//        prints the initial password and the otpauth:// URI ONCE (scan it into an authenticator app); neither is stored in clear
//   node src/cli/operators.js list --actor <owner name>
//   node src/cli/operators.js disable --operator <email|id> --actor <owner name>      (sessions revoked, pending requests cancelled)
//   node src/cli/operators.js set-role --operator <email|id> --role <role> --actor <owner name>
//   node src/cli/operators.js reset-totp --operator <email|id> --actor <owner name>   (prints a new otpauth URI once)
//   node src/cli/operators.js reset-password --operator <email|id> --actor <owner name>
//        prints a new initial password once; sessions revoked; the operator must change it at the next sign-in
// A new operator (and a reset password) can sign in only to change the password: until then the
// session is restricted to POST /v1/admin/password, /me and /logout.
// Every subcommand needs --actor and is audited (actor "cli:<actor>").
// --secrets-file <path>: write the one-time secrets to a new 0600 file instead of stdout.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createPool } from '../db.js';
import { audit } from '../audit.js';
import { createOperator, listOperators, disableOperator, setOperatorRole, resetOperatorTotp, resetOperatorPassword } from '../operators.js';

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
  email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, actor: { type: 'string' }, operator: { type: 'string' },
  'secrets-file': { type: 'string' } } });
const cmd = positionals[0];
const once = (lines) => {
  if (a['secrets-file']) { fs.writeFileSync(a['secrets-file'], lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' }); console.log(`one-time secrets written to ${a['secrets-file']} (0600)`); }
  else { console.log('--- shown once, not stored in clear ---'); for (const l of lines) console.log(l); }
};
const pool = createPool();
try {
  if (!a.actor) throw new Error('--actor <owner name> is required');
  if (cmd === 'create') {
    const r = await createOperator(pool, { email: a.email, displayName: a.name, role: a.role }, a.actor, { env: process.env });
    console.log(`created operator ${r.id} (${r.role})`);
    once([`INITIAL_PASSWORD=${r.password}`, `OTPAUTH_URI=${r.otpauthUri}`]);
  } else if (cmd === 'list') {
    await audit(pool, { actorType: 'admin', actorId: 'cli:' + a.actor, action: 'operator.list', entityType: 'operator', entityId: 'all' });
    for (const o of await listOperators(pool)) console.log([o.id, o.email, JSON.stringify(o.display_name), o.role, o.status, o.locked ? 'LOCKED' : '-', o.must_change_password ? 'MUST_CHANGE_PASSWORD' : '-', o.last_login_at?.toISOString() || 'never'].join('  '));
  } else if (cmd === 'disable') {
    console.log(JSON.stringify(await disableOperator(pool, a.operator, a.actor)));
  } else if (cmd === 'set-role') {
    console.log(JSON.stringify(await setOperatorRole(pool, a.operator, a.role, a.actor)));
  } else if (cmd === 'reset-totp') {
    const r = await resetOperatorTotp(pool, a.operator, a.actor, { env: process.env });
    console.log(`new TOTP secret for operator ${r.id}; all its sessions were revoked`);
    once([`OTPAUTH_URI=${r.otpauthUri}`]);
  } else if (cmd === 'reset-password') {
    const r = await resetOperatorPassword(pool, a.operator, a.actor);
    console.log(`new initial password for operator ${r.id}; all its sessions were revoked; it must be changed at the next sign-in`);
    once([`INITIAL_PASSWORD=${r.password}`]);
  } else throw new Error('usage: create | list | disable | set-role | reset-totp | reset-password (see the header of this file)');
} catch (e) { console.error(e.message); process.exitCode = 2; } finally { await pool.end(); }
