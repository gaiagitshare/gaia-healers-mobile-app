#!/usr/bin/env node
/**
 * Is Gaia Assist actually working, and which provider is answering?
 *
 * Written because "the assistant won't talk" is indistinguishable, from the
 * outside, between an empty balance, a retired model slug, a key missing one
 * permission, and a dispatcher that silently skips its first choice. All four
 * were true here at once. This asks every provider directly and says which.
 *
 * Read-only. Sends a handful of tiny prompts and prints a table.
 *   node /root/gaia-staging-proxy/tools/assist-health.mjs
 */
import fs from 'node:fs';

const env = {};
for (const line of fs.readFileSync('/root/gaia-staging-proxy/.env', 'utf8').split('\n')) {
  const s = line.trim();
  if (s && !s.startsWith('#') && s.includes('=')) {
    const i = s.indexOf('=');
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}
const PROMPT = 'Say OK';
const rows = [];
const add = (name, role, ok, note) => rows.push({ name, role, ok, note: String(note).replace(/\s+/g, ' ').slice(0, 74) });
const order = (env.ASSIST_PROVIDER_ORDER || 'gemini,groq').split(',').map((s) => s.trim());
const ttsOrder = (env.TTS_PROVIDER_ORDER || 'elevenlabs,openai').split(',').map((s) => s.trim());
const roleOf = (n) => (order.indexOf(n) > -1 ? `chat #${order.indexOf(n) + 1}` : 'unused');

async function openaiShaped(name, url, key, model) {
  if (!key) return add(name, roleOf(name), false, 'no API key configured');
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 40 }),
    });
    const t = await r.text();
    if (!r.ok) return add(name, roleOf(name), false, `HTTP ${r.status} ${t}`);
    const reply = (JSON.parse(t).choices?.[0]?.message?.content || '').trim();
    // An empty reply is a failure: it is what a member sees as silence.
    add(name, roleOf(name), Boolean(reply), reply ? `${model} — "${reply}"` : `${model} — EMPTY REPLY`);
  } catch (e) { add(name, roleOf(name), false, e.message); }
}

if (env.GEMINI_API_KEY) {
  const model = env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT }] }] }) });
    const t = await r.text();
    const reply = r.ok ? (JSON.parse(t).candidates?.[0]?.content?.parts?.[0]?.text || '').trim() : '';
    add('gemini', roleOf('gemini'), r.ok && Boolean(reply), r.ok ? `${model} — "${reply}"` : `HTTP ${r.status} ${t}`);
  } catch (e) { add('gemini', roleOf('gemini'), false, e.message); }
} else add('gemini', roleOf('gemini'), false, 'no API key configured');

await openaiShaped('groq', 'https://api.groq.com/openai/v1/chat/completions', env.GROQ_API_KEY, env.GROQ_MODEL);
await openaiShaped('openai', 'https://api.openai.com/v1/chat/completions', env.OPENAI_API_KEY, env.OPENAI_MODEL);
await openaiShaped('openrouter', 'https://openrouter.ai/api/v1/chat/completions', env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL);

// Voice out. ElevenLabs is asked for audio, not for its subscription: the key
// here is scoped for speech and 401s on the account endpoints.
if (env.ELEVENLABS_API_KEY) {
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Test.', model_id: env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5' }),
    });
    const bytes = r.ok ? (await r.arrayBuffer()).byteLength : 0;
    add('elevenlabs', `tts #${ttsOrder.indexOf('elevenlabs') + 1}`, r.ok && bytes > 1000,
        r.ok ? `${bytes} bytes of audio` : `HTTP ${r.status} ${(await r.text())}`);
    const v = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } });
    add('elevenlabs/voices', 'voice list', v.ok,
        v.ok ? `${(await v.json()).voices?.length || 0} voices` : `HTTP ${v.status} — picker falls back to one hardcoded voice`);
  } catch (e) { add('elevenlabs', 'tts', false, e.message); }
}

const pad = (s, n) => String(s).padEnd(n);
console.log('\nGAIA ASSIST — provider health\n');
console.log(pad('provider', 19) + pad('role', 12) + pad('', 5) + 'detail');
console.log('-'.repeat(104));
for (const r of rows) console.log(pad(r.name, 19) + pad(r.role, 12) + pad(r.ok ? ' ok ' : 'DOWN', 5) + r.note);
const chat = rows.filter((r) => r.role.startsWith('chat #')).sort((a, b) => a.role.localeCompare(b.role));
const first = chat.find((r) => r.ok);
console.log('\nchat order : ' + order.join(' -> '));
console.log('answering  : ' + (first ? first.name : 'NOBODY — members get the canned local fallback'));
const down = rows.filter((r) => !r.ok);
if (down.length) console.log('needs attention: ' + down.map((r) => r.name).join(', '));
