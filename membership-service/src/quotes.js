/**
 * Coin prices and single-use quotes (spec §4: show the price before any AI job,
 * then charge exactly that). The hold is tied to its quote in one transaction:
 * a quote is used at most once, by the client and person it was issued to,
 * before it expires.
 */
import { withTransaction } from './db.js';
import { audit } from './audit.js';
import { fail } from './errors.js';
import { holdDebit, quote as describe } from './coins.js';

export const QUOTE_TTL_SECONDS = 10 * 60;

export async function setActionPrice(pool, { actionKey, coins, description }, actor) {
  if (!Number.isSafeInteger(coins) || coins <= 0) fail('INVALID_INPUT', 'coins must be a positive integer');
  return withTransaction(pool, async (c) => {
    const before = (await c.query('SELECT coins, status FROM coin_action_prices WHERE action_key = $1', [actionKey])).rows[0] || null;
    await c.query(`INSERT INTO coin_action_prices (action_key, coins, description, updated_by) VALUES ($1, $2, $3, $4)
                   ON CONFLICT (action_key) DO UPDATE SET coins = EXCLUDED.coins, description = EXCLUDED.description, status = 'active', updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [actionKey, coins, description, actor.actorId]);
    await audit(c, { ...actor, action: 'coin_price.set', entityType: 'coin_action_price', entityId: actionKey, before, after: { coins } });
  });
}

export async function createQuote(pool, { client, personId, actionKey, now = new Date() }, actor) {
  return withTransaction(pool, async (c) => {
    const price = (await c.query("SELECT coins FROM coin_action_prices WHERE action_key = $1 AND status = 'active'", [actionKey])).rows[0];
    if (!price) fail('NOT_FOUND', 'no price for this action');
    const expiresAt = new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000);
    const q = (await c.query('INSERT INTO coin_quotes (person_id, client_id, action_key, coins, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [personId, client.id, actionKey, price.coins, expiresAt])).rows[0];
    await audit(c, { ...actor, action: 'coins.quote', entityType: 'coin_quote', entityId: q.id, after: { personId, actionKey, coins: price.coins } });
    return { quoteId: q.id, actionKey, expiresAt, ...describe(price.coins) };
  });
}

export async function holdForQuote(pool, { client, personId, quoteId, idempotencyKey, now = new Date() }, actor) {
  return withTransaction(pool, async (c) => {
    const q = (await c.query('SELECT * FROM coin_quotes WHERE id = $1 FOR UPDATE', [quoteId])).rows[0];
    if (!q || q.person_id !== personId || q.client_id !== client.id) fail('NOT_FOUND', 'quote not found');
    if (q.used_by_operation) {
      const op = (await c.query('SELECT * FROM coin_operations WHERE id = $1', [q.used_by_operation])).rows[0];
      if (op.idempotency_key === idempotencyKey) return { operation: op, replayed: true };
      fail('CONFLICT', 'quote already used');
    }
    if (new Date(q.expires_at) <= now) fail('CONFLICT', 'quote expired');
    const r = await holdDebit(c, { personId, coins: q.coins, idempotencyKey, reason: q.action_key, relatedType: 'coin_quote', relatedId: q.id, now, actor });
    await c.query('UPDATE coin_quotes SET used_by_operation = $2 WHERE id = $1', [q.id, r.operation.id]);
    return r;
  });
}
