import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const STATIC_GAIA = {
  members: 1233,
  portalUrl: 'https://education.gaiahealers.com',
  event: {
    id: 'elevate-2026',
    name: 'Gaia Healers Elevate 2026',
    date: 'Nov 20-22, 2026',
    venue: 'Rosen Shingle Creek',
    location: 'Orlando, FL',
    source: 'staging-proxy',
    stats: {
      attendees: 0,
      paidMembers: 0,
      checkedIn: 0,
      exhibitors: 0,
      leads: 0,
      checkInRate: 0,
    },
  },
};

function corsHeaders(origin) {
  const allowed = !origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? (origin || '*') : 'null',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Vary': 'Origin',
  };
}

function sendJson(res, status, data, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(JSON.stringify(data, null, 2));
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function getEventSummary() {
  const base = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
  const eventId = process.env.EVENT_MANAGER_EVENT_ID || '';
  if (!base || !eventId) return STATIC_GAIA.event;

  const headers = {};
  if (process.env.EVENT_MANAGER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EVENT_MANAGER_TOKEN}`;
  }

  const event = await fetchJson(`${base}/public/events/${encodeURIComponent(eventId)}`, headers);
  return {
    id: `event-${event.id || eventId}`,
    name: event.name || STATIC_GAIA.event.name,
    date: event.start_date && event.end_date ? `${event.start_date} - ${event.end_date}` : STATIC_GAIA.event.date,
    venue: event.location || STATIC_GAIA.event.venue,
    location: event.location || STATIC_GAIA.event.location,
    source: 'event-manager',
    stats: {
      attendees: event.attendee_count || 0,
      paidMembers: 0,
      checkedIn: event.checked_in_count || 0,
      exhibitors: 0,
      leads: 0,
      checkInRate: event.attendee_count ? Math.round(((event.checked_in_count || 0) / event.attendee_count) * 100) : 0,
    },
  };
}

async function getGhlSummary() {
  const base = (process.env.GHL_API_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.GHL_API_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!base || !token || !locationId) {
    return { configured: false };
  }

  return {
    configured: true,
    locationId,
    apiBaseUrl: base,
    note: 'GHL credentials are configured backend-side. Add normalized reads here after staging auth is approved.',
  };
}

async function bootstrap() {
  const [event, ghl] = await Promise.all([
    getEventSummary().catch((error) => ({ ...STATIC_GAIA.event, source: 'event-manager-error', error: error.message })),
    getGhlSummary().catch((error) => ({ configured: false, error: error.message })),
  ]);

  return {
    ok: true,
    gaia: {
      ...STATIC_GAIA,
      event,
      sync: {
        generatedAt: new Date().toISOString(),
        ghl,
        voice: {
          configured: Boolean(process.env.OPENAI_API_KEY),
          enabled: process.env.GAIA_ASSIST_VOICE_ENABLED === 'true',
        },
      },
    },
  };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/app/bootstrap') {
      sendJson(res, 200, await bootstrap(), origin);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Not found' }, origin);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`Gaia staging proxy listening on :${PORT}`);
});
