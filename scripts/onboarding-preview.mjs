// Local-only, synthetic CRM and session. Never connects to GHL or sends email.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOnboardingStore, FIELD_KEYS } from '../staging-proxy/onboarding-store.js';
import { STEPS, onboardingPath } from '../staging-proxy/gaia-onboarding.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitions = Object.entries(FIELD_KEYS).map(([key, value]) => ({ id: key, fieldKey: 'contact.' + value, model: 'contact' }));
let contact, loggedIn = true, fail = false;
function reset(scenario) {
  loggedIn = scenario !== 'visitor'; fail = false;
  contact = { id: 'preview-contact', firstName: 'Ada', email: 'ada@example.test', tags: scenario === 'complete' ? ['gaia_practitioner_form_complete'] : [], customFields: [] };
  if (scenario === 'resume') contact.customFields = [{ id: 'primary_interests', value: ['Water: I am interested in healing and restructuring our water systems'] }, { id: 'why_join', value: ['For my own healing / consciousness'] }];
}
reset('new');
const store = createOnboardingStore({ locationId: () => 'preview',
  get: async url => url.includes('/locations/') ? { customFields: definitions } : { contact: structuredClone(contact) },
  put: async (_url, body) => { if (fail) return null; for (const field of body.customFields) { const old = contact.customFields.find(f => f.id === field.id); if (old) old.value = field.fieldValue; else contact.customFields.push({ id: field.id, value: field.fieldValue }); } return {}; },
  post: async (_url, body) => { if (body.tags) contact.tags = [...new Set([...contact.tags, ...body.tags])]; return {}; },
});
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (status, body) => { res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); };
  try {
    if (url.pathname === '/__qa/reset') { reset(url.searchParams.get('scenario')); return json(200, { ok: true }); }
    if (url.pathname === '/__qa/fail') { fail = url.searchParams.get('value') === 'true'; return json(200, { ok: true }); }
    if (url.pathname === '/api/assist/onboarding') {
      if (!loggedIn) return json(401, { ok: false });
      if (req.method === 'GET') return json(200, await store.load(contact.id));
      let input = ''; for await (const chunk of req) input += chunk;
      const b = JSON.parse(input); const result = await store.save(contact.id, b.stepKey, b.selections, b.freeText, b.complete, true);
      return json(200, { ok: true, ...result });
    }
    if (url.pathname === '/api/auth/session') return json(200, { ok: true, authenticated: loggedIn, member: loggedIn ? { contactId: contact.id, email: contact.email, displayName: 'Ada' } : null });
    if (url.pathname === '/api/auth/logout') { loggedIn = false; return json(200, { ok: true }); }
    if (url.pathname === '/api/wellness/sky') return json(503, { ok: false });
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') return json(200, { ok: true, configured: true, authenticated: loggedIn, profile: { name: 'Ada' }, courses: [], products: [], plans: [], items: [], communities: [], events: [], notifications: [], owned: [], access: {}, member: { displayName: 'Ada', email: contact.email } });
    const requested = url.pathname === '/' ? 'home.html' : decodeURIComponent(url.pathname).slice(1);
    const filename = path.resolve(root, requested);
    if (!filename.startsWith(root + path.sep)) return json(403, {});
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); res.end(await fs.readFile(filename));
  } catch (e) { if (!res.headersSent) json(e.status || 503, { ok: false, reason: e.reason || 'preview_failed' }); else res.end(); }
}).listen(4178, '127.0.0.1', () => console.log('Synthetic onboarding preview: http://127.0.0.1:4178/home.html?proxy=http://127.0.0.1:4178'));
