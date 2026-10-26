/**
 * Coin wallet (spec §4, §9; audit H).
 *
 * Buckets: granted (monthly allowance, reset each cycle), purchased (never
 * expires), legacy (migrated, unproven provenance; never expires).
 * Spend order: granted -> purchased -> legacy.
 *
 * Every write:
 *   - locks the wallet row (SELECT ... FOR UPDATE), so concurrent debits
 *     serialize and can never overdraw;
 *   - is one coin_operations row keyed by (wallet, idempotency_key): replaying
 *     the same request returns the first result, a different request under the
 *     same key is a CONFLICT;
 *   - writes append-only coin_transactions rows, so balances always equal the
 *     transaction sums.
 *
 * AI jobs use hold -> capture / release: the coins are reserved before the job,
 * captured if it succeeds, released if it fails, so a failed job nets zero and
 * a retried job is never charged twice.
 *
 * Nothing here moves real coins: the partner's coin system is untouched and no
 * production database exists yet.
 */
import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';
import { COIN_CENTS } from './catalog.js';

const SPEND_ORDER = ['granted', 'purchased', 'legacy'];
const COLUMN = { granted: 'granted_balance', purchased: 'purchased_balance', legacy: 'legacy_balance' };
export const DEFAULT_HOLD_SECONDS = 15 * 60;

const posInt = (n, what) => { if (!Number.isSafeInteger(n) || n <= 0) fail('INVALID_INPUT', what + ' must be a positive integer'); return n; };
const checkKey = (k) => { if (typeof k !== 'string' || k.length < 8 || k.length > 200) fail('INVALID_INPUT', 'idempotencyKey must be 8-200 characters'); return k; };
const hashOf = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

export const coinsToCents = (coins) => coins * COIN_CENTS;
export const formatUsd = (cents) => '$' + (cents / 100).toFixed(2);

async function lockWallet(c, personId) {
  await c.query('INSERT INTO coin_wallets (person_id) VALUES ($1) ON CONFLICT (person_id) DO NOTHING', [personId]);
  return (await c.query('SELECT * FROM coin_wallets WHERE person_id = $1 FOR UPDATE', [personId])).rows[0];
}

async function lockWalletById(c, walletId) {
  return (await c.query('SELECT * FROM coin_wallets WHERE id = $1 FOR UPDATE', [walletId])).rows[0];
}

async function move(c, wallet, operationId, type, delta, reason) {
  const col = COLUMN[type];
  const after = wallet[col] + delta;
  if (after < 0) fail('INSUFFICIENT_COINS', 'balance would go negative');
  wallet[col] = after;
  await c.query(`UPDATE coin_wallets SET ${col} = $2, updated_at = now() WHERE id = $1`, [wallet.id, after]);
  await c.query('INSERT INTO coin_transactions (wallet_id, operation_id, balance_type, delta_coins, balance_after, reason) VALUES ($1, $2, $3, $4, $5, $6)',
    [wallet.id, operationId, type, delta, after, reason]);
}

/**
 * Shared idempotent operation wrapper. `apply(c, wallet, op)` writes the rows.
 * Returns { operation, replayed }.
 */
