// Opt-in synthetic PCM benchmark; no CRM, tools, member identity or deployment.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
const { values } = parseArgs({ options: { env: { type: 'string' }, instructions: { type: 'string' }, 'audio-dir': { type: 'string' }, out: { type: 'string' }, label: { type: 'string', default: 'review' }, repeats: { type: 'string', default: '1' }, 'dry-run': { type: 'boolean' }, 'max-requests': { type: 'string' } } });
// One Qwen session per sample per repeat. It used to repeat twice by default (6
// sessions); the default is now one pass (3), under the project cap (AGENTS.md).
import { installPaidCallGuard } from '../tools/paid-call-guard.mjs';
const REPEATS = Math.max(1, Number(values.repeats) || 1);
const paidGuard = installPaidCallGuard({
  label: 'voice-latency-probe', planned: REPEATS * 3,
  why: 'measure speech-end to first-audio latency on three recorded samples',
  argv: ['--max-requests', values['max-requests'] || '5', ...(values['dry-run'] ? ['--dry-run'] : [])],
});
for (const key of ['env', 'instructions', 'audio-dir', 'out']) if (!values[key]) throw new Error(`Missing --${key}`);
const env = Object.fromEntries(fs.readFileSync(values.env, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')]; }));
if (!env.QWEN_API_KEY) throw new Error('Qwen key unavailable');
const model = env.QWEN_VOICE_MODEL || 'qwen3.8-omni-flash-realtime';
const endpoint = (env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com').replace(/^http/, 'ws').replace(/\/+$/, '') + '/api-ws/v1/realtime?model=' + encodeURIComponent(model);
const instructions = fs.readFileSync(values.instructions, 'utf8');
async function turn(sample) {
  const audio = fs.readFileSync(path.join(values['audio-dir'], sample + '.pcm'));
  let lastSpeechByte = audio.length;
  while (lastSpeechByte > 2 && Math.abs(audio.readInt16LE(lastSpeechByte - 2)) < 180) lastSpeechByte -= 2;
  const stages = {}; const events = []; let done, error = null, sendTimer;
  const finished = new Promise(resolve => { done = resolve; });
  paidGuard.count(endpoint);
  const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${env.QWEN_API_KEY}` } });
  const timer = setTimeout(() => { error = 'timeout'; done(); }, 45000);
  ws.on('error', () => { error = 'connection_error'; done(); });
  const send = data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  ws.on('open', () => send({ type: 'session.update', session: { modalities: ['text', 'audio'], instructions, input_audio_format: 'pcm16', output_audio_format: 'pcm24', turn_detection: { type: 'server_vad', silence_duration_ms: 900 }, ...(env.QWEN_VOICE_NAME ? { voice: env.QWEN_VOICE_NAME } : {}) } }));
  ws.on('message', raw => {
    let e; try { e = JSON.parse(String(raw)); } catch { return; }
    const now = performance.now();
    if (['input_audio_buffer.speech_stopped', 'conversation.item.input_audio_transcription.completed', 'response.audio.delta', 'response.audio_transcript.delta', 'response.function_call_arguments.delta'].includes(e.type)) events.push({ type: e.type, time: now });
    if (e.type === 'error') { error = e.error?.code || 'provider_error'; done(); }
    if (e.type === 'session.updated' && !sendTimer) {
      let offset = 0;
      sendTimer = setInterval(() => {
        if (offset === 0) stages.T0 = performance.now();
        if (offset >= lastSpeechByte && stages.T1 == null) stages.T1 = performance.now();
        if (offset < audio.length) send({ type: 'input_audio_buffer.append', audio: audio.subarray(offset, offset + 640).toString('base64') });
        else if (offset < audio.length + 64000) send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(640).toString('base64') });
        else clearInterval(sendTimer);
        offset += 640;
      }, 20);
    }
    if (e.type === 'input_audio_buffer.speech_stopped') stages.vadCommitted ??= now;
    if (e.type === 'conversation.item.input_audio_transcription.completed') stages.T2 ??= now;
    if (e.type === 'response.created') stages.T3 ??= now;
    if (['response.audio.delta', 'response.audio_transcript.delta', 'response.function_call_arguments.delta'].includes(e.type)) stages.T4 ??= now;
    if (e.type === 'response.audio.delta') stages.T6 ??= now;
    if (e.type === 'response.done') done();
  });
  await finished; clearTimeout(timer); clearInterval(sendTimer); ws.close();
  const firstAfterEnd = types => events.find(e => e.time >= stages.T1 && types.includes(e.type))?.time;
  stages.vadCommitted = firstAfterEnd(['input_audio_buffer.speech_stopped']);
  stages.T2 = firstAfterEnd(['conversation.item.input_audio_transcription.completed']);
  stages.T4 = firstAfterEnd(['response.audio.delta', 'response.audio_transcript.delta', 'response.function_call_arguments.delta']);
  stages.T6 = firstAfterEnd(['response.audio.delta']);
  const earlyVadCommits = events.filter(e => e.type === 'input_audio_buffer.speech_stopped' && e.time < stages.T1).length;
  const elapsed = key => stages.T1 != null && stages[key] != null ? Math.round(stages[key] - stages.T1) : null;
  return { sample, error, earlyVadCommits, speechEndToVadMs: elapsed('vadCommitted'), speechEndToTranscriptMs: elapsed('T2'), speechEndToModelMs: elapsed('T4'), speechEndToAudioMs: elapsed('T6'), playbackMs: null };
}
const results = [];
for (let repeat = 0; repeat < REPEATS; repeat++) for (const sample of ['water', 'normal', 'pauses']) {
  const result = await turn(sample); results.push(result); console.log(JSON.stringify({ label: values.label, ...result }));
}
const summary = {};
for (const key of ['speechEndToVadMs', 'speechEndToTranscriptMs', 'speechEndToModelMs', 'speechEndToAudioMs']) {
  const sorted = results.map(r => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
  summary[key] = sorted.length ? { n: sorted.length, median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2, p90: sorted[Math.ceil(sorted.length * .9) - 1] } : { n: 0, median: null, p90: null };
}
fs.writeFileSync(values.out, JSON.stringify({ label: values.label, model, transport: 'direct provider realtime PCM; excludes browser microphone gate, network relay, tools and speaker playback', results, summary }, null, 2));
