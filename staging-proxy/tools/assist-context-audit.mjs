/**
 * OFFLINE CONTEXT AUDIT — what Gaia Assist sends to a model, in tokens.
 *
 * Rebuilds the exact instruction strings, tool schemas and prompts from the
 * real functions, for each role and conversation shape, and measures them.
 * It never calls a model: every outbound request is refused before it leaves
 * the process, so it is safe under the paid-API rule in AGENTS.md and needs no
 * approval to run.
 *
 * Tokens are estimated at ~3.45 characters per token, calibrated against real
 * Qwen billing (a real visitor session billed 5,720 tokens for a context this
 * tool measures at 5,755). Treat absolute numbers as +/-10%; before/after
 * DIFFERENCES between two runs of this tool are exact in characters.
 *
 * Voice history is the one modelled part: Qwen holds the conversation
 * server-side, so history is rebuilt from a scripted transcript (text) plus an
 * estimate of the member's audio (~100 tokens per utterance).
 *
 *   node tools/assist-context-audit.mjs                 # table
 *   node tools/assist-context-audit.mjs --json out.json # machine-readable
 */
import fs from 'node:fs';

// ── seal the network before anything is imported ─────────────────────────
const SECRET = 'offline-context-audit-'.padEnd(48, 'x');
Object.assign(process.env, {
  PORT: '0', HOST: '127.0.0.1',
  GHL_API_BASE_URL: 'http://127.0.0.1:9', GHL_API_TOKEN: 'x', GHL_LOCATION_ID: 'x',
  EVENT_MANAGER_BASE_URL: 'http://127.0.0.1:9', GAIA_DISABLE_ALERT_TIMER: '1', STORE_SYNC_ENABLED: 'false',
  AUTH_SESSION_SECRET: SECRET, COURSES_SYNC_SECRET: SECRET, GHL_BACKFILL_SECRET: SECRET,
  GHL_WORKFLOW_WEBHOOK_SECRET: SECRET, GAIA_ASSIST_VOICE_ENABLED: 'true', QWEN_VOICE_ENABLED: 'false',
  GAIA_USAGE_LOG: '',                       // never write usage records from an audit
});
globalThis.fetch = async (u) => {
  const host = new URL(String(u)).hostname;
  if (!/^(127\.|localhost$)/.test(host)) throw new Error(`OFFLINE AUDIT refused a call to ${host}`);
  return new Response('{}');
};

const srv = await import('../server.js');
const tools = await import('../assist-tools.js');
const relay = await import('../qwen-voice-relay.js');
const guide = globalThis.GaiaAssistGuide;

const CPT = 3.45;
const tok = (s) => Math.round(String(s || '').length / CPT);

// ── who is asking ─────────────────────────────────────────────────────────
// A realistic completed member, written with buildMemberVoiceContext's own
// line templates so its size matches what a real member produces.
const memberContext = (state) => [
  `GAIA SESSION STATE: ${state}`,
  'MEMBER CONTEXT (private — this is the currently signed-in member). Use it ONLY to personalize answers for this person. Never read it aloud verbatim, never disclose it to anyone else, and never reference data belonging to other members.',
  'You are speaking with Sara Keshavarz. Use their first name sparingly ("Sara").',
  `Status: member · 2025 cohort · Gold member${state === 'practitioner' ? ' · certified practitioner' : ''}.`,
  'Community access (unlocked): Gaia Circle, Bio-Well Users, Energy Medicine Hub, Members Lounge.',
  'Not included yet: Practitioner Mastermind, Elevate VIP — if asked, offer to help them get access; never claim they already have it.',
  'Device ownership signals (may be self-declared; not proof of purchase or authenticity): Bio-Well 3.0, Healy.',
  'Course access (unlocked, 8): Bio-Well Basic Certification Training, Bio-Well Advanced Level 1 Certification Training, Chakra Foundations, Biofield Science 101, Sound Healing Essentials, Energy Hygiene, Meditation for Healers, Crystal Grids. If they ask which courses they have, list these by name. Open the course in Academy; available lessons play in the app, while portal-only content opens the education portal.',
  'Account: 6 completed purchase(s), 1 subscription(s) on file. Do NOT say amounts, prices, or card details out loud.',
  'Has 1 upcoming appointment(s) booked.',
  'Has submitted 2 form(s) and 1 survey(s).',
  'WHAT YOU CAN SEE: their profile, memberships/communities, which courses they are entitled to (by name), products/devices, purchases & subscriptions (counts only), appointments, form/survey submissions, unread messages, and what you remember from past visits.',
  'WHAT YOU CANNOT SEE: how far along a lesson they are, grades, or community post/discussion content — the backend does not expose these. You CAN tell them which courses they have (by name) and open them; you cannot tell them which lesson they are on or how much they have finished. If they ask, say so plainly and offer to open the course so they can see their place.',
  'Privacy: discuss only THIS member’s own data, and only when they ask about it. Do not proactively recite sensitive details.',
  'ONBOARDING PROFILE: DONE — do NOT run the onboarding survey again; use their interests below to tailor suggestions.',
  'CURRENT GAIA PROFILE CHOICES: {"primary_interests":["Energy healing","Bio-Well"],"goals":["Better sleep","Reduce stress"],"experience":["Some experience"]}',
  'Use these saved choices for relevant Store, Energy, Academy and Community guidance. Choices are current; historical interest tags can remain after a branch change. Interests guide suggestions but do not establish eligibility, ownership or access.',
  'What we already know (profile tags): interest_energy_healing, interest_biowell, product_biowell_owner, practice_stage_practitioner, need_sleep, need_stress, community_feature_events, interest_sound, interest_chakra, invest_course.',
  'SUBSCRIPTION: This member is a PAID subscriber — do NOT pitch a plan they already pay for; focus on helping them get more value from it.',
].join('\n');
const ONBOARDING = 'GAIA SESSION STATE: onboarding\nONBOARDING PROFILE: NOT DONE. onboarding_required=true. Normal member features are locked. Help with the required profile, sign out or recovery. Answer a simple unrelated question briefly before returning to the current step. Resume at primary_interests. Saved answers: {}. Use save_onboarding_step or conversational ONBOARD markers for answers. Do not navigate, open portals, recommend products, book or run other member actions until confirmed completion.';

