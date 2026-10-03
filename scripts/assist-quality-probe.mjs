// Opt-in live model QA; synthetic prompts only, no authenticated CRM session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectCrisis,crisisReply} from '../staging-proxy/assist-safety.js';
import { createRequire } from 'node:module';
const {WebSocket}=createRequire(new URL('../staging-proxy/package.json',import.meta.url))('ws');
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { env: { type: 'string' }, label: { type: 'string', default: 'review' }, out: { type: 'string' }, only: {type:'string'}, 'dry-run': {type:'boolean'}, 'max-requests': {type:'string'} } });
if (!values['dry-run'] && (!values.env || !values.out)) throw new Error('Pass --env /private/provider.env --out results.json');
const env = values['dry-run'] && !values.env ? {} : Object.fromEntries(fs.readFileSync(values.env, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')]; }));
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_TEXT_MODEL', 'GROQ_API_KEY', 'GROQ_MODEL']) if (env[k]) process.env[k] = env[k];
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-guide-probe-')));
Object.assign(process.env, { PORT: '0', HOST: '127.0.0.1', AUTH_SESSION_SECRET: 'qa'.repeat(24), COURSES_SYNC_SECRET: 'qa'.repeat(24), GHL_BACKFILL_SECRET: 'qa'.repeat(24), GHL_WORKFLOW_WEBHOOK_SECRET: 'qa'.repeat(24), GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'fixture', GHL_LOCATION_ID: 'fixture', EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9', GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false' });
const { assistSystemPrompt, assistUserPrompt, buildGaiaLiveInstructions, closeServer } = await import('../staging-proxy/server.js');
const cases = JSON.parse(fs.readFileSync(new URL('./assist-quality-cases.json', import.meta.url)));

// Up to two paid text calls per text case (Gemini and Groq) and one Qwen voice
// session per voice case: 100 for the full set. Capped like every paid script
// (AGENTS.md); --only narrows it to the cases that matter.
import { installPaidCallGuard } from '../staging-proxy/tools/paid-call-guard.mjs';
const selected = cases.filter((c) => !values.only || values.only.split(',').includes(c.id));
const paidGuard = installPaidCallGuard({
  label: 'assist-quality-probe',
  planned: selected.reduce((n, c) => n + (c.mode === 'voice' ? 1 : 2), 0),
  why: 'review Assist answers across the quality cases',
  argv: ['--max-requests', values['max-requests'] || '5', ...(values['dry-run'] ? ['--dry-run'] : [])],
});
async function qwenVoice(system, user) {
  const base=(env.QWEN_BASE_URL||'https://dashscope-intl.aliyuncs.com').replace(/^http/,'ws').replace(/\/+$/,'');
  const model=env.QWEN_VOICE_MODEL||'qwen3.8-omni-flash-realtime';
  return new Promise((resolve,reject)=>{
    paidGuard.count(base); const ws=new WebSocket(`${base}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`,{headers:{Authorization:`Bearer ${env.QWEN_API_KEY}`}});
    let reply='',audioBytes=0,sent=false;
    const timer=setTimeout(()=>{ws.close();reject(new Error('qwen-timeout'));},45000);
    ws.on('error',()=>{clearTimeout(timer);reject(new Error('qwen-unavailable'));});
    ws.on('open',()=>ws.send(JSON.stringify({type:'session.update',session:{modalities:['text','audio'],instructions:system,...(env.QWEN_VOICE_NAME?{voice:env.QWEN_VOICE_NAME}:{}),input_audio_format:'pcm16',output_audio_format:'pcm24',turn_detection:null}})));
    ws.on('message',raw=>{
      const e=JSON.parse(String(raw));
      if(e.type==='session.updated'&&!sent){sent=true;ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:user}]}}));ws.send(JSON.stringify({type:'response.create'}));}
      if(e.type==='response.audio_transcript.delta')reply+=e.delta||'';
      if(e.type==='response.audio.delta')audioBytes+=Buffer.from(e.delta||'','base64').length;
      if(e.type==='error'){clearTimeout(timer);ws.close();reject(new Error('qwen-provider-error'));}
      if(e.type==='response.done'){clearTimeout(timer);ws.close();resolve({reply,provider:'qwen/'+model,status:'qwen:200',audioBytes});}
    });
  });
}
const results = [];
fs.writeFileSync(values.out + '.voice-instructions.txt', buildGaiaLiveInstructions({ view: 'today' }));
try {
  const requests = cases.filter(c => !values.only || values.only.split(',').includes(c.id)).map(c => {
    const member = c.state === 'visitor' ? '' : `MEMBER CONTEXT: Synthetic QA member. ${c.state === 'practitioner' ? 'Role: practitioner, from verified account.' : ''} ONBOARDING PROFILE: ${c.state === 'onboarding' ? 'NOT DONE; onboarding_required=true; resume at water' : 'DONE'}. CURRENT GAIA PROFILE CHOICES: {"primary_interests":["Water","Environment"],"growth_needs":["Education"]}. No confirmed course grants or paid subscription.`;
    const live = 'LIVE GAIA HEALERS DATA (synthetic QA fixtures, not production listings): Current event QA Water Workshop on 2026-11-12 at 18:00 UTC, online. Current product QA Water Sensor, a measurement accessory with no approved clinical claims. Academy catalog: Bio-Well Orientation; member has no grant. No verified discounts. Membership details must be checked in Shop > Membership.';
    const context = { memberContext:[member,live].filter(Boolean).join('\n'), appContext: {screen:c.screen, ...(c.screen==='events'?{itemId:'qa-event'}:c.screen==='store'?{itemId:'qa-product'}:{})}, source:c.mode, history:c.history||[] };
    return {...c, memberContext:context.memberContext, system:c.mode==='voice'?buildGaiaLiveInstructions({memberContext:[member,live].filter(Boolean).join('\n'),appContext:context.appContext}):assistSystemPrompt([member,live].filter(Boolean).join('\n')), user:assistUserPrompt(c.prompt,context)};
  });
  let index=0;
  await Promise.all(Array.from({length:3},async()=>{while(index<requests.length){
    const c=requests[index++]; const {screen,prompt}=c;
    const started = performance.now(); let reply = '', provider = '', status = '', audioBytes = 0;
    const system=c.system,user=c.user;
    const crisis=detectCrisis(prompt);
    const fixed=c.mode==='text' ? (crisis ? crisisReply(crisis,prompt) : globalThis.GaiaAssistGuide.reviewedReply?.(prompt,{state:c.state,memberContext:c.memberContext})) : null;
    if(fixed){reply=fixed;provider=crisis?'safety/fixed':'reviewed-guidance/fixed';status='local:200';}
    if(c.mode==='voice') {try {({reply,provider,status,audioBytes}=await qwenVoice(system,prompt));}catch{status='qwen:unavailable';}}
    for (const p of (fixed||c.mode==='voice'?[]:['gemini', 'groq'])) {
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
    results.push({ id:c.id,state:c.state,mode:c.mode,expect:c.expect,screen, prompt, reply, provider, status, ...(c.mode==='voice'?{audioBytes}:{}), durationMs: Math.round(performance.now() - started), flags: { intimateAddress: /\b(beautiful soul|darling|sweetheart|my love)\b/i.test(reply), unsolicitedUpgrade: !/membership|access/i.test(prompt) && /upgrade|silver|gold|diamond/i.test(reply) } });
    console.log(JSON.stringify({ label: values.label, screen, provider, status, answered: !!reply }));
  }}));
  results.sort((a,b)=>a.id.localeCompare(b.id));
  fs.writeFileSync(values.out, JSON.stringify({ label: values.label, synthetic: true, results }, null, 2));
} finally { closeServer(); }
