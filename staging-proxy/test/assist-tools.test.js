/**
 * GAIA ASSIST TOOLS — what the model may call, and whose data comes back.
 *
 * The tools used to be declared by the browser. That was survivable while they
 * only moved somebody around their own app; it stopped being survivable when one
 * of them reads a client's Bio-Well results. The server decides now, and these
 * are the properties that make that worth anything:
 *
 *   - a member who is not a practitioner is never TOLD the practitioner tools
 *     exist, and is refused if they ask for one anyway
 *   - no handler accepts an identity: not a practitioner id, not a contact id,
 *     not a token, by argument or by any other route
 *   - results are shaped before a model ever sees them
 *
 * The third is not fussiness. get_customer_scan returns 1.6 MB against their
 * staging server, which is around four hundred thousand tokens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const t = await import('../assist-tools.js');
const { TOOLS, allowed, toolDeclarationsFor, clientToolNames, slowToolNames, runTool } = t;

const MEMBER = { contactId: 'C-member', isPractitioner: false };
const PRACTITIONER = { contactId: 'C-prac', isPractitioner: true };

// ── who is offered what ────────────────────────────────────────────────────

test('a member is not even told the practitioner tools exist', () => {
  const names = toolDeclarationsFor(MEMBER).map((d) => d.name);
  assert.ok(names.includes('navigate'), 'the ordinary tools stay');
  assert.ok(names.includes('save_onboarding_step'));
  for (const n of names) {
    assert.ok(!n.startsWith('practitioner_'), `${n} was offered to a plain member`);
  }
});

test('a practitioner gets the member tools as well as their own', () => {
  const names = toolDeclarationsFor(PRACTITIONER).map((d) => d.name);
  assert.ok(names.includes('navigate'), 'a practitioner is still a member');
  assert.ok(names.includes('practitioner_list_clients'));
  assert.ok(names.includes('practitioner_find_client'));
  assert.ok(names.includes('practitioner_get_client'));
  assert.ok(names.length > toolDeclarationsFor(MEMBER).length);
});

test('nobody signed in is offered nothing', () => {
  // A null context is an anonymous visitor, not a member with no tags.
  const names = toolDeclarationsFor(null).map((d) => d.name);
  for (const n of names) assert.ok(!n.startsWith('practitioner_'), `${n} offered anonymously`);
});

test('the page is told only the tools it is expected to perform', () => {
  const client = clientToolNames(PRACTITIONER);
  assert.ok(client.includes('navigate') && client.includes('gaia_lookup'),
    'the page performs all the member tools, not a selection of them');
  for (const n of client) {
    assert.ok(!n.startsWith('practitioner_'),
      'a tool that reads client data must never be handed to the page to run');
  }
});

// ── who may run what ───────────────────────────────────────────────────────

test('a member asking for a practitioner tool by name is refused', async () => {
  for (const n of ['practitioner_list_clients', 'practitioner_find_client', 'practitioner_get_client']) {
    await assert.rejects(() => runTool(n, {}, MEMBER), (e) => e.code === 'forbidden', n);
  }
});

test('an unknown tool is refused by name rather than attempted', async () => {
  await assert.rejects(() => runTool('practitioner_delete_everything', {}, PRACTITIONER),
    (e) => e.code === 'unknown_tool');
  await assert.rejects(() => runTool('', {}, PRACTITIONER), (e) => e.code === 'unknown_tool');
  await assert.rejects(() => runTool(null, {}, PRACTITIONER), (e) => e.code === 'unknown_tool');
});

test('a tool the page performs is not runnable here', async () => {
  await assert.rejects(() => runTool('navigate', { screen: 'today' }, MEMBER),
    (e) => e.code === 'client_tool');
});

test('allowed() is the one rule, and it reads the context not the arguments', () => {
  const prac = TOOLS.find((x) => x.name === 'practitioner_list_clients');
  assert.equal(allowed(prac, PRACTITIONER), true);
  assert.equal(allowed(prac, MEMBER), false);
  assert.equal(allowed(prac, null), false);
  assert.equal(allowed(prac, { contactId: 'x', isPractitioner: 'yes' }), true,
    'truthiness is the test; the caller is responsible for deriving it honestly');
  assert.equal(allowed(undefined, PRACTITIONER), false);
});

// ── identity is never an argument ──────────────────────────────────────────

test('no tool accepts an identity, by any name', () => {
  // The shape of the bug this prevents: get_client(practitioner_id, client_id)
  // where the model decides who it is. Their server would still refuse another
  // practitioner's customer, but we would be asking it to.
  const forbidden = /^(practitioner_?id|practitionerId|contact_?id|contactId|member_?id|memberId|user_?id|userId|token|access_?token|email)$/i;
  for (const tool of TOOLS) {
    for (const key of Object.keys(tool.parameters?.properties || {})) {
      assert.ok(!forbidden.test(key), `${tool.name} takes "${key}" as an argument`);
    }
  }
});

test('every tool declaration is complete enough for a model to use', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description && tool.description.length > 30, `${tool.name} needs a real description`);
    assert.equal(tool.parameters?.type, 'object', `${tool.name} parameters must be an object schema`);
    assert.ok(['client', 'server'].includes(tool.where), `${tool.name} must say where it runs`);
    assert.ok(['member', 'practitioner'].includes(tool.role), `${tool.name} must declare a role`);
    if (tool.where === 'server') assert.equal(typeof tool.handler, 'function', `${tool.name} needs a handler`);
  }
});

test('tool names are unique, or the registry would silently shadow one', () => {
  const names = TOOLS.map((x) => x.name);
  assert.equal(new Set(names).size, names.length);
});

// ── arguments are validated before anything is fetched ─────────────────────

test('a search with no query is refused rather than sent as a blank', async () => {
  await assert.rejects(() => runTool('practitioner_find_client', {}, PRACTITIONER),
    (e) => e.code === 'bad_args');
  await assert.rejects(() => runTool('practitioner_find_client', { query: '   ' }, PRACTITIONER),
    (e) => e.code === 'bad_args');
});

test('an absurdly long argument is refused', async () => {
  await assert.rejects(() => runTool('practitioner_find_client', { query: 'x'.repeat(500) }, PRACTITIONER),
    (e) => e.code === 'bad_args');
  await assert.rejects(() => runTool('practitioner_get_client', { clientId: 'x'.repeat(500) }, PRACTITIONER),
    (e) => e.code === 'bad_args');
});

test('a client id is required, since there is no sensible default', async () => {
  await assert.rejects(() => runTool('practitioner_get_client', {}, PRACTITIONER),
    (e) => e.code === 'bad_args');
});

// ── the shape of what comes back ───────────────────────────────────────────

test('a practitioner who has not connected gets a clear reason, not a crash', async () => {
  // No token is stored for this contact, so the handler should say so plainly
  // enough for the page to offer a Connect button.
  await assert.rejects(() => runTool('practitioner_list_clients', {}, { contactId: 'C-never', isPractitioner: true }),
    (e) => e.code === 'not_connected' || e.code === 'needs_reconnect');
});

test('the declarations carry no handler, no role and no internals', () => {
  for (const d of toolDeclarationsFor(PRACTITIONER)) {
    assert.deepEqual(Object.keys(d).sort(), ['description', 'name', 'parameters'],
      `${d.name} leaks registry internals into the model's view`);
  }
});

// ── the relay must not take the page's word for the tool list ──────────────

test('the relay prefers the server list and an empty one means no tools', async () => {
  const relay = await import('../qwen-voice-relay.js');
  const setup = { setup: { tools: [{ functionDeclarations: [{ name: 'from_the_page', description: 'x', parameters: { type: 'object', properties: {} } }] }] } };

  const served = relay.sessionUpdateFor(setup.setup, {
    instructions: 'S', voice: '',
    tools: [{ name: 'from_the_server', description: 'y', parameters: { type: 'object', properties: {} } }],
  });
  const names = served.session.tools.map((x) => x.name);
  assert.deepEqual(names, ['from_the_server'], 'the page must not be able to add a tool');

  const none = relay.sessionUpdateFor(setup.setup, { instructions: 'S', voice: '', tools: [] });
  assert.deepEqual(none.session.tools, [], 'an empty server list means no tools, not the page\'s list');

  const legacy = relay.sessionUpdateFor(setup.setup, { instructions: 'S', voice: '' });
  assert.deepEqual(legacy.session.tools.map((x) => x.name), ['from_the_page'],
    'a client from before this change still works');
});

test('the ticket carries the tool list, so it cannot be swapped on connect', async () => {
  const relay = await import('../qwen-voice-relay.js');
  relay._resetRelayState();
  const tools = [{ name: 'practitioner_list_clients', description: 'd', parameters: { type: 'object', properties: {} } }];
  const ticket = relay.issueQwenTicket({ instructions: 'S', ip: '1.2.3.4', tools });
  assert.ok(ticket && typeof ticket === 'string');
  // The list travels with the grant rather than arriving over the socket later.
  const src = fs.readFileSync(new URL('../qwen-voice-relay.js', import.meta.url), 'utf8');
  assert.ok(/tickets\.set\(ticket, \{[\s\S]{0,200}?\btools\b/.test(src),
    'the ticket must hold the tools');
  assert.ok(/tools:\s*grant\.tools/.test(src), 'the session must be opened with the grant\'s tools');
});

// ── the route that runs them ───────────────────────────────────────────────

test('the tool route takes identity from the session and never from the body', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // Match the ROUTE, not the endpoint name echoed in the voice-token payload.
  const i = src.indexOf("url.pathname === '/api/assist/tool'");
  assert.ok(i > 0, 'the tool route must exist');
  const block = src.slice(i, i + 1800);
  assert.ok(block.includes('await assistContext(req)'), 'identity must be derived server-side');
  assert.ok(/runTool\(name,\s*body\?\.args,\s*ctx\)/.test(block),
    'the model supplies the name and arguments only; the context is ours');
  assert.ok(!/isPractitioner\s*[:=]\s*body/.test(block), 'the body must not be able to claim a role');
  assert.ok(block.includes("401"), 'an unsigned-in caller is refused');
});

test('assistContext treats an unknown role as a member, never as a practitioner', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function assistContext(req)');
  const block = src.slice(i, i + 1200);
  // Since 4 Oct 2026 the link to Gaia Practitioners (verified by their own
  // profile) is the first word; the GHL tag is a mirror, read only when there
  // is no verified link. Neither path may promote on an outage.
  assert.ok(/let isPractitioner = isLinkedPractitioner\(member\.contactId\);/.test(block), 'the verified link is the source of truth');
  assert.ok(/if \(!isPractitioner\) \{/.test(block), 'the GHL tag is consulted only as a fallback');
  assert.ok(/catch/.test(block) && /role unknown/.test(block),
    'a GHL outage must not silently promote anyone');
});

// ── parity with the page, which is how this broke once ─────────────────────

/** The orb's source when it is checked out beside us, else null. */
function readOrb() {
  for (const rel of ['../../gaia-realtime-voice.js', '../../../gaia-healers-mobile-app-1/gaia-realtime-voice.js']) {
    try { return fs.readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { /* try the next */ }
  }
  return null;
}

test('every tool the page can perform is still declared by the server', () => {
  // The server's list REPLACES the page's. A tool declared in the orb but
  // missing here is a tool the model can no longer call -- and that is not a
  // failure anybody sees, it is Gaia quietly losing an ability. It happened:
  // the first registry declared two of the twelve, which removed gaia_lookup,
  // the one the system prompt tells the model to use for every live fact.
  const orb = readOrb();
  if (orb === null) return;   // deployed proxy: the app source is not checked out beside it
  const i = orb.indexOf('functionDeclarations:');
  if (i < 0) return;          // the orb no longer declares its own; nothing to compare
  let depth = 0, j = orb.indexOf('[', i), start = j;
  do { if (orb[j] === '[') depth += 1; else if (orb[j] === ']') depth -= 1; j += 1; } while (depth && j < orb.length);
  const declared = [...orb.slice(start, j).matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const served = TOOLS.map((t) => t.name);
  const missing = declared.filter((n) => !served.includes(n));
  assert.deepEqual(missing, [], `the page can perform these but the server never offers them: ${missing.join(', ')}`);
});

test('every client-executed tool has somewhere to be executed', () => {
  // The mirror image: a tool the server offers as the page's job, that the page
  // has no handler for, is a call that dead-ends.
  const orb = readOrb();
  if (orb === null) return;
  const i = orb.indexOf('function runToolCall');
  if (i < 0) return;
  const dispatcher = orb.slice(i, i + 2500);
  const unhandled = TOOLS.filter((t) => t.where === 'client')
    .map((t) => t.name)
    .filter((n) => !dispatcher.includes(`case '${n}'`));
  assert.deepEqual(unhandled, [], `the server offers these for the page to run, but it has no handler: ${unhandled.join(', ')}`);
});

test('the page sends tools it does not perform back to the server', () => {
  const orb = readOrb();
  if (orb === null) return;
  assert.ok(/serverToolNames\s*&&\s*!serverToolNames\.includes\(name\)/.test(orb),
    'the dispatcher must route an unhandled name to the server, not answer "not available"');
  assert.ok(/runServerToolCall/.test(orb), 'there must be a server path at all');
  assert.ok(/credentials:\s*'include'/.test(orb.slice(orb.indexOf('runServerToolCall'), orb.indexOf('runServerToolCall') + 900)),
    'the session cookie is what identifies the caller, so it has to be sent');
  const call = orb.slice(orb.indexOf('async function runServerToolCall'), orb.indexOf('async function runServerToolCall') + 900);
  assert.ok(!/contactId|practitioner_?id|token/i.test(call),
    'the page must not put an identity in the request; the cookie carries it');
});

test('a fetched result reaches the model as data, not as "Done."', () => {
  const orb = readOrb();
  if (orb === null) return;
  const i = orb.indexOf('functionResponses');
  const block = orb.slice(i, i + 700);
  assert.ok(/result\.data !== undefined/.test(block),
    'a tool that fetched something must return the something, or the model has nothing to answer from');
});

// ── the scan tools, where the shaping is the whole point ───────────────────

test('the slow tools are named as slow, and the fast ones are not', () => {
  const slow = slowToolNames(PRACTITIONER);
  assert.deepEqual(slow.sort(), [
    'practitioner_client_latest_scan', 'practitioner_client_trend', 'practitioner_compare_sessions',
  ], 'these three go out to Bio-Well and take about ten seconds');
  assert.ok(!slow.includes('practitioner_flagged_clients'), 'that one answers in under a second');
  assert.deepEqual(slowToolNames(MEMBER), [], 'a member has no slow tools because it has none of these');
});

test('a slow tool tells the model to say so before calling it', () => {
  for (const name of slowToolNames(PRACTITIONER)) {
    const d = toolDeclarationsFor(PRACTITIONER).find((x) => x.name === name);
    assert.match(d.description, /SLOW/,
      `${name} must warn the model, or it leaves a ten-second silence mid-conversation`);
  }
});

test('the scan tools take a client id and nothing resembling an identity', () => {
  for (const name of ['practitioner_client_latest_scan', 'practitioner_client_trend', 'practitioner_compare_sessions']) {
    const tool = TOOLS.find((x) => x.name === name);
    const keys = Object.keys(tool.parameters.properties);
    assert.ok(keys.includes('clientId'), `${name} needs a client id`);
    for (const k of keys) {
      assert.ok(!/practitioner|contact|token|member/i.test(k), `${name} takes "${k}"`);
    }
  }
});

test('a missing client id is refused before any ten-second call is made', async () => {
  for (const name of ['practitioner_client_latest_scan', 'practitioner_client_trend', 'practitioner_compare_sessions']) {
    const started = Date.now();
    await assert.rejects(() => runTool(name, {}, PRACTITIONER), (e) => e.code === 'bad_args', name);
    assert.ok(Date.now() - started < 200, `${name} went to the network before validating its arguments`);
  }
});

test('the comparison limit is bounded, whatever the model asks for', () => {
  // Not a security matter -- a limit of 500 would simply make a slow tool
  // slower and return more than anyone reads.
  const src = fs.readFileSync(new URL('../assist-tools.js', import.meta.url), 'utf8');
  const i = src.indexOf("name: 'practitioner_compare_sessions'");
  const block = src.slice(i, i + 1400);
  assert.ok(/Math\.min\(Math\.max\(Number\(args\?\.limit\)/.test(block),
    'the limit must be clamped at both ends');
});

test('scan shaping drops the raw envelope and keeps what is meaningful', () => {
  // get_customer_scan returns 100 scans at ~16 KB each: 1.6 MB, of which most is
  // a JSON-RPC envelope under `data` that means nothing to anybody.
  const src = fs.readFileSync(new URL('../assist-tools.js', import.meta.url), 'utf8');
  const i = src.indexOf('function slimScan');
  const block = src.slice(i, i + 700);
  assert.ok(block.includes('scan.labeled'), 'the labelled readings are the signal');
  assert.ok(!/scan\.data/.test(block), 'the raw envelope must never be forwarded');
  assert.ok(block.includes('most_out_of_balance'), 'the point is which areas are furthest out');
});

test('only the worst few readings travel, not all fifty-one', () => {
  const src = fs.readFileSync(new URL('../assist-tools.js', import.meta.url), 'utf8');
  const i = src.indexOf('function worstDisbalances');
  const block = src.slice(i, i + 600);
  assert.ok(/organs/.test(block) && /meridians/.test(block) && /systems/.test(block),
    'all three groups are candidates');
  assert.ok(/sort\(/.test(block) && /slice\(0, limit\)/.test(block),
    'they must be ranked and cut, or 51 readings reach the model');
});

test('the page is told which tools are slow', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(src.includes('slowTools: slowToolNames(toolCtx)'),
    'without this the orb cannot show it is working through a ten-second wait');
  const orb = readOrb();
  if (orb === null) return;
  assert.ok(/serverSlowTools/.test(orb), 'the page must read it');
  assert.ok(/serverSlowTools\.includes\(name\)/.test(orb), 'and act on it');
});

// ── what a practitioner hears when they ask for their clients ─────────────

test('the client list is capped at 40 names without email, keeps the true count, and points past the cap', async () => {
  const { shapeClientList } = await import('../assist-tools.js');
  const customers = Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, name: `Client ${i}`, email: `c${i}@example.com`, hasBioWellCard: i % 2 === 0 }));
  const r = shapeClientList({ count: 200, customers });
  assert.equal(r.count, 200);
  assert.equal(r.shown, 40);
  assert.equal(r.clients.length, 40);
  assert.deepEqual(Object.keys(r.clients[0]).sort(), ['has_biowell', 'id', 'name'], 'no email in a spoken list');
  assert.equal(r.clients[0].id, '1000');
  assert.match(r.more, /Showing 40 of 200/);
  assert.match(r.more, /practitioner_find_client/);
  assert.ok(JSON.stringify(r).length < 2_600, `a full list is now ${JSON.stringify(r).length} chars (was ~18,800)`);
});

test('a short client list is complete, with no "more" pointer, and an empty one is honest', async () => {
  const { shapeClientList } = await import('../assist-tools.js');
  const small = shapeClientList({ count: 3, customers: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }] });
  assert.equal(small.shown, 3); assert.equal(small.count, 3); assert.equal(small.more, undefined);
  const none = shapeClientList({ customers: [] });
  assert.deepEqual(none, { count: 0, shown: 0, clients: [] });
  assert.deepEqual(shapeClientList(undefined), { count: 0, shown: 0, clients: [] });
});

test('the list tool tells the model about the cap; the find tool still returns email, which a search can need', () => {
  const list = TOOLS.find((t) => t.name === 'practitioner_list_clients');
  assert.match(list.description, /up to 40 clients/);
  assert.match(list.description, /practitioner_find_client/);
  const src = fs.readFileSync(new URL('../assist-tools.js', import.meta.url), 'utf8');
  assert.match(src, /name: 'practitioner_find_client'[\s\S]*?slice\(0, MAX_CUSTOMERS\)\.map\(slimCustomer\)/, 'find keeps the default (email on) shape');
});
