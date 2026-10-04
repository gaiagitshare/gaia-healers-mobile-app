/**
 * Has Qwen stopped refusing the account?
 *
 * On 3 Oct 2026 the realtime model answered every session with a typeless
 * {"code":"AccessDenied.Unpurchased"} frame. This opens ONE realtime session
 * with the live key, sends one session.update -- no audio, no tools, no
 * response requested -- and reports what came back, then closes. Billable
 * usage is ~0 tokens. It is still a paid-API call, so it runs under the guard
 * (planned: 1) and, under the project rule, only when the owner asks.
 *
 *   node tools/qwen-access-check.mjs --dry-run      # prints the plan, opens nothing
 *   node tools/qwen-access-check.mjs                # one session
 *   node tools/qwen-access-check.mjs --env <file>   # another .env (default: the live one)
 *   node tools/qwen-access-check.mjs --account 2    # the second account (QWEN_API_KEY_2 / QWEN_BASE_URL_2)
 *
 * Exit 0 = session.updated (access OK); 3 = refused; 4 = no answer / closed early.
 * The key is read from the .env file and never printed.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { installPaidCallGuard } from './paid-call-guard.mjs';
import { qwenVoiceConfig } from '../qwen-voice-relay.js';

const guard = installPaidCallGuard({ label: 'qwen-access-check', planned: 1, tokensPerCall: 0, why: 'one session.update, no audio: does Qwen still refuse the account?' });

const envFlag = process.argv.indexOf('--env');
const envPath = envFlag >= 0 ? process.argv[envFlag + 1] : '/root/gaia-staging-proxy/.env';
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const s = line.trim();
  if (s && !s.startsWith('#') && s.includes('=')) {
    const i = s.indexOf('=');
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}
const accountFlag = process.argv.indexOf('--account');
const accountNo = accountFlag >= 0 ? Number(process.argv[accountFlag + 1]) : 1;
if (accountNo === 2) {
  if (!env.QWEN_API_KEY_2) { console.error('QWEN_API_KEY_2 is not set in ' + envPath); process.exit(2); }
  env.QWEN_API_KEY = env.QWEN_API_KEY_2;
  env.QWEN_BASE_URL = env.QWEN_BASE_URL_2 || 'https://dashscope-intl.aliyuncs.com';
} else if (accountNo !== 1) { console.error('--account must be 1 or 2'); process.exit(2); }
const cfg = qwenVoiceConfig(env);
if (!cfg.apiKey) { console.error('QWEN_API_KEY is not set in ' + envPath); process.exit(2); }

const WebSocket = createRequire(import.meta.url)('ws');
const url = `${cfg.wsBase}/api-ws/v1/realtime?model=${encodeURIComponent(cfg.model)}`;
console.log(`account ${accountNo}; model ${cfg.model}; host ${new URL(url).host}`);
guard.count(url);

const t0 = Date.now();
const frames = [];
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
let done = false;
const finish = (verdict, code) => {
  if (done) return; done = true;
  console.log(JSON.stringify({ verdict, ms: Date.now() - t0, frames }, null, 2));
  try { ws.close(1000); } catch { /* already closed */ }
  setTimeout(() => process.exit(code), 300);
};
const timer = setTimeout(() => finish('NO ANSWER: neither session.updated nor an error within 10 s', 4), 10000);

ws.on('open', () => {
  frames.push('open');
  ws.send(JSON.stringify({ type: 'session.update', session: {
    modalities: ['text', 'audio'], instructions: 'Say nothing.',
    input_audio_format: 'pcm16', output_audio_format: 'pcm24',
    turn_detection: { type: 'server_vad', silence_duration_ms: 900 }, tools: [], voice: cfg.voice,
  } }));
});
ws.on('message', (raw) => {
  let evt; try { evt = JSON.parse(String(raw)); } catch { frames.push('unparseable'); return; }
  // The refusal arrives as a bare {code, message} with no type (see the relay).
  const refusal = evt.type === 'error' ? evt.error?.code : (!evt.type && evt.code ? evt.code : null);
  frames.push(evt.type || `typeless code=${evt.code}`);
  if (evt.type === 'session.updated') { clearTimeout(timer); finish('ACCESS OK: session.updated received -- the account can open voice sessions again', 0); }
  else if (refusal) { clearTimeout(timer); finish(`STILL REFUSED: ${refusal}`, 3); }
});
ws.on('error', (e) => frames.push('socket error: ' + String(e.message || e).slice(0, 80)));
ws.on('close', (c) => { frames.push(`close ${c}`); clearTimeout(timer); finish(`closed before setup (${c})`, 4); });
