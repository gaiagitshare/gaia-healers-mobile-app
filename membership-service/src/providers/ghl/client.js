/**
 * GHL (LeadConnector v2) contact client for the membership mirror.
 *
 * Same conventions as staging-proxy/server.js (ghlHeaders / ghlPost /
 * ghlLiveContactsByEmail): base https://services.leadconnectorhq.com,
 * `Authorization: Bearer`, `Version: 2021-07-28`, contact search by free-text
 * query then an EXACT email match against the main and additional emails.
 *
 * Read-only towards GHL billing, structurally: the client only knows five
 * contact routes, and any other path (payments, subscriptions, invoices,
 * orders, products, prices, …) is refused before a request is built. This
 * adapter can never create, change or cancel a GHL subscription.
 */
import { createHttpClient } from '../http.js';
import { MembershipError, fail } from '../../errors.js';

export const GHL_API_BASE = 'https://services.leadconnectorhq.com';
export const GHL_API_VERSION = '2021-07-28';

const ID = '[A-Za-z0-9_-]{1,64}';
const ROUTES = [
  ['POST', new RegExp('^/contacts/search$')],
  ['GET', new RegExp(`^/contacts/${ID}$`)],
  ['PUT', new RegExp(`^/contacts/${ID}$`)],
  ['POST', new RegExp(`^/contacts/${ID}/tags$`)],
  ['DELETE', new RegExp(`^/contacts/${ID}/tags$`)],
];

export function guardGhlPath(method, path) {
  if (!ROUTES.some(([m, re]) => m === method && re.test(path))) {
    throw new MembershipError('FORBIDDEN', `GHL ${method} ${path.split('?')[0]} is outside the membership mirror (contacts only; billing is read-only)`);
  }
}

const contactId = (id) => { if (typeof id !== 'string' || !new RegExp(`^${ID}$`).test(id)) fail('INVALID_INPUT', 'invalid GHL contact id'); return id; };
const normEmail = (e) => String(e || '').trim().toLowerCase();

export function createGhlClient({ token, locationId, fetch, baseUrl = GHL_API_BASE, version = GHL_API_VERSION, retry, sleep, random, maxCandidates = 10 } = {}) {
  if (!token) throw new MembershipError('INVALID_INPUT', 'GHL token is required');
  if (!locationId) throw new MembershipError('INVALID_INPUT', 'GHL locationId is required');
  const request = createHttpClient({
    provider: 'ghl', baseUrl, fetch, retry, sleep, random, guardPath: guardGhlPath,
    headers: { Authorization: `Bearer ${token}`, Version: version },
  });
  const unwrap = (r) => r?.contact || r;

  return Object.freeze({
    async getContact(id) { return unwrap(await request('GET', `/contacts/${contactId(id)}`)); },

    /** Every contact whose main or additional email is EXACTLY this address. Fuzzy hits are dropped. */
    async findContactsByEmail(email) {
      const e = normEmail(email);
      if (!e || !e.includes('@')) fail('INVALID_INPUT', 'email required');
      const r = await request('POST', '/contacts/search', { json: { locationId, page: 1, pageLimit: 20, query: e } });
      const hits = (r?.contacts || r?.data?.contacts || r?.data || []).filter((h) => h && h.id).slice(0, maxCandidates);
      const out = [];
      for (const hit of hits) {
        let c;
        try { c = unwrap(await request('GET', `/contacts/${contactId(String(hit.id))}`)); } catch (err) { if (err.code === 'NOT_FOUND') continue; throw err; }
        const extra = (Array.isArray(c?.additionalEmails) ? c.additionalEmails : []).map((x) => normEmail(x && typeof x === 'object' ? x.email : x));
        if (normEmail(c?.email) === e || extra.includes(e)) out.push({ ...c, id: c.id || hit.id });
      }
      return out;
    },

    async addTags(id, tags) { if (tags.length) await request('POST', `/contacts/${contactId(id)}/tags`, { json: { tags } }); },
    async removeTags(id, tags) { if (tags.length) await request('DELETE', `/contacts/${contactId(id)}/tags`, { json: { tags } }); },
    async updateCustomFields(id, fields) {
      if (fields.length) await request('PUT', `/contacts/${contactId(id)}`, { json: { customFields: fields.map((f) => ({ id: f.id, field_value: f.field_value })) } });
    },
  });
}
