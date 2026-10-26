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
import { inTransaction } from './db.js';
import { audit } from './audit.js';
import { fail, MembershipError } from './errors.js';
import { COIN_CENTS } from './catalog.js';

const SPEND_ORDER = ['granted', 'purchased', 'legacy'];
const COLUMN = { granted: 'granted_balance', purchased: 'purchased_balance', legacy: 'legacy_balance' };
export const DEFAULT_HOLD_SECONDS = 15 * 60;

const posInt = (n, what) => { if (!Number.isSafeInteger(n) || n <= 0) fail('INVALID_INPUT', what + ' must be a positive integer'); return n; };
const checkKey = (k) => { if (typeof k !== 'string' || k.length < 8 || k.length > 200) fail('INVALID_INPUT', 'idempotencyKey must be 8-200 characters'); return k; };
/** Actor: 'system', a person id string, or { actorType, actorId, requestId } from the API layer. */
export function toActor(actor = 'system') {
  if (actor && typeof actor === 'object') return { actorType: actor.actorType || 'system', actorId: String(actor.actorId || 'system'), requestId: actor.requestId || null };
  return { actorType: actor === 'system' ? 'system' : 'person', actorId: String(actor), requestId: null };
}
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
async function operation(db, args, apply) {
  try { return await operationTx(db, args, apply); }
  catch (e) { if (e.code === '23505') throw new MembershipError('CONFLICT', 'conflicting coin operation'); throw e; }
}