async function operation(pool, { personId, walletId, kind, idempotencyKey, coins, reason, relatedType = null, relatedId = null, refundsOperation = null,
  status = 'completed', holdExpiresAt = null, actor = 'system' }, apply) {
  checkKey(idempotencyKey); posInt(coins, 'coins');
  const requestHash = hashOf({ kind, coins, reason, relatedType, relatedId, refundsOperation });
  return withTransaction(pool, async (c) => {
    const wallet = walletId ? await lockWalletById(c, walletId) : await lockWallet(c, personId);
    if (!wallet) fail('NOT_FOUND', 'wallet not found');
    const prior = (await c.query('SELECT * FROM coin_operations WHERE wallet_id = $1 AND idempotency_key = $2', [wallet.id, idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) fail('CONFLICT', 'idempotency key reused for a different request');
      return { operation: prior, replayed: true };
    }
    const op = (await c.query(
      `INSERT INTO coin_operations (wallet_id, kind, idempotency_key, request_hash, coins, status, reason, related_entity_type, related_entity_id,
                                    refunds_operation, hold_expires_at, actor, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $6 = 'held' THEN NULL ELSE now() END) RETURNING *`,
      [wallet.id, kind, idempotencyKey, requestHash, coins, status, reason, relatedType, relatedId, refundsOperation, holdExpiresAt, actor])).rows[0];
    const extra = await apply(c, wallet, op);
    await audit(c, { actorType: actor === 'system' ? 'system' : 'person', actorId: actor, action: 'coins.' + kind, entityType: 'coin_operation', entityId: op.id,
      after: { coins, reason, status, ...(extra || {}) } });
    return { operation: op, replayed: false, ...(extra || {}) };
  });
}

/**
 * Monthly allowance (spec §9): expire what is left of the previous allowance
 * (use-it-or-lose-it, written as a grant_expiry row, never a silent overwrite)
 * and credit the new one. `cycleKey` identifies the cycle, e.g.
 * `${subscriptionId}:${periodStartISO}`, so a re-run grants once.
 */
export async function grantAllowance(pool, { personId, coins, cycleKey, resetAt = new Date(), actor = 'system' }) {
  return operation(pool, { personId, kind: 'grant', idempotencyKey: 'grant:' + cycleKey, coins, reason: 'monthly_allowance', relatedType: 'cycle', relatedId: cycleKey, actor },
    async (c, wallet, op) => {
      const expired = wallet.granted_balance;
      if (expired > 0) await move(c, wallet, op.id, 'granted', -expired, 'grant_expiry');
      await move(c, wallet, op.id, 'granted', coins, 'grant');
      await c.query('UPDATE coin_wallets SET granted_reset_at = $2 WHERE id = $1', [wallet.id, resetAt]);
      return { expiredCoins: expired };
    });
}

/** Credit a purchased pack. Only from a recorded (here: simulated) payment. */
export async function creditPurchase(pool, { personId, coins, idempotencyKey, paymentRef, actor = 'system' }) {
  if (!paymentRef) fail('INVALID_INPUT', 'paymentRef is required for purchased coins');
  return operation(pool, { personId, kind: 'purchase', idempotencyKey, coins, reason: 'coin_pack', relatedType: 'payment', relatedId: paymentRef, actor },
    (c, wallet, op) => move(c, wallet, op.id, 'purchased', coins, 'purchase'));
}

/** Migration opening balance (spec §11). Exists for a future approved import; nothing calls it on real data. */
export async function openingBalance(pool, { personId, coins, bucket, sourceRef, actor }) {
  if (bucket !== 'purchased' && bucket !== 'legacy') fail('INVALID_INPUT', 'opening balances go to purchased or legacy');
  if (!sourceRef || !actor) fail('INVALID_INPUT', 'sourceRef and actor are required');
  return operation(pool, { personId, kind: 'migration_opening_balance', idempotencyKey: 'opening:' + sourceRef, coins, reason: 'migration_' + bucket, relatedType: 'migration', relatedId: sourceRef, actor },
    (c, wallet, op) => move(c, wallet, op.id, bucket, coins, 'migration_opening_balance'));
}

function plan(wallet, coins) {
  const parts = []; let left = coins;
  for (const t of SPEND_ORDER) {
    const take = Math.min(left, wallet[COLUMN[t]]);
    if (take > 0) { parts.push([t, take]); left -= take; }
  }
  if (left > 0) fail('INSUFFICIENT_COINS', 'not enough coins', { needed: coins, available: coins - left });
  return parts;
}

/** Reserve coins before an AI job. The price must already have been quoted and confirmed. */
export async function holdDebit(pool, { personId, coins, idempotencyKey, reason, relatedType = null, relatedId = null, holdSeconds = DEFAULT_HOLD_SECONDS, now = new Date(), actor = 'system' }) {
  if (!reason) fail('INVALID_INPUT', 'reason is required');
  return operation(pool, { personId, kind: 'debit', idempotencyKey, coins, reason, relatedType, relatedId, status: 'held', holdExpiresAt: new Date(now.getTime() + holdSeconds * 1000), actor },
    async (c, wallet, op) => {
      const parts = plan(wallet, coins);
      for (const [t, n] of parts) await move(c, wallet, op.id, t, -n, 'debit_hold');
      return { split: Object.fromEntries(parts) };
    });
}

async function settle(pool, operationId, to) {
  return withTransaction(pool, async (c) => {
    const op0 = (await c.query('SELECT wallet_id FROM coin_operations WHERE id = $1', [operationId])).rows[0];
    if (!op0) fail('NOT_FOUND', 'operation not found');
    const wallet = await lockWalletById(c, op0.wallet_id);
    const op = (await c.query('SELECT * FROM coin_operations WHERE id = $1', [operationId])).rows[0];
    if (op.kind !== 'debit') fail('CONFLICT', 'not a debit');
    if (op.status === to) return { operation: op, replayed: true };
    if (op.status !== 'held') fail('CONFLICT', `debit is already ${op.status}`);
    if (to === 'released') {
      const rows = (await c.query("SELECT balance_type, delta_coins FROM coin_transactions WHERE operation_id = $1 AND reason = 'debit_hold'", [op.id])).rows;
      for (const r of rows) await move(c, wallet, op.id, r.balance_type, -r.delta_coins, 'hold_release');
    }
    const u = (await c.query('UPDATE coin_operations SET status = $2, settled_at = now() WHERE id = $1 RETURNING *', [op.id, to])).rows[0];
    await audit(c, { action: 'coins.debit_' + to, entityType: 'coin_operation', entityId: op.id });
    return { operation: u, replayed: false };
  });
}

/** The AI job succeeded: the held coins are spent. */
export const captureDebit = (pool, operationId) => settle(pool, operationId, 'captured');
/** The AI job failed or was abandoned: the held coins return to the buckets they came from. */
export const releaseDebit = (pool, operationId) => settle(pool, operationId, 'released');

/** One-step debit for actions that cannot fail after charging. Same idempotency rules. */
export async function debitNow(pool, args) {
  const r = await holdDebit(pool, args);
  if (r.replayed && r.operation.status !== 'held') return r;
  const s = await captureDebit(pool, r.operation.id);
  return { ...r, operation: s.operation };
}

/**
 * Refund a captured debit (e.g. a support decision). Coins return to their
 * original buckets; the granted part is returned only if the allowance has not
 * been reset since (it would have expired anyway; never converted to perpetual
 * purchased coins).
 */
export async function refundDebit(pool, { operationId, idempotencyKey, reason, actor }) {
  if (!reason || !actor) fail('INVALID_INPUT', 'reason and actor are required');
  const orig = (await pool.query('SELECT * FROM coin_operations WHERE id = $1', [operationId])).rows[0];
  if (!orig) fail('NOT_FOUND', 'operation not found');
  return operation(pool, { walletId: orig.wallet_id, kind: 'refund', idempotencyKey, coins: orig.coins, reason, relatedType: 'coin_operation', relatedId: orig.id, refundsOperation: orig.id, actor },
    async (c, wallet, op) => {
      const cur = (await c.query('SELECT status, created_at FROM coin_operations WHERE id = $1', [orig.id])).rows[0];
      if (cur.status !== 'captured') fail('CONFLICT', 'only a captured debit can be refunded');
      const rows = (await c.query("SELECT balance_type, delta_coins FROM coin_transactions WHERE operation_id = $1 AND reason = 'debit_hold'", [orig.id])).rows;
      let forfeited = 0;
      for (const r of rows) {
        if (r.balance_type === 'granted' && wallet.granted_reset_at && new Date(wallet.granted_reset_at) > new Date(cur.created_at)) { forfeited += -r.delta_coins; continue; }
        await move(c, wallet, op.id, r.balance_type, -r.delta_coins, 'refund');
      }
      return { forfeitedGrantedCoins: forfeited };
    });
}

/** Release holds whose job never reported back. Bounded batch; safe to run on a timer. */
export async function releaseExpiredHolds(pool, { now = new Date(), limit = 100 } = {}) {
  const ids = (await pool.query("SELECT id FROM coin_operations WHERE status = 'held' AND hold_expires_at <= $1 ORDER BY hold_expires_at LIMIT $2", [now, limit])).rows;
  let released = 0;
  for (const { id } of ids) {
    try { const r = await releaseDebit(pool, id); if (!r.replayed) released++; } catch (e) { if (e.code !== 'CONFLICT') throw e; }   // captured meanwhile
  }
  return released;
}

/** Wallet screen data (spec §4 UX): both balances with dollar equivalents and the next grant date. */
export async function walletView(db, personId, { nextGrantAt = null } = {}) {
  const w = (await db.query('SELECT * FROM coin_wallets WHERE person_id = $1', [personId])).rows[0]
    || { granted_balance: 0, purchased_balance: 0, legacy_balance: 0, granted_reset_at: null };
  const b = (coins) => ({ coins, usd: formatUsd(coinsToCents(coins)) });
  const total = w.granted_balance + w.purchased_balance + w.legacy_balance;
  return { granted: b(w.granted_balance), purchased: b(w.purchased_balance), legacy: b(w.legacy_balance), total: b(total), lastGrantAt: w.granted_reset_at, nextGrantAt };
}

/** "This analysis costs 40 coins (≈ $0.40)" — the quote shown before any AI job runs. */
export function quote(coins) {
  posInt(coins, 'coins');
  return { coins, usd: formatUsd(coinsToCents(coins)), text: `This costs ${coins} coins (≈ ${formatUsd(coinsToCents(coins))})` };
}
