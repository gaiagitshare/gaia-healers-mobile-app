/** Gaia — can this practitioner actually be booked online?
 *
 * The directory shows a "Book" button for every practitioner with a calendar
 * link, but in Nov 2026 about one in four of those calendars could never offer
 * a time (no one assigned in GHL, or a dead link), and neither could the Gaia
 * scan-team calendar the app fell back to. Members tapped Book and met an
 * empty calendar.
 *
 * This checks every booking link on a timer, read-only, and keeps one status
 * per practitioner for the directory to show:
 *   online       the calendar has open times in the next 30 days
 *   full         the calendar works but has no open time in the next 30 days
 *   unavailable  the calendar cannot take a booking (no one assigned, switched
 *                off, or the link is dead)
 *   none         no booking link at all
 *   unknown      not checked yet, or a calendar we cannot see (another
 *                booking service, another GHL account): treated as bookable
 *
 * GHL calls go through the official API with the app's own key (the
 * calendars live in Gaia's location). A timeout, a 429 or a 5xx is no
 * evidence of anything: the previous status is kept.
 */
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['online', 'full', 'unavailable', 'none', 'unknown'];
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LINKS_EVERY_MS = 6 * 60 * 60 * 1000;    // practitioners' links change rarely
const GHL_HOST = /^https:\/\/([a-z0-9-]+\.)*leadconnectorhq\.com\/widget\/bookings?\//i;

let state = { checkedAt: 0, linksAt: 0, scanTeam: 'unknown', byId: {}, links: {}, counts: {} };
let file = '';
let running = false;

export function statusFor(id) { const s = state.byId[String(id)]; return s ? s.status : 'unknown'; }
/** What the directory shows beside the Book button: status, the next open time
 * (only while it is still ahead), how long a session is, and whether the
 * calendar confirms a booking on the spot or the practitioner confirms it. */
export function bookingFor(id, now = Date.now()) {
  const s = state.byId[String(id)];
  if (!s) return { status: 'unknown' };
  const out = { status: s.status };
  const nx = (Array.isArray(s.slots) && s.slots.length ? s.slots : (s.next ? [s.next] : [])).find((t) => Date.parse(t) > now);
  if (nx) out.next = nx;
  if (s.durationMin) out.durationMin = s.durationMin;
  if (typeof s.autoConfirm === 'boolean') out.autoConfirm = s.autoConfirm;
  return out;
}
export function scanTeamStatus() { return state.scanTeam || 'unknown'; }
export function summary() { return { checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null, scanTeam: state.scanTeam, counts: state.counts }; }
/** A Book button leads somewhere only for these. */
export function isBookable(status) { return status === 'online' || status === 'unknown'; }

export function load(filePath) {
  file = filePath || file;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && j.byId) state = Object.assign(state, j); } catch (e) { /* first run */ }
}
function save() {
  if (!file) return;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, file); } catch (e) { /* the in-memory copy still serves */ }
}

