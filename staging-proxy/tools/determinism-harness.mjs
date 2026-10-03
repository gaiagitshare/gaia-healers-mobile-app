/**
 * TOOL-CALL DETERMINISM HARNESS
 *
 * The question this answers is not "can the model call the practitioner tools"
 * -- it demonstrably can -- but "does it call them every time". A single pass
 * cannot tell a reliable prompt from a lucky one, so every intent is asked
 * several times, in several phrasings, and the rate is what gets reported.
 *
 * It drives the PRODUCTION decision path: the same realtime model the orb
 * talks to, the same instructions from buildGaiaLiveInstructions(), the same
 * declarations from toolDeclarationsFor(). Only two things differ, both
 * deliberately:
 *
 *   TURNS ARE TYPED, NOT SPOKEN. qwen3.8-omni-flash-realtime accepts typed
 *   turns (the orb sends them too, for the text box). This removes the audio
 *   encoder from the measurement -- whisper-level transcription noise is not
 *   what we are tuning -- and keeps the tool-choice decision identical.
 *
 *   TOOL RESULTS ARE REPLAYED, NOT FETCHED. A real scan is a ten-second call
 *   to someone else's server and 1.6 MB on the wire; two hundred of them would
 *   take forty minutes and tell us nothing new. The stubs below are the exact
 *   shape the real handlers return, so the model sees what it would really see.
 *
 * Usage:  node tools/determinism-harness.mjs --reps 8 --out before.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { qwenVoiceConfig, sessionUpdateFor } from '../qwen-voice-relay.js';
import { toolDeclarationsFor } from '../assist-tools.js';
import { installPaidCallGuard } from './paid-call-guard.mjs';

// Set once the plan has passed the spending check below; every session counts
// against it before connecting, so a run cannot open more sessions than were
// approved even if the plan was miscounted.
let paidGuard = null;

// ── env, without ever printing it ─────────────────────────────────────────
for (const line of fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
// server.js binds a port when imported, so the real instruction builder is
// run in a child process on an ephemeral one rather than imported here. The
// string under test has to be the production string; rebuilding it by hand
// would measure a copy of the prompt instead of the prompt.
import { execFileSync } from 'node:child_process';
function productionInstructions(contexts) {
  const script = `
    import fs from 'node:fs';
    for (const line of fs.readFileSync('.env','utf8').split('\\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g,'');
    }
    process.env.PORT = '0';
    const { buildGaiaLiveInstructions } = await import('./server.js');
    const want = JSON.parse(process.env.GAIA_HARNESS_CONTEXTS);
    const out = {};
    for (const [k, v] of Object.entries(want)) out[k] = buildGaiaLiveInstructions(v);
    process.stdout.write('\\u0001' + JSON.stringify(out));
    process.exit(0);
  `;
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 8 << 20,
      env: { ...process.env, GAIA_HARNESS_CONTEXTS: JSON.stringify(contexts) } });
  return JSON.parse(raw.slice(raw.indexOf('\u0001') + 1));
}

const cfg = qwenVoiceConfig();
if (!cfg.apiKey) { console.error('QWEN_API_KEY missing'); process.exit(1); }

// ── the practitioner whose session we are simulating ──────────────────────
// The shape buildMemberVoiceContext() produces for a practitioner, with the
// line sessionState() keys off. Names are the staging test accounts.
// The real first line is what sessionState() keys off -- buildMemberVoiceContext
// emits `GAIA SESSION STATE: practitioner`, and the rest is the shape it builds
// around it. Getting this wrong makes the whole run a visitor session with no
// state policy at all, which is how the first attempt measured nothing.
const PRACTITIONER_CONTEXT = [
  'GAIA SESSION STATE: practitioner',
  'MEMBER CONTEXT (private \u2014 this is the currently signed-in member). Use it ONLY to personalize answers for this person. Never read it aloud verbatim, never disclose it to anyone else, and never reference data belonging to other members.',
  'You are speaking with Babak. Use their first name sparingly ("Babak").',
  'Status: certified practitioner.',
  'ONBOARDING PROFILE: complete.',
].join('\n');

const CTX = { contactId: 'C-test', isPractitioner: true };
const MEMBER_CTX = { contactId: 'C-member', isPractitioner: false };
const MEMBER_CONTEXT = PRACTITIONER_CONTEXT
  .replace('GAIA SESSION STATE: practitioner', 'GAIA SESSION STATE: member')
  .replace('Status: certified practitioner.', 'Status: Gold member.');

// ── replayed tool results, in the real handlers' shape ────────────────────
const CLIENTS = [
  { id: '474', name: 'Arman Daryaei', email: 'arman@example.com', has_biowell_card: true },
  { id: '512', name: 'Sara Keshavarz', email: 'sara@example.com', has_biowell_card: true },
  { id: '377', name: 'Daniel Osei', email: 'daniel@example.com', has_biowell_card: false },
];
const scan = (date, stress, energy, worst) => ({
  scanned_at: date, stress, energy,
  chakras: [
    { name: 'Root', value: 4.1, alignment: -0.8 }, { name: 'Sacral', value: 5.2, alignment: 0.3 },
    { name: 'Solar Plexus', value: 3.4, alignment: -1.9 }, { name: 'Heart', value: 6.0, alignment: 0.1 },
    { name: 'Throat', value: 4.8, alignment: -0.4 }, { name: 'Third Eye', value: 5.5, alignment: 0.2 },
    { name: 'Crown', value: 5.1, alignment: 0.0 },
  ],
  most_out_of_balance: worst,
});

const STUBS = {
  practitioner_list_clients: () => ({ clients: CLIENTS, count: CLIENTS.length }),
  practitioner_find_client: (a) => {
    const q = String(a.query || a.name || '').toLowerCase();
    const hit = CLIENTS.find((c) => c.name.toLowerCase().includes(q) || c.email.includes(q));
    return hit ? { found: true, client: hit } : { found: false, reason: 'No client matches that name.' };
  },
  practitioner_get_client: (a) => {
    const hit = CLIENTS.find((c) => c.id === String(a.clientId));
    return hit ? { found: true, client: { ...hit, sex: 'male', date_of_birth: '1986-04-11' } }
               : { found: false, reason: 'That client is not on your list.' };
  },
  practitioner_client_latest_scan: (a) => ({
    found: true, client: { id: String(a.clientId), name: 'Arman Daryaei' }, scans_on_file: 6,
    latest: scan('2026-09-24', 3.9, 54, ['Solar Plexus', 'Root']),
  }),
  practitioner_client_trend: (a) => ({
    found: true, client: { id: String(a.clientId), name: 'Arman Daryaei' }, scans_on_file: 6,
    span: { first: '2026-03-02', last: '2026-09-24' },
    energy: { min: 41, max: 58, latest: 54 }, stress: { min: 2.6, max: 4.8, latest: 3.9 },
    worsening: ['Solar Plexus'], improving: ['Heart', 'Throat'],
    flagged: ['Solar Plexus disbalance raised across the last three readings'],
  }),
  practitioner_compare_sessions: (a) => ({
    found: true, client: { id: String(a.clientId), name: 'Arman Daryaei' },
    comparisons: [{
      basis: 'consecutive sessions', from: '2026-08-13', to: '2026-09-24', note: '',
      stress_change: -0.5, energy_change: 7,
      biggest_changes: [{ area: 'Chakra', name: 'Root', before: 2.9, after: 4.1, change: 1.2 },
                        { area: 'Chakra', name: 'Solar Plexus', before: 3.7, after: 3.4, change: -0.3 }],
    }],
  }),
  practitioner_client_files: () => ({ files: [], count: 0, note: 'Their platform lists files but does not expose them yet.' }),
  practitioner_suggested_services: () => ({
    services: [{ name: 'Somatic Release 60min', why: 'Solar Plexus disbalance and raised stress' }], count: 1,
  }),
  practitioner_flagged_clients: () => ({
    clients: [{ id: '474', name: 'Arman Daryaei', reason: 'Solar Plexus disbalance raised' },
              { id: '512', name: 'Sara Keshavarz', reason: 'energy falling over three readings' }], count: 2,
  }),
  practitioner_follow_ups: () => ({
    clients: [{ id: '512', name: 'Sara Keshavarz', due: 'overdue by 2 weeks' }], count: 1,
  }),
};
// Client-performed tools answer the way the page answers.
const CLIENT_STUB = { ok: true, opened: true, message: 'Done; it is on screen.' };

// ── one conversation against the live model ───────────────────────────────
const PRACTITIONER_TOOLS = new Set(Object.keys(STUBS));

async function runConversation({ turns, tools, instructions, label }) {
  const url = `${cfg.wsBase}/api-ws/v1/realtime?model=${encodeURIComponent(cfg.model)}`;
  if (!paidGuard) throw new Error('paid-call guard not installed; refusing to open a paid session');
  paidGuard.count(url);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  const result = { label, turns: [], error: null };

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('connect timeout')), 20000);
    ws.once('open', () => { clearTimeout(to); resolve(); });
    ws.once('error', (e) => { clearTimeout(to); reject(e); });
  });

  const send = (m) => ws.send(JSON.stringify(m));
  send(sessionUpdateFor(null, { instructions, voice: cfg.voice, tools }));

  let turn = null;
  const inbox = [];
  let notify = null;
  ws.on('message', (raw) => {
    let evt; try { evt = JSON.parse(raw); } catch { return; }
    inbox.push(evt);
    if (notify) { const n = notify; notify = null; n(); }
  });
  let closed = false;
  const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
  ws.on('close', () => { closed = true; wake(); });
  ws.on('error', () => { closed = true; wake(); });
  /**
   * Next event, or null if none arrives in `ms` or the socket went away. An
   * unbounded wait here wedged a whole run at 173 of 232 jobs: a socket that
   * goes quiet without closing is indistinguishable from a slow turn, and six
   * workers all sat on it.
   */
  const next = async (ms = 45000) => {
    const until = Date.now() + ms;
    while (!inbox.length) {
      if (closed) return null;
      const left = until - Date.now();
      if (left <= 0) return null;
      await new Promise((r) => {
        notify = r;
        setTimeout(() => { if (notify === r) { notify = null; r(); } }, Math.min(left, 2000));
      });
    }
    return inbox.shift();
  };

  // Wait for the session to be accepted before the first turn.
  const deadline = Date.now() + 20000;
  for (;;) {
    const e = Date.now() > deadline ? null : await next(20000);
    if (!e) { result.error = 'session never accepted'; ws.close(); return result; }
    if (e.type === 'session.updated') break;
    if (e.type === 'error') { result.error = e.error?.message || 'session error'; ws.close(); return result; }
  }

  for (const text of turns) {
    turn = { said: text, calls: [], spoken: '' };
    result.turns.push(turn);
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    send({ type: 'response.create' });

    // A turn can contain several tool calls; each gets its result, and the
    // model continues until it produces a response with no new call.
    let guard = 0;
    for (;;) {
      if (guard++ > 6) { turn.spoken += ' [loop guard]'; break; }
      const pending = [];
      const end = Date.now() + 60000;
      let done = false;
      while (!done && Date.now() < end) {
        const e = await next(Math.max(1000, end - Date.now()));
        if (!e) { result.error = result.error || 'turn timed out'; done = true; continue; }
        if (e.type === 'response.audio_transcript.delta') turn.spoken += e.delta || '';
        else if (e.type === 'response.function_call_arguments.done') {
          let args = {}; try { args = JSON.parse(e.arguments || '{}'); } catch { /* junk */ }
          pending.push({ id: e.call_id, name: e.name, args });
          turn.calls.push({ name: e.name, args });
        } else if (e.type === 'response.done') done = true;
        else if (e.type === 'error') { result.error = e.error?.message || 'error'; done = true; }
      }
      if (!pending.length) break;
      for (const c of pending) {
        const out = PRACTITIONER_TOOLS.has(c.name)
          ? (STUBS[c.name](c.args) ?? CLIENT_STUB)
          : CLIENT_STUB;
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.id, output: JSON.stringify(out) } });
      }
      send({ type: 'response.create' });
    }
    turn.spoken = turn.spoken.trim();
  }

  ws.close();
  return result;
}

