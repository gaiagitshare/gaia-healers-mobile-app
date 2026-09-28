/**
 * GAIA ASSIST — the pipeline fallback, when the live socket cannot be opened.
 *
 * The voice orb is one WebSocket carrying audio both ways, and there are
 * networks it cannot cross: conference wifi that blocks ws://, a captive
 * portal, a withdrawn model, a Google outage. None of those are a reason for
 * somebody standing in a hall to get silence.
 *
 * /api/assist/voice/turn is the whole turn in one round trip -- speech in,
 * spoken answer out -- assembled from three legs the proxy already had. What
 * is pinned here is that it is a complete turn (a transcript, a reply AND
 * audio), that it says which stage failed rather than just failing, and that
 * a failure to speak still returns something the member can READ.
 *
 *   node --test test/assist-voice-pipeline.test.js
 */
import assert from 'node:assert';
import { env, apiBase as BASE, liveTest } from './_live-env.js';

const turn = (body) => fetch(`${BASE}/api/assist/voice/turn`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// Real speech to feed it: the proxy's own TTS, so the test needs no fixture
// and exercises the same audio path a phone would produce.
let clip = null;
async function spokenClip() {
  if (clip) return clip;
  const r = await fetch(`${BASE}/api/assist/tts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'When does the exhibit hall open?' }),
  });
  assert.ok(r.ok, `could not synthesise a test clip: HTTP ${r.status}`);
  clip = Buffer.from(await r.arrayBuffer()).toString('base64');
  return clip;
}

liveTest('a spoken question comes back transcribed, answered and spoken', async () => {
  const r = await turn({ audioBase64: await spokenClip(), mimeType: 'audio/mpeg', view: 'events' });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.ok, true, `turn failed at ${body.stage}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.ok(body.transcript && body.transcript.length > 3, `nothing was heard: ${body.transcript}`);
  assert.ok(body.reply && body.reply.length > 3, 'no reply came back');
  assert.ok(body.audioBase64, 'the reply was never spoken');
  assert.ok(Buffer.from(body.audioBase64, 'base64').length > 1000, 'the spoken reply is too small to be audio');
}, ['GROQ_API_KEY']);

liveTest('and says which provider served each leg', async () => {
  const body = await (await turn({ audioBase64: await spokenClip(), mimeType: 'audio/mpeg' })).json();
  assert.ok(body.providers?.stt, 'no speech-to-text provider named');
  assert.ok(body.providers?.llm, 'no language model named');
  assert.ok(body.providers?.tts, 'no voice provider named');
  for (const leg of ['sttMs', 'llmMs', 'ttsMs', 'totalMs']) {
    assert.ok(Number.isFinite(body.timings?.[leg]), `${leg} was not measured`);
  }
}, ['GROQ_API_KEY']);

liveTest('an empty request names the stage rather than just failing', async () => {
  const body = await (await turn({})).json();
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.stage, 'transcribe');
  assert.match(String(body.reason), /audioBase64/);
}, ['GROQ_API_KEY']);

liveTest('audio nobody could transcribe is reported, with every provider tried', async () => {
  const body = await (await turn({
    audioBase64: Buffer.from('this is not audio').toString('base64'),
    mimeType: 'audio/webm',
  })).json();
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.stage, 'transcribe');
  const tried = (body.attempts || []).map((a) => a.provider);
  assert.ok(tried.length >= 2,
    `only ${tried.join(', ') || 'nothing'} was tried — a single STT outage would take voice down`);
}, ['GROQ_API_KEY']);

liveTest('speech-to-text prefers the provider that is fastest and free to us', async () => {
  const order = (env.STT_PROVIDER_ORDER || 'groq,elevenlabs,openai').split(',').map((s) => s.trim());
  assert.strictEqual(order[0], 'groq',
    'Groq whisper answers in ~250ms on a key we already hold; anything else first costs money or time');
  assert.ok(order.length >= 2, 'a single speech-to-text provider is a single point of failure');
}, ['GROQ_API_KEY']);