/** Which Gaia calendar a widget link points at: /widget/booking/<calendarId> or /widget/bookings/<slug>. */
export function calendarFor(url, calendars) {
  const u = String(url || '');
  if (!GHL_HOST.test(u)) return { ghl: false };
  const byId = u.match(/\/widget\/booking\/([A-Za-z0-9]{10,40})(?:[/?#]|$)/);
  const bySlug = u.match(/\/widget\/bookings\/([^/?#]+)/);
  let cal = null;
  if (byId) cal = calendars.find((c) => c.id === byId[1]) || null;
  else if (bySlug) { const s = decodeURIComponent(bySlug[1]).toLowerCase(); cal = calendars.find((c) => String(c.widgetSlug || c.slug || '').toLowerCase() === s) || null; }
  return { ghl: true, calendar: cal };
}

/** Session length and confirmation mode, from the calendar's own settings. */
export function calendarMeta(cal) {
  const out = {};
  const n = Number(cal && cal.slotDuration);
  if (Number.isFinite(n) && n > 0) out.durationMin = /hour/i.test(String(cal.slotDurationUnit || '')) ? n * 60 : n;
  if (cal && typeof cal.autoConfirm === 'boolean') out.autoConfirm = cal.autoConfirm;
  return out;
}

/** One calendar's status from GHL's own free-slots answer. */
export async function calendarStatus(cal, ghlRequest, now) {
  if (!cal) return null;
  if (cal.isActive === false) return { status: 'unavailable', why: 'switched off' };
  const r = await ghlRequest(`/calendars/${encodeURIComponent(cal.id)}/free-slots`, { startDate: now, endDate: now + WINDOW_MS, timezone: 'UTC' });
  if (!r || !r.status || r.status === 429 || r.status >= 500) return null;           // no evidence; keep what we had
  if (r.status === 200) {
    const j = r.json || {};
    const dayKeys = Object.keys(j).filter((k) => /^\d{4}-\d\d-\d\d$/.test(k) && Array.isArray(j[k] && j[k].slots) && j[k].slots.length);
    const meta = calendarMeta(cal);
    if (!dayKeys.length) return Object.assign({ status: 'full', days: 0 }, meta);
    // The earliest open time still ahead -- GHL already sent it; keeping it lets
    // the directory say "Next: Thu 4:30 pm" instead of only "Books online".
    // The next few, not one: the check runs hourly, and a single time that
    // passed left the practitioner showing none until the next run.
    const upcoming = dayKeys.flatMap((k) => j[k].slots).map((t) => Date.parse(t)).filter((t) => Number.isFinite(t) && t > now).sort((a, b) => a - b).slice(0, 8);
    return Object.assign({ status: 'online', days: dayKeys.length }, upcoming.length ? { next: new Date(upcoming[0]).toISOString(), slots: upcoming.map((t) => new Date(t).toISOString()) } : {}, meta);
  }
  // 400/404/422 ("No users found in the calendar") — this calendar cannot take a booking.
  return { status: 'unavailable', why: String((r.json && r.json.message) || ('http ' + r.status)).slice(0, 80) };
}

/**
 * One full pass. deps:
 *   ghlRequest(path, params) -> { status, json }   official GHL API, the app's key
 *   listCalendars() -> [calendar] | null           GET /calendars/?locationId=
 *   practitionerLinks() -> [{ id, meetingLink }] | null   from gaiapractitioners.com
 *   pageStatus(url) -> http status | 0             for links not in Gaia's location
 *   scanTeamSlug                                    the Gaia scan-team calendar
 */
export async function runOnce(deps, opts = {}) {
  if (running) return summary();
  running = true;
  try {
    const now = opts.now || Date.now();
    const calendars = await deps.listCalendars();
    if (!Array.isArray(calendars)) return summary();                                  // GHL unreachable: keep everything
    if (!state.linksAt || now - state.linksAt > LINKS_EVERY_MS || opts.refreshLinks) {
      const links = await deps.practitionerLinks();
      if (Array.isArray(links) && links.length) { state.links = {}; links.forEach((l) => { state.links[String(l.id)] = String(l.meetingLink || '').trim(); }); state.linksAt = now; }
    }
    const pace = opts.paceMs == null ? 120 : opts.paceMs;
    const seen = new Map();   // the same calendar is checked once per pass
    const check = async (url) => {
      if (!url) return { status: 'none' };
      if (seen.has(url)) return seen.get(url);
      let out;
      const { ghl, calendar } = calendarFor(url, calendars);
      if (!ghl) out = { status: 'unknown', why: 'not a GHL calendar' };
      else if (calendar) { out = await calendarStatus(calendar, deps.ghlRequest, now); if (pace) await new Promise((r) => setTimeout(r, pace)); }
      else { const st = await deps.pageStatus(url); out = st === 404 || st === 410 ? { status: 'unavailable', why: 'link not found' } : { status: 'unknown', why: 'calendar outside Gaia\'s account' }; }
      seen.set(url, out);
      return out;
    };
    const byId = {};
    for (const [id, url] of Object.entries(state.links)) {
      const r = await check(url);
      byId[id] = r ? { status: r.status, days: r.days, why: r.why, at: now, next: r.next, slots: r.slots, durationMin: r.durationMin, autoConfirm: r.autoConfirm }
        : (state.byId[id] || { status: 'unknown', at: now });
    }
    state.byId = byId;
    if (deps.scanTeamSlug) {
      const cal = calendars.find((c) => String(c.widgetSlug || c.slug || '').toLowerCase() === String(deps.scanTeamSlug).toLowerCase());
      const r = cal ? await calendarStatus(cal, deps.ghlRequest, now) : { status: 'unavailable' };
      if (r) state.scanTeam = r.status;
    }
    state.counts = STATUSES.reduce((acc, s) => { acc[s] = Object.values(byId).filter((x) => x.status === s).length; return acc; }, {});
    state.checkedAt = now;
    save();
    return summary();
  } finally { running = false; }
}

/** Test hook. */
export function _reset() { state = { checkedAt: 0, linksAt: 0, scanTeam: 'unknown', byId: {}, links: {}, counts: {} }; file = ''; running = false; }
