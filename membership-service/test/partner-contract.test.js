import test from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, unavailableAdapter } from '../src/partner/adapter.js';
import { classifyCarryOver, validateCoinLedger, validateSubscription } from '../src/partner/contract.js';

const ledger = {
  balance: { practitioner_account_id: 'gp_fixture_1', coins: 700, as_of: '2026-12-01T00:00:00Z' },
  transactions: [
    { transaction_id: 't1', delta_coins: 500, source: 'grant', created_at: '2026-01-01T00:00:00Z' },
    { transaction_id: 't2', delta_coins: 600, source: 'purchase', payment_ref: 'pi_fixture', created_at: '2026-02-01T00:00:00Z' },
    { transaction_id: 't3', delta_coins: -400, source: 'spend', created_at: '2026-03-01T00:00:00Z' },
  ],
};

test('with no partner configured, every call fails closed', async () => {
  await assert.rejects(unavailableAdapter.getCoinLedger('x'), (e) => e.code === 'PROVIDER_UNAVAILABLE');
});

test('carry-over: purchased only where a payment backs it; the rest is legacy (N-4 open)', () => {
  assert.deepEqual(classifyCarryOver(ledger), { purchased: 600, legacy: 100 });
  assert.deepEqual(classifyCarryOver(ledger, { allHistoricalArePurchased: true }), { purchased: 700, legacy: 0 });
});

test('a balance that does not match its history, or a purchase without a payment, is rejected', () => {
  assert.throws(() => validateCoinLedger({ ...ledger, balance: { ...ledger.balance, coins: 701 } }), /sum of its transactions/);
  assert.throws(() => validateCoinLedger({ ...ledger, transactions: [{ transaction_id: 'x', delta_coins: 700, source: 'purchase', created_at: '2026-01-01T00:00:00Z' }] }), /payment_ref/);
});

test('mock adapter serves validated fixtures; module entitlements come from live subscriptions only', async () => {
  const sub = { subscription_id: 's1', practitioner_account_id: 'gp_fixture_1', plan_code: 'scan_analysis', status: 'active', price_cents: 4700, currency: 'USD',
    interval: 'month', current_period_end: '2026-12-31T00:00:00Z', billing_owner: 'partner', billing_provider: 'stripe', modules: ['scan_analysis'] };
  const a = mockAdapter({ practitioners: [{ practitioner_account_id: 'gp_fixture_1', status: 'active' }],
    subscriptions: [sub, { ...sub, subscription_id: 's2', status: 'canceled', modules: ['chakras'] }], coinLedgers: { gp_fixture_1: ledger } });
  assert.deepEqual(await a.listModuleEntitlements('gp_fixture_1'), ['scan_analysis']);
  assert.equal((await a.getCoinLedger('gp_fixture_1')).balance.coins, 700);
  assert.throws(() => validateSubscription({ ...sub, billing_owner: 'unknown' }), /billing_owner/);
});
