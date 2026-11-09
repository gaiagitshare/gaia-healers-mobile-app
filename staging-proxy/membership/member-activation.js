/**
 * Profile activation and password sign-in (9 Nov 2026).
 *
 * Badge QR -> 6-digit code -> create password -> signed in, into the SAME
 * member session the email link creates. There is no second account system:
 * the Event Manager keeps only a bcrypt hash against the person's existing
 * Gaia profile (member card), and everything else is the existing identity.
 *
 *   POST /api/activate/start     { token }                 -> what the badge page offers; sends the email code
 *   POST /api/activate/verify    { token, code }           -> { permit }   (email code or help-desk code)
 *   POST /api/activate/complete  { token, permit, password } -> session
 *   POST /api/activate/login     { token, password }       -> session    (returning person on the badge page)
 *   POST /api/auth/password/login  { email, password }     -> session
 *   POST /api/auth/password/forgot { email }               -> always the same answer
 *   POST /api/auth/password/reset  { email, code, password } -> session
 *
 * Codes are delivered only by the existing GHL email route, only to the email
 * already on the profile, and are never returned to the browser or logged.
 * Passwordless email sign-in is untouched.
 */

import crypto from 'node:crypto';

const LIMITS = { start: [5, 15], verify: [12, 15], login: [10, 15], forgot: [5, 15] };   // [count, minutes]

