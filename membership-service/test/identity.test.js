import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPool, SKIP } from './_db.js';
import { resolveOrCreatePerson, linkIdentity, findPerson, identitiesOf } from '../src/identity.js';

test('one external id maps to one person, even under concurrent first sight', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const ref = { platform: 'ghl', kind: 'contact', externalId: 'ghl-contact-fixture-1' };
    const results = await Promise.all(Array.from({ length: 8 }, () => resolveOrCreatePerson(pool, ref)));
    assert.equal(new Set(results.map((r) => r.personId)).size, 1);
    assert.equal(results.filter((r) => r.created).length, 1);
  } finally { await pool.end(); }
});

test('a Practitioners account already linked to someone else is a CONFLICT, never a silent re-key', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const a = (await resolveOrCreatePerson(pool, { platform: 'ghl', kind: 'contact', externalId: 'c-a' })).personId;
    const b = (await resolveOrCreatePerson(pool, { platform: 'ghl', kind: 'contact', externalId: 'c-b' })).personId;
    const prac = { platform: 'gaia_practitioners', kind: 'practitioner_account', externalId: 'gp-acct-fixture-9' };
    assert.deepEqual(await linkIdentity(pool, a, prac, { linkedBy: 'oauth' }), { linked: true, alreadyLinked: false });
    assert.deepEqual(await linkIdentity(pool, a, prac, { linkedBy: 'oauth' }), { linked: false, alreadyLinked: true });
    await assert.rejects(linkIdentity(pool, b, prac, { linkedBy: 'oauth' }), (e) => e.code === 'CONFLICT');
    assert.equal((await findPerson(pool, prac)).id, a);
    assert.equal((await identitiesOf(pool, a)).length, 2);
  } finally { await pool.end(); }
});

test('emails are normalized; bad references are rejected', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const x = await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: ' Someone@Example.invalid ' });
    const y = await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: 'someone@example.invalid' });
    assert.equal(x.personId, y.personId);
    await assert.rejects(resolveOrCreatePerson(pool, { platform: 'myspace', kind: 'contact', externalId: '1' }), (e) => e.code === 'INVALID_INPUT');
  } finally { await pool.end(); }
});

test('concurrent links of the same identity to the same person all succeed (no false conflict)', { skip: SKIP }, async () => {
  const pool = await freshPool();
  try {
    const { personId } = await resolveOrCreatePerson(pool, { platform: 'email', kind: 'address', externalId: 'race@example.invalid' });
    const ref = { platform: 'stripe', kind: 'customer', externalId: 'cus_fixture_race' };
    for (let round = 0; round < 5; round++) {
      await pool.query("DELETE FROM person_identities WHERE platform = 'stripe'");
      const out = await Promise.all(Array.from({ length: 6 }, () => linkIdentity(pool, personId, ref, { linkedBy: 'test' })));
      assert.equal(out.filter((o) => o.linked).length, 1);
      assert.ok(out.every((o) => o.linked || o.alreadyLinked));
    }
  } finally { await pool.end(); }
});
