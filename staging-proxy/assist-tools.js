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

export const TOOLS = [
  // —— available to everyone, executed by the page ——
  {
    name: 'navigate',
    role: 'member',
    where: 'client',          // the page performs it; there is nothing to run here
    description: 'Navigate the member to a screen in the Gaia Healers app. Call this whenever the member asks to open, go to, show, or see a specific screen, tab, or feature.',
    parameters: {
      type: 'object',
      properties: {
        screen: { type: 'string', description: 'today=Home, academy=Courses, community=Community, events, bookings, inbox, directory=Find a Healer, store, profile, wellness=Energy.',
                  enum: ['today', 'academy', 'community', 'events', 'bookings', 'inbox', 'directory', 'store', 'profile', 'wellness'] },
        tab: { type: 'string', description: 'Optional tab within the screen.' },
        tool: { type: 'string', description: 'Optional Energy tool to open on the wellness screen.',
                enum: ['pulse', 'breath', 'numerology', 'sky', 'colour', 'chakra', 'match', 'cosmic', 'moon'] },
      },
      required: ['screen'],
    },
  },
  {
    name: 'save_onboarding_step',
    role: 'member',
    where: 'client',
    description: 'Record ONE step of the getting-to-know-you survey for the signed-in member. Call this right after the member answers each step, passing the EXACT option label(s) they chose.',
    parameters: {
      type: 'object',
      properties: {
        stepKey: { type: 'string', description: 'The step key, e.g. primary_interests, why_join, water, final_notes.' },
        selections: { type: 'array', items: { type: 'string' }, description: 'The exact option label(s) chosen.' },
        freeText: { type: 'string', description: 'Optional free-text answer.' },
        complete: { type: 'boolean', description: 'True only on the final step.' },
      },
      required: ['stepKey'],
    },
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
