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
const { TOOLS, allowed, toolDeclarationsFor, clientToolNames, runTool } = t;

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
  assert.deepEqual(client.sort(), ['navigate', 'save_onboarding_step']);
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
  assert.ok(/let isPractitioner = false/.test(block), 'the default must be false');
  assert.ok(/catch/.test(block) && /role unknown/.test(block),
    'a GHL outage must not silently promote anyone');
});
