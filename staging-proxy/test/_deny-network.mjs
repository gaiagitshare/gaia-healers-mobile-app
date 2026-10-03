/**
 * NETWORK DENY FOR THE TEST SUITE — loaded by `npm test` (--import), before
 * any test file.
 *
 * The paid-API rule in AGENTS.md says the suite must never contact a paid
 * provider. Until now that rested on every test remembering to stub `fetch`
 * or point QWEN_BASE_URL at a local port. This makes it structural: name
 * resolution for any host outside a short allow-list fails immediately, so an
 * accidental call to Gemini, Qwen, Groq, OpenRouter, OpenAI, ElevenLabs -- or a
 * provider nobody has thought of yet -- is an error, not a bill.
 *
 * It patches dns.lookup, which is what net.connect (and therefore fetch via
 * undici, http, https and the `ws` client) all use to turn a hostname into an
 * address. Literal IP addresses never reach dns.lookup, so 127.0.0.1 and ::1
 * keep working, and so do the loopback hostnames.
 *
 * Allowed by name: our own public proxy and site, which the live-env checks
 * (test/_live-env.js) exercise on the VPS. Those are our servers, not a model.
 * GAIA_TEST_ALLOW_HOSTS=a.example,b.example extends the list for one run.
 *
 * It also turns the usage log OFF by default for the whole suite, so no test
 * can write fake sessions into data/assist-usage.jsonl. A test that wants
 * records names its own file in GAIA_USAGE_LOG (the capture test does).
 */
import dns from 'node:dns';

const ALLOW = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost',
  'api.gaiahealers.app', 'gaiahealers.app', 'www.gaiahealers.app', 'gaiagitshare.github.io',
  ...String(process.env.GAIA_TEST_ALLOW_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);

const realLookup = dns.lookup;
function denyingLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (ALLOW.has(host) || /^(127\.|0\.0\.0\.0$|\[?::1\]?$)/.test(host)) {
    return realLookup.call(dns, hostname, options, callback);
  }
  const err = new Error(`TEST NETWORK DENY: ${host} is not a local or Gaia host. ` +
    'Tests must not reach external services (AGENTS.md); stub the provider or point it at a local port.');
  err.code = 'ENOTFOUND';
  err.hostname = host;
  err.syscall = 'getaddrinfo';
  process.nextTick(() => callback(err));
  return undefined;
}
dns.lookup = denyingLookup;
// dns.promises.lookup is a separate function; patch it the same way.
if (dns.promises && typeof dns.promises.lookup === 'function') {
  dns.promises.lookup = (hostname, options) => new Promise((resolve, reject) =>
    denyingLookup(hostname, options || {}, (err, address, family) =>
      (err ? reject(err) : resolve(Array.isArray(address) ? address : { address, family }))));
}

if (process.env.GAIA_USAGE_LOG === undefined) process.env.GAIA_USAGE_LOG = '';

globalThis.__GAIA_TEST_NETWORK_DENY__ = { allowed: [...ALLOW] };