// ── what gets asked ───────────────────────────────────────────────────────
//
// Each case names the tools that would satisfy it. `any` means the turn passes
// if one of them was called; `none` means the turn passes only if nothing was.
const OPEN = 'Show me my clients.';           // establishes the list in context
const ON_CLIENT = 'Tell me about Arman.';     // establishes the active client

// NOTE: the client's name must not appear in the system prompt. The first run
// used "Nima", which collides with Dr. Nima Farshid, the founder named in the
// ABOUT line -- the model kept correctly answering that he is not a client, and
// the run measured a name collision rather than the prompt.
// The six follow-ups from the brief, as one conversation -- which is how they
// were asked and how they failed. Each turn is scored on its own.
const FOLLOW_UP_CONVERSATION = {
  id: 'conversation/six-follow-ups',
  turns: [
    { say: OPEN, expect: ['practitioner_list_clients'] },
    { say: ON_CLIENT, expect: ['practitioner_find_client', 'practitioner_get_client'] },
    { say: 'How has he been?', expect: ['practitioner_client_trend', 'practitioner_client_latest_scan', 'practitioner_find_client', 'practitioner_get_client'] },
    { say: 'Show me his latest scan.', expect: ['practitioner_client_latest_scan'] },
    { say: 'What about the previous one?', expect: ['practitioner_compare_sessions', 'practitioner_client_latest_scan', 'practitioner_client_trend'] },
    { say: 'Compare those two.', expect: ['practitioner_compare_sessions'] },
    { say: 'Has he improved?', expect: ['practitioner_client_trend', 'practitioner_compare_sessions'] },
    { say: 'Who else needs attention?', expect: ['practitioner_flagged_clients'] },
  ],
};

