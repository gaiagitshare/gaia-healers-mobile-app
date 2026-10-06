/**
 * Personal Path V1 routes. Wired from server.js with the server's own helpers
 * (deps), so authorisation uses exactly what the rest of the app uses.
 *
 * Member:
 *   GET  /api/member/path                the member's path (session member only)
 *   POST /api/member/path/event          opened / completed / dismissed + analytics
 * Practitioner (verified OAuth link; ids from the session, never the page):
 *   GET  /api/practitioners/path/options?customer_id=   what they may recommend to THIS client
 *   POST /api/practitioners/path/recommend               confirm one recommendation
 *   POST /api/practitioners/path/revoke                  revoke their own recommendation
 *
 * /api/member/* sits behind the onboarding gate (protectedMemberPath), so a
 * member who has not finished required onboarding never reaches the path: the
 * gate's own screen is their first step. The engine still ranks P-ONBOARD
 * first for any caller that does reach it with onboarding open.
 */
import { buildPath, loadCatalogue, selectableResources, entryById, assistLine } from './personal-path.js';
import { activeForMember, forPractitionerClient, createRecommendation, revokeRecommendation, stateFor, setItemState,
  recordEvent, PATH_EVENTS, cleanText, REASON_MAX, NOTE_MAX, DEFAULT_REASON } from './path-store.js';

/** Fields the page may receive for an item. Internal ranking and record ids of other people never leave. */
function publicItem(i) {
  const out = { key: i.key, id: i.id, title: i.title, stage: i.stage, stage_label: i.stage_label, reason: i.reason || '', state: i.state,
    action: i.action, provenance: { label: i.provenance.label, source_type: i.provenance.source_type }, completion: i.completion };
  for (const k of ['note', 'practitioner_name', 'when', 'session_title', 'progress', 'lock', 'free_alternative']) if (i[k] !== undefined && i[k] !== null && i[k] !== '') out[k] = i[k];
  return out;
}

