/**
 * Loopback-only preload for scripts/membership-test-all.sh (loaded through
 * NODE_OPTIONS into every node process the runner starts, child processes too).
 *
 * The suites carry their own network denies: the membership provider tests
 * allow loopback only; the staging-proxy preload also lets our own public host
 * names resolve, for the live checks that run on the server. The runner promises
 * loopback only, so this layer sits UNDER both: anything that is not loopback
 * fails here as "not resolved" (ENOTFOUND) — a plain offline answer, not the
 * suites' own "TEST NETWORK DENY" verdict, so their tests about which names they
 * allow still see their own rules.
 */
import dns from 'node:dns';
import net from 'node:net';

const NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);
const loopback = (host) => {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return NAMES.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '::1' || h === '::ffff:127.0.0.1' || h === '0.0.0.0';
};
const offline = (host) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (membership-test-all runs offline: loopback only)`),
  { code: 'ENOTFOUND', hostname: host, syscall: 'getaddrinfo' });

const realLookup = dns.lookup;
dns.lookup = function offlineLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (loopback(hostname)) return realLookup.call(dns, hostname, options, callback);
  process.nextTick(() => callback(offline(hostname)));
  return undefined;
};
if (dns.promises?.lookup) {
  const realP = dns.promises.lookup;
  dns.promises.lookup = (hostname, options) => (loopback(hostname) ? realP.call(dns.promises, hostname, options) : Promise.reject(offline(hostname)));
}

const realFetch = globalThis.fetch;
if (realFetch) {
  globalThis.fetch = async function offlineFetch(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (!loopback(url.hostname)) throw new TypeError('fetch failed', { cause: offline(url.hostname) });
    return realFetch(input, init);
  };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function offlineConnect(...args) {
  const a0 = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host = 'localhost';
  if (a0 && typeof a0 === 'object') { if (!a0.path) host = a0.host ?? 'localhost'; }
  else if (typeof a0 === 'number' || /^\d+$/.test(String(a0))) host = typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!loopback(host)) throw offline(host);
  return realConnect.apply(this, args);
};

globalThis.__MEMBERSHIP_TEST_ALL_OFFLINE__ = true;