// The same intents, one at a time, in several natural phrasings. Context is
// set first so pronouns resolve; the measured turn is the last one.
const paraphrase = (id, expect, phrasings) => ({ id, expect, phrasings });
const SINGLE_INTENTS = [
  paraphrase('compare', ['practitioner_compare_sessions'], [
    'Compare his last two scans.',
    'What changed between his last two readings?',
    'Did the protocol help him? Compare before and after.',
    'Put his last two sessions side by side for me.',
  ]),
  paraphrase('latest', ['practitioner_client_latest_scan'], [
    'Show me his latest scan.',
    'What does his most recent reading say?',
    "Pull up Arman's last Bio-Well.",
    'Where is he at right now?',
  ]),
  paraphrase('trend', ['practitioner_client_trend', 'practitioner_compare_sessions'], [
    'How has he been?',
    'Has he improved over time?',
    'What should I be watching with him?',
    'Is his stress going anywhere?',
  ]),
  paraphrase('flagged', ['practitioner_flagged_clients'], [
    'Who needs attention?',
    'Anyone I should look at today?',
    'Which of my clients are concerning right now?',
  ]),
  paraphrase('followups', ['practitioner_follow_ups'], [
    'Who should I book back in?',
    'Who am I due to see?',
    'Anyone overdue for a follow-up?',
  ]),
  paraphrase('services', ['practitioner_suggested_services'], [
    'What should I offer him?',
    'Which of my services would help him?',
  ]),
];

