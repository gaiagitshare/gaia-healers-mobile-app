#!/usr/bin/env node
/**
 * Does the Gemini Live socket behind the voice orb actually connect?
 *
 * The voice widget is Gemini Live over a WebSocket, NOT the /api/assist/tts
 * path -- so a working token proves nothing on its own: the token has to be
 * accepted by the v1alpha Constrained endpoint, which is the one ephemeral
 * tokens are minted for. Point it at v1beta and Google closes the socket with
 * 1008 "unregistered callers", which looks exactly like a dead key.
 *
 * Read-only. Opens one session, waits for setupComplete, closes.
 *   node --experimental-websocket /root/gaia-staging-proxy/tools/assist-live-check.mjs
 */
import { installPaidCallGuard } from './paid-call-guard.mjs';
// Two outbound calls: the token from our own public endpoint (counted anyway --
// the guard does not try to guess which hosts are free) and one live session.
const guard = installPaidCallGuard({ label: 'assist-live-check', planned: 2, why: 'one live voice session' });
const t = await (await fetch('https://api.gaiahealers.app/api/assist/voice/token')).json();
if (!t.ok) { console.log('token FAILED:', JSON.stringify(t).slice(0, 200)); process.exit(1); }
console.log('token   : ok   model =', t.model, ' voice =', t.voice);
const model = String(t.model).replace(/^models\//, '');
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(t.token)}`;
guard.count(url);
const ws = new WebSocket(url);
const done = (m, code = 0) => { console.log(m); try { ws.close(); } catch {} process.exit(code); };
const timer = setTimeout(() => done('socket  : TIMED OUT after 20s — no open, no error', 1), 20000);
ws.onopen = () => {
  console.log('socket  : OPEN');
  ws.send(JSON.stringify({ setup: { model: `models/${model}`,
    generationConfig: { responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: t.voice || 'Puck' } } } } } }));
};
ws.onmessage = async (ev) => {
  const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString('utf8');
  let j = null; try { j = JSON.parse(raw); } catch {}
  if (j && j.setupComplete) {
    console.log('setup   : COMPLETE — the live voice session is usable');
    clearTimeout(timer); done('');
  } else {
    console.log('message :', raw.slice(0, 200));
  }
};
ws.onerror = (e) => { clearTimeout(timer); done('socket  : ERROR ' + (e.message || ''), 1); };
ws.onclose = (e) => { clearTimeout(timer); if (e.code !== 1000) done(`socket  : CLOSED code=${e.code} reason=${e.reason}`, 1); };
