/**
 * OAuth / OIDC core — signature and claim verification, Apple client secret,
 * auth URLs, and config gating. No network: keys are generated in-process and
 * id_tokens are hand-signed so the verifier is exercised end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  decodeJwt, verifyIdToken, claimEmailVerified, isAppleRelayEmail,
  appleClientSecret, googleAuthUrl, appleAuthUrl, normalizePrivateKey,
  providerConfig, OAUTH_ENDPOINTS,
} from '../membership/oauth-core.js';

const b64urlJson = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// A throwaway RSA signer standing in for a provider's key.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const JWKS = { keys: [jwk] };

function signIdToken(payload, { kid = KID, alg = 'RS256' } = {}) {
  const header = b64urlJson({ alg, kid, typ: 'JWT' });
  const body = b64urlJson(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${sig}`;
}

const now = 1_760_000_000_000; // fixed clock
const soon = Math.floor(now / 1000) + 600;
const base = { iss: 'https://accounts.google.com', aud: 'client-123', exp: soon, iat: Math.floor(now / 1000), email: 'p@example.com', email_verified: true };

test('a well-formed id_token verifies and returns its claims', () => {
  const payload = verifyIdToken(signIdToken(base), JWKS, { aud: 'client-123', iss: OAUTH_ENDPOINTS.google.issuers, now });
  assert.equal(payload.email, 'p@example.com');
  assert.equal(claimEmailVerified(payload), true);
});

test('a tampered payload fails on the signature', () => {
  const token = signIdToken(base);
  const parts = token.split('.');
  parts[1] = b64urlJson({ ...base, email: 'attacker@evil.com' });
  assert.throws(() => verifyIdToken(parts.join('.'), JWKS, { aud: 'client-123', iss: base.iss, now }), /bad_signature/);
});

test('wrong audience is rejected', () => {
  assert.throws(() => verifyIdToken(signIdToken(base), JWKS, { aud: 'someone-else', iss: base.iss, now }), /bad_aud/);
});

test('wrong issuer is rejected', () => {
  assert.throws(() => verifyIdToken(signIdToken(base), JWKS, { aud: 'client-123', iss: 'https://appleid.apple.com', now }), /bad_iss/);
});

test('an expired token is rejected', () => {
  const expired = signIdToken({ ...base, exp: Math.floor(now / 1000) - 10 });
  assert.throws(() => verifyIdToken(expired, JWKS, { aud: 'client-123', iss: base.iss, now }), /expired/);
});

test('an unknown key id is rejected (no matching JWK)', () => {
  const token = signIdToken(base, { kid: 'rotated-away' });
  assert.throws(() => verifyIdToken(token, JWKS, { aud: 'client-123', iss: base.iss, now }), /unknown_kid/);
});

test('a non-RS256 alg is refused (alg confusion guard)', () => {
  const header = b64urlJson({ alg: 'none', kid: KID, typ: 'JWT' });
  const body = b64urlJson(base);
  assert.throws(() => verifyIdToken(`${header}.${body}.`, JWKS, { aud: 'client-123', iss: base.iss, now }), /unexpected_alg|malformed_jwt/);
});

test('nonce mismatch is rejected when a nonce is expected', () => {
  const token = signIdToken({ ...base, nonce: 'abc' });
  assert.throws(() => verifyIdToken(token, JWKS, { aud: 'client-123', iss: base.iss, now, nonce: 'xyz' }), /bad_nonce/);
  // matching nonce is fine
  assert.ok(verifyIdToken(token, JWKS, { aud: 'client-123', iss: base.iss, now, nonce: 'abc' }));
});

test('email_verified accepts the string "true" as well as boolean', () => {
  assert.equal(claimEmailVerified({ email_verified: 'true' }), true);
  assert.equal(claimEmailVerified({ email_verified: false }), false);
  assert.equal(claimEmailVerified({}), false);
});

test('Apple relay addresses are detected', () => {
  assert.equal(isAppleRelayEmail('abc123@privaterelay.appleid.com'), true);
  assert.equal(isAppleRelayEmail('real@gmail.com'), false);
});

test('the Apple client secret is a valid ES256 JWT that verifies against its key', () => {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = ec.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const secret = appleClientSecret({ servicesId: 'app.gaia.web', teamId: 'TEAM123', keyId: 'KEY123', privateKey: pem, now });
  const { header, payload, signingInput, signature } = decodeJwt(secret);
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'KEY123');
  assert.equal(payload.iss, 'TEAM123');
  assert.equal(payload.sub, 'app.gaia.web');
  assert.equal(payload.aud, 'https://appleid.apple.com');
  const ok = crypto.verify('SHA256', Buffer.from(signingInput), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  assert.equal(ok, true, 'ES256 signature verifies with the matching public key');
});

test('the auth URLs carry the required OIDC parameters', () => {
  const g = new URL(googleAuthUrl({ clientId: 'cid', redirectUri: 'https://api.gaiahealers.app/api/auth/oauth/google/callback', state: 'st', nonce: 'nn' }));
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(g.searchParams.get('client_id'), 'cid');
  assert.equal(g.searchParams.get('response_type'), 'code');
  assert.match(g.searchParams.get('scope'), /email/);
  assert.equal(g.searchParams.get('state'), 'st');

  const a = new URL(appleAuthUrl({ servicesId: 'sid', redirectUri: 'https://api.gaiahealers.app/api/auth/oauth/apple/callback', state: 'st' }));
  assert.equal(a.origin + a.pathname, 'https://appleid.apple.com/auth/authorize');
  assert.equal(a.searchParams.get('response_mode'), 'form_post', 'email scope requires form_post');
  assert.equal(a.searchParams.get('client_id'), 'sid');
});

test('normalizePrivateKey unescapes literal newlines and rejects non-PEM', () => {
  assert.match(normalizePrivateKey('-----BEGIN PRIVATE KEY-----\\nAAA\\n-----END PRIVATE KEY-----'), /\n/);
  assert.equal(normalizePrivateKey('not-a-key'), '');
  assert.equal(normalizePrivateKey(''), '');
});

test('a provider is enabled only when every credential is present', () => {
  const off = providerConfig({});
  assert.equal(off.google.enabled, false);
  assert.equal(off.apple.enabled, false);

  const g = providerConfig({ GOOGLE_OAUTH_CLIENT_ID: 'x', GOOGLE_OAUTH_CLIENT_SECRET: 'y' });
  assert.equal(g.google.enabled, true);

  const partialApple = providerConfig({ APPLE_OAUTH_SERVICES_ID: 'a', APPLE_OAUTH_TEAM_ID: 'b', APPLE_OAUTH_KEY_ID: 'c' });
  assert.equal(partialApple.apple.enabled, false, 'missing private key -> disabled');

  const fullApple = providerConfig({
    APPLE_OAUTH_SERVICES_ID: 'a', APPLE_OAUTH_TEAM_ID: 'b', APPLE_OAUTH_KEY_ID: 'c',
    APPLE_OAUTH_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nAAA\\n-----END PRIVATE KEY-----',
  });
  assert.equal(fullApple.apple.enabled, true);
});
