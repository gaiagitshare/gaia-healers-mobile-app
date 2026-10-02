// Qwen-only bootstrap and token policy; no alternate voice provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-bootstrap-voice-'));
fs.mkdirSync(path.join(workdir, 'data'), { recursive: true });
process.chdir(workdir);

const PORT = 8946;
Object.assign(process.env, {
  PORT: String(PORT), HOST: '127.0.0.1',
  AUTH_SESSION_SECRET: 'bootstrap-voice-secret-'.padEnd(48, 'v'),
  COURSES_SYNC_SECRET: 'bootstrap-voice-sync-'.padEnd(48, 's'),
  GHL_BACKFILL_SECRET: 'bootstrap-voice-backfill-'.padEnd(48, 'b'),
  GHL_WORKFLOW_WEBHOOK_SECRET: 'bootstrap-voice-webhook-'.padEnd(48, 'w'),
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9',
  GAIA_ASSIST_VOICE_ENABLED: 'true',
  QWEN_VOICE_ENABLED:'true', QWEN_API_KEY:'test-qwen-key',
  GEMINI_API_KEY: 'test-gemini-key',
  GEMINI_LIVE_MODEL: 'gemini-3.8-live',
  ELEVENLABS_API_KEY: 'test-eleven-key',
  ELEVENLABS_VOICE_ID: 'pNInz6obpgDQGcFmaJgB',
  ELEVENLABS_VOICE_NAME: 'Adam',
});
const { closeServer } = await import(new URL('../server.js', import.meta.url).href);
await new Promise((r) => setTimeout(r, 300));
test.after(() => closeServer());

const bootstrap = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/app/bootstrap`);
  assert.equal(r.status, 200);
  return (await r.json()).gaia.sync;
};

test('bootstrap tells the app that live voice is on, and with which model', async () => {
  const { voice } = await bootstrap();
  assert.ok(voice, 'gaia.sync.voice is missing — the app will fall back to record-then-reply');
  assert.equal(voice.live.enabled, true);
  assert.equal(voice.live.model, 'qwen3.8-omni-flash-realtime');
  assert.deepEqual(voice.realtime, voice.live, 'gaia-ui.js reads either name');
});

test('bootstrap disables alternate TTS even when old credentials exist', async () => {
  const {voice}=await bootstrap();assert.deepEqual(voice.tts,{configured:false,providerOrder:[]});assert.equal(voice.live.provider,'qwen');
});

test('bootstrap never carries a provider key', async () => {
  const text = JSON.stringify(await bootstrap());
  assert.ok(!text.includes('test-gemini-key'), 'Gemini key leaked into bootstrap');
  assert.ok(!text.includes('test-eleven-key'), 'ElevenLabs key leaked into bootstrap');
});

test('token requests cannot select Gemini, including old clients without a language hint', async () => {
  for(const query of ['', '?provider=gemini', '?lang=fa-IR']) {
    const r=await fetch(`http://127.0.0.1:${PORT}/api/assist/voice/token${query}`,{method:'POST'});
    const body=await r.json();assert.equal(body.provider,'qwen');assert.ok(body.relayUrl);assert.ok(!body.token);
  }
});
test('legacy audio endpoints are disabled without invoking any provider', async () => {
  for(const route of ['tts','transcribe','voice/turn']) {
    const r=await fetch(`http://127.0.0.1:${PORT}/api/assist/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'hi',audioBase64:'AAAA',provider:'gemini'})});
    assert.equal(r.status,410);assert.equal((await r.json()).reason,'qwen_live_only');
  }
  const voices=await (await fetch(`http://127.0.0.1:${PORT}/api/assist/voices`)).json();
  assert.ok(voices.voices.every(v=>v.provider==='qwen'));
});