const ROLES = {
  visitor:      { context: '',                          tool: null },
  member:       { context: memberContext('member'),       tool: { contactId: 'm', isPractitioner: false, state: 'member' } },
  onboarding:   { context: ONBOARDING,                    tool: { contactId: 'o', isPractitioner: false, state: 'onboarding' } },
  practitioner: { context: memberContext('practitioner'), tool: { contactId: 'p', isPractitioner: true,  state: 'practitioner' } },
};

// ── the parts of one voice reply ──────────────────────────────────────────
const DYNAMIC = /^(GAIA SESSION STATE|MEMBER CONTEXT|You are speaking|Status:|Community access|Not included|Device ownership|Course access|Account:|Has |WHAT YOU|Privacy:|ONBOARDING PROFILE|CURRENT GAIA PROFILE|Use these saved|What we already know|SUBSCRIPTION:|CURRENT NAVIGATION|Current screen|CURRENT SCREEN|CURRENT PAGE)/;
function split(instructions) {
  let fixed = 0; let dynamic = 0;
  for (const line of instructions.split('\n')) {
    if (DYNAMIC.test(line)) dynamic += line.length + 1; else fixed += line.length + 1;
  }
  return { fixed: Math.round(fixed / CPT), dynamic: Math.round(dynamic / CPT) };
}

/** The longest leading run of instructions that is identical for every role. */
function sharedPrefix(texts) {
  let n = 0;
  const first = texts[0];
  while (n < first.length && texts.every((t) => t[n] === first[n])) n += 1;
  return n;
}

// ── a scripted voice conversation, for history ────────────────────────────
const SCRIPT = [
  ['How do I book a session with a healer?', 'Tap Bookings, choose a practitioner and a time. Want me to open it?'],
  ['Yes please.', 'Bookings is open. Pick a practitioner to see their times.'],
  ['What does the Bio-Well cost?', 'The Bio-Well 3.0 starts at $1,950 in the store. Shall I open it?'],
  ['Not now. Any events coming up?', 'Elevate 2026 is 20 to 22 November at Rosen Shingle Creek in Orlando.'],
  ['Great, thanks.', 'You are welcome.'],
];
const LOOKUP_RESULT = 'LIVE DATA (answer only from this, do not invent): Store products: Bio-Well 3.0 Professional Kit — from $1,950 | Bio-Well Sputnik — $420 | Bio-Well Water Sensor — $290 | Bio-Well Glove — $185\nCurrent event: Gaia Healers Elevate Conference 2026 — 2026-11-20T09:00:00 - 2026-11-22T18:00:00 at Rosen Shingle Creek, Orlando, FL';
const AUDIO_PER_UTTERANCE = 100;

function voiceHistoryTokens(turn, { withTool = false } = {}) {
  // Everything said BEFORE this turn, as Qwen holds it.
  let text = ''; let audio = 0;
  for (let i = 0; i < turn - 1; i += 1) {
    const [user, assistant] = SCRIPT[i % SCRIPT.length];
    text += user + assistant; audio += AUDIO_PER_UTTERANCE;
    if (withTool && i === 2) text += JSON.stringify({ name: 'gaia_lookup', arguments: { query: 'bio-well price' } }) + JSON.stringify({ ok: true, message: LOOKUP_RESULT });
  }
  return { text: tok(text), audio, total: tok(text) + audio };
}

function textHistory(turns) {
  const out = [];
  for (let i = 0; i < turns; i += 1) {
    const [user, assistant] = SCRIPT[i % SCRIPT.length];
    out.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
  }
  return out;
}

