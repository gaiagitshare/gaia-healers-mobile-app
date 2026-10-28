/**
 * Each ticket in a checkout carries its own share of the charge, not the order
 * total (26 Oct 2026: VIP + Three Day in one $1,747.94 order was counted twice).
 * Offline, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineAmounts, unitPrice, lineQty } from '../order-lines.mjs';

const vip = { product: { _id: 'VIP' }, qty: 1, price: { amount: 999 } };
const day3 = { product: { _id: 'DAY3' }, qty: 1, price: { amount: 650 } };

test('the real 26 Oct order splits into its two lines, tax included, summing to the charge', () => {
  const m = lineAmounts([vip, day3], 1747.94);
  assert.equal(m.get('VIP'), 1058.94);
  assert.equal(m.get('DAY3'), 689);
  assert.equal(Math.round((m.get('VIP') + m.get('DAY3')) * 100) / 100, 1747.94);
});

test('one line takes the whole charge, as before', () => {
  assert.equal(lineAmounts([vip], 1058.94).get('VIP'), 1058.94);
});

test('quantity multiplies the line; cents always add up to the total', () => {
  const ga = { productId: 'GA', qty: 3, price: 99 };
  const m = lineAmounts([ga, { productId: 'SAT', quantity: 1, amount: 197 }], 524.94);
  assert.equal(Math.round((m.get('GA') + m.get('SAT')) * 100) / 100, 524.94);
  assert.ok(m.get('GA') > m.get('SAT'));
  assert.equal(lineQty(ga), 3);
  assert.equal(unitPrice({ amount: 197 }), 197);
});

test('a discount is shared out the same way as tax', () => {
  const m = lineAmounts([vip, day3], 1484.1);   // 10% off, no tax
  assert.equal(m.get('VIP'), 899.1);
  assert.equal(m.get('DAY3'), 585);
});

test('an order with no readable prices is not split by guesswork', () => {
  const m = lineAmounts([{ productId: 'A' }, { productId: 'B' }], 200);
  assert.equal(m.get('A'), null);
  assert.equal(m.get('B'), null);
});