// Ordinary conversation. A stricter prompt that starts calling tools here has
// made things worse, not better, so these are scored as hard failures.
const CONTROLS = [
  { id: 'control/greeting', turns: ['Good morning Gaia, how are you today?'] },
  { id: 'control/thanks', turns: [OPEN, 'Thanks, that is really helpful.'] },
  { id: 'control/education', turns: ['In a Bio-Well reading, what is the difference between stress and energy?'] },
  { id: 'control/what-is-practice', turns: ['Remind me what the Practice screen is for?'] },
  { id: 'control/small-talk', turns: [OPEN, ON_CLIENT, 'I am running late today, let us keep this short.'] },
  { id: 'control/opinion', turns: [OPEN, ON_CLIENT, 'Do you think I am taking on too many clients?'] },
];
const MEMBER_CONTROLS = [
  { id: 'member/no-tool', turns: ['Hi Gaia, how are you?'], expect: 'none' },
  { id: 'member/navigate', turns: ['Take me to my courses.'], expect: ['navigate'] },
];


// ── the two variants, measured side by side ───────────────────────────────
//
// A run of eight repetitions turned out to be far too small to compare two
// configurations measured an hour apart: one run hit 35 upstream
// ModelServingErrors and scored fifteen points lower on IDENTICAL code. So the
// prompt is rewritten in memory instead, and both variants are interleaved in
// one process -- same window, same upstream weather, same queue.
const OLD_NAV = ' For a PRACTITIONER this also opens the Practice screen (inside You) on one of their clients: pass screen="practice" with the client id, and `open` to show a particular result card. Prefer this over describing readings aloud -- open the card, then say one short sentence about what it shows.';
const NEW_NAV = ' For a PRACTITIONER this also opens the Practice screen (inside You): pass screen="practice", with a client id to open one of their clients. Use it only when they ask to be taken somewhere. It moves the screen and returns no data, so it can never answer a question: anything about a client or a reading goes to the matching practitioner_ tool, which opens the same card itself and is the only thing that returns the numbers. After it, say one short sentence and do not list what is already visible.';
const NEW_SLOW = 'SLOW \u2014 about ten seconds; the card opens and shows the wait by itself, so call it rather than announcing it. Never say you are fetching it without calling it in the same turn.';
const OLD_SLOW = {
  practitioner_client_latest_scan: 'SLOW \u2014 takes about ten seconds, so tell the practitioner you are fetching it before you call it.',
  practitioner_client_trend: 'SLOW \u2014 about ten seconds, so say you are looking it up first.',
  practitioner_compare_sessions: 'SLOW \u2014 about ten seconds, so say you are checking first.',
};

