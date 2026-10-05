import { readingSeries, recentAverage } from './reading-history.js';
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
import { practitionersConfig, validAccessToken, mcpCall, unwrapMcp, linkState } from './practitioners-oauth.js';

const MAX_QUERY = 120;
const MAX_CUSTOMERS = 200;       // a search is already narrow
const MAX_LISTED_CLIENTS = 40;   // the whole list: what a spoken session can carry (owner, 3 Oct 2026)

/** A customer, reduced to what a practitioner's question actually needs. */
function slimCustomer(c = {}, { email = true } = {}) {
  const slim = {
    id: String(c.id ?? ''),
    name: c.name || '',
    has_biowell: Boolean(c.hasBioWellCard),
  };
  if (email) slim.email = c.email || '';
  return slim;
}

/**
 * The list a practitioner hears. With 200 clients the full list was 5,451
 * tokens, and in voice it is re-processed on every later reply of the
 * session. A name resolves to an id; an email never does in speech. So: at
 * most MAX_LISTED_CLIENTS names, no email, the true count, and a pointer to
 * practitioner_find_client for anyone not shown.
 */
export function shapeClientList(out = {}) {
  const all = Array.isArray(out?.customers) ? out.customers : [];
  const count = Number.isFinite(Number(out?.count)) && out?.count !== null && out?.count !== undefined ? Number(out.count) : all.length;
  const clients = all.slice(0, MAX_LISTED_CLIENTS).map((c) => slimCustomer(c, { email: false }));
  const result = { count, shown: clients.length, clients };
  if (count > clients.length) result.more = `Showing ${clients.length} of ${count}. For anyone not listed, use practitioner_find_client with their name.`;
  return result;
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
  const state = linkState(ctx.contactId).state;
  if (state !== 'connected') throw Object.assign(new Error('practitioner link is not authorized'), { code: state });
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

/**
 * SCAN NARRATION (HIPAA gap, 4 Oct 2026). The scan tools fetch a client's
 * Bio-Well readings for the Practice screen -- and, through the same result,
 * for the model to say aloud. The model is a third-party provider (Qwen for
 * voice, Gemini for text) without a BAA, so until one exists the model is
 * given only that the reading is on screen; the page keeps the full card.
 * GAIA_SCAN_NARRATION=on restores the old behaviour once a BAA-covered
 * provider is in place.
 */
export const SCAN_TOOLS = Object.freeze(['practitioner_client_latest_scan', 'practitioner_client_trend', 'practitioner_compare_sessions']);
export function scanNarrationEnabled(env = process.env) { return env.GAIA_SCAN_NARRATION === 'on'; }
/** What the MODEL is given for a tool result; the page always gets the full result. */
export function modelView(name, result, env = process.env) {
  if (!SCAN_TOOLS.includes(name) || scanNarrationEnabled(env) || !result || typeof result !== 'object') return result;
  if (result.found === false) return result;
  return {
    opened: true,
    client: result.client || null,
    scans_on_file: result.scans_on_file ?? null,
    note: 'The reading is now showing on the practitioner\'s screen. Say that it is up and offer to go through it with them. Do not read out, estimate or summarise any values: they are on screen, not in this reply.',
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
    description: 'Navigate the member to a screen in the Gaia Healers app. Call this whenever the member asks to open, go to, show, or see a specific screen, tab, or feature.',
    parameters: {
      type: 'object',
      properties: {
        screen: { type: 'string', description: 'today=Home (dashboard), daily=Today (daily energy check, today\'s sky, readings shortcut, next booking), academy=Courses, community=Community, events, bookings, inbox, directory=Find a Healer, store, profile, wellness=Energy.',
                  enum: ['today', 'daily', 'academy', 'community', 'events', 'bookings', 'inbox', 'directory', 'store', 'profile', 'wellness'] },
        tab: { type: 'string', description: 'Optional tab within the screen.' },
        tool: { type: 'string', description: 'Optional Energy tool to open on the wellness screen.',
                enum: ['pulse', 'breath', 'numerology', 'sky', 'colour', 'chakra', 'match', 'cosmic', 'moon'] },
        section: { type: 'string', description: 'Optional section of the screen to scroll to: "readings" on profile = the member\'s own Bio-Well readings (My readings).' },
      },
      required: ['screen'],
    },
    /**
     * A practitioner gets one more destination and two more arguments.
     *
     * `client` must be an id this practitioner's own tools returned. That is not
     * enforced by hope: opening a client fetches it with their token, and their
     * server answers "not owned by this practitioner" for anything that is not
     * theirs -- tested against eight ids that were not. A guessed id therefore
     * reaches a refusal, never data.
     */
    declare(ctx) {
      if (!ctx?.isPractitioner) return this;
      return {
        description: this.description
          + ' For a PRACTITIONER this also opens the Practice screen (inside You): pass screen="practice", with a client id to open one of their clients. Use it only when they ask to be taken somewhere. It moves the screen and returns no data, so it can never answer a question: anything about a client or a reading goes to the matching practitioner_ tool, which opens the same card itself and is the only thing that returns the numbers. After it, say one short sentence and do not list what is already visible.',
        parameters: {
          type: 'object',
          properties: {
            screen: { type: 'string', description: 'today=Home (dashboard), daily=Today (daily energy check, today\'s sky, readings shortcut, next booking), academy=Courses, community=Community, events, bookings, inbox, directory=Find a Healer, store, profile, wellness=Energy, practice=your clients and their readings.',
                      enum: ['today', 'daily', 'academy', 'community', 'events', 'bookings', 'inbox', 'directory', 'store', 'profile', 'wellness', 'practice'] },
            tab: { type: 'string', description: 'Optional tab within the screen.' },
            tool: { type: 'string', description: 'Optional Energy tool to open on the wellness screen.',
                    enum: ['pulse', 'breath', 'numerology', 'sky', 'colour', 'chakra', 'match', 'cosmic', 'moon'] },
            client: { type: 'string', description: 'With screen="practice": the client id to open, exactly as returned by practitioner_list_clients, practitioner_find_client, practitioner_flagged_clients or practitioner_follow_ups. Never invent one.' },
            open: { type: 'string', description: 'With a client: which result card to open. latest=their most recent Bio-Well reading, trend=how they have changed, compare=before and after a session. Each takes about ten seconds to load, and the screen shows the waiting state.',
                    enum: ['latest', 'trend', 'compare'] },
            section: { type: 'string', description: 'With screen="practice" and NO client: which part of the Practice screen to show. attention=clients with concerning readings, followups=clients due a follow-up, clients=the full list. With screen="profile": readings=the member\'s own Bio-Well readings (My readings).',
                       enum: ['attention', 'followups', 'clients', 'readings'] },
          },
          required: ['screen'],
        },
      };
    },
  },
  {
    role: 'member',
    where: 'client',
    // Only while the profile journey is unfinished. That is the 'onboarding'
    // state, OR any session whose prompt carries the survey script (a 'member'
    // whose profile still reads NOT DONE) -- the prompt tells the model to call
    // this, so it must be offered whenever the prompt says so.
    offeredIn: ['onboarding'],
    offeredWithSurvey: true,

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
    // Needs a signed-in member; a visitor's call can only fail (/api/assist/memory -> not_signed_in).
    offeredIn: ['member', 'practitioner', 'onboarding'],

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
    // Only for someone who is signed out; its own description says not to call it otherwise.
    offeredIn: ['visitor'],

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
    description: "List the practitioner's own clients. Use when they ask to see their clients, patients or customers. Returns the total count and up to 40 clients (id, name, whether a Bio-Well card is linked); for a specific person, or anyone beyond the first 40, use practitioner_find_client. Takes no arguments — whose clients these are is already known.",
    parameters: { type: 'object', properties: {} },
    async handler(_args, ctx) {
      return shapeClientList(await readMcp(ctx, 'list_customers'));
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
    description: "The client's most recent Bio-Well reading: stress, energy, the seven chakras, and the areas furthest out of balance. SLOW — about ten seconds; the card opens and shows the wait by itself, so call it rather than announcing it. Never say you are fetching it without calling it in the same turn. Needs a client id.",
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
    description: "How a client has changed over their scan history: the range and latest value for energy and stress, and which areas are worsening or improving, with anything automatically flagged as a concern. Use for 'how has she been', 'is he improving', 'what should I watch'. SLOW — about ten seconds; the card opens and shows the wait by itself, so call it rather than announcing it. Never say you are fetching it without calling it in the same turn. Needs a client id.",
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
    description: "Compare a client's scans before and after a session or protocol: how stress and energy moved, and which areas changed most. Use for 'what changed since last time' or 'did the protocol help'. SLOW — about ten seconds; the card opens and shows the wait by itself, so call it rather than announcing it. Never say you are fetching it without calling it in the same turn. Needs a client id.",
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'The client id.' },
        limit: { type: 'number', description: 'How many before/after pairs to compare. Defaults to 2, most recent first.' },
        selectScans: { type: 'boolean', description: 'Include dated energy/stress history for manual scan selection in the Practice screen.' },
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
      let series = [], history_unavailable = false;
      if (args?.selectScans === true) {
        try {
          const history = await readMcp(ctx, 'get_customer_scan', { customerId: clientId });
          series = readingSeries((history?.scans || []).map(scan => ({
            ...scan, energy: scan.values?.energy ?? scan.labeled?.energy,
            stress: scan.values?.stress ?? scan.labeled?.stress,
          })));
        } catch { history_unavailable = true; }
      }
      if (!pairs.length && series.length < 2) return { found: false, history_unavailable, reason: history_unavailable ? 'Scan history could not be loaded. Try again.' : 'There are not two comparable scans on file for this client yet.' };
      return { found: true, client: { id: String(out?.customer?.id ?? clientId), name: out?.customer?.name || '' },
               comparisons: pairs, series, average_recent: recentAverage(series), history_unavailable };
    },
  },

  {
    name: 'practitioner_client_files',
    role: 'practitioner',
    where: 'server',
    mcp: 'get_customer_files',
    description: "List the files on a client's record — scans, PDFs and the like. Fast. Returns an empty list today: their platform exposes the listing but not the files themselves.",
    parameters: {
      type: 'object',
      properties: { clientId: { type: 'string', description: 'The client id.' } },
      required: ['clientId'],
    },
    async handler(args, ctx) {
      const clientId = requireString(args, 'clientId');
      const out = await readMcp(ctx, 'get_customer_files', { customerId: clientId });
      return {
        count: out?.count ?? 0,
        // Nothing retrieves a file, so a name and a date are all that can
        // honestly be offered. No download link is built that cannot work.
        files: (out?.files || []).slice(0, 50).map((f) => ({
          name: f.name || f.filename || 'File',
          kind: f.type || f.mime || '',
          added: String(f.created_at || f.uploaded_at || '').slice(0, 10),
        })),
      };
    },
  },

  {
    name: 'practitioner_suggested_services',
    role: 'practitioner',
    where: 'server',
    description: "Which of the practitioner's OWN services address what a client's readings show. Use when they ask what to do about a client, or what to offer them. Fast.",
    parameters: {
      type: 'object',
      properties: { clientId: { type: 'string', description: 'The client id.' } },
      required: ['clientId'],
    },
    async handler(args, ctx) {
      const clientId = requireString(args, 'clientId');
      // Built from the two FAST calls, not from the trend. list_flagged_customers
      // already carries each flagged client's concerns by name, and services carry
      // the same vocabulary -- so this answers in about a second instead of the
      // ten the trend would cost, and it is the answer a practitioner actually
      // wants: not "what is wrong" but "what do I do about it".
      const [flagged, services] = await Promise.all([
        readMcp(ctx, 'list_flagged_customers'),
        readMcp(ctx, 'list_services'),
      ]);
      const row = (flagged?.flaggedCustomers || [])
        .find((f) => String(f.customer?.id) === String(clientId));
      const concerns = (row?.flags || []).map((f) => ({
        name: String(f.name || ''), area: String(f.category || '').replace(/s$/, ''),
        value: round(f.value), severity: f.severity || '',
      })).filter((c) => c.name);
      if (!concerns.length) return { concerns: [], services: [], note: 'Nothing is currently flagged for this client.' };

      const wanted = new Set(concerns.map((c) => c.name.toLowerCase()));
      const matches = (services?.services || []).map((sv) => {
        const covers = String(sv.attributes || '').split(',')
          .map((a) => a.trim()).filter((a) => wanted.has(a.toLowerCase()));
        return { id: String(sv.id ?? ''), name: sv.name || '', price: sv.price ?? null,
                 duration: sv.duration ?? null, covers: [...new Set(covers)] };
      }).filter((sv) => sv.covers.length)
        .sort((a, b) => b.covers.length - a.covers.length);
      return {
        concerns,
        services: matches,
        // Said plainly, because "no matches" is a real answer here rather than a
        // failure: it means nothing they offer addresses what the scan shows.
        note: matches.length ? '' : 'None of your services list these areas.',
      };
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
 * Is it worth OFFERING this tool to this session? Separate from permission on
 * purpose: `allowed` decides what may run and is unchanged; this only stops the
 * model being handed actions that cannot succeed for who it is talking to.
 *
 * A visitor was offered remember_member and save_onboarding_step; a finished
 * member was offered sign_in and save_onboarding_step. None of those can do
 * anything for them, so each is a wrong option the model may pick -- and ~450
 * to ~550 tokens re-sent on every reply.
 *
 * When the session's state is not known (no `state` on the context, or GHL was
 * unreachable), EVERY allowed tool is offered, exactly as before. Being unsure
 * must never cost someone an action they need.
 */
export function offered(tool, ctx) {
  if (!allowed(tool, ctx)) return false;
  if (!Array.isArray(tool.offeredIn)) return true;
  if (tool.offeredWithSurvey && ctx?.surveyActive) return true;
  const state = ctx ? ctx.state : 'visitor';
  if (!state || state === 'unavailable') return true;
  return tool.offeredIn.includes(state);
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
  return TOOLS.filter((t) => offered(t, ctx)).map((t) => {
    // A tool may describe itself differently to different roles. navigate is the
    // only one that does: a practitioner can be sent to a client's readings, and
    // a member who has no Practice screen should not be offered a destination
    // that does not exist for them.
    const d = typeof t.declare === 'function' ? t.declare(ctx) : t;
    return { name: t.name, description: d.description, parameters: d.parameters };
  });
}

/** Names the PAGE is expected to execute; everything else comes back here. */
/** Tools that take many seconds, so the page can say so rather than look stuck. */
export function slowToolNames(ctx) {
  return TOOLS.filter((t) => offered(t, ctx) && t.slow).map((t) => t.name);
}

export function clientToolNames(ctx) {
  return TOOLS.filter((t) => offered(t, ctx) && t.where === 'client').map((t) => t.name);
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
