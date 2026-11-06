import test from 'node:test';
import assert from 'node:assert/strict';
import { indexMappings, lineText, pickMapping } from '../ticket-mapping.mjs';

const P = '69b463a14181e967e2fc2cfe';
const plain = { external_product_id: P, ticket_type_id: 8, product_name_match: null };
const conf = { external_product_id: P, ticket_type_id: 7, product_name_match: '+ CONFERENCE' };

test('the order line decides between a product\'s mappings, in either feed order', () => {
  for (const rows of [[plain, conf], [conf, plain]]) {
    const list = indexMappings(rows).get(P);
    assert.equal(pickMapping(list, 'GENERAL ADMISSION (EXHIBIT HALL ONLY) GENERAL ADMISSION ').ticket_type_id, 8);
    assert.equal(pickMapping(list, 'GENERAL ADMISSION + CONFERENCE GENERAL ADMISSION + CONFERENCE @ 249').ticket_type_id, 7);
    assert.equal(pickMapping(list, 'general admission + conference').ticket_type_id, 7);
    assert.equal(pickMapping(list, '').ticket_type_id, 8, 'no wording: the plain mapping');
  }
});

test('the longest matching wording wins', () => {
  const vip = { external_product_id: P, ticket_type_id: 4, product_name_match: '+ CONFERENCE VIP' };
  assert.equal(pickMapping([plain, conf, vip], 'X + CONFERENCE VIP').ticket_type_id, 4);
});

test('an unmapped product stays unmapped, and a variant-only product needs its wording', () => {
  assert.equal(pickMapping(undefined, 'anything'), undefined);
  assert.equal(pickMapping([conf], 'EXHIBIT HALL ONLY'), undefined);
});

test('lineText reads the line and its price name', () => {
  assert.equal(lineText({ name: 'GA', price: { name: 'GA @ 249' } }), 'GA GA @ 249');
  assert.equal(lineText({}), '');
});

test('indexMappings applies the filter', () => {
  const idx = indexMappings([plain, { ...conf, provider: 'shopify' }], (m) => m.provider !== 'shopify');
  assert.equal(idx.get(P).length, 1);
});