/** The practitioner policy with the new clauses taken back off. */
function downgradeInstructions(text) {
  const i = text.indexOf(' THEIR OWN CLIENTS ARE THEIRS TO ASK ABOUT:');
  if (i < 0) return text;                      // already the old wording
  const j = text.indexOf('\n', i);
  return text.slice(0, i) + (j < 0 ? '' : text.slice(j));
}
/** The declarations with the new descriptions taken back off. */
function downgradeTools(decls) {
  return decls.map((d) => {
    if (d.name === 'navigate' && d.description.includes(NEW_NAV)) {
      return { ...d, description: d.description.replace(NEW_NAV, OLD_NAV) };
    }
    if (OLD_SLOW[d.name] && d.description.includes(NEW_SLOW)) {
      return { ...d, description: d.description.replace(NEW_SLOW, OLD_SLOW[d.name]) };
    }
    return d;
  });
}

// ── scoring ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const REPS = Number(arg('--reps', 1));
const OUT = arg('--out', 'determinism.json');
const CONCURRENCY = Number(arg('--jobs', 4));

const built = productionInstructions({
  practitioner: { view: 'profile', memberContext: PRACTITIONER_CONTEXT },
  member: { view: 'today', memberContext: MEMBER_CONTEXT },
});
const instructions = built.practitioner;
const memberInstructions = built.member;
if (!/VERIFIED PRACTITIONER/.test(instructions)) {
  console.error('the practitioner context fixture is not producing a practitioner session; the run would measure a visitor');
  process.exit(1);
}
const toolsAfter = toolDeclarationsFor(CTX);
const memberTools = toolDeclarationsFor(MEMBER_CTX);
// A third wording, to test one hypothesis: that mentioning the utterance at all
// is what invites it. Twice now a clause of the form "never say you are
// fetching it" has coincided with MORE turns that say exactly that and call
// nothing -- 14 -> 20 for the clause that was reverted, 7 -> 16 for the one
// that shipped. `quiet` says the tool is slow and says nothing whatsoever about
// speaking, which is the only way to tell priming from coincidence.
const QUIET_SLOW = 'SLOW \u2014 about ten seconds; the card opens and shows the wait by itself.';
const quietTools = (decls) => decls.map((d) => (OLD_SLOW[d.name] && d.description.includes(NEW_SLOW)
  ? { ...d, description: d.description.replace(NEW_SLOW, QUIET_SLOW) }
  : d));