async function operationTx(db, { personId, walletId, kind, idempotencyKey, coins, reason, relatedType = null, relatedId = null, refundsOperation = null,
  status = 'completed', holdExpiresAt = null, actor = 'system' }, apply) {
  checkKey(idempotencyKey); posInt(coins, 'coins');
  const requestHash = hashOf({ kind, coins, reason, relatedType, relatedId, refundsOperation });
  const who = toActor(actor);
  return inTransaction(db, async (c) => {
    const wallet = walletId ? await lockWalletById(c, walletId) : await lockWallet(c, personId);
    if (!wallet) fail('NOT_FOUND', 'wallet not found');
    const prior = (await c.query('SELECT * FROM coin_operations WHERE wallet_id = $1 AND idempotency_key = $2', [wallet.id, idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) fail('CONFLICT', 'idempotency key reused for a different request');
      // A released hold must not look like a successful charge to a retrying job.
      if (prior.kind === 'debit' && prior.status === 'released') fail('CONFLICT', 'this hold was released; use a new idempotency key for a new job');
      return { operation: prior, replayed: true };
    }
    const op = (await c.query(
      `INSERT INTO coin_operations (wallet_id, kind, idempotency_key, request_hash, coins, status, reason, related_entity_type, related_entity_id,
                                    refunds_operation, hold_expires_at, actor, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $6 = 'held' THEN NULL ELSE now() END) RETURNING *`,
      [wallet.id, kind, idempotencyKey, requestHash, coins, status, reason, relatedType, relatedId, refundsOperation, holdExpiresAt, who.actorId])).rows[0];
    const extra = await apply(c, wallet, op);
    await audit(c, { ...who, action: 'coins.' + kind, entityType: 'coin_operation', entityId: op.id,
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
      if (wallet.granted_reset_at && new Date(resetAt) < new Date(wallet.granted_reset_at)) fail('CONFLICT', 'an allowance for a later cycle was already granted');
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

/**
 * Take back purchased coins after a coin-pack refund: as many of `coins` as are
 * still unspent in the purchased bucket, never below zero. Coins already spent
 * are reported as `shortfall` (a support decision, never a negative balance).
 */
export async function clawbackPurchased(db, { personId, coins, idempotencyKey, relatedId, actor = 'system' }) {
  posInt(coins, 'coins'); checkKey(idempotencyKey);
  return inTransaction(db, async (c) => {
    const w = (await c.query('SELECT id, purchased_balance FROM coin_wallets WHERE person_id = $1 FOR UPDATE', [personId])).rows[0];
    if (!w) return { clawedBack: 0, shortfall: coins, replayed: false };
    const prior = (await c.query('SELECT coins FROM coin_operations WHERE wallet_id = $1 AND idempotency_key = $2', [w.id, idempotencyKey])).rows[0];
    if (prior) return { clawedBack: prior.coins, shortfall: coins - prior.coins, replayed: true };
    const take = Math.min(coins, w.purchased_balance);
    if (take <= 0) {
      await audit(c, { ...toActor(actor), action: 'coins.clawback_shortfall', entityType: 'coin_wallet', entityId: w.id, after: { requested: coins, clawedBack: 0, relatedId } });
      return { clawedBack: 0, shortfall: coins, replayed: false };
    }
    const r = await operation(c, { personId, kind: 'adjustment', idempotencyKey, coins: take, reason: 'coin_pack_refunded', relatedType: 'payment', relatedId, actor },
      async (c2, wallet, op) => { await move(c2, wallet, op.id, 'purchased', -take, 'adjustment'); return { shortfall: coins - take }; });
    return { clawedBack: take, shortfall: coins - take, replayed: false, operation: r.operation };
  });
}

/** Open coin-refund review items (unrecovered refunded value), oldest first. */
export async function openRefundReviews(db, { limit = 100 } = {}) {
  return (await db.query("SELECT * FROM coin_refund_reviews WHERE status = 'open' ORDER BY created_at LIMIT $1", [limit])).rows;
}

export async function resolveRefundReview(db, id, { by, resolution }) {
  if (!by || typeof resolution !== 'string' || resolution.trim().length < 5) fail('INVALID_INPUT', 'by and a written resolution are required');
  return inTransaction(db, async (c) => {
    const r = await c.query("UPDATE coin_refund_reviews SET status = 'resolved', resolved_by = $2, resolution = $3, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING id", [id, by, resolution.trim()]);
    if (!r.rowCount) fail('CONFLICT', 'review not open');
    await audit(c, { actorType: 'admin', actorId: by, action: 'coins.refund_review_resolved', entityType: 'coin_refund_review', entityId: id, after: { resolution: resolution.trim() } });
    return true;
  });
}

/** Migration opening balance (spec §11). Exists for a future approved import; nothing calls it on real data. */
export async function openingBalance(pool, { personId, coins, bucket, sourceRef, actor }) {
  if (bucket !== 'purchased' && bucket !== 'legacy') fail('INVALID_INPUT', 'opening balances go to purchased or legacy');
  if (!sourceRef || !actor) fail('INVALID_INPUT', 'sourceRef and actor are required');
  return operation(pool, { personId, kind: 'migration_opening_balance', idempotencyKey: 'opening:' + sourceRef, coins, reason: 'migration_' + bucket, relatedType: 'migration', relatedId: sourceRef, actor },
    (c, wallet, op) => move(c, wallet, op.id, bucket, coins, 'migration_opening_balance'));
}

/**
 * Granted coins taken by a debit return only if no allowance reset happened
 * after it (decided by ledger order, not clocks). Otherwise they would come back
 * into a newer cycle — and must never become perpetual purchased coins.
 */
async function returnable(c, walletId, operationId) {
  const rows = (await c.query("SELECT id, balance_type, delta_coins FROM coin_transactions WHERE operation_id = $1 AND reason = 'debit_hold'", [operationId])).rows;
  const holdTx = Math.max(0, ...rows.map((r) => r.id));
  const reset = (await c.query("SELECT 1 FROM coin_transactions WHERE wallet_id = $1 AND id > $2 AND balance_type = 'granted' AND reason IN ('grant', 'grant_expiry') LIMIT 1", [walletId, holdTx])).rowCount > 0;
  const back = [], forfeited = { coins: 0 };
  for (const r of rows) {
    if (r.balance_type === 'granted' && reset) forfeited.coins += -r.delta_coins;
    else back.push(r);
  }
  return { back, forfeited: forfeited.coins };
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
export async function holdDebit(db, { personId, coins, idempotencyKey, reason, relatedType = null, relatedId = null, holdSeconds = DEFAULT_HOLD_SECONDS, now = new Date(), actor = 'system' }) {
  if (!reason) fail('INVALID_INPUT', 'reason is required');
  return operation(db, { personId, kind: 'debit', idempotencyKey, coins, reason, relatedType, relatedId, status: 'held', holdExpiresAt: new Date(now.getTime() + holdSeconds * 1000), actor },
    async (c, wallet, op) => {
      const parts = plan(wallet, coins);
      for (const [t, n] of parts) await move(c, wallet, op.id, t, -n, 'debit_hold');
      return { split: Object.fromEntries(parts) };
    });
}

async function settle(db, operationId, to, actor) {
  return inTransaction(db, async (c) => {
    const op0 = (await c.query('SELECT wallet_id FROM coin_operations WHERE id = $1', [operationId])).rows[0];
    if (!op0) fail('NOT_FOUND', 'operation not found');
    const wallet = await lockWalletById(c, op0.wallet_id);
    const op = (await c.query('SELECT * FROM coin_operations WHERE id = $1', [operationId])).rows[0];
    if (op.kind !== 'debit') fail('CONFLICT', 'not a debit');
    if (op.status === to) return { operation: op, replayed: true };
    if (op.status !== 'held') fail('CONFLICT', `debit is already ${op.status}`);
    let forfeited = 0;
    if (to === 'released') {
      const r = await returnable(c, wallet.id, op.id);
      for (const t of r.back) await move(c, wallet, op.id, t.balance_type, -t.delta_coins, 'hold_release');
      forfeited = r.forfeited;
    }
    const u = (await c.query('UPDATE coin_operations SET status = $2, settled_at = now() WHERE id = $1 RETURNING *', [op.id, to])).rows[0];
    await audit(c, { ...toActor(actor), action: 'coins.debit_' + to, entityType: 'coin_operation', entityId: op.id, after: forfeited ? { forfeitedGrantedCoins: forfeited } : null });
    return { operation: u, replayed: false, forfeitedGrantedCoins: forfeited };
  });
}

/** The AI job succeeded: the held coins are spent. */
export const captureDebit = (db, operationId, actor = 'system') => settle(db, operationId, 'captured', actor);
/** The AI job failed or was abandoned: the held coins return to the buckets they came from. */
export const releaseDebit = (db, operationId, actor = 'system') => settle(db, operationId, 'released', actor);

/** One-step debit for actions that cannot fail after charging. Same idempotency rules. */
export async function debitNow(pool, args) {
  const r = await holdDebit(pool, args);
  if (r.replayed && r.operation.status !== 'held') return r;
  const s = await captureDebit(pool, r.operation.id, args.actor);
  return { ...r, operation: s.operation };
}

/**
 * Refund a captured debit (e.g. a support decision). Coins return to their
 * original buckets; the granted part only if no allowance reset happened since
 * (see returnable()).
 */
export async function refundDebit(pool, { operationId, idempotencyKey, reason, actor }) {
  if (!reason || !actor) fail('INVALID_INPUT', 'reason and actor are required');
  const orig = (await pool.query('SELECT * FROM coin_operations WHERE id = $1', [operationId])).rows[0];
  if (!orig) fail('NOT_FOUND', 'operation not found');
  return operation(pool, { walletId: orig.wallet_id, kind: 'refund', idempotencyKey, coins: orig.coins, reason, relatedType: 'coin_operation', relatedId: orig.id, refundsOperation: orig.id, actor },
    async (c, wallet, op) => {
      const cur = (await c.query('SELECT status, created_at FROM coin_operations WHERE id = $1', [orig.id])).rows[0];
      if (cur.status !== 'captured') fail('CONFLICT', 'only a captured debit can be refunded');
      const { back, forfeited } = await returnable(c, wallet.id, orig.id);
      for (const r of back) await move(c, wallet, op.id, r.balance_type, -r.delta_coins, 'refund');
      return { forfeitedGrantedCoins: forfeited };
    });
}

/** Release holds whose job never reported back. Bounded batch; safe to run on a timer. */
export async function releaseExpiredHolds(pool, { now = new Date(), limit = 100 } = {}) {
  const ids = (await pool.query("SELECT id FROM coin_operations WHERE status = 'held' AND hold_expires_at <= $1 ORDER BY hold_expires_at LIMIT $2", [now, limit])).rows;
  let released = 0;
  for (const { id } of ids) {
    try { const r = await releaseDebit(pool, id, { actorType: 'system', actorId: 'job:release-expired-holds' }); if (!r.replayed) released++; } catch (e) { if (e.code !== 'CONFLICT') throw e; }   // captured meanwhile
  }
  return released;
}

/**
 * The allowance stops when no subscription grants one any more: what is left of
 * the granted balance expires as a ledger event (never a silent overwrite).
 * `cycleKey` makes it once per lapse.
 */
export async function expireGranted(db, { personId, cycleKey, actor = 'system' }) {
  return inTransaction(db, async (c) => {
    const w = (await c.query('SELECT granted_balance FROM coin_wallets WHERE person_id = $1 FOR UPDATE', [personId])).rows[0];
    if (!w || w.granted_balance <= 0) return { expiredCoins: 0, replayed: false };
    return operation(c, { personId, kind: 'adjustment', idempotencyKey: 'lapse:' + cycleKey, coins: w.granted_balance, reason: 'allowance_lapsed', relatedType: 'cycle', relatedId: cycleKey, actor },
      async (c2, wallet, op) => { await move(c2, wallet, op.id, 'granted', -wallet.granted_balance, 'grant_expiry'); return { expiredCoins: op.coins }; });
  });
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
