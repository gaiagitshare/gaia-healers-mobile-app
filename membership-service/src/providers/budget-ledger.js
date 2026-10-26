/**
 * Cross-run Stripe request budget (owner: 25 requests in total for the first
 * real sandbox runs). Same file format as stripe-sandbox.js --budget-ledger:
 * { budget, used, runs: [...] }. A step RESERVES its whole planned count before
 * sending anything, so a crash can never take the total past the budget; the
 * reservation is never refunded. The budget cannot be raised from code or flags.
 */
import fs from 'node:fs';
import { MembershipError } from '../errors.js';

export function openLedger(file, budget) {
  if (!file || !Number.isInteger(budget) || budget < 1) throw new MembershipError('INVALID_INPUT', 'ledger file and budget are required');
  let state = { budget, used: 0, runs: [] };
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new MembershipError('INVALID_INPUT', 'budget ledger unreadable'); }
  if (state.budget !== budget) throw new MembershipError('FORBIDDEN', `ledger budget is ${state.budget}; a new budget needs a new ledger, after approval`);
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 1), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  return {
    get used() { return state.used; },
    get budget() { return state.budget; },
    remaining: () => state.budget - state.used,
    reserve(label, planned) {
      if (state.used + planned > state.budget) throw new MembershipError('FORBIDDEN', `${state.used} used + ${planned} planned exceeds the total budget of ${state.budget}`);
      state.used += planned;
      state.runs.push({ label, reserved: planned, requests: null, at: new Date().toISOString() });
      save();
      const run = state.runs[state.runs.length - 1];
      return { done(sent) { run.requests = sent; save(); } };
    },
  };
}
