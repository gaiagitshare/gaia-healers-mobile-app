/**
 * GAIA ASSIST — the live-facts lookup must not answer with noise.
 *
 * The system prompt tells the model to use ONLY what this lookup returns for
 * prices, counts and names, and never to invent others. That makes the lookup's
 * PRECISION a correctness property, not a nicety: hand it six arbitrary
 * products and the model will dutifully offer them.
 *
 * It did. Scoring split the question on whitespace, kept every word over two
 * characters, and matched with indexOf — so "the" was a wildcard, and "well"
 * matched every product in a WELLNESS store. Almost any question returned six
 * unrelated products presented as the relevant facts.
 *
 * These run against the live proxy, and skip where there is none.
 */
import assert from 'node:assert';
import { apiBase as BASE, liveTest } from './_live-env.js';

const look = async (query) => {
  const r = await fetch(`${BASE}/api/assist/lookup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  assert.strictEqual(r.status, 200, `lookup returned ${r.status}`);
  return r.json();
};

liveTest('stop words are not search terms', async () => {
  const { data } = await look('what is the price');
  assert.ok(!data.terms.includes('the'), `"the" survived as a term: ${data.terms}`);
  assert.ok(!data.terms.includes('what'), `"what" survived as a term: ${data.terms}`);
  assert.deepStrictEqual(data.terms, ['price'], `only the meaningful word should remain: ${data.terms}`);
});

liveTest('a word must match a WORD, not a substring', async () => {
  // The trap: this is a wellness store, so "well" is inside a great many
  // product titles that have nothing to do with Bio-Well.
  const { data } = await look('well');
  for (const p of data.store || []) {
    assert.match(p.title.toLowerCase().replace(/[-_/]+/g, ' '), /(^|[^a-z0-9])well([^a-z0-9]|$)/,
      `"${p.title}" matched the term "well" only as a substring`);
  }
});

liveTest('a question about nothing we sell returns nothing, not a consolation list', async () => {
  const { summary } = await look('do you sell the rasha');
  assert.ok(!/Store products:/.test(summary || ''),
    `offered products for something we do not stock: ${String(summary).slice(0, 160)}`);
});

liveTest('counts are answered with the real number', async () => {
  const practitioners = await look('how many practitioners are in the directory');
  assert.match(practitioners.summary || '', /\d+ practitioners/,
    `no practitioner count came back: ${String(practitioners.summary).slice(0, 120)}`);
  assert.ok(practitioners.data.practitionerTotal > 0, 'the directory reported zero practitioners');

  const courses = await look('what courses do you have');
  assert.match(courses.summary || '', /Courses/,
    `"what courses do you have" answered with nothing: ${String(courses.summary).slice(0, 120)}`);
});

liveTest('a place in the question finds practitioners in that place', async () => {
  const { data } = await look('is there a practitioner near Orlando');
  const named = (data.practitioners || []).map((p) => `${p.name} ${p.location}`.toLowerCase());
  assert.ok(named.length > 0, 'no practitioners returned for a city we have several in');
  assert.ok(named.some((n) => n.includes('orlando')), `none of ${named.length} results is in Orlando`);
});

liveTest('a price question leads with the price, not with the conference', async () => {
  // Every lookup carries the current event, so whatever is listed FIRST is what
  // the model reaches for. "how much" was missing from the ordering rules while
  // being present in the gate, so the commonest phrasing of a price question
  // answered with the conference and buried the product fourth.
  const { summary, data } = await look('how much is the bio-well');
  assert.ok((data.store || []).length > 0, 'no products matched a question about a product we sell');
  assert.ok(String(summary).startsWith('Store products:'),
    `a price question did not lead with products: ${String(summary).slice(0, 120)}`);
});

liveTest('the event is known even from a cold cache, and leads when asked about', async () => {
  const { summary, data } = await look('when and where is the conference');
  assert.ok(data.event && data.event.name, 'the assistant does not know an event exists');
  assert.ok(String(summary).startsWith('Current event:'),
    `a question about the conference did not lead with it: ${String(summary).slice(0, 120)}`);
  assert.ok(data.event.venue, 'the event came back with no venue');
});