const VARIANTS = {
  after: { instructions: built.practitioner, tools: toolsAfter },
  before: { instructions: downgradeInstructions(built.practitioner), tools: downgradeTools(toolsAfter) },
  quiet: { instructions: built.practitioner, tools: quietTools(toolsAfter) },
};
const WANT = String(arg('--variant', 'after'));
const PICKED = WANT === 'both' ? ['before', 'after'] : WANT.split(',').map((v) => v.trim()).filter(Boolean);
for (const v of PICKED) {
  if (!VARIANTS[v]) { console.error('unknown variant ' + v); process.exit(1); }
}
if (PICKED.includes('before')) {
  if (VARIANTS.before.instructions === VARIANTS.after.instructions) {
    console.error('the before variant is identical to the after variant; the downgrade did not apply');
    process.exit(1);
  }
  const navA = VARIANTS.after.tools.find((d) => d.name === 'navigate').description;
  const navB = VARIANTS.before.tools.find((d) => d.name === 'navigate').description;
  if (navA === navB) { console.error('navigate was not downgraded'); process.exit(1); }
}

/** Every job this run performs, as a flat list so they can be pooled. */
const jobs = [];
for (let r = 0; r < REPS; r += 1) {
  // The variants are adjacent in the queue, not grouped per repetition. The
  // upstream flaps -- the same single-session probe returned 13 errors in one
  // minute and none in the next -- so the only way a difference means anything
  // is for each pair of observations to be in flight at the same time. Grouped
  // by repetition, the workers finished every `before` job first and `after`
  // starved, which is both slower to a usable sample and unpaired at the edges.
  const specs = [{ kind: 'conversation', spec: FOLLOW_UP_CONVERSATION }];
  for (const intent of SINGLE_INTENTS) {
    for (const say of intent.phrasings) specs.push({ kind: 'single', intent, say });
  }
  for (const c of CONTROLS) specs.push({ kind: 'control', spec: c });
  for (const c of MEMBER_CONTROLS) specs.push({ kind: 'member', spec: c });
  for (const spec of specs) {
    for (const variant of PICKED) jobs.push({ ...spec, rep: r, variant });
  }
}

const records = [];
let flushed = 0;
let completed = 0;
async function runJob(job) {
  const { instructions, tools } = VARIANTS[job.variant];
  try {
    if (job.kind === 'conversation') {
      const out = await runConversation({
        turns: job.spec.turns.map((t) => t.say), tools, instructions, label: job.spec.id,
      });
      job.spec.turns.forEach((t, i) => {
        const turn = out.turns[i];
        if (!turn) return;
        const names = turn.calls.map((c) => c.name);
        // A turn whose data was fetched by the turn immediately before it is
        // answering from fresh data, not from memory -- a different thing from
        // a turn that fetched nothing and never had any.
        const prev = out.turns[i - 1];
        const fresh = !!prev && prev.calls.some((c) => /latest_scan|client_trend|compare_sessions/.test(c.name));
        records.push({
          group: 'follow-ups', case: `${job.spec.id}#${i + 1}`, say: t.say, rep: job.rep,
          variant: job.variant,
          pass: names.some((n) => t.expect.includes(n)),
          freshData: fresh, calls: names, spoken: turn.spoken, error: out.error,
          invalid: !!out.error,
        });
      });
    } else if (job.kind === 'single') {
      const out = await runConversation({
        turns: [OPEN, ON_CLIENT, job.say], tools, instructions, label: `${job.intent.id}:${job.say}`,
      });
      const turn = out.turns[2] || { calls: [], spoken: '' };
      const names = turn.calls.map((c) => c.name);
      // A probe whose setup turns never fetched the client is measuring the
      // setup, not the intent, so the trace travels with the record.
      const setup = out.turns.slice(0, 2).flatMap((t) => t.calls.map((c) => c.name));
      records.push({
        group: `intent/${job.intent.id}`, case: job.say, say: job.say, rep: job.rep,
        variant: job.variant,
        pass: names.some((n) => job.intent.expect.includes(n)),
        calls: names, setup, clientEstablished: setup.some((n) => /find_client|get_client|list_clients/.test(n)),
        spoken: turn.spoken, error: out.error, invalid: !!out.error,
      });
    } else {
      const member = job.kind === 'member';
      const out = await runConversation({
        turns: job.spec.turns,
        tools: member ? memberTools : tools,
        instructions: member ? memberInstructions : instructions,
        label: job.spec.id,
      });
      const turn = out.turns[out.turns.length - 1] || { calls: [], spoken: '' };
      const names = turn.calls.map((c) => c.name);
      const want = job.spec.expect;
      records.push({
        group: member ? 'member' : 'controls', case: job.spec.id,
        say: job.spec.turns[job.spec.turns.length - 1], rep: job.rep,
        variant: job.variant,
        pass: Array.isArray(want) ? names.some((n) => want.includes(n)) : names.length === 0,
        calls: names, spoken: turn.spoken, error: out.error, invalid: !!out.error,
      });
    }
  } catch (e) {
    records.push({ group: job.kind, case: job.spec?.id || job.say, rep: job.rep, variant: job.variant,
                   pass: false, calls: [], spoken: '', error: String(e.message || e), invalid: true });
  }
  completed += 1;
  // A run of nine hundred jobs takes hours and the JSON was only written at the
  // end, so a timeout threw the whole thing away. Each record is appended as it
  // lands; tools/determinism-rollup.mjs turns the .jsonl back into a run file.
  try {
    fs.appendFileSync(OUT + 'l', records.slice(flushed).map((r) => JSON.stringify(r)).join('\n') + '\n');
    flushed = records.length;
  } catch { /* a failed flush must not lose the run */ }
  process.stderr.write(`\r${completed}/${jobs.length} jobs`);
}

