/**
 * OAuth / OpenID Connect core — Sign in with Google and Sign in with Apple.
 *
 * Pure, dependency-free helpers (Node's built-in crypto only) so the receiver
 * and the tests exercise identical logic. No I/O here: the caller does the
 * token exchange and JWKS fetch and hands the results in.
 *
 * Identity on Gaia is GHL-contact based. These helpers only PROVE an email
 * address; the caller maps that address to a GHL contact (or routes a
 * non-member to the join funnel). An id_token is trusted only after its
 * signature and its iss/aud/exp claims verify.
 */
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

/** Split and JSON-decode a JWT without verifying it. Throws on malformed input. */
export function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) throw new Error('malformed_jwt');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] };
}

/**
 * Verify an RS256 id_token against a provider JWKS and its expected claims.
 * Returns the validated payload, or throws with a specific reason. Both Google
 * and Apple sign their id_tokens RS256 and publish an RSA JWKS.
 */
export function verifyIdToken(token, jwks, { aud, iss, now = Date.now(), nonce = null } = {}) {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  if (header.alg !== 'RS256') throw new Error('unexpected_alg');
  if (!header.kid) throw new Error('missing_kid');
  const jwk = (jwks?.keys || []).find(
    (k) => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256'),
  );
  if (!jwk) throw new Error('unknown_kid');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(
    'RSA-SHA256', Buffer.from(signingInput), pub, Buffer.from(signature, 'base64url'),
  );
  if (!ok) throw new Error('bad_signature');

  const issuers = (Array.isArray(iss) ? iss : [iss]).filter(Boolean);
  if (issuers.length && !issuers.includes(payload.iss)) throw new Error('bad_iss');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud && !auds.includes(aud)) throw new Error('bad_aud');
  if (typeof payload.exp === 'number' && now >= payload.exp * 1000) throw new Error('expired');
  if (typeof payload.iat === 'number' && payload.iat * 1000 > now + 5 * 60 * 1000) throw new Error('future_iat');
  if (nonce && payload.nonce && payload.nonce !== nonce) throw new Error('bad_nonce');
  return payload;
}

/** True boolean whether the provider says it verified this email. */
export function claimEmailVerified(payload) {
  const v = payload?.email_verified;
  return v === true || v === 'true';
}

/** Apple mints per-user relay addresses for people who chose to hide their email. */
export function isAppleRelayEmail(email) {
  return /@privaterelay\.appleid\.com$/i.test(String(email || '').trim());
}

/**
 * The Apple client secret is a short-lived ES256 JWT the app signs itself with
 * the .p8 key downloaded from the Apple Developer portal. ES256 signatures must
 * be raw R||S (ieee-p1363), not DER — Apple rejects DER.
 */
export function appleClientSecret({ servicesId, teamId, keyId, privateKey, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: teamId,
    iat,
    exp: iat + 300,
    aud: 'https://appleid.apple.com',
    sub: servicesId,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = crypto.createPrivateKey(privateKey);
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

/** Google's authorization redirect. */
export function googleAuthUrl({ clientId, redirectUri, state, nonce }) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  if (nonce) u.searchParams.set('nonce', nonce);
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

/**
 * Apple's authorization redirect. When the scope asks for email, Apple requires
 * response_mode=form_post and POSTs the result to the callback.
 */
export function appleAuthUrl({ servicesId, redirectUri, state, nonce }) {
  const u = new URL('https://appleid.apple.com/auth/authorize');
  u.searchParams.set('client_id', servicesId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('response_mode', 'form_post');
  u.searchParams.set('scope', 'name email');
  u.searchParams.set('state', state);
  if (nonce) u.searchParams.set('nonce', nonce);
  return u.toString();
}

/** Multi-line .p8 keys are often stored in an env var with literal \n escapes. */
export function normalizePrivateKey(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  const unescaped = v.includes('\\n') ? v.replace(/\\n/g, '\n') : v;
  return unescaped.includes('BEGIN') ? unescaped : '';
}

/**
 * Read provider configuration from the environment. A provider is `enabled`
 * only when every credential it needs is present, so the frontend shows a
 * button exactly when the backend can complete the flow.
 */
export function providerConfig(env = process.env) {
  const google = {
    clientId: String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim(),
    clientSecret: String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
  };
  google.enabled = Boolean(google.clientId && google.clientSecret);

  const apple = {
    servicesId: String(env.APPLE_OAUTH_SERVICES_ID || '').trim(),
    teamId: String(env.APPLE_OAUTH_TEAM_ID || '').trim(),
    keyId: String(env.APPLE_OAUTH_KEY_ID || '').trim(),
    privateKey: normalizePrivateKey(env.APPLE_OAUTH_PRIVATE_KEY || ''),
  };
  apple.enabled = Boolean(apple.servicesId && apple.teamId && apple.keyId && apple.privateKey);

  return { google, apple };
}

export const OAUTH_ENDPOINTS = {
  google: {
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
  },
  apple: {
    token: 'https://appleid.apple.com/auth/token',
    jwks: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
  },
};