// ── measure ───────────────────────────────────────────────────────────────
const report = { calibration: `~${CPT} chars/token (Qwen billing)`, roles: {}, navigation: {}, history: {}, tools: {} };
const instructionsByRole = {};
for (const [role, r] of Object.entries(ROLES)) {
  const instructions = srv.buildGaiaLiveInstructions({ view: 'today', memberContext: r.context, appContext: { screen: 'today' } });
  instructionsByRole[role] = instructions;
  const decls = tools.toolDeclarationsFor(r.tool);
  const schema = tok(JSON.stringify(decls));
  const wire = JSON.stringify(relay.sessionUpdateFor(null, { instructions, voice: 'Zane', tools: decls }));
  const { fixed, dynamic } = split(instructions);
  const sys = srv.assistSystemPrompt(r.context);
  report.roles[role] = {
    voicePerReply: tok(wire),
    fixedSetup: fixed, toolSchemas: schema, dynamicContext: dynamic,
    tools: decls.map((d) => d.name),
    textSystemPrompt: tok(sys),
  };
}
const prefix = sharedPrefix(Object.values(instructionsByRole));
report.sharedStaticPrefix = { chars: prefix, tokens: tok('x'.repeat(prefix)) };

// Repeated navigation: what the relay sends after N screen changes.
{
  const base = instructionsByRole.member;
  const screens = ['academy', 'store', 'events', 'profile', 'wellness', 'community', 'today', 'directory', 'inbox', 'bookings'];
  const after = [];
  let current = base;
  for (const screen of screens) {
    const ctx = guide.context({ screen });
    current = typeof relay.instructionsWithNavigation === 'function'
      ? relay.instructionsWithNavigation(current, ctx)
      : base + '\nCURRENT NAVIGATION (hints only; explicit user intent takes priority): ' + JSON.stringify(ctx);
    after.push(current);
  }
  const last = after[after.length - 1];
  report.navigation = {
    beforeAnyNavigation: tok(base),
    afterOneNavigation: tok(after[0]),
    afterTenNavigations: tok(last),
    growthOverTen: tok(last) - tok(after[0]),
    navigationLinesAfterTen: (last.match(/CURRENT NAVIGATION|CURRENT SCREEN/g) || []).length,
    screenLinesAfterTen: (last.match(/^Current screen:/gm) || []).length,
    staleScreenStillPresent: /"screen":"today"/.test(last) && !last.trim().endsWith('"screen":"today"}') && (last.match(/"screen":"/g) || []).length > 1,
  };
}

// History by conversation length.
for (const [label, turn] of [['turn 1', 1], ['turn 5', 5], ['turn 20', 20]]) {
  const v = voiceHistoryTokens(turn);
  const userPrompt = srv.assistUserPrompt('Does Gaia have sleep courses?', { appContext: { screen: 'today' }, history: textHistory(turn - 1) });
  report.history[label] = { voiceHistory: v.total, voiceHistoryAudio: v.audio, textUserPrompt: tok(userPrompt) };
}
// A tool call, then the conversation continues.
{
  const without = voiceHistoryTokens(6);
  const withTool = voiceHistoryTokens(6, { withTool: true });
  report.history['turn 6 after a lookup at turn 3'] = { voiceHistory: withTool.total, addedByToolCall: withTool.total - without.total };
}
// Long-conversation text history: is the NEWEST message kept?
{
  const long = [];
  for (let i = 0; i < 12; i += 1) long.push({ role: i % 2 ? 'assistant' : 'user', content: `message-${i} ` + 'detail '.repeat(180) });
  const kept = guide.history(long);
  report.history.longTextConversation = {
    sent: long.length, kept: kept.length,
    newestKept: kept.some((m) => m.content.startsWith('message-11 ')),
    oldestKept: kept.length ? kept[0].content.split(' ')[0] : null,
    tokens: tok(JSON.stringify(kept)),
  };
}
for (const d of tools.toolDeclarationsFor({ contactId: 'p', isPractitioner: true, state: 'practitioner' })) {
  report.tools[d.name] = tok(JSON.stringify(d));
}

const args = process.argv.slice(2);
if (args.includes('--json')) {
  fs.writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(report, null, 2));
}
const r = report.roles;
const lines = [];
lines.push('PER VOICE REPLY (tokens re-processed on every reply, before history and audio)');
lines.push('role           total   fixed   tools   dynamic   text-chat system   tools offered');
for (const [role, v] of Object.entries(r)) {
  lines.push(`${role.padEnd(13)}${String(v.voicePerReply).padStart(7)}${String(v.fixedSetup).padStart(8)}${String(v.toolSchemas).padStart(8)}${String(v.dynamicContext).padStart(10)}${String(v.textSystemPrompt).padStart(19)}   ${v.tools.length}`);
}
lines.push(`\nshared static prefix (identical for every role): ${report.sharedStaticPrefix.tokens} tokens`);
lines.push('\nREPEATED NAVIGATION (member): ' + JSON.stringify(report.navigation));
lines.push('\nHISTORY:');
for (const [k, v] of Object.entries(report.history)) lines.push(`  ${k.padEnd(34)} ${JSON.stringify(v)}`);
process.stdout.write(lines.join('\n') + '\n', () => process.exit(0));
