/**
 * NETWORK DENY for the provider-adapter tests. Every test/providers-*.test.js
 * imports this FIRST (test/providers-guard.test.js enforces that).
 *
 * Stricter than staging-proxy/test/_deny-network.mjs: nothing but loopback is
 * allowed, by name or by address. Three layers, so no transport slips past:
 *   1. globalThis.fetch refuses any URL whose host is not loopback;
 *   2. dns.lookup refuses every non-loopback name (covers http, https, undici, ws);
 *   3. net.Socket#connect refuses every non-loopback address, including literal
 *      IPs that never reach dns.lookup.
 * Stripe, GHL and the partner are therefore unreachable from these tests —
 * not even Stripe test mode.
 */
import dns from 'node:dns';
import net from 'node:net';

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);
export function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return LOOPBACK_NAMES.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '::1' || h === '::ffff:127.0.0.1';
}
const deny = (host) => Object.assign(new Error(`TEST NETWORK DENY: ${host} is not loopback. Provider tests must use loopback fakes (AGENTS.md).`), { code: 'ENOTFOUND', hostname: host });

const realFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (!isLoopbackHost(url.hostname)) throw deny(url.hostname);
  return realFetch(input, init);
};

const realLookup = dns.lookup;
dns.lookup = function denyingLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (isLoopbackHost(hostname)) return realLookup.call(dns, hostname, options, callback);
  process.nextTick(() => callback(deny(hostname)));
  return undefined;
};
if (dns.promises?.lookup) {
  const realP = dns.promises.lookup;
  dns.promises.lookup = (hostname, options) => (isLoopbackHost(hostname) ? realP.call(dns.promises, hostname, options) : Promise.reject(deny(hostname)));
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const a0 = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host = 'localhost';
  if (a0 && typeof a0 === 'object') { if (!a0.path) host = a0.host ?? 'localhost'; }
  else if (typeof a0 === 'number' || /^\d+$/.test(String(a0))) host = typeof args[1] === 'string' ? args[1] : 'localhost';
  // a bare string that is not a port is a unix socket path: local by definition
  if (!isLoopbackHost(host)) throw deny(host);
  return realConnect.apply(this, args);
};

globalThis.__GAIA_PROVIDER_NETWORK_DENY__ = true;
