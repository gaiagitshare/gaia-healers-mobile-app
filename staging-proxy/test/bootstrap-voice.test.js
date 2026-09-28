/**
 * GAIA ASSIST — the app must be told that live voice exists.
 *
 * gaia-ui.js chooses between Gemini Live (tap once, talk hands-free) and the
 * record-then-reply fallback by reading gaia.sync.voice.live from
 * /api/app/bootstrap. On 2026-09-12 that block went out with the renderer
 * fields nobody read, and every member silently got the fallback: one answer,
 * then an orb that said "Listening next…" and never listened again.
 *
 * It also carries the ElevenLabs voice. Without it the voice picker offered
 * browser voice names, and ElevenLabs answered "voice_id 'Samantha' was not
 * found".
 */
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
  assert.equal(voice.live.model, 'gemini-3.8-live');
  assert.deepEqual(voice.realtime, voice.live, 'gaia-ui.js reads either name');
});

test('bootstrap names the ElevenLabs voice, so the picker never sends a browser voice name', async () => {
  const { voice } = await bootstrap();
  assert.equal(voice.tts.elevenLabsConfigured, true);
  assert.equal(voice.tts.elevenLabsVoiceId, 'pNInz6obpgDQGcFmaJgB');
  assert.equal(voice.tts.elevenLabsVoice, 'Adam');
});

test('bootstrap never carries a provider key', async () => {
  const text = JSON.stringify(await bootstrap());
  assert.ok(!text.includes('test-gemini-key'), 'Gemini key leaked into bootstrap');
  assert.ok(!text.includes('test-eleven-key'), 'ElevenLabs key leaked into bootstrap');
});
