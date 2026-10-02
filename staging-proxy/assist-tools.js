/**
 * GAIA ASSIST — the tools, declared and executed on the server.
 *
 * They used to be declared by the browser. The orb sent `setup.tools` and the
 * relay forwarded whatever arrived, which was tolerable while the only tools
 * were `navigate` (it moves you around your own app) and `save_onboarding_step`
 * (the endpoint re-authorizes anyway). It stops being tolerable the moment a
 * tool reads somebody's health data: a modified client could declare any tool it
 * liked, and the tool surface would be whatever the page claimed it was.
 *
 * So the server owns the list now. Three rules hold it together:
 *
 *   1. WHO YOU ARE IS NEVER AN ARGUMENT. No handler takes a practitioner id, a
 *      contact id, or a token. Identity arrives in `ctx`, derived from the signed
 *      session cookie, and the model has no way to influence it. The worst a
 *      confused or manipulated model can do is ask for a customer -- and their
 *      server then refuses any customer that is not this practitioner's, which we
 *      verified by asking for eight that were not.
 *
 *   2. WHAT YOU MAY SEE IS DECIDED BEFORE YOU ASK. Tools are filtered by role
 *      when the list is built, so a member who is not a practitioner is never
 *      even told these tools exist. Privileges come from GHL tags on an
 *      authenticated contact, not from anything said in a conversation.
 *
 *   3. RESULTS ARE SHAPED BEFORE THE MODEL SEES THEM. get_customer_scan returns
 *      1.6 MB -- roughly four hundred thousand tokens of raw readings. Nothing
 *      goes into a context window unshaped, ever.
 */
import { practitionersConfig, validAccessToken, mcpCall, unwrapMcp } from './practitioners-oauth.js';

const MAX_QUERY = 120;
const MAX_CUSTOMERS = 200;

/** A customer, reduced to what a practitioner's question actually needs. */
function slimCustomer(c = {}) {
  return {
    id: String(c.id ?? ''),
    name: c.name || '',
    email: c.email || '',
    has_biowell: Boolean(c.hasBioWellCard),
  };
}

function requireString(args, key, { max = 64, required = true } = {}) {
  const raw = args?.[key];
  if (raw === undefined || raw === null || raw === '') {
    if (!required) return '';
    throw Object.assign(new Error(`${key} is required`), { code: 'bad_args' });
  }
  const v = String(raw).trim();
  if (!v || v.length > max) {
    throw Object.assign(new Error(`${key} is not a valid value`), { code: 'bad_args' });
  }
  return v;
}

/** One MCP read, with this practitioner's own token and nobody else's. */
async function readMcp(ctx, tool, args = {}) {
  const cfg = practitionersConfig();
  const token = await validAccessToken(cfg, ctx.contactId);
  if (!token) {
    throw Object.assign(new Error('not connected'), { code: 'not_connected' });
  }
  return unwrapMcp(await mcpCall(cfg, token, tool, args));
}


// ── shaping scan data ──────────────────────────────────────────────────────
// get_customer_scan returns the client's WHOLE history: a hundred scans at about
// sixteen kilobytes each, 1.6 MB in all, which is somewhere near four hundred
// thousand tokens. Most of each scan is a raw JSON-RPC envelope under `data`
// that carries no meaning at all. What a practitioner is actually asking about
// is the newest reading and the handful of things furthest out of balance, so
// that is what gets built here and nothing else travels.

const TOP_N = 6;
const round = (n, dp = 1) => (typeof n === 'number' && Number.isFinite(n)
  ? Number(n.toFixed(dp)) : null);

/** The few readings furthest out of balance, worst first. */
function worstDisbalances(labeled = {}, limit = TOP_N) {
  const rows = [];
  for (const group of ['organs', 'meridians', 'systems']) {
    for (const r of labeled[group] || []) {
      if (typeof r?.disbalance === 'number') {
        rows.push({ area: group.replace(/s$/, ''), name: r.name, disbalance: round(r.disbalance) });
      }
    }
  }
  return rows.sort((a, b) => b.disbalance - a.disbalance).slice(0, limit);
}