// ── spending guard ────────────────────────────────────────────────────────
//
// Every session here is billed to a pay-as-you-go account. On 2-3 Oct 2026 this
// script ran ~5,400 requests and ~90 million tokens to measure consistency --
// about 99% of that month's bill, against ~1% from every real member combined.
// Nobody had approved that volume, because nothing asked.
//
// Project rule since then: default to 3-5 requests, and anything larger needs
// the owner's explicit approval, given in advance, with the request count,
// tokens and cost stated. So this refuses -- it does not trim the run quietly
// and carry on -- and it prints exactly what it would have cost.
// --only narrows the run to the cases that matter -- "compare", "follow-ups",
// "control/greeting" -- so a question can be answered with three requests
// rather than three hundred.
const ONLY = arg('--only', '');
if (ONLY) {
  const keep = jobs.filter((j) => [j.kind, j.spec?.id, j.intent?.id, j.say]
    .some((v) => v && String(v).includes(ONLY)));
  jobs.length = 0;
  jobs.push(...keep);
  if (!jobs.length) { console.error(`--only "${ONLY}" matched nothing`); process.exit(2); }
}
const TURNS_PER_JOB = (job) => (job.kind === 'conversation' ? job.spec.turns.length
  : job.kind === 'single' ? 3 : job.spec.turns.length);
const turnsPlanned = jobs.reduce((n, j) => n + TURNS_PER_JOB(j), 0);
// Measured on the live account: one voice turn re-bills ~8-12k input tokens,
// and the October bill came to ~$0.24 per million tokens all-in.
const TOKENS_PER_TURN = 10000;
const USD_PER_MILLION = 0.24;
const tokensPlanned = turnsPlanned * TOKENS_PER_TURN;
const TURNS_PER_JOB_AVG = () => Math.round((turnsPlanned / Math.max(1, jobs.length)) * TOKENS_PER_TURN);
const costPlanned = (tokensPlanned / 1e6) * USD_PER_MILLION;
const DEFAULT_MAX_SESSIONS = 5;
const MAX_SESSIONS = Number(arg('--max-sessions', DEFAULT_MAX_SESSIONS));
const estimate = `${jobs.length} sessions, ~${turnsPlanned} model turns, ~${(tokensPlanned / 1e6).toFixed(1)}M tokens, ~$${costPlanned.toFixed(2)}`;
console.error(`planned: ${estimate}`);
if (!Number.isFinite(MAX_SESSIONS) || MAX_SESSIONS < 1) {
  console.error('--max-sessions must be a positive number'); process.exit(2);
}
if (jobs.length > MAX_SESSIONS) {
  console.error(`\nREFUSED: ${jobs.length} sessions exceeds the cap of ${MAX_SESSIONS}.`);
  console.error('This calls a paid model. Runs above the default of ' + DEFAULT_MAX_SESSIONS
    + ' need explicit approval from the account owner first, with the estimate above.');
  console.error(`Once approved, re-run with --max-sessions ${jobs.length}. Use --only to narrow the run instead.`);
  process.exit(2);
}
if (args.includes('--dry-run')) { console.error('dry run: nothing sent.'); process.exit(0); }

