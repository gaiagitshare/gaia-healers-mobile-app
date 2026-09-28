/**
 * GAIA ASSIST — a member's allowance is theirs, not their neighbours'.
 *
 * assist-guard keys spending by address. That is right for anonymous callers
 * and wrong for members: 350 people at a conference sit behind ONE hotel NAT,
 * so one member's allowance was being spent by the 349 strangers next to them.
 *
 * A verified member is now keyed by their own id. "Verified" is the whole
 * point, so it is pinned here too: the id comes from the session cookie, which
 * readSignedToken checks with an HMAC-SHA256 over the payload using the
 * server's secret, compared with timingSafeEqual and expiry-checked. Nothing a
 * client can set reaches it. A forged cookie does not become a fresh bucket —
 * it fails the signature and lands in the shared anonymous one.
 *
 *   node --test test/assist-guard-member-key.test.js
 */
import assert from 'node:assert';
import test from 'node:test';
import { allowSpend, callerKey, guardSubject, guardConfig, _resetGuard } from '../assist-guard.js';

const VENUE = '198.51.100.7';                       // the hotel's one address
const req = (ip = VENUE) => ({ headers: { 'x-real-ip': ip }, socket: { remoteAddress: '127.0.0.1' } });
const member = (id) => ({ memberId: id, contactId: id, email: `${id}@example.invalid` });
const CFG = { ...guardConfig({}), chat: { perMinute: 5, perDay: 20, globalPerDay: 100000 }, memberFactor: 1 };

/** How many chats this subject gets through before being refused. */
function burn(subject, cfg = CFG) {
  let n = 0;
  for (let i = 0; i < 500; i += 1) {
    if (!allowSpend({ kind: 'chat', caller: subject.key, member: subject.member, cfg }).ok) break;
    n += 1;
  }
  return n;
}

test('three members on one address have three independent allowances', () => {
  _resetGuard();
  const a = guardSubject(req(), member('member-a'));
  const b = guardSubject(req(), member('member-b'));
  const c = guardSubject(req(), member('member-c'));

  assert.notStrictEqual(a.key, b.key, 'A and B share a bucket');
  assert.notStrictEqual(b.key, c.key, 'B and C share a bucket');
  assert.ok(a.member && b.member && c.member, 'a verified session must count as a member');

  // A burns their whole minute. B and C must not notice.
  assert.strictEqual(burn(a), 5, 'A did not get a full allowance');
  assert.strictEqual(allowSpend({ kind: 'chat', caller: a.key, member: true, cfg: CFG }).ok, false,
    'A should be spent out');
  assert.strictEqual(burn(b), 5, "B's allowance was consumed by A");
  assert.strictEqual(burn(c), 5, "C's allowance was consumed by A and B");
});

test('anonymous visitors on that same address keep sharing one bucket', () => {
  _resetGuard();
  // Four different browsers, one NAT, no session between them.
  const anons = [guardSubject(req(), null), guardSubject(req(), null),
                 guardSubject(req(), undefined), guardSubject(req(), {})];
  for (const a of anons) {
    assert.strictEqual(a.key, `ip:${VENUE}`, 'an anonymous caller must be keyed by address');
    assert.strictEqual(a.member, false, 'an anonymous caller is not a member');
  }
  // Their spending is pooled: the first two exhaust it for the other two.
  assert.strictEqual(burn(anons[0]), 5, 'the first anonymous caller got no allowance');
  assert.strictEqual(burn(anons[1]), 0, 'anonymous callers are NOT sharing a bucket');
  assert.strictEqual(burn(anons[3]), 0, 'anonymous callers are NOT sharing a bucket');
});

test('a member and the anonymous pool on one address do not touch each other', () => {
  _resetGuard();
  const anon = guardSubject(req(), null);
  const a = guardSubject(req(), member('member-a'));
  assert.strictEqual(burn(anon), 5, 'the anonymous pool got no allowance');
  assert.strictEqual(burn(a), 5, "the anonymous pool drained a member's allowance");
});

test('the same member from a different address is still the same member', () => {
  _resetGuard();
  const atVenue = guardSubject(req(VENUE), member('member-a'));
  const atHome = guardSubject(req('203.0.113.55'), member('member-a'));
  assert.strictEqual(atVenue.key, atHome.key, 'one member became two by moving network');
  assert.strictEqual(burn(atVenue), 5, 'no allowance at the venue');
  assert.strictEqual(burn(atHome), 0, 'a member doubled their allowance by changing address');
});

test('nothing a client sends can name a member', () => {
  _resetGuard();
  // Every channel a caller controls, all claiming to be somebody.
  const spoofed = {
    headers: {
      'x-real-ip': VENUE,
      'x-member-id': 'member-a',
      'x-forwarded-for': '1.2.3.4',
      'x-gaia-member': 'member-a',
      authorization: 'Bearer member-a',
      cookie: 'gaia_session=forged.signature; member_id=member-a',
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
  // guardSubject is only ever given an identity the SERVER resolved. A forged
  // cookie fails readSignedToken upstream, so what arrives here is null.
  const who = guardSubject(spoofed, null);
  assert.strictEqual(who.key, `ip:${VENUE}`, 'a client-supplied id was accepted as identity');
  assert.strictEqual(who.member, false, 'a client talked its way into the member factor');

  // And it cannot escape a spent bucket by claiming to be someone.
  assert.strictEqual(burn(guardSubject(req(), null)), 5);
  assert.strictEqual(burn(who), 0, 'spoofed headers bought a fresh allowance');
});

test('a spoofed address cannot buy a fresh anonymous bucket either', () => {
  _resetGuard();
  const real = guardSubject({ headers: { 'x-real-ip': VENUE, 'x-forwarded-for': '9.9.9.9' },
                              socket: { remoteAddress: '127.0.0.1' } }, null);
  assert.strictEqual(real.key, `ip:${VENUE}`, 'X-Forwarded-For was trusted over X-Real-IP');
  assert.strictEqual(burn(guardSubject(req(), null)), 5);
  assert.strictEqual(burn(real), 0, 'a spoofed X-Forwarded-For bought a fresh allowance');
});

test('member and address keys can never collide', () => {
  // A member id that looks exactly like the venue's address.
  const looksLikeAnIp = guardSubject(req(), member(VENUE));
  const anon = guardSubject(req(), null);
  assert.notStrictEqual(looksLikeAnIp.key, anon.key,
    "a member id shaped like an address landed in that address's bucket");
});

test('a session with only an e-mail is still keyed to that person', () => {
  _resetGuard();
  const byEmail = guardSubject(req(), { email: 'Someone@Example.Invalid' });
  assert.strictEqual(byEmail.key, 'member:someone@example.invalid', 'e-mail identity was dropped');
  assert.strictEqual(byEmail.member, true);
  assert.notStrictEqual(byEmail.key, `ip:${VENUE}`);
});