export function createPathRoutes(deps) {
  const {
    requireSessionMember, sendJson, readJsonBody, linkState, tokenFor, memberReadingsEnabled, memberAllowed, linkStatus,
    recheckAfterDays, memberForPractitionerClient, loadAcademyManifest, loadAcademyProgress, academyOwnedIdsForRequest,
    academyCourseOwned, appointmentsFor, planLevelFor, readMcp, log = () => {},
  } = deps;

  async function signalsFor(req, member, { appointments, recs = [], catalogue }) {
    const cid = String(member.contactId || member.memberId || '');
    const enabled = Boolean(memberReadingsEnabled() && memberAllowed(cid));
    const ls = enabled ? linkStatus(cid) : {};
    const manifest = loadAcademyManifest();
    const progress = (loadAcademyProgress().byContact || {})[cid] || {};
    const { ids } = academyOwnedIdsForRequest(req);
    const courseAccess = {}, courses = [];
    for (const c of manifest.courses || []) {
      const accessible = c.preview === true || academyCourseOwned(c, ids);
      courseAccess[c.id] = accessible;
      const p = progress[c.id];
      if (p) courses.push({ id: c.id, title: c.title, pct: Number(p.pct) || 0, accessible,
        started: (Array.isArray(p.completed) && p.completed.length > 0) || Object.keys(p.pos || {}).length > 0 });
    }
    const needsPlan = recs.some((r) => r.resource?.catalogue_id && entryById(catalogue, r.resource.catalogue_id)?.membership_requirement);
    return {
      readings: { enabled, linked: Boolean(ls.linked), new_reading: Boolean(ls.new_reading), latest_scanned_at: ls.latest_scanned_at || null },
      appointments: appointments || (await appointmentsFor(cid).catch(() => [])),
      courses, courseAccess,
      membership: needsPlan ? { level: await planLevelFor(req, member).catch(() => 'free') } : null,
      progress,
    };
  }

  /** The member's path (also used for Gaia's context line). */
  async function memberPath(req, member, { appointments } = {}) {
    const cid = String(member.contactId || member.memberId || '');
    const catalogue = loadCatalogue();
    const recs = activeForMember(cid);
    const signals = await signalsFor(req, member, { appointments, recs, catalogue });
    // Backend completion: a recommended course the member has finished is complete, whatever the page said.
    for (const r of recs) if (r.resource?.kind === 'course' && (Number(signals.progress[r.resource.id]?.pct) || 0) >= 100) setItemState(cid, `R:${r.id}`, 'completed', 'backend');
    return buildPath(signals, { catalogue, state: stateFor(cid), recheckDays: recheckAfterDays(), practitionerRecs: recs });
  }

  /** The practitioner behind this session: verified link only. */
  function practitionerFor(req, res, origin) {
    const sm = requireSessionMember(req, res, origin); if (!sm) return null;
    const cid = String(sm.contactId || sm.memberId || '');
    const st = linkState(cid);
    const row = st.state === 'connected' ? tokenFor(cid) : null;
    if (!row || !row.practitioner_id) { sendJson(res, 403, { ok: false, error: 'not_a_connected_practitioner' }, origin); return null; }
    return { contactId: cid, practitionerId: String(row.practitioner_id), practitionerName: String(row.practitioner_name || '') };
  }
  /** Their client who is a Gaia member and linked to THEM; anything else looks the same: not found. */
  function clientFor(prac, customerId, res, origin) {
    const memberId = memberForPractitionerClient(prac.practitionerId, customerId);
    if (!memberId) { sendJson(res, 404, { ok: false, error: 'not_a_linked_client' }, origin); return null; }
    return memberId;
  }
  async function servicesFor(prac) {
    const out = await readMcp({ contactId: prac.contactId }, 'list_services');
    return (out?.services || []).map((s) => ({ key: 'svc:' + String(s.id), id: String(s.id), title: String(s.name || '').slice(0, 120),
      description: String(s.description || '').replace(/<[^>]*>/g, '').slice(0, 160), duration: s.duration ?? null, price: s.price ?? null }));
  }
  const recView = (r) => ({ id: r.id, title: r.resource?.title || '', kind: r.resource?.kind || '', member_safe_reason: r.member_safe_reason, note: r.note,
    created_at: r.created_at, revoked_at: r.revoked_at, state: r.revoked_at ? 'revoked' : 'active' });

  async function handle(req, res, url, origin) {
    const p = url.pathname;

    if (p === '/api/member/path' && req.method === 'GET') {
      const sm = requireSessionMember(req, res, origin); if (!sm) return true;
      const path = await memberPath(req, sm);
      sendJson(res, 200, { ok: true, items: path.items.map(publicItem), caught_up: path.caught_up, recheck_after_days: recheckAfterDays() }, origin);
      return true;
    }

    if (p === '/api/member/path/event' && req.method === 'POST') {
      const sm = requireSessionMember(req, res, origin); if (!sm) return true;
      const cid = String(sm.contactId || sm.memberId || '');
      let body = {}; try { body = await readJsonBody(req, 2048); } catch { sendJson(res, 400, { ok: false, error: 'bad_json' }, origin); return true; }
      const event = String(body.event || ''), key = String(body.key || '').slice(0, 80);
      if (!PATH_EVENTS.includes(event)) { sendJson(res, 400, { ok: false, error: 'unknown_event' }, origin); return true; }
      if (key && !/^(P-[A-Z]+(:[A-Za-z0-9:.\-T]+)?|R:rec_[A-Za-z0-9_-]{6,20})$/.test(key)) { sendJson(res, 400, { ok: false, error: 'bad_key' }, origin); return true; }
      let rec = null;
      if (key.startsWith('R:')) { rec = activeForMember(cid).find((r) => `R:${r.id}` === key); if (!rec) { sendJson(res, 404, { ok: false, error: 'not_found' }, origin); return true; } }
      let state = null;
      if (event === 'recommendation_opened' && key) state = setItemState(cid, key, 'opened', 'user');
      if (event === 'recommendation_dismissed' && key) state = setItemState(cid, key, 'dismissed', 'user');
      if (event === 'recommendation_completed') {
        // The member may say they did a practice or saw a service; a course, a
        // reading, a session or a scan is complete only when the server knows it.
        if (!rec || rec.resource?.kind === 'course') { sendJson(res, 409, { ok: false, error: 'completed_by_server_only' }, origin); return true; }
        state = setItemState(cid, key, 'completed', 'user');
      }
      recordEvent(cid, event, { item_id: key || undefined, stage: body.stage, surface: body.surface, items: body.items, level: body.level,
        via: event === 'recommendation_completed' ? 'user' : undefined, route: body.route, source: key.startsWith('R:') ? 'practitioner_manual' : (key ? 'platform_rule' : undefined) });
      sendJson(res, 200, { ok: true, state }, origin);
      return true;
    }

    if (p === '/api/practitioners/path/options' && req.method === 'GET') {
      const prac = practitionerFor(req, res, origin); if (!prac) return true;
      const customerId = String(url.searchParams.get('customer_id') || '').slice(0, 64);
      if (!clientFor(prac, customerId, res, origin)) return true;
      let services = [], servicesError = null;
      try { services = await servicesFor(prac); } catch (e) { servicesError = e.code || 'unavailable'; }
      sendJson(res, 200, { ok: true, services, services_error: servicesError, resources: selectableResources(loadCatalogue()),
        default_reason: DEFAULT_REASON, limits: { reason: REASON_MAX, note: NOTE_MAX },
        recommendations: forPractitionerClient(prac.practitionerId, customerId).map(recView) }, origin);
      return true;
    }

    if (p === '/api/practitioners/path/recommend' && req.method === 'POST') {
      const prac = practitionerFor(req, res, origin); if (!prac) return true;
      let body = {}; try { body = await readJsonBody(req, 4096); } catch { sendJson(res, 400, { ok: false, error: 'bad_json' }, origin); return true; }
      if (body.confirm !== true) { sendJson(res, 400, { ok: false, error: 'confirm_required' }, origin); return true; }
      const customerId = String(body.customer_id || '').slice(0, 64);
      const memberId = clientFor(prac, customerId, res, origin); if (!memberId) return true;
      const reason = cleanText(body.member_safe_reason, REASON_MAX), note = cleanText(body.note, NOTE_MAX);
      if (!reason.ok || !note.ok) { sendJson(res, 400, { ok: false, error: !reason.ok ? `reason_${reason.error}` : `note_${note.error}` }, origin); return true; }
      const key = String(body.resource_key || '');
      const catalogue = loadCatalogue();
      let resource = null;
      if (key.startsWith('cat:')) {
        const r = selectableResources(catalogue).find((x) => x.key === key);
        if (r) resource = { ...r.resource, title: r.title, catalogue_id: r.id };
      } else if (key.startsWith('svc:')) {
        let services = []; try { services = await servicesFor(prac); } catch { sendJson(res, 503, { ok: false, error: 'services_unavailable' }, origin); return true; }
        const s = services.find((x) => x.key === key);
        if (s) resource = { kind: 'service', id: s.id, title: s.title };
      }
      if (!resource) { sendJson(res, 400, { ok: false, error: 'resource_not_selectable' }, origin); return true; }
      const dup = forPractitionerClient(prac.practitionerId, customerId).find((r) => !r.revoked_at && r.resource?.kind === resource.kind && String(r.resource?.id) === String(resource.id));
      if (dup) { sendJson(res, 409, { ok: false, error: 'already_recommended', recommendation: recView(dup) }, origin); return true; }
      const rec = createRecommendation({ practitionerContactId: prac.contactId, practitionerId: prac.practitionerId, practitionerName: prac.practitionerName,
        memberId, customerId, resource, memberSafeReason: reason.text, note: note.text, catalogueVersion: catalogue.version });
      log('recommendation confirmed', { practitioner: prac.practitionerId, kind: resource.kind });
      sendJson(res, 200, { ok: true, recommendation: recView(rec) }, origin);
      return true;
    }

    if (p === '/api/practitioners/path/revoke' && req.method === 'POST') {
      const prac = practitionerFor(req, res, origin); if (!prac) return true;
      let body = {}; try { body = await readJsonBody(req, 1024); } catch { sendJson(res, 400, { ok: false, error: 'bad_json' }, origin); return true; }
      const out = revokeRecommendation(String(body.id || '').slice(0, 40), prac.practitionerId);
      if (!out.ok) { sendJson(res, out.error === 'forbidden' ? 404 : 404, { ok: false, error: 'not_found' }, origin); return true; }   // someone else's looks the same as none
      sendJson(res, 200, { ok: true, recommendation: recView(out.rec) }, origin);
      return true;
    }
    return false;
  }

  /** Gaia's context line for this member (public path fields only). */
  async function assistPathLine(req, member, opts) { try { return assistLine(await memberPath(req, member, opts)); } catch { return ''; } }

  return { handle, memberPath, assistPathLine };
}