/** One scan, reduced to what somebody would actually say about it. */
function slimScan(scan = {}) {
  const l = scan.labeled || {};
  return {
    scanned_at: String(scan.scanned_at || '').slice(0, 10),
    stress: round(l.stress, 2),
    energy: round(l.energy),
    chakras: (l.chakras || []).map((c) => ({ name: c.name, value: round(c.value, 2), alignment: round(c.align) })),
    most_out_of_balance: worstDisbalances(l),
  };
}

export const TOOLS = [
  // —— available to everyone, performed by the page ——
  //
  // Lifted verbatim from gaia-realtime-voice.js, where they used to be declared.
  // All twelve, not a selection: the server's list REPLACES the page's, so a
  // tool missing here is a tool the model can no longer call. Declaring only the
  // two obvious ones silently removed gaia_lookup -- which the system prompt
  // tells the model to use for every live fact -- along with nine others.
  {
    role: 'member',
    where: 'client',

                  name: 'navigate',
                  description: 'Navigate the member to a screen in the Gaia Healers app. Call this whenever the member asks to open, go to, show, or see a specific screen, tab, or feature — for example "take me to my courses", "open the store", "show my profile", "find a healer", "go to wellness". Do not just describe the path; call this tool to actually move them there.',
                  parameters: {
                    type: 'object',
                    properties: {
                      screen: {
                        type: 'string',
                        description: 'The destination screen. today=Home, academy=Courses & Library, community=Community/Find a Healer/Events/Gaia Radio/Book a session, events=gatherings, bookings=your sessions, inbox=messages, directory=Find a Healer, store=Shop & Membership, profile=You (account & access), wellness=Energy (energy check, horoscope, chakras, numerology, colour test, Bio-Well).',
                        enum: ['today', 'academy', 'community', 'events', 'bookings', 'inbox', 'directory', 'store', 'profile', 'wellness'],
                      },
                      tab: {
                        type: 'string',
                        description: 'Optional tab within the screen. store: "shop" or "membership". wellness: "check", "horoscope", or "chakras". community: "discussion", "members", or "events". Omit if unsure.',
                      },
                      tool: {
                        type: 'string',
                        description: 'Optional single Energy tool to open on the wellness screen, instead of leaving the member to scroll for it. Each value is the card the member will see: pulse=Energy Pulse (camera heart-rate reading), breath=Coherence Breathing, numerology=Numerology, sky=Today\u2019s Sky, colour=Colour Test, chakra=Chakra Balance, match=Energy Match, cosmic=Cosmic Map, moon=Moon Rituals. Only valid with screen=wellness.',
                        enum: ['pulse', 'breath', 'numerology', 'sky', 'colour', 'chakra', 'match', 'cosmic', 'moon'],
                      },
                    },
                    required: ['screen'],
                  },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'save_onboarding_step',
                  description: 'Record ONE step of the Gaia Healers getting-to-know-you (onboarding) survey for the signed-in member, which creates their interest tags. Call this right after the member answers each step, passing the EXACT option label(s) they chose. Use complete=true only on the final step. Only for signed-in members.',
                  parameters: {
                    type: 'object',
                    properties: {
                      stepKey: {
                        type: 'string',
                        description: 'The step key: primary_interests, why_join, living_beings_who, living_beings_support, environment_areas, environment_spaces, water, business_length, invest_timing, growth_needs, devices_owned, client_needs, can_offer, want_receive, or final_notes.',
                      },
                      selections: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'The exact option label(s) the member chose for this step (one or several). Empty for a skipped or free-text-only step.',
                      },
                      freeText: {
                        type: 'string',
                        description: 'Optional free-text answer (e.g. Other devices, or the final comments).',
                      },
                      complete: {
                        type: 'boolean',
                        description: 'True only on the final step, to mark the whole survey complete.',
                      },
                    },
                    required: ['stepKey'],
                  },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'gaia_lookup',
                  description: 'Look up LIVE Gaia Healers facts to answer a question accurately: store products and prices (gaiahealers.com), the practitioner directory (count and who/where), which courses exist, and the current event. Call when current verified context is missing for a price, product, membership, practitioner, course or event. Current page IDs resolve on the server; no need to repeat a lookup already answered by current context. Answer only from what it returns; never invent a price, count, or name.',
                  parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look up, in the member\'s words (e.g. "Bio-Well price", "practitioner in California", "chakra sprays", "what courses").' } }, required: ['query'] },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'remember_member',
                  description: 'Save durable facts about the signed-in member so you can continue naturally next visit. Call this when you learn something worth remembering — a real interest, a goal, a decision they made, an objection they raised, or a follow-up for next time. Do NOT save trivia, one-off logistics, or sensitive personal/financial details.',
                  parameters: { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' }, description: 'Short durable facts to remember, e.g. "Wants to get Bio-Well certified", "Declined Gold - too expensive right now".' }, summary: { type: 'string', description: 'Optional one-line summary of who they are / where they are in their journey.' } }, required: ['facts'] },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'play_course',
                  description: 'Play one of the member\'s courses in the native in-app video player. Call this when they ask to watch, play, open, or continue a specific course or its videos — e.g. "play my Bio-Well Advanced course", "watch the chakra challenge". Pass the course name.',
                  parameters: { type: 'object', properties: { courseTitle: { type: 'string', description: 'The course name to play, as the member said it.' } }, required: ['courseTitle'] },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'express_interest',
                  description: 'Record that the member is interested in a device, topic, membership, or getting certified, and open the best place for it. Call this when they express interest — e.g. "I\'m interested in BioPulsar", "tell me about getting certified", "I want structured water", "I\'m curious about Gold". Pass the topic in their words.',
                  parameters: { type: 'object', properties: { topic: { type: 'string', description: 'What they are interested in, in their own words (device, topic, membership tier, certification, etc.).' } }, required: ['topic'] },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'register_event',
                  description: 'Take the member to register for the current Gaia Healers event. Call this when they want to sign up for, register for, or attend the event — e.g. "sign me up for the event", "I want to attend the conference".',
                  parameters: { type: 'object', properties: {} },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'find_practitioner',
                  description: 'Open the in-app Find a Healer practitioner directory. Call this when they want to find, browse, or connect with a practitioner or healer — e.g. "find me a healer", "show me practitioners near me".',
                  parameters: { type: 'object', properties: { specialty: { type: 'string', description: 'Optional specialty or location they mentioned.' } } },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'book_session',
                  description: 'Open a booking or session widget so the member can book an appointment, scan, demo, call, or a 1:1 with the founder. Call this when the member asks to book, schedule, or reserve a session — for example "book a Bio-Well scan", "I want a demo", "book a discovery call", "schedule wellness coaching", or "book a call with Dr. Nima". Opens the real booking form in a new tab; the member completes the booking there.',
                  parameters: {
                    type: 'object',
                    properties: {
                      session: {
                        type: 'string',
                        description: 'Which session to book. nima = book a 1:1 meeting with Dr. Nima Farshid (the founder) via Calendly.',
                        enum: ['nima', 'scan', 'demo', 'discovery', 'coaching'],
                      },
                    },
                    required: ['session'],
                  },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'open_community',
                  description: 'Open a specific Gaia Healers community in the member portal. Call this when the member asks to open, visit, or go to a community — for example "open the Bio-Well community", "take me to BioPulsar", "show me the All Gaia Healers group". Opens the community page in a new tab.',
                  parameters: {
                    type: 'object',
                    properties: {
                      community: {
                        type: 'string',
                        description: 'Which community to open.',
                        enum: ['all-gaia', 'biowell', 'biopulsar', 'biotekna', 'asea', 'braintap', 'lifewave', 'golden-practitioner'],
                      },
                    },
                    required: ['community'],
                  },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'open_portal',
                  description: 'Open the Gaia Healers member portal (education.gaiahealers.com) or a specific part of it. Call this when the member wants to go to the portal itself — for example "open the portal", "take me to the member portal", "open my courses in the portal", "go to the education site". For course videos and community discussions this is where they actually live.',
                  parameters: {
                    type: 'object',
                    properties: {
                      section: {
                        type: 'string',
                        description: 'Optional section of the portal. Omit for the portal home.',
                        enum: ['home', 'courses', 'login'],
                      },
                    },
                  },
  },
  {
    role: 'member',
    where: 'client',

                  name: 'sign_in',
                  description: 'Open the in-app sign-in form so the member can sign in with their email (a one-tap magic link is sent). Call this when the member asks to sign in, log in, access their account, or says they are not signed in — for example "sign me in", "I want to log in", "help me sign in", "let me access my account". Do not call this if the member is already signed in.',
                  parameters: { type: 'object', properties: {} },
  },

  // —— practitioners only, executed here ——
  //
  // Only the three sub-second reads. Measured against their staging server on
  // 2 October: these answer in about 470 ms, while anything touching a scan
  // takes nine to twelve seconds, which is not a thing to put in the middle of a
  // spoken sentence. The scan tools come next, with their own handling.
  {
    name: 'practitioner_list_clients',
    role: 'practitioner',
    where: 'server',
    mcp: 'list_customers',
    description: "List the practitioner's own clients. Use when they ask to see their clients, patients or customers. Returns id, name, email and whether a Bio-Well card is linked. Takes no arguments — whose clients these are is already known.",
    parameters: { type: 'object', properties: {} },
    async handler(_args, ctx) {
      const out = await readMcp(ctx, 'list_customers');
      const list = (out?.customers || []).slice(0, MAX_CUSTOMERS).map(slimCustomer);
      return { count: out?.count ?? list.length, clients: list };
    },
  },
  {
    name: 'practitioner_find_client',
    role: 'practitioner',
    where: 'server',
    mcp: 'search_customers',
    description: "Find one of the practitioner's own clients by part of their name or email. Use this to turn a name the practitioner said into a client id before asking for anything else about them.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Part of the client’s name or email.' } },
      required: ['query'],
    },
    async handler(args, ctx) {
      const query = requireString(args, 'query', { max: MAX_QUERY });
      const out = await readMcp(ctx, 'search_customers', { query });
      const list = (out?.customers || []).slice(0, MAX_CUSTOMERS).map(slimCustomer);
      return { count: out?.count ?? list.length, query, clients: list };
    },
  },
  {
    name: 'practitioner_get_client',
    role: 'practitioner',
    where: 'server',
    mcp: 'get_customer',
    description: "Get one of the practitioner's own clients: name, contact details, sex, date of birth and whether a Bio-Well card is linked. Needs a client id from practitioner_list_clients or practitioner_find_client.",
    parameters: {
      type: 'object',
      properties: { clientId: { type: 'string', description: 'The client id, as returned by the listing or search tools.' } },
      required: ['clientId'],
    },
    async handler(args, ctx) {
      const clientId = requireString(args, 'clientId', { max: 64 });
      const c = await readMcp(ctx, 'get_customer', { customerId: clientId });
      if (!c || typeof c !== 'object' || c.error) {
        return { found: false, reason: 'That client is not on this practitioner’s list.' };
      }
      // Named explicitly rather than spread: a field they add later should not
      // reach a model context without somebody deciding that it should.
      return {
        found: true,
        ...slimCustomer(c),
        sex: c.sex || '',
        date_of_birth: c.dob || c.birthdate || '',
        phone: c.phone || '',
        city: c.city || '',
      };
    },
  },

  // —— the scan tools ——
  //
  // These are the slow ones. Measured against their staging server: nine to
  // twelve seconds, against about 470 ms for everything above, because their
  // side goes out to Bio-Well for them. The descriptions say so, so the model
  // tells the practitioner it is fetching rather than leaving a silence in the
  // middle of a conversation, and `slow` is published to the page so it can show
  // that it is working.
  {
    name: 'practitioner_client_latest_scan',
    role: 'practitioner',
    where: 'server',
    slow: true,
    mcp: 'get_customer_scan',
    description: "The client's most recent Bio-Well reading: stress, energy, the seven chakras, and the areas furthest out of balance. SLOW — takes about ten seconds, so tell the practitioner you are fetching it before you call it. Needs a client id.",
    parameters: {
      type: 'object',
      properties: { clientId: { type: 'string', description: 'The client id.' } },
      required: ['clientId'],
    },
    async handler(args, ctx) {
      const clientId = requireString(args, 'clientId');
      const out = await readMcp(ctx, 'get_customer_scan', { customerId: clientId });
      const scans = out?.scans || [];
      if (!scans.length) return { found: false, reason: 'No Bio-Well scans are on file for this client.' };
      // Newest first, whatever order their history arrives in.
      const newest = [...scans].sort((a, b) =>
        String(b.scanned_at || '').localeCompare(String(a.scanned_at || '')))[0];
      return {
        found: true,
        client: { id: String(out?.customer?.id ?? clientId), name: out?.customer?.name || '' },
        scans_on_file: scans.length,
        latest: slimScan(newest),
      };
    },
  },
  {
    name: 'practitioner_client_trend',
    role: 'practitioner',
    where: 'server',
    slow: true,
    mcp: 'get_scan_trend',
    description: "How a client has changed over their scan history: the range and latest value for energy and stress, and which areas are worsening or improving, with anything automatically flagged as a concern. Use for 'how has she been', 'is he improving', 'what should I watch'. SLOW — about ten seconds, so say you are looking it up first. Needs a client id.",
    parameters: {
      type: 'object',
      properties: { clientId: { type: 'string', description: 'The client id.' } },
      required: ['clientId'],
    },
    async handler(args, ctx) {
      const clientId = requireString(args, 'clientId');
      // summary_only drops the bulky per-scan series their docs warn about.
      const out = await readMcp(ctx, 'get_scan_trend', { customerId: clientId, summary_only: true });
      const band = (b) => (b ? { lowest: round(b.min), highest: round(b.max),
                                 average: round(b.avg), latest: round(b.latest) } : null);
      const trend = (t) => ({
        area: String(t.category || '').replace(/s$/, ''),
        name: t.name,
        direction: t.direction,
        change: round(t.delta),
        latest: round(t.latest),
        flagged: Boolean(t.flagged),
        reason: t.flagReason || '',
      });
      const flags = (out?.flags || []).map(trend);
      // The whole organTrends array is 39 entries and most of them are quiet.
      // Only the movers are worth a sentence.
      const movers = (out?.organTrends || [])
        .filter((t) => !t.flagged && Math.abs(Number(t.delta) || 0) >= 5)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, TOP_N).map(trend);
      return {
        client: { id: String(out?.customer?.id ?? clientId), name: out?.customer?.name || '' },
        scans_on_file: out?.scanCount ?? 0,
        energy: band(out?.summary?.energy),
        stress: band(out?.summary?.stress),
        flagged: flags,
        other_movements: movers,
      };
    },
  },
  {
    name: 'practitioner_compare_sessions',
    role: 'practitioner',
    where: 'server',
    slow: true,
    mcp: 'compare_protocol_before_after',
    description: "Compare a client's scans before and after a session or protocol: how stress and energy moved, and which areas changed most. Use for 'what changed since last time' or 'did the protocol help'. SLOW — about ten seconds, so say you are checking first. Needs a client id.",
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'The client id.' },
        limit: { type: 'number', description: 'How many before/after pairs to compare. Defaults to 2, most recent first.' },
      },
      required: ['clientId'],
    },
    async handler(args, ctx) {
      const clientId = requireString(args, 'clientId');
      const want = Math.min(Math.max(Number(args?.limit) || 2, 1), 5);
      const out = await readMcp(ctx, 'compare_protocol_before_after', { customerId: clientId, limit: want });
      const pairs = (out?.comparisons || []).slice(0, want).map((c) => ({
        basis: c.source === 'time' ? 'consecutive sessions' : (c.protocol || 'a labelled protocol'),
        from: String(c.before?.date || '').slice(0, 10),
        to: String(c.after?.date || '').slice(0, 10),
        note: c.before?.comment || c.after?.comment || '',
        stress_change: round(c.deltas?.stress, 2),
        energy_change: round(c.deltas?.energy, 2),
        biggest_changes: (c.deltas?.disbalance || []).slice(0, TOP_N).map((d) => ({
          area: String(d.category || '').replace(/s$/, ''),
          name: d.name, before: round(d.before), after: round(d.after), change: round(d.delta),
        })),
      }));
      if (!pairs.length) return { found: false, reason: 'There are not two comparable scans on file for this client yet.' };
      return { found: true, client: { id: String(out?.customer?.id ?? clientId), name: out?.customer?.name || '' },
               comparisons: pairs };
    },
  },

  // —— practice-wide, and fast ——
  {
    name: 'practitioner_flagged_clients',
    role: 'practitioner',
    where: 'server',
    mcp: 'list_flagged_customers',
    description: "Which of the practitioner's clients have concerning readings right now — raised disbalance, rising stress or falling energy. Use for 'who needs attention' or 'anyone I should look at'. Fast.",
    parameters: {
      type: 'object',
      properties: { minSeverity: { type: 'string', description: 'Optional: "elevated" or "high".', enum: ['elevated', 'high'] } },
    },
    async handler(args, ctx) {
      const sev = args?.minSeverity;
      const out = await readMcp(ctx, 'list_flagged_customers',
        sev === 'elevated' || sev === 'high' ? { minSeverity: sev } : {});
      return {
        count: out?.count ?? 0,
        clients: (out?.flaggedCustomers || []).map((f) => ({
          id: String(f.customer?.id ?? ''),
          name: f.customer?.name || '',
          last_scan: String(f.latestScan?.scanned_at || '').slice(0, 10),
          concerns: (f.flags || []).slice(0, TOP_N).map((x) => ({
            area: String(x.category || '').replace(/s$/, ''),
            name: x.name, value: round(x.value), severity: x.severity,
          })),
        })),
      };
    },
  },
  {
    name: 'practitioner_follow_ups',
    role: 'practitioner',
    where: 'server',
    mcp: 'suggest_follow_ups',
    description: "Which clients are due a follow-up, based on their own flagged readings and how often they usually come in. Use for 'who should I book back in' or 'who am I due to see'. Fast. No arguments.",
    parameters: { type: 'object', properties: {} },
    async handler(_args, ctx) {
      const out = await readMcp(ctx, 'suggest_follow_ups');
      return {
        count: out?.count ?? 0,
        suggestions: (out?.suggestions || []).map((sg) => {
          // Their flags repeat the same `type` once per affected area, so the
          // reason is the AREAS, not the type said three times.
          const concerns = (sg.flags || []).slice(0, TOP_N)
            .map((f) => `${f.name} (${f.severity || 'flagged'})`).filter(Boolean);
          const w = sg.suggestedFollowUp;
          return {
            id: String(sg.customer?.id ?? ''),
            name: sg.customer?.name || '',
            concerns,
            last_seen: sg.lastAppointment ? String(sg.lastAppointment).slice(0, 10) : 'no appointment on record',
            usual_gap_days: sg.typicalCadenceDays ?? null,
            suggested_window: w?.start ? `${String(w.start).slice(0, 10)} to ${String(w.end || '').slice(0, 10)}` : '',
          };
        }),
      };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Is this tool allowed for this caller at all? Decided before it is offered. */
export function allowed(tool, ctx) {
  if (!tool) return false;
  if (tool.role === 'practitioner') return Boolean(ctx?.isPractitioner);
  return true;
}

/**
 * The declarations to hand the model, in Gemini's shape, filtered by role.
 *
 * A member who is not a practitioner is not told the practitioner tools exist.
 * That is not only a permission check -- a tool the model can see is a tool it
 * will try, and failing a call it should never have made is a worse answer than
 * not having the option.
 */
export function toolDeclarationsFor(ctx) {
  return TOOLS.filter((t) => allowed(t, ctx)).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Names the PAGE is expected to execute; everything else comes back here. */
/** Tools that take many seconds, so the page can say so rather than look stuck. */
export function slowToolNames(ctx) {
  return TOOLS.filter((t) => allowed(t, ctx) && t.slow).map((t) => t.name);
}

export function clientToolNames(ctx) {
  return TOOLS.filter((t) => allowed(t, ctx) && t.where === 'client').map((t) => t.name);
}

/**
 * Run one server-side tool.
 *
 * `ctx` is built by the caller from the session, never from the model's
 * arguments. A tool that does not exist, is not this caller's to run, or is the
 * page's to execute is refused by name rather than attempted.
 */
export async function runTool(name, args, ctx) {
  const tool = BY_NAME.get(String(name || ''));
  if (!tool) throw Object.assign(new Error('unknown tool'), { code: 'unknown_tool' });
  if (!allowed(tool, ctx)) throw Object.assign(new Error('not permitted'), { code: 'forbidden' });
  if (tool.where !== 'server') {
    throw Object.assign(new Error('that tool is performed by the app'), { code: 'client_tool' });
  }
  return tool.handler(args || {}, ctx);
}