// The runtime half of the cap. --max-sessions is this script's own name for it;
// the shared guard takes the same number, and never raises it.
paidGuard = installPaidCallGuard({
  label: 'determinism-harness', planned: jobs.length,
  tokensPerCall: TURNS_PER_JOB_AVG(), usdPerMillion: USD_PER_MILLION,
  why: 'measure how consistently the model calls practitioner tools',
  argv: ['--max-requests', String(MAX_SESSIONS)],
});

const queue = [...jobs];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) { const j = queue.shift(); if (!j) return; await runJob(j); }
}));
process.stderr.write('\n');

// ── report ────────────────────────────────────────────────────────────────
const invalid = records.filter((r) => r.invalid).length;
if (invalid) {
  console.log(`\n${invalid} of ${records.length} turns failed upstream and are excluded from the rates.`);
  console.log('(an upstream ModelServingError is not a decision the model made)');
}
const byCase = new Map();
for (const r of records.filter((x) => !x.invalid)) {
  const key = `${r.group}\u0000${r.case}`;
  if (!byCase.has(key)) byCase.set(key, { group: r.group, case: r.case, say: r.say, n: 0, pass: 0, calls: [], misses: [] });
  const row = byCase.get(key);
  row.n += 1;
  if (r.pass) row.pass += 1; else row.misses.push({ calls: r.calls, spoken: r.spoken.slice(0, 160), error: r.error });
  row.calls.push(r.calls.join('+') || '(none)');
}
const rows = [...byCase.values()];
for (const v of PICKED) {
  const mine = records.filter((r) => !r.invalid && r.variant === v);
  const data = mine.filter((r) => r.group.startsWith('intent/') || r.group === 'follow-ups');
  const ctrl = mine.filter((r) => r.group === 'controls' || r.group === 'member');
  const rate = (a) => (a.length ? ((a.filter((r) => r.pass).length / a.length) * 100).toFixed(1) + '%' : '-');
  console.log(`\n${v.toUpperCase().padEnd(7)} data ${rate(data)} (${data.filter((r) => r.pass).length}/${data.length})`
    + `   controls ${rate(ctrl)} (${ctrl.filter((r) => r.pass).length}/${ctrl.length})`);
}
const groups = new Map();
for (const row of rows) {
  if (!groups.has(row.group)) groups.set(row.group, { n: 0, pass: 0 });
  const g = groups.get(row.group);
  g.n += row.n; g.pass += row.pass;
}

const pct = (p, n) => (n ? ((p / n) * 100).toFixed(0) + '%' : '-');
console.log(`\nmodel=${cfg.model}  reps=${REPS}  turns=${records.length}\n`);
for (const [name, g] of groups) console.log(`  ${name.padEnd(22)} ${pct(g.pass, g.n).padStart(5)}  (${g.pass}/${g.n})`);
console.log('\nper case:');
for (const row of rows.sort((a, b) => (a.pass / a.n) - (b.pass / b.n))) {
  console.log(`  ${pct(row.pass, row.n).padStart(5)} (${row.pass}/${row.n})  ${row.group} :: ${row.case}`);
  if (row.misses.length) {
    const m = row.misses[0];
    console.log(`         miss: calls=[${m.calls.join(',')}] ${m.error ? 'err=' + m.error + ' ' : ''}said="${m.spoken}"`);
  }
}
fs.writeFileSync(OUT, JSON.stringify({ model: cfg.model, reps: REPS, at: new Date().toISOString(), rows, records }, null, 2));
console.log(`\nwrote ${OUT}`);
