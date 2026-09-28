/**
 * Is this a machine that can actually reach the running proxy?
 *
 * Some checks are only meaningful against the real thing: that the model the
 * voice orb is handed exists in the Gemini catalogue, that a spoken question
 * comes back answered and spoken. Those need the proxy's .env — the one file
 * that is deliberately never committed — and an outbound network.
 *
 * On the VPS both are there and the checks run. In CI neither is, and they
 * SKIP rather than fail: a suite that reports red because a runner has no
 * production credentials teaches people to stop reading red, which costs more
 * than the tests are worth.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

/** The proxy's environment, or {} where there is none to read. */
function readEnvFile() {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// process.env wins, so a runner can supply a single key to turn one of these on.
const env = { ...readEnvFile(), ...process.env };
const liveEnv = fs.existsSync(envPath) || Boolean(process.env.GAIA_LIVE_TESTS);

// Talk to the proxy directly, not through nginx.
//
// nginx caps /api/assist/ at 30 requests a minute, shared by IP, to protect the
// paid model quota. A test run makes far more than that: it turns itself red
// with 503s AND spends a limit that real members are sharing at the time. The
// local port has no limiter and no TLS handshake, and is the same process.
const PUBLIC_BASE = (env.APP_PUBLIC_API_BASE || 'https://api.gaiahealers.app').replace(/\/+$/, '');
const LOCAL_BASE = 'http://127.0.0.1:' + (env.PORT || '8787');

async function reachable(base) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const r = await fetch(`${base}/api/events/wallet-status`, { signal: controller.signal });
    clearTimeout(timer);
    return r.ok;
  } catch { return false; }
}

const apiBase = (liveEnv && await reachable(LOCAL_BASE)) ? LOCAL_BASE : PUBLIC_BASE;

/** A test that needs the proxy's own environment and the network. */
function liveTest(name, fn, requires = []) {
  const missing = requires.filter((key) => !env[key]);
  const reason = !liveEnv
    ? 'no proxy .env here — live checks run on the server, not in CI'
    : (missing.length ? `missing ${missing.join(', ')}` : '');
  return test(name, { skip: reason || false }, fn);
}

export { env, liveEnv, apiBase, liveTest };