export function createActivation(deps) {
  const { readJsonBody, sendJson, buildSetCookie, signTokenPayload, createMemberSession,
          resolveMemberRecord, normalizeMemberIdentity, ghlSendEmail, firstNonEmptyString } = deps;
  const hits = new Map();

  function ipOf(req) {
    return firstNonEmptyString(req.headers['cf-connecting-ip'], String(req.headers['x-forwarded-for'] || '').split(',')[0],
      req.socket?.remoteAddress, 'unknown');
  }

  function limited(kind, req, key) {
    const [max, mins] = LIMITS[kind];
    const k = crypto.createHash('sha256').update(kind + '|' + ipOf(req) + '|' + String(key || '')).digest('hex');
    const cutoff = Date.now() - mins * 60000;
    const list = (hits.get(k) || []).filter((t) => t > cutoff);
    list.push(Date.now());
    hits.set(k, list);
    return list.length > max;
  }

  async function em(path, body) {
    const base = (process.env.EVENT_MANAGER_BASE_URL || '').replace(/\/+$/, '');
    const token = (process.env.IDENTITY_SERVICE_TOKEN || '').trim();
    if (!base || !token) return { ok: false, reason: 'identity_not_configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch(base + path, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body || {}),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, reason: (data && (data.detail || data.reason)) || ('event_manager_' + r.status), status: r.status };
      return data;
    } catch (_e) {
      return { ok: false, reason: 'event_manager_unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  function codeEmail(code, firstName, what) {
    const hi = firstName ? 'Hi ' + String(firstName).replace(/[<>&"]/g, '') + ',' : 'Hello,';
    return [
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a2b20">',
      '<p style="margin:0 0 12px;font-size:17px">' + hi + '</p>',
      '<p style="margin:0 0 18px;font-size:17px;line-height:1.5">Here is your code to ' + what + ':</p>',
      '<p style="margin:0 0 22px;font-size:36px;letter-spacing:8px;font-weight:700;color:#2e7d32">' + code + '</p>',
      '<p style="margin:0;font-size:15px;color:#4a5a50">It works once and expires in 10 minutes.</p>',
      '<p style="margin:22px 0 0;font-size:13px;color:#8a978f">If you did not ask for this, you can ignore this email.</p>',
      '</div>',
    ].join('');
  }

  async function deliver(target, code, firstName, what) {
    let contactId = (target && target.contact_id) || '';
    if (!contactId && target && target.email && target.ghl_lookup !== false) {
      // Only a contact whose own address is this one: never a buyer or a
      // household member who happens to be found near it.
      const m = await resolveMemberRecord({ email: target.email }).catch(() => null);
      if (m && m.contactId && String(m.email || '').toLowerCase() === String(target.email).toLowerCase()) contactId = m.contactId;
    }
    if (!contactId) return { ok: false, reason: 'no_contact_for_delivery' };
    return ghlSendEmail({ contactId, subject: 'Your Gaia Healers code', html: codeEmail(code, firstName, what) });
  }

  async function signIn(req, res, origin, ident, source) {
    let member = null;
    // Keep the profile's own GHL association: look up by its contact id when it
    // has one (never by email, which another contact may share), else by email.
    if (ident.contact_id) {
      member = await resolveMemberRecord({ contactId: ident.contact_id }).catch(() => null);
      if (member && member.contactId && member.contactId !== ident.contact_id) member = null;
    } else if (ident.email && ident.ghl_lookup !== false) {
      member = await resolveMemberRecord({ email: ident.email }).catch(() => null);
      if (member && String(member.email || '').toLowerCase() !== String(ident.email).toLowerCase()) member = null;
    }
    if (!member) {
      member = normalizeMemberIdentity({ contactId: ident.contact_id || '', memberId: ident.contact_id || '',
        email: ident.email || '', displayName: ident.name || 'Gaia Healers member', role: 'Member', source: 'gaia-profile' });
    }
    // The person proved the profile's email (a code sent there) or was checked
    // in person by desk staff, so the session may open that profile's tickets.
    const session = createMemberSession(member, source, { emailVerified: true });
    const token = signTokenPayload(session);
    sendJson(res, 200, { ok: true, authenticated: true, member: session.member, expiresAt: session.exp },
      origin, { 'Set-Cookie': buildSetCookie(req, token, session.exp), 'Cache-Control': 'no-store' });
  }

  const friendly = {
    unknown_badge: 'We could not find this badge. Please ask the help desk.',
    too_many_codes: 'Too many codes were requested. Please wait a few minutes or ask the help desk.',
    no_contact_for_delivery: 'We could not email a code. Please ask the help desk for a code.',
    code_incorrect: 'That code is not right. Please check it and try again.',
    code_expired: 'That code has expired. Please ask for a new one.',
    too_many_attempts: 'Too many tries. Please ask for a new code.',
    no_code_outstanding: 'Please ask for a code first.',
    verification_expired: 'Please enter a new code — the last one expired.',
    wrong_password: 'That password is not right.',
    locked: 'Too many tries. Please wait 15 minutes, or use “Forgot password”.',
    no_password: 'Please create your password first.',
    wrong_email_or_password: 'That email or password is not right.',
  };
  const say = (reason) => friendly[reason] || 'Something went wrong. Please try again or ask the help desk.';

  async function handle(req, res, origin, url) {
    const p = url.pathname;
    if (req.method !== 'POST') return false;
    const routes = ['/api/activate/start', '/api/activate/verify', '/api/activate/complete', '/api/activate/login',
      '/api/auth/password/login', '/api/auth/password/forgot', '/api/auth/password/reset'];
    if (!routes.includes(p)) return false;
    const body = await readJsonBody(req).catch(() => ({}));
    const token = String(body.token || '').trim().toUpperCase();
    const email = String(body.email || '').trim().toLowerCase();

    if (p === '/api/activate/start') {
      if (limited('start', req, token)) { sendJson(res, 429, { ok: false, error: say('too_many_codes') }, origin); return true; }
      const r = await em('/identity/activate/start', { token, send_code: Boolean(body.send_code) });
      if (!r.ok && !r.first_name) { sendJson(res, 200, { ok: false, error: say(r.reason) }, origin); return true; }
      let sent = false;
      let error = r.ok ? '' : say(r.reason);
      if (r.code) {
        const d = await deliver(r.deliver_to, r.code, r.first_name, 'create your Gaia Healers password');
        sent = Boolean(d && d.ok);
        if (!sent) error = say('no_contact_for_delivery');
      }
      sendJson(res, 200, { ok: !error, first_name: r.first_name || '', has_password: Boolean(r.has_password),
        email_masked: r.email_masked || '', desk_only: Boolean(r.desk_only), code_sent: sent, error }, origin,
        { 'Cache-Control': 'no-store' });
      return true;
    }
    if (p === '/api/activate/verify') {
      if (limited('verify', req, token)) { sendJson(res, 429, { ok: false, error: say('too_many_attempts') }, origin); return true; }
      const r = await em('/identity/activate/verify', { token, code: String(body.code || '') });
      sendJson(res, 200, r.ok ? { ok: true, permit: r.permit } : { ok: false, error: say(r.reason) }, origin, { 'Cache-Control': 'no-store' });
      return true;
    }
    if (p === '/api/activate/complete') {
      const r = await em('/identity/activate/complete', { token, permit: String(body.permit || ''), password: String(body.password || ''),
        via: body.via === 'desk_code' ? 'desk_code' : 'email_code' });
      if (!r.ok) { sendJson(res, 200, { ok: false, error: r.status === 400 ? r.reason : say(r.reason) }, origin); return true; }
      await signIn(req, res, origin, r.identity, 'password-activation');
      return true;
    }
    if (p === '/api/activate/login') {
      if (limited('login', req, token)) { sendJson(res, 429, { ok: false, error: say('locked') }, origin); return true; }
      const r = await em('/identity/activate/login', { token, password: String(body.password || '') });
      if (!r.ok) { sendJson(res, 200, { ok: false, error: say(r.reason) }, origin); return true; }
      await signIn(req, res, origin, r.identity, 'password');
      return true;
    }
    if (p === '/api/auth/password/login') {
      if (limited('login', req, email)) { sendJson(res, 429, { ok: false, error: say('locked') }, origin); return true; }
      const r = await em('/identity/password/login', { email, password: String(body.password || '') });
      if (!r.ok) { sendJson(res, 200, { ok: false, error: say(r.reason) }, origin); return true; }
      await signIn(req, res, origin, r.identity, 'password');
      return true;
    }
    if (p === '/api/auth/password/forgot') {
      if (!limited('forgot', req, email)) {
        const r = await em('/identity/password/forgot', { email });
        if (r.ok && r.code) await deliver(r.deliver_to, r.code, '', 'reset your Gaia Healers password');
      }
      // Same answer whether or not the address is known.
      sendJson(res, 200, { ok: true, message: 'If that email has a Gaia profile, a code is on its way.' }, origin);
      return true;
    }
    if (p === '/api/auth/password/reset') {
      if (limited('verify', req, email)) { sendJson(res, 429, { ok: false, error: say('too_many_attempts') }, origin); return true; }
      const r = await em('/identity/password/reset', { email, code: String(body.code || ''), password: String(body.password || '') });
      if (!r.ok) { sendJson(res, 200, { ok: false, error: r.status === 400 ? r.reason : say(r.reason) }, origin); return true; }
      await signIn(req, res, origin, r.identity, 'password-reset');
      return true;
    }
    return false;
  }

  return { handle, _hits: hits };
}

