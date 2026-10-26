/**
 * Monthly coin allowance job (spec §4, §9). Safe to run as often as wanted: each
 * grant is keyed by (subscription, cycle start), so a re-run grants nothing new.
 *
 * - The allowance comes from the plan version the subscription is on.
 * - One person, several granting subscriptions: the largest allowance applies,
 *   never the sum (entitlements are not stacked; neither are coins).
 * - Annual plans still grant monthly, on the subscription's own day of month.
 * - When no subscription grants an allowance any more, the leftover granted
 *   balance expires as a ledger event.
 */
import { grantAllowance, expireGranted } from '../coins.js';
import { grantsAccess } from '../subscriptions.js';

const ACTOR = { actorType: 'system', actorId: 'job:monthly-allowance' };

function atMonth(a, y, m) {
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(yy, mm, Math.min(a.getUTCDate(), last), a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds(), a.getUTCMilliseconds()));
}

/** Start of the monthly cycle containing `now`, counted from `anchor` (UTC; day clamped to the month's length). */
export function cycleStart(anchor, now) {
  const a = new Date(anchor);
  if (now <= a) return a;
  let s = atMonth(a, now.getUTCFullYear(), now.getUTCMonth());
  if (s > now) s = atMonth(a, now.getUTCFullYear(), now.getUTCMonth() - 1);
  return s < a ? a : s;
}

/** When the next allowance is due (shown on the wallet screen). */
export function nextCycleStart(anchor, now) {
  const a = new Date(anchor), s = cycleStart(a, now);
  const n = atMonth(a, s.getUTCFullYear(), s.getUTCMonth() + 1);
  return n > s ? n : atMonth(a, s.getUTCFullYear(), s.getUTCMonth() + 2);
}

export async function runMonthlyAllowance(pool, { now = new Date(), limit = 500 } = {}) {
  const subs = (await pool.query(
    `SELECT s.*, v.monthly_coin_grant FROM subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id
      WHERE s.status IN ('active', 'trialing', 'past_due') AND v.monthly_coin_grant > 0
      ORDER BY s.person_id, v.monthly_coin_grant DESC, s.created_at LIMIT $1`, [limit])).rows;
  const best = new Map();
  for (const s of subs) if (grantsAccess(s, now) && !best.has(s.person_id)) best.set(s.person_id, s);
  const out = { granted: 0, alreadyGranted: 0, expired: 0, skipped: 0 };
  for (const s of best.values()) {
    const start = cycleStart(s.current_period_start || s.created_at, now);
    try {
      const r = await grantAllowance(pool, { personId: s.person_id, coins: s.monthly_coin_grant, cycleKey: `${s.id}:${start.toISOString()}`, resetAt: start, actor: ACTOR });
      out[r.replayed ? 'alreadyGranted' : 'granted']++;
    } catch (e) {
      if (e.code !== 'CONFLICT') throw e;
      out.skipped++;   // a later cycle was already granted (e.g. a plan change mid-cycle); never go backwards
    }
  }
  // Lapsed: wallets still holding granted coins with no granting subscription now.
  const lapsed = (await pool.query(
    'SELECT person_id, granted_reset_at FROM coin_wallets WHERE granted_balance > 0 ORDER BY person_id LIMIT $1', [limit])).rows
    .filter((w) => !best.has(w.person_id));
  for (const w of lapsed) {
    const r = await expireGranted(pool, { personId: w.person_id, cycleKey: `${w.person_id}:${new Date(w.granted_reset_at || 0).toISOString()}`, actor: ACTOR });
    if (r.expiredCoins) out.expired++;
  }
  return out;
}
