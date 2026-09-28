/**
 * GAIA ASSIST — the streaming path must know every provider the blocking one does.
 *
 * ASSIST_PROVIDER_ORDER is one list, used by two dispatchers. callChatProvider
 * special-cases Gemini because its API is not OpenAI-shaped; streamChatProvider
 * did not, and providerConfig() has no Gemini entry -- so with an order of
 * "gemini,groq" every STREAMED answer skipped the configured first choice as an
 * "unknown-provider" and quietly came from the fallback instead. Nothing failed
 * loudly; the assistant simply stopped being the model it was configured to be.
 *
 * This reads the source rather than the network: the invariant is that the two
 * dispatchers handle the same set of providers, and that is a property of the
 * code, not of anyone's API key or balance.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'server.js'), 'utf8');

function bodyOf(name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `${name} not found in server.js`);
  // Far enough to cover the dispatch at the top of either function.
  return src.slice(start, start + 1200);
}

// Providers each dispatcher special-cases before falling back to providerConfig().
const special = (body) => new Set(
  [...body.matchAll(/provider === '([a-z0-9_-]+)'/g)].map((m) => m[1]));

const blocking = special(bodyOf('callChatProvider'));
const streaming = special(bodyOf('streamChatProvider'));

assert.ok(blocking.size > 0, 'expected callChatProvider to special-case at least one provider');

const missing = [...blocking].filter((p) => !streaming.has(p));
assert.deepStrictEqual(
  missing, [],
  `streamChatProvider cannot handle ${missing.join(', ')} — a streamed reply will silently `
  + 'fall through to the next provider in ASSIST_PROVIDER_ORDER');

// The configured order must be answerable by BOTH paths: a name that neither
// providerConfig() nor a special case knows is a silent skip.
const configured = (process.env.ASSIST_PROVIDER_ORDER || 'gemini,groq')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const known = new Set([...streaming]);
for (const m of src.matchAll(/^\s{4}([a-z0-9_]+): \{\s*$/gm)) known.add(m[1]);
const unknown = configured.filter((p) => !known.has(p));
assert.deepStrictEqual(
  unknown, [],
  `ASSIST_PROVIDER_ORDER names ${unknown.join(', ')}, which no dispatcher handles`);

// An empty answer is not an answer: both stream paths must hand over rather
// than report success with nothing in it.
const streamStart = Math.min(...['async function streamGeminiChat(', 'async function streamChatProvider(']
  .map((n) => src.indexOf(n)).filter((i) => i > -1));
const streamBody = src.slice(streamStart, src.indexOf('async function callAssistProviders('));
assert.ok(
  (streamBody.match(/reason: 'empty-reply'/g) || []).length >= 2,
  'a provider that streams no text must be skipped so the next one is tried, '
  + 'in both the Gemini and the OpenAI-shaped stream paths');

console.log('assist-provider-parity: ok');
console.log('  blocking dispatcher handles :', [...blocking].join(', '));
console.log('  streaming dispatcher handles:', [...streaming].join(', '));
console.log('  configured order            :', configured.join(', '));
