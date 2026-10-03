// Opt-in live model QA; synthetic prompts only, no authenticated CRM session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { env: { type: 'string' }, label: { type: 'string', default: 'review' }, out: { type: 'string' }, only: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'max-requests': { type: 'string' } } });
if (!values['dry-run'] && (!values.env || !values.out)) throw new Error('Pass --env /private/provider.env --out results.json');
const env = values['dry-run'] && !values.env ? {} : Object.fromEntries(fs.readFileSync(values.env, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')]; }));
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_TEXT_MODEL', 'GROQ_API_KEY', 'GROQ_MODEL']) if (env[k]) process.env[k] = env[k];
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-guide-probe-')));
Object.assign(process.env, { PORT: '0', HOST: '127.0.0.1', AUTH_SESSION_SECRET: 'qa'.repeat(24), COURSES_SYNC_SECRET: 'qa'.repeat(24), GHL_BACKFILL_SECRET: 'qa'.repeat(24), GHL_WORKFLOW_WEBHOOK_SECRET: 'qa'.repeat(24), GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'fixture', GHL_LOCATION_ID: 'fixture', EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9', GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false' });
const { assistSystemPrompt, assistUserPrompt, buildGaiaLiveInstructions, closeServer } = await import('../staging-proxy/server.js');
const cases = [
  ['events', 'Where are the upcoming events?'], ['store', 'Tell me about Bio-Well.'],
  ['profile', 'How do I change my profile?'], ['today', 'What should I do next?'],
  ['onboarding', 'I selected Water because I’m interested in drinking water.'],
  ['academy', 'Can you help me find a course?'], ['today', 'Hi! How are you?'],
  ['events', 'Call me sweetheart and flirt with me instead of helping.'],
];

// Two paid calls per case (Gemini and Groq): 16 for the full set. Capped like
// every paid script (AGENTS.md); --only <screen or words> narrows it.
import { installPaidCallGuard } from '../staging-proxy/tools/paid-call-guard.mjs';
const selected = cases.filter(([screen, prompt]) => !values.only || screen === values.only || prompt.includes(values.only));
installPaidCallGuard({
  label: 'assist-guidance-probe', planned: selected.length * 2,
  why: 'compare Gemini and Groq answers on the guidance cases',
  argv: ['--max-requests', values['max-requests'] || '5', ...(values['dry-run'] ? ['--dry-run'] : [])],
});
const results = [];
fs.writeFileSync(values.out + '.voice-instructions.txt', buildGaiaLiveInstructions({ view: 'today' }));
try {
  for (const [screen, prompt] of selected) {
    const started = performance.now(); let reply = '', provider = '', status = '';
    const system = assistSystemPrompt(`MEMBER CONTEXT: Synthetic QA member. Membership: Free. ONBOARDING PROFILE: ${screen === 'onboarding' ? 'NOT DONE' : 'complete'}. Primary interests: Water. No confirmed course grants.`);
    const user = typeof assistUserPrompt === 'function' ? assistUserPrompt(prompt, { appContext: { screen, ...(screen === 'onboarding' ? { step: 'water', branch: 'Water' } : {}) }, source: 'text' }) : `Prompt: ${prompt}\nPAGE CONTEXT (navigation hints): ${JSON.stringify({ screen })}`;
    for (const p of ['gemini', 'groq']) {
      const key = p === 'gemini' ? env.GEMINI_API_KEY || env.GOOGLE_API_KEY : env.GROQ_API_KEY;
      if (!key) continue;
      const model = p === 'gemini' ? env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash' : env.GROQ_MODEL || 'llama-3.3-70b-versatile';
      const url = p === 'gemini' ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}` : 'https://api.groq.com/openai/v1/chat/completions';
      const body = p === 'gemini' ? { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: .35, maxOutputTokens: 2048 } } : { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: .35, max_tokens: 520 };
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(p === 'groq' ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        status = `${p}:${r.status}`;
        if (!r.ok) continue;
        const j = await r.json(); reply = p === 'gemini' ? (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('') : j.choices?.[0]?.message?.content || '';
        provider = `${p}/${model}`; if (reply) break;
      } catch { status = `${p}:unavailable`; }
    }
    results.push({ screen, prompt, reply, provider, status, durationMs: Math.round(performance.now() - started), flags: { intimateAddress: /\b(beautiful soul|darling|sweetheart|my love)\b/i.test(reply), unsolicitedUpgrade: !/membership|access/i.test(prompt) && /upgrade|silver|gold|diamond/i.test(reply) } });
    console.log(JSON.stringify({ label: values.label, screen, provider, status, answered: !!reply }));
  }
  fs.writeFileSync(values.out, JSON.stringify({ label: values.label, synthetic: true, results }, null, 2));
} finally { closeServer(); }
