/**
 * The one place a request's client IP is decided.
 *
 * The proxy listens on loopback and nginx on the same host forwards to it,
 * setting `X-Real-IP $remote_addr` from the TCP connection it accepted. That
 * header is therefore trustworthy only when the TCP peer we see is loopback
 * (i.e. the request really came through nginx). From any other peer it is just
 * text the caller wrote, so the socket address is used instead.
 *
 * Deliberately NOT used:
 *   - CF-Connecting-IP: there is no Cloudflare in front of api.gaiahealers.app,
 *     so this is a header any caller can set to anything.
 *   - X-Forwarded-For: nginx *appends* to whatever the caller sent, so its first
 *     entry is attacker-controlled. Rotating it used to buy a fresh login and
 *     magic-link allowance per request.
 */

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

function normalise(addr) {
  return String(addr || '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
}

export function isLoopback(addr) {
  return LOOPBACK.test(String(addr || '').trim());
}

/** The caller's IP as nginx saw it, or the socket peer when not behind nginx. */
export function clientIp(req) {
  const peer = String(req?.socket?.remoteAddress || '').trim();
  if (isLoopback(peer)) {
    const real = normalise(req?.headers?.['x-real-ip']);
    if (real) return real;
  }
  return normalise(peer) || 'unknown';
}
