/**
 * Constant-time comparison for shared secrets, service tokens and signatures.
 *
 * `a === b` on a secret returns as soon as the first byte differs, so response
 * timing can reveal how much of a guess was right. `crypto.timingSafeEqual`
 * does not, but it throws on buffers of different lengths -- and the usual
 * `a.length === b.length &&` guard in front of it leaks the secret's length.
 *
 * Hashing both sides with SHA-256 first gives two 32-byte digests, so the
 * comparison always runs over the same number of bytes whatever was supplied.
 *
 * An empty or missing EXPECTED value never matches: an unset secret must not
 * turn into "an empty header is accepted".
 */
import crypto from 'node:crypto';

const digest = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();

/**
 * @param {unknown} supplied  what the caller sent (header, query, bearer)
 * @param {unknown} expected  the configured secret
 * @returns {boolean}
 */
export function safeEqual(supplied, expected) {
  if (expected === undefined || expected === null) return false;
  const want = String(expected);
  if (!want) return false;
  const given = supplied === undefined || supplied === null ? '' : String(supplied);
  // Always compare, even when `given` is empty, so the code path is uniform.
  return crypto.timingSafeEqual(digest(given), digest(want));
}

export default safeEqual;
