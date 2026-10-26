/* Gaia Healers Control Center — Membership 2.0 area.
 *
 * Contract: docs/membership/CONTROL-CENTER.md (sections 2, 4, 5, 6). This file
 * is loaded before gadmin.js, which calls GaiaMembership2.init(bridge) and,
 * once the shared-password session is confirmed, probe(). The area exists only
 * when GET /api/admin/membership2/status answers 200; otherwise this file makes
 * no other request and the menu item is never drawn.
 *
 * Safety rules this file keeps (tests/control-center-membership2.test.cjs
 * checks them):
 *  - every node is built with el() and textContent; no innerHTML anywhere, so
 *    nothing the API returns can become markup;
 *  - the operator token lives in an HttpOnly cookie the page never sees; no
 *    token, secret or session id is read, stored or logged here;
 *  - action buttons are drawn only for keys in /me.permissions (the server
 *    still decides; hiding is courtesy, not the control);
 *  - every write goes through openAction(): plain-words consequence, a reason
 *    of 10+ characters, and one requestId per action that is reused, with the
 *    same body, when a retry follows a network error or a 5xx.
 */
(function () {
  'use strict';
  var BASE = '/api/admin/membership2';
  // Mirror of COIN_CENTS in membership-service/src/catalog.js (1 coin = $0.01).
  // Used only when a response does not carry the coin/cent figure itself.
  var COIN_CENTS = 1;
  var REASON_MIN = 10;
  var STAGES = ['OFF', 'INTERNAL_PILOT', 'LIMITED_NEW_CUSTOMERS', 'ALL_NEW_CUSTOMERS'];
  var BILLING_OFF = 'Approved, but billing is not connected in this environment; nothing was charged or refunded.';
  var SCREENS = [
    ['overview', 'Overview'], ['members', 'Members'], ['payments', 'Payments'], ['coins', 'Coins'],
    ['legacy', 'Legacy & migration'], ['requests', 'Requests'], ['reconciliation', 'Reconciliation'],
    ['audit', 'Audit'], ['health', 'Health'], ['launch', 'Launch']
  ];
  var PERSON_TABS = [
    ['identities', 'Identities'], ['subscriptions', 'Subscriptions'], ['entitlements', 'Entitlements'],
    ['coins', 'Coins'], ['payments', 'Payments'], ['legacy', 'Legacy'], ['offers', 'Offers'],
    ['notes', 'Notes'], ['audit', 'Audit']
  ];
  var ACTION_LABELS = {
    'note.add': 'Add a note', 'offer.create': 'Create a migration offer', 'offer.withdraw': 'Withdraw a migration offer',
    'legacy.confirm_cancelled': 'Confirm the legacy subscription was cancelled',
    'subscription.cancel_period_end': 'Cancel at period end', 'subscription.cancel_now': 'Cancel immediately',
    'coins.credit': 'Goodwill coin credit', 'refund_review.resolve': 'Resolve a coin refund review',
    'payment.refund': 'Refund a payment', 'migration.authorize_exception': 'Authorize a migration exception',
    'pilot.add': 'Add a pilot member', 'pilot.remove': 'Remove a pilot member', 'launch.set': 'Change the launch stage'
  };

  var bridge = { authHeaders: function () { return {}; }, toast: function () {}, adminExpired: function () {} };
  var S = {
    enabled: false,      // the probe answered 200
    signedIn: false,
    me: null,            // { operator, permissions, idleExpiresAt }
    screen: 'overview',
    personId: null, personTab: 'identities',
    signinMsg: '',
    idleMs: 0, idleTimer: null,
    box: null            // the #content node we are mounted in
  };

  // ================= helpers =================
  // el('div', { class: 'x', text: 'y', onclick: fn, 'aria-label': 'z' }, [children])
  // Strings in children become text nodes. This is the only way this file makes DOM.
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, String(v));
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function pick(o) { if (!o) return null; for (var i = 1; i < arguments.length; i++) { var v = o[arguments[i]]; if (v != null && v !== '') return v; } return null; }
  function list(o) { for (var i = 1; i < arguments.length; i++) { var v = o && o[arguments[i]]; if (Array.isArray(v)) return v; } return []; }
  function num(v) { return v == null || v === '' || isNaN(Number(v)) ? null : Number(v); }
  function fmtInt(v) { v = num(v); return v == null ? '—' : v.toLocaleString('en-US'); }
  // Exact date and time, with the zone, because "Oct 26" is not enough to act on.
  function fmtWhen(iso) {
    if (!iso) return '—';
    var d = new Date(iso); if (isNaN(d)) return String(iso);
    return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  }
  function fmtDay(iso) {
    if (!iso) return '—';
    var d = new Date(iso); if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });
  }
  function dollars(cents) { var c = num(cents); if (c == null) return '—'; var neg = c < 0; c = Math.abs(c); return (neg ? '−$' : '$') + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // Money is always "$ and coins". The coin figure comes from the API when it sends one.
  function money(cents, coins) {
    var c = num(cents); if (c == null) return '—';
    var k = num(coins); if (k == null) k = Math.round(c / COIN_CENTS);
    return dollars(c) + ' (' + fmtInt(k) + ' coins)';
  }
  function coinsText(coins, cents) {
    var k = num(coins); if (k == null) return '—';
    var c = num(cents); if (c == null) c = k * COIN_CENTS;
    return fmtInt(k) + ' coins (' + dollars(c) + ')';
  }
  function plain(v) {
    if (v == null || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (Array.isArray(v)) return v.length ? v.map(plain).join(', ') : '—';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return '[object]'; } }
    return String(v);
  }
  // Generic cell: field names decide the format, so unknown shapes still read well.
  function cell(key, v) {
    if (/(_cents|Cents)$/.test(key)) return dollars(v);
    if (/(_at|At|_end|End|_until|Until)$/.test(key) && v && !isNaN(new Date(v))) return fmtWhen(v);
    return plain(v);
  }
  function newRequestId() {
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return 'cc_' + Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function can(action) { return !!(S.me && Array.isArray(S.me.permissions) && S.me.permissions.indexOf(action) >= 0); }
  function role() { return (S.me && S.me.operator && S.me.operator.role) || ''; }
  function isOwner() { return role() === 'owner'; }
  function myId() { return (S.me && S.me.operator && S.me.operator.id) || ''; }

  // ================= network =================
  // Resolves to { status, j, network } and never rejects: callers decide.
  function call(method, path, body) {
    var headers = Object.assign({ 'Content-Type': 'application/json' }, bridge.authHeaders() || {});
    var opts = { method: method, credentials: 'same-origin', headers: headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(BASE + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j || {}, network: false }; });
    }, function () { return { status: 0, j: {}, network: true }; });
  }
  // A 401 is either our operator session ending (AUTH_REQUIRED) or the
  // shared-password session ending underneath us. Each goes back to its own sign-in.
  function handledAuth(res) {
    if (res.status !== 401) return false;
    if (res.j && res.j.code === 'AUTH_REQUIRED') signedOut('Your operator session has ended (signed out elsewhere, expired, or idle for too long). Sign in again.');
    else bridge.adminExpired('Your session expired — sign in again.');
    return true;
  }
  function touch() {
    // Each answered request counts as activity. The idle window comes from /me.
    if (!S.idleMs) return;
    clearTimeout(S.idleTimer);
    S.idleTimer = setTimeout(function () {
      signedOut('You were signed out after ' + Math.round(S.idleMs / 60000) + ' minutes without activity. Sign in again.');
    }, S.idleMs);
  }
  function get(path) {
    return call('GET', path).then(function (res) {
      if (handledAuth(res)) return null;
      if (res.status === 200 && res.j.ok !== false) { touch(); return res.j; }
      throw res;
    });
  }
  function loadErr(res) {
    if (res && res.status === 403) return 'You can’t see this. It needs the ' + ((res.j && res.j.requiredRole) || 'a higher') + ' role.';
    if (res && res.network) return 'Could not reach the server. Check the connection and try again.';
    return 'Could not load this' + (res && res.j && res.j.message ? ': ' + res.j.message : '.');
  }

  // ================= probe / session =================
  function probe() {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, 4000) : null;
    return fetch(BASE + '/status', { credentials: 'same-origin', headers: bridge.authHeaders() || {}, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        clearTimeout(t);
        if (r.status !== 200) return false;
        return r.json().then(function (j) { S.enabled = !!(j && j.enabled); S.signedIn = !!(j && j.signedIn); return S.enabled; });
      })
      .catch(function () { clearTimeout(t); return false; });
  }
  function loadMe() {
    return call('GET', '/me').then(function (res) {
      if (res.status === 200 && res.j && res.j.operator) {
        S.me = { operator: res.j.operator, permissions: res.j.permissions || [], idleExpiresAt: res.j.idleExpiresAt };
        S.signedIn = true;
        var ms = res.j.idleExpiresAt ? new Date(res.j.idleExpiresAt).getTime() - Date.now() : 0;
        S.idleMs = ms > 60000 ? ms : 30 * 60000;
        touch();
        return true;
      }
      S.signedIn = false; S.me = null;
      return false;
    });
  }
  function signedOut(msg) {
    clearTimeout(S.idleTimer);
    S.signedIn = false; S.me = null; S.signinMsg = msg || '';
    closeDialog();
    if (mounted()) paint();
  }
  function signOut(silent) {
    if (!S.enabled) return Promise.resolve();
    return call('POST', '/logout', {}).then(function () {
      signedOut(silent ? '' : 'You are signed out of the operator area.');
    });
  }
  function mounted() { return !!(S.box && document.body.contains(S.box)); }

  // ================= mount =================
  function mount(box) {
    if (!S.enabled) return;
    S.box = box;
    clear(box).appendChild(el('div', { class: 'spinner' }));
    if (S.signedIn && !S.me) loadMe().then(paint); else paint();
  }
  function paint() {
    if (!mounted()) return;
    clear(S.box);
    if (!S.signedIn || !S.me) return S.box.appendChild(signinView());
    S.box.appendChild(areaView());
  }

  // ================= sign-in =================
  function field(id, label, input) {
    return el('div', { class: 'm2-field' }, [el('label', { for: id, text: label }), input]);
  }
  function signinView() {
    var msg = el('div', { class: 'login__err', id: 'm2err', role: 'alert', 'aria-live': 'assertive', text: S.signinMsg });
    var em = el('input', { id: 'm2em', type: 'email', autocomplete: 'username', required: true });
    var pw = el('input', { id: 'm2pw', type: 'password', autocomplete: 'current-password', required: true });
    var code = el('input', { id: 'm2code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6', required: true, 'aria-describedby': 'm2codehint' });
    var btn = el('button', { class: 'btn btn--primary btn--full', type: 'submit', text: 'Sign in' });
    var form = el('form', { class: 'm2-signin', novalidate: true, 'aria-labelledby': 'm2signin-h' }, [
      field('m2em', 'Operator email', em),
      field('m2pw', 'Password', pw),
      field('m2code', 'Authenticator code', code),
      el('div', { class: 'm2-hint', id: 'm2codehint', text: 'The 6-digit code from your authenticator app.' }),
      btn
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = '';
      var c = code.value.replace(/\s+/g, '');
      if (!em.value.trim() || !pw.value || !/^[0-9]{6}$/.test(c)) { msg.textContent = 'Enter your email, password and the 6-digit code.'; return; }
      btn.disabled = true; btn.textContent = 'Signing in…';
      call('POST', '/login', { email: em.value.trim(), password: pw.value, totp: c }).then(function (res) {
        btn.disabled = false; btn.textContent = 'Sign in';
        pw.value = ''; code.value = '';
        if (res.status === 200 && res.j.ok !== false) {
          S.signinMsg = '';
          return loadMe().then(function (ok) { if (!ok) msg.textContent = 'Signed in, but your operator profile could not be loaded. Try again.'; else paint(); });
        }
        if (res.status === 401 && !(res.j && res.j.code)) { bridge.adminExpired('Your session expired — sign in again.'); return; }
        if (res.status === 429 || (res.j && res.j.code === 'RATE_LIMITED')) {
          var mins = res.j && res.j.retryAfterSeconds ? Math.ceil(res.j.retryAfterSeconds / 60) : 15;
          msg.textContent = 'Too many failed sign-ins. Sign-in is locked for about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '. Try again later.';
          return;
        }
        if (res.network || res.status >= 500) { msg.textContent = 'Could not reach the sign-in service. Try again.'; return; }
        // One message for every failure: which part was wrong is not said.
        msg.textContent = 'Sign-in failed. Check your email, password and code.';
        pw.focus();
      });
    });
    setTimeout(function () { if (document.body.contains(em)) em.focus(); }, 30);
    return el('div', { class: 'm2 m2-signwrap' }, [
      el('div', { class: 'login__card m2-signcard' }, [
        el('h1', { id: 'm2signin-h', text: 'Gaia Healers Control Center' }),
        el('p', { text: 'Membership 2.0 needs your own operator sign-in, in addition to the console password.' }),
        form, msg
      ])
    ]);
  }

  // ================= area shell =================
  function tabs(items, current, onPick, labelText, idp) {
    var bar = el('div', { class: 'm2-tabs', role: 'tablist', 'aria-label': labelText });
    var btns = items.map(function (it) {
      var on = it[0] === current;
      var b = el('button', {
        class: 'm2-tab' + (on ? ' is-on' : ''), type: 'button', role: 'tab', id: idp + '-' + it[0],
        'aria-selected': on ? 'true' : 'false', 'aria-controls': idp + '-panel', tabindex: on ? '0' : '-1', text: it[1],
        onclick: function () { onPick(it[0]); }
      });
      bar.appendChild(b);
      return b;
    });
    // Arrow keys move between tabs (WAI-ARIA tabs pattern); Enter/Space click.
    bar.addEventListener('keydown', function (e) {
      var i = btns.indexOf(document.activeElement); if (i < 0) return;
      var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : null;
      if (j == null) return;
      e.preventDefault();
      j = (j + btns.length) % btns.length;
      btns[j].focus(); btns[j].click();
    });
    return bar;
  }
  function refocusTab(idp, key) { var t = document.getElementById(idp + '-' + key); if (t) t.focus(); }

  function areaView() {
    var op = S.me.operator || {};
    var head = el('div', { class: 'm2-head' }, [
      el('div', { class: 'm2-brand' }, [el('b', { text: 'Gaia Healers Control Center' }), el('span', { text: 'Membership 2.0' })]),
      el('div', { class: 'm2-who' }, [
        el('span', { text: (op.displayName || op.email || 'Operator') }),
        el('span', { class: 'm2-role', text: op.role || '' }),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Sign out', onclick: function () { signOut(false); } })
      ])
    ]);
    var panel = el('div', { class: 'm2-panel', id: 'm2s-panel', role: 'tabpanel', 'aria-labelledby': 'm2s-' + S.screen, tabindex: '-1' });
    var bar = tabs(SCREENS, S.screen, function (k) {
      S.screen = k; if (k !== 'members') S.personId = null;
      paint(); refocusTab('m2s', k);
    }, 'Membership 2.0 sections', 'm2s');
    var wrap = el('div', { class: 'm2' }, [head, bar, panel]);
    var fn = { overview: screenOverview, members: screenMembers, payments: screenPayments, coins: screenCoins,
      legacy: screenLegacy, requests: screenRequests, reconciliation: screenReconciliation, audit: screenAudit,
      health: screenHealth, launch: screenLaunch }[S.screen] || screenOverview;
    fn(panel);
    return wrap;
  }

  // ================= building blocks =================
  function card(title, kids, extra) {
    return el('section', { class: 'm2-card' }, [el('div', { class: 'm2-card__hd' }, [el('h3', { text: title })].concat(extra || []))].concat(kids || []));
  }
  function spinner() { return el('div', { class: 'spinner' }); }
  function note(text, cls) { return el('div', { class: 'm2-note' + (cls ? ' ' + cls : ''), text: text }); }
  function actBtn(label, onclick, danger) {
    return el('button', { class: 'btn btn--sm ' + (danger ? 'm2-btn--danger' : 'btn--ghost'), type: 'button', text: label, onclick: onclick });
  }
  // cols: [[label, fn(row) -> string|Node]]. Rows are wrapped so a phone scrolls the table, not the page.
  function table(rows, cols, caption) {
    if (!rows || !rows.length) return note('Nothing here yet.');
    var t = el('table', { class: 'm2-table' }, [
      caption ? el('caption', { class: 'm2-sr', text: caption }) : null,
      el('thead', {}, [el('tr', {}, cols.map(function (c) { return el('th', { scope: 'col', text: c[0] }); }))]),
      el('tbody', {}, rows.map(function (r) {
        return el('tr', {}, cols.map(function (c) {
          var v = c[1](r);
          return el('td', { 'data-label': c[0] }, [v == null ? '—' : v]);
        }));
      }))
    ]);
    return el('div', { class: 'm2-tablewrap', tabindex: '0', role: 'region', 'aria-label': caption || 'Table' }, [t]);
  }
  // A table for shapes this UI does not know field by field: first row's keys decide.
  function autoTable(rows, caption, skip) {
    if (!rows || !rows.length) return note('Nothing here yet.');
    skip = skip || [];
    var keys = Object.keys(rows[0]).filter(function (k) { return skip.indexOf(k) < 0; }).slice(0, 8);
    return table(rows, keys.map(function (k) { return [k.replace(/_/g, ' '), function (r) { return cell(k, r[k]); }]; }), caption);
  }
  function kv(obj, skip) {
    skip = skip || ['ok'];
    var keys = Object.keys(obj || {}).filter(function (k) { return skip.indexOf(k) < 0; });
    if (!keys.length) return note('Nothing reported.');
    return el('dl', { class: 'm2-kv' }, keys.reduce(function (a, k) {
      return a.concat([el('dt', { text: k.replace(/_/g, ' ') }), el('dd', { text: cell(k, obj[k]) })]);
    }, []));
  }
  function stat(label, value) { return el('div', { class: 'm2-stat' }, [el('b', { text: value }), el('span', { text: label })]); }
  function into(box, promise, draw) {
    clear(box).appendChild(spinner());
    promise.then(function (d) { if (d == null) return; clear(box); draw(d); }, function (res) { clear(box).appendChild(note(loadErr(res), 'm2-note--err')); });
  }
  function personLink(id, label) {
    if (!id) return '—';
    return el('button', { class: 'm2-link', type: 'button', text: label || String(id), onclick: function () { openPerson(id); } });
  }
  function openPerson(id) { S.screen = 'members'; S.personId = id; S.personTab = 'identities'; paint(); var p = document.getElementById('m2s-panel'); if (p) p.focus(); }
  function moreButton(box, next, load) {
    if (!next) return;
    box.appendChild(el('button', { class: 'btn btn--ghost btn--sm m2-more', type: 'button', text: 'Load more', onclick: function (e) { e.target.remove(); load(next); } }));
  }
  function qs(o) {
    var p = Object.keys(o).filter(function (k) { return o[k] != null && o[k] !== ''; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); });
    return p.length ? '?' + p.join('&') : '';
  }

  // ================= action dialog =================
  // spec: { action, title, lines(values) -> [string], fields: [{name,label,type,min,max,options,value,required,hint}],
  //         params(values) -> object, send(body) -> Promise<res> (default POST /actions), dual: string|null, done() }
  var dlg = null;
  function closeDialog() {
    if (!dlg) return;
    var back = dlg.returnTo;
    dlg.node.remove(); document.removeEventListener('keydown', dlg.onKey, true);
    dlg = null;
    if (back && document.body.contains(back)) back.focus();
  }
  function outcome(res) {
    var j = res.j || {};
    if (j.status === 'approved_not_executed' || j.code === 'PROVIDER_UNAVAILABLE') return { kind: 'final', text: BILLING_OFF };
    if (res.status === 403 || j.code === 'FORBIDDEN') return { kind: 'error', text: 'You don’t have permission for this. It needs the ' + (j.requiredRole || 'a higher') + ' role.' };
    if (j.status === 'pending') return { kind: 'final', text: 'Sent for approval. A different operator' + (j.request && j.request.requiredRole ? ' with the ' + j.request.requiredRole + ' role' : '') + ' must approve it within 72 hours before anything happens.' };
    if (j.status === 'executed') return { kind: 'done', text: 'Done.' };
    if (j.status === 'failed') return { kind: 'final', text: 'Approved, but it did not complete: ' + plain((j.result && (j.result.message || j.result.code)) || j.message || 'unknown error') + '.' };
    if (j.own) return { kind: 'error', text: 'You can’t decide your own request. A different operator' + (j.role ? ' with the ' + j.role + ' role' : '') + ' has to.' };
    if (j.expired) return { kind: 'final', text: 'This request has expired (72 hours). Nothing happened.' };
    if (j.status === 'rejected') return { kind: 'done', text: 'Rejected. Nothing was changed.' };
    if (j.status === 'cancelled') return { kind: 'done', text: 'Request cancelled.' };
    if (res.status === 200 && j.ok !== false) return { kind: 'done', text: 'Done.' };
    if (res.status === 429 || j.code === 'RATE_LIMITED') return { kind: 'error', text: 'Too many attempts. Wait a few minutes and try again.' };
    if (j.code === 'CONFLICT') return { kind: 'error', text: 'This changed since you opened it: ' + plain(j.message || 'conflict') + '. Close and reload.' };
    if (j.code === 'INVALID_INPUT') return { kind: 'error', text: 'The server refused the values: ' + plain(j.message || 'invalid input') + '.' };
    if (j.code === 'NOT_FOUND') return { kind: 'error', text: 'Not found. It may have been removed. Close and reload.' };
    return { kind: 'error', text: 'Refused: ' + plain(j.message || j.code || ('HTTP ' + res.status)) + '.' };
  }
  function retryable(res) { return res.network || (res.status >= 500 && !(res.j && res.j.code === 'PROVIDER_UNAVAILABLE') && !(res.j && res.j.status)); }

  function openAction(spec) {
    closeDialog();
    var requestId = newRequestId();   // one per action; reused on retry
    var sentBody = null;              // after a network error/5xx the same body is resent
    var inputs = {};
    var titleId = 'm2dlg-t', descId = 'm2dlg-d';
    var conseq = el('ul', { class: 'm2-conseq', id: descId });
    var fieldsBox = el('div', {});
    (spec.fields || []).forEach(function (f) {
      var id = 'm2f-' + f.name, inp;
      if (f.type === 'select') {
        inp = el('select', { id: id }, (f.options || []).map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
        if (f.value != null) inp.value = f.value;
      } else if (f.type === 'textarea') {
        inp = el('textarea', { id: id, rows: '3', value: f.value || '' });
      } else {
        inp = el('input', { id: id, type: f.type || 'text', value: f.value != null ? f.value : '', min: f.min, max: f.max, step: f.step, inputmode: f.type === 'number' ? 'numeric' : null });
      }
      if (f.hint) inp.setAttribute('aria-describedby', id + '-h');
      inputs[f.name] = inp;
      inp.addEventListener('input', drawLines); inp.addEventListener('change', drawLines);
      fieldsBox.appendChild(el('div', { class: 'm2-field' }, [el('label', { for: id, text: f.label }), inp, f.hint ? el('div', { class: 'm2-hint', id: id + '-h', text: f.hint }) : null]));
    });
    var reason = el('textarea', { id: 'm2f-reason', rows: '3', required: true, 'aria-describedby': 'm2f-reason-h' });
    var reasonHint = el('div', { class: 'm2-hint', id: 'm2f-reason-h', text: 'Required, at least ' + REASON_MIN + ' characters. It is stored in the audit log with your name.' });
    var msg = el('div', { class: 'm2-dlg__msg', role: 'status', 'aria-live': 'polite' });
    var ok = el('button', { class: 'btn btn--primary', type: 'submit', text: spec.confirm || 'Confirm' });
    var cancel = el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel', onclick: closeDialog });
    var form = el('form', { class: 'm2-dlg__card', novalidate: true }, [
      el('h2', { id: titleId, text: spec.title }),
      el('div', { class: 'm2-dlg__k', text: 'What will happen' }),
      conseq,
      spec.dual ? note('This needs a second approver (' + spec.dual + ' role). It is sent for approval and nothing happens until they approve.', 'm2-note--warn') : null,
      fieldsBox,
      el('div', { class: 'm2-field' }, [el('label', { for: 'm2f-reason', text: spec.reasonLabel || 'Reason' }), reason, reasonHint]),
      msg,
      el('div', { class: 'm2-dlg__btns' }, [cancel, ok])
    ]);
    var node = el('div', { class: 'm2 m2-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': descId }, [form]);
    function values() { var v = {}; Object.keys(inputs).forEach(function (k) { v[k] = inputs[k].value; }); return v; }
    function drawLines() {
      clear(conseq);
      var lines = []; try { lines = spec.lines(values()) || []; } catch (e) { lines = []; }
      lines.forEach(function (l) { conseq.appendChild(el('li', { text: l })); });
    }
    function lock() {
      Object.keys(inputs).forEach(function (k) { inputs[k].disabled = true; });
      reason.disabled = true;
    }
    function finish(text) {
      lock(); msg.textContent = text; msg.className = 'm2-dlg__msg is-final';
      ok.remove(); cancel.textContent = 'Close'; cancel.focus();
      if (spec.done) spec.done();
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = ''; msg.className = 'm2-dlg__msg';
      var body = sentBody;
      if (!body) {
        var r = reason.value.trim();
        if (r.length < REASON_MIN) { msg.textContent = 'Write a reason of at least ' + REASON_MIN + ' characters.'; msg.className = 'm2-dlg__msg is-err'; reason.focus(); return; }
        var problem = spec.validate ? spec.validate(values()) : null;
        if (problem) { msg.textContent = problem; msg.className = 'm2-dlg__msg is-err'; return; }
        body = { action: spec.action, params: spec.params ? spec.params(values()) : {}, reason: r, requestId: requestId };
      }
      ok.disabled = true; ok.textContent = 'Sending…';
      (spec.send ? spec.send(body) : call('POST', '/actions', body)).then(function (res) {
        ok.disabled = false; ok.textContent = spec.confirm || 'Confirm';
        if (res.status === 401) { handledAuth(res); return; }
        if (retryable(res)) {
          // Nothing is confirmed. Freeze the form so the retry is the very same
          // request (same requestId, same body): the server replays, never doubles.
          sentBody = body; lock();
          ok.textContent = 'Retry';
          msg.textContent = (res.network ? 'No answer from the server.' : 'The server had a problem (' + res.status + ').') + ' It is not known whether this ran. Press Retry: it is sent again with the same request id, so it cannot run twice.';
          msg.className = 'm2-dlg__msg is-err';
          return;
        }
        touch();
        var o = outcome(res);
        if (o.kind === 'error') {
          // A definite refusal: nothing ran, so a corrected attempt is a new request.
          requestId = newRequestId(); sentBody = null;
          msg.textContent = o.text; msg.className = 'm2-dlg__msg is-err';
          return;
        }
        if (o.kind === 'done') { bridge.toast(o.text); if (spec.done) spec.done(); closeDialog(); return; }
        finish(o.text);
      });
    });
    function onKey(e) {
      if (!dlg) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeDialog(); return; }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the dialog.
      var f = Array.prototype.filter.call(node.querySelectorAll('button,input,select,textarea,[tabindex]'), function (x) { return !x.disabled && x.tabIndex >= 0 && x.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    node.addEventListener('mousedown', function (e) { if (e.target === node) closeDialog(); });
    dlg = { node: node, onKey: onKey, returnTo: document.activeElement };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(node);
    drawLines();
    var firstInput = (spec.fields && spec.fields.length) ? inputs[spec.fields[0].name] : reason;
    setTimeout(function () { firstInput.focus(); }, 20);
    return { requestId: function () { return requestId; } };
  }

  // ================= action specs =================
  function personName(p) { return p ? (pick(p, 'email', 'primaryEmail') || (list(p, 'emails')[0]) || pick(p, 'personId', 'id')) : 'this member'; }

  function actNote(person, done) {
    openAction({
      action: 'note.add', title: 'Add a note', confirm: 'Add note',
      fields: [{ name: 'body', label: 'Note', type: 'textarea' }],
      lines: function () { return ['A note is added to ' + personName(person) + '. Notes are permanent and cannot be edited or deleted.', 'Nothing else changes for the member.']; },
      validate: function (v) { return v.body.trim() ? null : 'Write the note.'; },
      params: function (v) { return { personId: pick(person, 'personId', 'id'), body: v.body.trim() }; }, done: done
    });
  }
  function actCredit(person, done) {
    openAction({
      action: 'coins.credit', title: 'Goodwill coin credit', confirm: 'Credit coins',
      fields: [{ name: 'coins', label: 'Coins', type: 'number', min: 1, max: 10000, step: 1, value: '', hint: 'Whole coins, 1 to 10,000. Up to 500 runs at once; above 500 needs a second finance approver.' }],
      lines: function (v) {
        var k = parseInt(v.coins, 10);
        if (!(k > 0)) return ['Enter how many coins to add to ' + personName(person) + '’s wallet.'];
        return ['Adds ' + coinsText(k) + ' to ' + personName(person) + '’s wallet as a goodwill credit.',
          k > 500 ? 'Above 500 coins: this is sent for approval and is credited only after a second finance operator approves.' : 'It is credited immediately.',
          'No money is charged or paid out.'];
      },
      validate: function (v) { var k = Number(v.coins); return (Number.isInteger(k) && k >= 1 && k <= 10000) ? null : 'Coins must be a whole number from 1 to 10,000.'; },
      params: function (v) { return { personId: pick(person, 'personId', 'id'), coins: Number(v.coins) }; }, done: done
    });
  }
  function subLabel(s) { return (pick(s, 'planName', 'plan_name', 'planKey', 'plan_key', 'plan') || 'subscription') + ' (' + (pick(s, 'billingInterval', 'billing_interval', 'interval') || '—') + ')'; }
  function actCancelEnd(s, person, done) {
    var end = pick(s, 'currentPeriodEnd', 'current_period_end');
    openAction({
      action: 'subscription.cancel_period_end', title: 'Cancel at period end', confirm: 'Cancel at period end',
      lines: function () { return ['The ' + subLabel(s) + ' for ' + personName(person) + ' stops renewing.', 'The member keeps access until ' + (end ? fmtWhen(end) : 'the end of the current period (date not reported)') + '. Nothing is refunded.']; },
      params: function () { return { subscriptionId: pick(s, 'id', 'subscriptionId') }; }, done: done
    });
  }
  function actCancelNow(s, person, done) {
    openAction({
      action: 'subscription.cancel_now', title: 'Cancel immediately', confirm: 'Send for approval', dual: 'finance',
      lines: function () { return ['The ' + subLabel(s) + ' for ' + personName(person) + ' ends at the moment it is approved: access and billing stop then, not at period end' + (pick(s, 'currentPeriodEnd', 'current_period_end') ? ' (' + fmtWhen(pick(s, 'currentPeriodEnd', 'current_period_end')) + ')' : '') + '.', 'This action does not refund anything; a refund is a separate request.']; },
      params: function () { return { subscriptionId: pick(s, 'id', 'subscriptionId') }; }, done: done
    });
  }
  function actRefund(p, done) {
    var full = Math.abs(num(pick(p, 'amountCents', 'amount_cents')) || 0);
    openAction({
      action: 'payment.refund', title: 'Refund a payment', confirm: 'Send for approval', dual: 'finance',
      fields: [{ name: 'dollars', label: 'Amount to refund in $', type: 'number', min: 0.01, max: (full / 100).toFixed(2), step: '0.01', value: (full / 100).toFixed(2), hint: 'Full amount is ' + money(full) + '. Lower it for a partial refund.' }],
      lines: function (v) {
        var c = Math.round(Number(v.dollars) * 100);
        return ['Refunds ' + (c > 0 ? money(c) : '—') + ' of the ' + money(full) + ' payment from ' + fmtWhen(pick(p, 'occurredAt', 'occurred_at')) + ' to the original card, through Stripe.',
          'The money leaves only after a second finance operator approves. If coins were bought with it, unspent coins are taken back.'];
      },
      validate: function (v) { var c = Math.round(Number(v.dollars) * 100); return (c >= 1 && c <= full) ? null : 'The amount must be between $0.01 and ' + dollars(full) + '.'; },
      params: function (v) { return { ledgerId: pick(p, 'id', 'ledgerId'), amountCents: Math.round(Number(v.dollars) * 100) }; }, done: done
    });
  }
  function actResolveReview(r, done) {
    openAction({
      action: 'refund_review.resolve', title: 'Resolve a coin refund review', confirm: 'Resolve',
      fields: [{ name: 'resolution', label: 'Resolution (what was decided)', type: 'textarea' }],
      lines: function () { return ['Marks this review resolved: ' + coinsText(pick(r, 'coinsUnrecovered', 'coins_unrecovered'), pick(r, 'valueCentsUnrecovered', 'value_cents_unrecovered')) + ' could not be taken back after a refund.', 'No coins or money move; this records the decision.']; },
      validate: function (v) { return v.resolution.trim().length >= 5 ? null : 'Write the resolution (at least 5 characters).'; },
      params: function (v) { return { reviewId: pick(r, 'id', 'reviewId'), resolution: v.resolution.trim() }; }, done: done
    });
  }
  function actOfferCreate(person, legacy, done) {
    openAction({
      action: 'offer.create', title: 'Create a migration offer', confirm: 'Create offer',
      fields: [
        { name: 'plan', label: 'Target plan', type: 'select', options: [['standard', 'Standard'], ['professional', 'Professional'], ['inner_circle', 'Inner Circle']] },
        { name: 'interval', label: 'Billing interval', type: 'select', options: [['month', 'Monthly'], ['year', 'Yearly']] }
      ],
      lines: function (v) { return ['Invites ' + personName(person) + ' to move from their legacy ' + (pick(legacy, 'tier') || '') + ' membership to ' + v.plan + ' (' + v.interval + ').', 'It is an invitation only: nothing is charged and the legacy GHL/PayPal subscription is not touched.']; },
      params: function (v) { return { personId: pick(person, 'personId', 'id'), legacyMembershipId: pick(legacy, 'id'), targetPlanKey: v.plan, interval: v.interval }; }, done: done
    });
  }
  function actOfferWithdraw(o, done) {
    openAction({
      action: 'offer.withdraw', title: 'Withdraw a migration offer', confirm: 'Withdraw',
      lines: function () { return ['The open offer (' + plain(pick(o, 'status')) + ') is withdrawn and the member can no longer accept it.', 'Nothing is charged; the legacy subscription is not touched.']; },
      params: function () { return { offerId: pick(o, 'id', 'offerId') }; }, done: done
    });
  }
  function actConfirmLegacy(o, done) {
    openAction({
      action: 'legacy.confirm_cancelled', title: 'Confirm the legacy subscription was cancelled', confirm: 'Confirm',
      fields: [{ name: 'evidence', label: 'Evidence (what you saw in GHL/PayPal, with date)', type: 'textarea' }],
      lines: function () { return ['Records that the old GHL/PayPal subscription was cancelled by hand, and completes the migration.', 'This does not cancel anything itself: do the cancellation in GHL/PayPal first.']; },
      validate: function (v) { return v.evidence.trim().length >= 10 ? null : 'Describe the evidence (at least 10 characters).'; },
      params: function (v) { return { offerId: pick(o, 'id', 'offerId'), evidence: v.evidence.trim() }; }, done: done
    });
  }
  function actException(o, done) {
    openAction({
      action: 'migration.authorize_exception', title: 'Authorize a migration exception', confirm: 'Send for approval', dual: 'owner',
      lines: function () { return ['Lets this migration offer go ahead even though a safeguard stopped it.', 'It runs only after an owner approves.']; },
      params: function () { return { offerId: pick(o, 'id', 'offerId') }; }, done: done
    });
  }
  function actPilot(add, personId, label, done) {
    openAction({
      action: add ? 'pilot.add' : 'pilot.remove', title: add ? 'Add a pilot member' : 'Remove a pilot member', confirm: add ? 'Add to pilot' : 'Remove from pilot',
      fields: personId ? [] : [{ name: 'personId', label: 'Person id', type: 'text' }],
      lines: function (v) { var who = label || personId || v.personId || 'this person'; return add ? [who + ' joins the pilot list and can start a Membership 2.0 checkout while the stage is INTERNAL_PILOT.', 'Nothing is charged by this.'] : [who + ' leaves the pilot list. An existing subscription is not cancelled.']; },
      validate: function (v) { return (personId || (v.personId || '').trim()) ? null : 'Enter the person id.'; },
      params: function (v) { return { personId: personId || v.personId.trim() }; }, done: done
    });
  }
  function actStage(current, done) {
    var high = function (s) { return STAGES.indexOf(s) > STAGES.indexOf('INTERNAL_PILOT'); };
    openAction({
      action: 'launch.set', title: 'Change the launch stage', confirm: 'Change stage',
      fields: [
        { name: 'stage', label: 'New stage', type: 'select', options: STAGES.map(function (s) { return [s, s]; }), value: current },
        { name: 'cap', label: 'Limit (new customers, for LIMITED_NEW_CUSTOMERS)', type: 'number', min: 1, step: 1, value: '' },
        { name: 'ref', label: 'GO approval reference (required above INTERNAL_PILOT)', type: 'text', value: '' }
      ],
      lines: function (v) {
        var s = v.stage, out = ['The stored stage goes from ' + (current || '—') + ' to ' + s + '. The environment ceiling still caps what is effective.'];
        if (s === 'OFF') out.push('Nobody can start a Membership 2.0 checkout.');
        if (s === 'INTERNAL_PILOT') out.push('Only people on the pilot list can start a checkout.');
        if (s === 'LIMITED_NEW_CUSTOMERS') out.push('New customers can sign up until ' + (v.cap ? fmtInt(v.cap) : 'the limit') + ' have done so. Real money moves if Stripe is connected.');
        if (s === 'ALL_NEW_CUSTOMERS') out.push('Every new customer can sign up. Real money moves if Stripe is connected.');
        if (high(s)) out.push('Above INTERNAL_PILOT this needs a second owner to approve.');
        return out;
      },
      validate: function (v) {
        if (v.stage === current) return 'That is already the stage.';
        if (v.stage === 'LIMITED_NEW_CUSTOMERS' && !(Number(v.cap) >= 1)) return 'Set the limit for LIMITED_NEW_CUSTOMERS.';
        if (high(v.stage) && v.ref.trim().length < 3) return 'Enter the GO approval reference.';
        return null;
      },
      params: function (v) { var p = { stage: v.stage }; if (v.stage === 'LIMITED_NEW_CUSTOMERS') p.limitedCap = Number(v.cap); if (v.ref.trim()) p.approvalRef = v.ref.trim(); return p; },
      done: done
    });
  }
  function describeParams(action, p) {
    p = p || {};
    if (action === 'coins.credit') return coinsText(p.coins) + ' to person ' + plain(p.personId);
    if (action === 'payment.refund') return money(p.amountCents) + ' from payment ' + plain(p.ledgerId);
    if (/^subscription\./.test(action)) return 'subscription ' + plain(p.subscriptionId);
    if (action === 'launch.set') return 'stage → ' + plain(p.stage) + (p.limitedCap ? ' (limit ' + fmtInt(p.limitedCap) + ')' : '') + (p.approvalRef ? ', approval ' + p.approvalRef : '');
    return Object.keys(p).map(function (k) { return k + ': ' + plain(p[k]); }).join(' · ') || '—';
  }
  function decide(req, verb, done) {
    var label = ACTION_LABELS[req.action] || req.action;
    var path = '/requests/' + encodeURIComponent(req.id) + '/' + verb;
    var lines = {
      approve: ['You approve: ' + label + ' — ' + describeParams(req.action, req.params) + '.', 'It runs as soon as you confirm.'],
      reject: ['You reject: ' + label + ' — ' + describeParams(req.action, req.params) + '.', 'The request is closed and nothing happens.'],
      cancel: ['You withdraw your own request: ' + label + '.', 'Nothing happens.']
    }[verb];
    openAction({
      action: 'request.' + verb, title: { approve: 'Approve request', reject: 'Reject request', cancel: 'Cancel my request' }[verb],
      confirm: { approve: 'Approve', reject: 'Reject', cancel: 'Cancel request' }[verb], reasonLabel: 'Reason',
      lines: function () { return lines; },
      send: function (body) { return call('POST', path, { note: body.reason, requestId: body.requestId }); }, done: done
    });
  }

  // ================= screens =================
  function screenOverview(panel) {
    var box = el('div', {}); panel.appendChild(box);
    into(box, get('/overview'), function (d) {
      var o = d.overview || d;
      var tiles = el('div', { class: 'm2-stats' });
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (k === 'ok' || v == null || typeof v === 'object') return;
        tiles.appendChild(stat(k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'), /(Cents|_cents)$/.test(k) ? money(v) : (typeof v === 'number' ? fmtInt(v) : plain(v))));
      });
      box.appendChild(tiles);
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (!v || typeof v !== 'object') return;
        box.appendChild(card(k.replace(/([a-z])([A-Z])/g, '$1 $2'), [Array.isArray(v) ? autoTable(v, k) : kv(v)]));
      });
    });
  }

  function screenMembers(panel) {
    if (S.personId) return screenPerson(panel);
    var q = el('input', { id: 'm2q', type: 'search', placeholder: 'Email, contact id or person id', value: S.lastQ || '' });
    var results = el('div', { class: 'm2-results', 'aria-live': 'polite' });
    var form = el('form', { class: 'm2-searchbar', role: 'search' }, [
      el('label', { for: 'm2q', class: 'm2-sr', text: 'Search members' }), q,
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit', text: 'Search' })
    ]);
    function load(cursor) {
      var path = '/persons' + qs({ q: S.lastQ, limit: 25, cursor: cursor });
      var holder = el('div', {}); results.appendChild(holder);
      into(holder, get(path), function (d) {
        var items = list(d, 'items');
        if (!cursor && !items.length) { holder.appendChild(note('No one matches “' + S.lastQ + '”.')); return; }
        holder.appendChild(table(items, [
          ['Person', function (r) { return personLink(r.personId, list(r, 'emails')[0] || r.personId); }],
          ['Contact ids', function (r) { return plain(r.contactIds); }],
          ['Plan', function (r) { return plain(r.plan); }],
          ['Status', function (r) { return plain(r.status); }],
          ['Legacy', function (r) { return plain(r.legacy); }],
          ['Coins', function (r) { return coinsText(r.coins); }]
        ], 'Search results'));
        moreButton(results, d.next, load);
      });
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); S.lastQ = q.value.trim(); clear(results); if (S.lastQ) load(null); });
    panel.appendChild(form); panel.appendChild(results);
    if (S.lastQ) load(null); else results.appendChild(note('Search by email, GHL contact id or person id.'));
    setTimeout(function () { if (document.body.contains(q)) q.focus(); }, 20);
  }

  function screenPerson(panel) {
    var id = S.personId;
    var box = el('div', {}); panel.appendChild(box);
    var back = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: '← Back to search', onclick: function () { S.personId = null; paint(); } });
    panel.insertBefore(back, box);
    function reload() { clear(box); draw(); }
    function draw() {
      into(box, get('/persons/' + encodeURIComponent(id)), function (d) {
        // The detail answers with top-level sections; d.person is only the person row.
        var p = d.identities ? d : (d.person || d);
        var emails = list(p, 'emails').length ? list(p, 'emails') : list(p, 'identities').filter(function (x) { return x.platform === 'email' || x.kind === 'email'; }).map(function (x) { return pick(x, 'external_id', 'externalId', 'email', 'value'); }).filter(Boolean);
        var personObj = { personId: id, email: emails[0] };
        var pilot = !!pick(p, 'pilot', 'isPilot', 'pilotMember');
        var head = el('div', { class: 'm2-person__hd' }, [
          el('h3', { text: emails[0] || id }),
          el('div', { class: 'm2-sub', text: 'Person ' + id + (pilot ? ' · on the pilot list' : '') })
        ]);
        if (isOwner() && can(pilot ? 'pilot.remove' : 'pilot.add')) head.appendChild(actBtn(pilot ? 'Remove from pilot' : 'Add to pilot', function () { actPilot(!pilot, id, emails[0] || id, reload); }));
        box.appendChild(head);
        var tabPanel = el('div', { class: 'm2-panel', id: 'm2p-panel', role: 'tabpanel', 'aria-labelledby': 'm2p-' + S.personTab });
        box.appendChild(tabs(PERSON_TABS, S.personTab, function (k) { S.personTab = k; clear(box); draw(); setTimeout(function () { refocusTab('m2p', k); }, 0); }, 'Person sections', 'm2p'));
        box.appendChild(tabPanel);
        personTab(tabPanel, S.personTab, p, personObj, reload);
      });
    }
    draw();
  }

  function personTab(box, tab, p, person, reload) {
    var add = function (n) { box.appendChild(n); };
    if (tab === 'identities') add(autoTable(list(p, 'identities'), 'Identities'));
    else if (tab === 'subscriptions') {
      add(table(list(p, 'subscriptions'), [
        ['Plan', function (s) { return subLabel(s); }],
        ['Status', function (s) { return plain(s.status); }],
        ['Provider', function (s) { return plain(s.provider); }],
        ['Period end', function (s) { return fmtWhen(pick(s, 'currentPeriodEnd', 'current_period_end')); }],
        ['Cancels at', function (s) { return fmtWhen(pick(s, 'cancelAt', 'cancel_at')); }],
        ['Events', function (s) { return fmtInt(list(s, 'events').length); }],
        ['Actions', function (s) {
          var live = /^(active|trialing|past_due)$/.test(String(s.status || ''));
          var w = el('div', { class: 'm2-acts' });
          if (live && !pick(s, 'cancelAt', 'cancel_at') && can('subscription.cancel_period_end')) w.appendChild(actBtn('Cancel at period end', function () { actCancelEnd(s, person, reload); }));
          if (live && can('subscription.cancel_now')) w.appendChild(actBtn('Cancel now', function () { actCancelNow(s, person, reload); }, true));
          return w.childNodes.length ? w : '—';
        }]
      ], 'Subscriptions'));
    } else if (tab === 'entitlements') add(autoTable(list(p, 'entitlements'), 'Entitlements'));
    else if (tab === 'coins') {
      var w = p.wallet || {};
      var bal = el('div', { class: 'm2-stats' }, Object.keys(w).filter(function (k) { return typeof w[k] === 'number'; }).map(function (k) { return stat(k.replace(/_/g, ' '), coinsText(w[k])); }));
      add(card('Wallet', [bal], can('coins.credit') ? [actBtn('Credit coins', function () { actCredit(person, reload); })] : []));
      add(card('Last 50 coin transactions', [autoTable(list(p, 'coinTransactions', 'coin_transactions', 'transactions'), 'Coin transactions')]));
    } else if (tab === 'payments') add(paymentsTable(list(p, 'payments'), reload));
    else if (tab === 'legacy') {
      add(note('Legacy GHL/PayPal memberships are read-only here: nothing in this area changes them.'));
      var offers = list(p, 'offers');
      add(table(list(p, 'legacy'), [
        ['Tier', function (r) { return plain(r.tier); }],
        ['Status (GHL)', function (r) { return plain(pick(r, 'reportedStatus', 'reported_status')); }],
        ['Provider', function (r) { return plain(pick(r, 'paymentProvider', 'payment_provider')); }],
        ['Amount', function (r) { return money(pick(r, 'amountCents', 'amount_cents')); }],
        ['Paid through (est.)', function (r) { return fmtWhen(pick(r, 'paidThroughEstimate', 'paid_through_estimate')); }],
        ['Review', function (r) { return plain(pick(r, 'reviewState', 'review_state')); }],
        ['Actions', function (r) {
          var open = offers.some(function (o) { return pick(o, 'legacyMembershipId', 'legacy_membership_id') === r.id && /^(offered|accepted|checkout_started|subscribed)$/.test(o.status); });
          return (!open && can('offer.create')) ? actBtn('Create offer', function () { actOfferCreate(person, r, reload); }) : '—';
        }]
      ], 'Legacy memberships'));
    } else if (tab === 'offers') add(offersTable(list(p, 'offers'), reload));
    else if (tab === 'notes') {
      var notes = list(p, 'notes');
      add(card('Notes', [notes.length ? el('ul', { class: 'm2-notes' }, notes.map(function (n) {
        return el('li', {}, [el('div', { class: 'm2-sub', text: fmtWhen(pick(n, 'createdAt', 'created_at')) + ' · ' + plain(pick(n, 'operatorName', 'operator_name', 'operatorEmail', 'operatorId', 'operator_id')) }), el('div', { text: plain(n.body) })]);
      })) : note('No notes yet.')], can('note.add') ? [actBtn('Add note', function () { actNote(person, reload); })] : []));
    } else if (tab === 'audit') add(auditTable(list(p, 'audit', 'auditLogs')));
  }

  function paymentsTable(rows, reload) {
    return table(rows, [
      ['When', function (r) { return fmtWhen(pick(r, 'occurredAt', 'occurred_at')); }],
      ['Type', function (r) { return plain(pick(r, 'entryType', 'entry_type', 'type')); }],
      ['Amount', function (r) { return money(pick(r, 'amountCents', 'amount_cents'), pick(r, 'coins')); }],
      ['Provider', function (r) { return plain(r.provider); }],
      ['Person', function (r) { var pid = pick(r, 'personId', 'person_id'); return pid ? personLink(pid) : '—'; }],
      ['Actions', function (r) {
        var charge = pick(r, 'entryType', 'entry_type', 'type') === 'charge' && num(pick(r, 'amountCents', 'amount_cents')) > 0;
        return charge && can('payment.refund') ? actBtn('Refund', function () { actRefund(r, reload); }, true) : '—';
      }]
    ], 'Payments');
  }
  function offersTable(rows, reload) {
    return table(rows, [
      ['Offered', function (o) { return fmtWhen(pick(o, 'offeredAt', 'offered_at')); }],
      ['Person', function (o) { var pid = pick(o, 'personId', 'person_id'); return pid ? personLink(pid) : '—'; }],
      ['Target', function (o) { return plain(pick(o, 'targetPlanKey', 'target_plan', 'target_plan_key', 'targetPlan')) + ' / ' + plain(pick(o, 'targetInterval', 'target_interval', 'interval')); }],
      ['Status', function (o) { return plain(o.status); }],
      ['Billing starts', function (o) { return fmtWhen(pick(o, 'billingStartsAt', 'billing_starts_at')); }],
      ['Actions', function (o) {
        var w = el('div', { class: 'm2-acts' }), st = String(o.status || '');
        if (/^(offered|accepted)$/.test(st) && can('offer.withdraw')) w.appendChild(actBtn('Withdraw', function () { actOfferWithdraw(o, reload); }));
        if (st === 'subscribed' && can('legacy.confirm_cancelled')) w.appendChild(actBtn('Confirm legacy cancelled', function () { actConfirmLegacy(o, reload); }));
        if (/^(offered|accepted|checkout_started)$/.test(st) && can('migration.authorize_exception')) w.appendChild(actBtn('Authorize exception', function () { actException(o, reload); }));
        return w.childNodes.length ? w : '—';
      }]
    ], 'Migration offers');
  }
  function auditTable(rows) {
    return table(rows, [
      ['When', function (r) { return fmtWhen(pick(r, 'occurredAt', 'occurred_at')); }],
      ['Actor', function (r) { return plain(pick(r, 'actorName', 'actorEmail', 'actorId', 'actor_id')) + ' (' + plain(pick(r, 'actorType', 'actor_type')) + ')'; }],
      ['Action', function (r) { return plain(r.action); }],
      ['Entity', function (r) { return plain(pick(r, 'entityType', 'entity_type')) + ' ' + plain(pick(r, 'entityId', 'entity_id')); }],
      ['Reason', function (r) { return plain(pick(r, 'reason')); }]
    ], 'Audit log');
  }

  function screenPayments(panel) {
    var from = el('input', { id: 'm2pf', type: 'date' }), to = el('input', { id: 'm2pt', type: 'date' });
    var type = el('select', { id: 'm2py' }, [['', 'All types'], ['charge', 'Charges'], ['refund', 'Refunds'], ['dispute', 'Disputes'], ['fee', 'Fees'], ['adjustment', 'Adjustments']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    var out = el('div', {});
    var form = el('form', { class: 'm2-filters' }, [
      field('m2pf', 'From', from), field('m2pt', 'To', to), field('m2py', 'Type', type),
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit', text: 'Show' })
    ]);
    function load(cursor) {
      var holder = el('div', {}); out.appendChild(holder);
      into(holder, get('/payments' + qs({ from: from.value, to: to.value, type: type.value, limit: 50, cursor: cursor })), function (d) {
        holder.appendChild(paymentsTable(list(d, 'items', 'payments', 'rows'), function () { clear(out); load(null); }));
        moreButton(out, d.next, load);
      });
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); clear(out); load(null); });
    panel.appendChild(form); panel.appendChild(out); load(null);
  }

  function screenCoins(panel) {
    var totals = el('div', {}), reviews = el('div', {}), tx = el('div', {});
    panel.appendChild(card('Coin refund reviews (open)', [reviews]));
    panel.appendChild(card('Wallet totals', [totals]));
    panel.appendChild(card('Coin transactions', [tx]));
    function loadReviews() {
      into(reviews, get('/refund-reviews?status=open'), function (d) {
        reviews.appendChild(table(list(d, 'items', 'reviews', 'rows'), [
          ['Opened', function (r) { return fmtWhen(pick(r, 'createdAt', 'created_at')); }],
          ['Person', function (r) { return personLink(pick(r, 'personId', 'person_id')); }],
          ['Refunded', function (r) { return coinsText(pick(r, 'coinsRefunded', 'coins_refunded')); }],
          ['Not recovered', function (r) { return coinsText(pick(r, 'coinsUnrecovered', 'coins_unrecovered'), pick(r, 'valueCentsUnrecovered', 'value_cents_unrecovered')); }],
          ['Actions', function (r) { return can('refund_review.resolve') ? actBtn('Resolve', function () { actResolveReview(r, loadReviews); }) : '—'; }]
        ], 'Open refund reviews'));
      });
    }
    loadReviews();
    function load(cursor) {
      var holder = el('div', {}); tx.appendChild(holder);
      into(holder, get('/coins' + qs({ limit: 50, cursor: cursor })), function (d) {
        if (!cursor) { clear(totals); var t = d.totals || d.walletTotals || {}; totals.appendChild(el('div', { class: 'm2-stats' }, Object.keys(t).map(function (k) { return stat(k.replace(/_/g, ' '), typeof t[k] === 'number' ? coinsText(t[k]) : plain(t[k])); }))); }
        holder.appendChild(autoTable(list(d, 'items', 'transactions', 'rows'), 'Coin transactions'));
        moreButton(tx, d.next, load);
      });
    }
    load(null);
  }

  function screenLegacy(panel) {
    var state = el('select', { id: 'm2ls' }, [['', 'All'], ['needs_review', 'Needs review'], ['unmapped', 'Unmapped'], ['ambiguous', 'Ambiguous'], ['stale', 'Stale suspected']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    var ostat = el('select', { id: 'm2os' }, [['', 'All'], ['offered', 'Offered'], ['accepted', 'Accepted'], ['checkout_started', 'Checkout started'], ['subscribed', 'Subscribed'], ['completed', 'Completed'], ['withdrawn', 'Withdrawn'], ['declined', 'Declined']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    var leg = el('div', {}), off = el('div', {});
    panel.appendChild(note('Legacy GHL/PayPal memberships are read-only here: nothing in this area changes a GHL or PayPal subscription.'));
    panel.appendChild(card('Legacy memberships', [el('div', { class: 'm2-filters' }, [field('m2ls', 'State', state)]), leg]));
    panel.appendChild(card('Migration offers', [el('div', { class: 'm2-filters' }, [field('m2os', 'Status', ostat)]), off]));
    function loadLeg() {
      into(leg, get('/legacy' + qs({ state: state.value, limit: 100 })), function (d) {
        var fresh = pick(d, 'freshness', 'mirrorAge', 'lastSyncAt');
        if (fresh) leg.appendChild(note('Mirror freshness: ' + (typeof fresh === 'object' ? plain(fresh) : cell('lastSyncAt', fresh))));
        leg.appendChild(table(list(d, 'items', 'rows', 'legacy'), [
          ['Person', function (r) { var pid = pick(r, 'personId', 'person_id'); return pid ? personLink(pid) : plain(pick(r, 'externalContactId', 'external_contact_id')); }],
          ['Tier', function (r) { return plain(r.tier); }],
          ['Mapping', function (r) { return plain(r.mapping); }],
          ['Status (GHL)', function (r) { return plain(pick(r, 'reportedStatus', 'reported_status')); }],
          ['Amount', function (r) { return money(pick(r, 'amountCents', 'amount_cents')); }],
          ['Last payment', function (r) { return fmtWhen(pick(r, 'lastPaymentAt', 'last_payment_at')); }],
          ['Review', function (r) { return plain(pick(r, 'reviewState', 'review_state')) + (pick(r, 'staleSuspected', 'stale_suspected') ? ' · stale?' : ''); }]
        ], 'Legacy memberships'));
      });
    }
    function loadOff() { into(off, get('/migration-offers' + qs({ status: ostat.value })), function (d) { off.appendChild(offersTable(list(d, 'items', 'offers', 'rows'), loadOff)); }); }
    state.addEventListener('change', loadLeg); ostat.addEventListener('change', loadOff);
    loadLeg(); loadOff();
  }

  function screenRequests(panel) {
    var box = el('div', {}); panel.appendChild(box);
    function load() {
      into(box, get('/requests?status=pending'), function (d) {
        var rows = list(d, 'items', 'requests', 'rows');
        if (!rows.length) { box.appendChild(note('No pending requests.')); return; }
        rows.forEach(function (r) {
          var by = r.requestedBy && typeof r.requestedBy === 'object' ? r.requestedBy : { id: pick(r, 'requestedBy', 'requested_by') };
          var mine = r.own === true || (!!myId() && by.id === myId());
          var who = plain(by.displayName || by.email || by.id);
          var acts = el('div', { class: 'm2-acts' });
          if (mine) {
            acts.appendChild(el('span', { class: 'm2-wait', text: 'Waiting for a second approver' }));
            acts.appendChild(actBtn('Cancel my request', function () { decide(r, 'cancel', load); }));
          } else if (r.canApprove) {
            acts.appendChild(actBtn('Approve', function () { decide(r, 'approve', load); }));
            acts.appendChild(actBtn('Reject', function () { decide(r, 'reject', load); }, true));
          } else {
            acts.appendChild(el('span', { class: 'm2-sub', text: 'Needs an approver with the ' + plain(pick(r, 'requiredRole', 'required_role')) + ' role.' }));
          }
          box.appendChild(el('article', { class: 'm2-card m2-req' }, [
            el('h3', { text: ACTION_LABELS[r.action] || plain(r.action) }),
            el('div', { class: 'm2-req__what', text: describeParams(r.action, r.params) }),
            el('dl', { class: 'm2-kv' }, [
              el('dt', { text: 'Requested by' }), el('dd', { text: who + (mine ? ' (you)' : '') }),
              el('dt', { text: 'Why' }), el('dd', { text: plain(r.reason) }),
              el('dt', { text: 'Requested' }), el('dd', { text: fmtWhen(pick(r, 'requestedAt', 'createdAt', 'created_at')) }),
              el('dt', { text: 'Expires' }), el('dd', { text: fmtWhen(pick(r, 'expiresAt', 'expires_at')) }),
              el('dt', { text: 'Approver role' }), el('dd', { text: plain(pick(r, 'requiredRole', 'required_role')) })
            ]),
            acts
          ]));
        });
      });
    }
    load();
  }

  function screenReconciliation(panel) {
    var box = el('div', {}); panel.appendChild(box);
    into(box, get('/reconciliation'), function (d) {
      box.appendChild(card('Open alerts', [autoTable(list(d, 'alerts', 'openAlerts'), 'Open alerts')]));
      box.appendChild(card('Last 30 daily runs', [autoTable(list(d, 'runs', 'items'), 'Daily runs')]));
    });
  }

  function screenAudit(panel) {
    var et = el('input', { id: 'm2ae', type: 'text' }), ei = el('input', { id: 'm2ai', type: 'text' }), ai = el('input', { id: 'm2aa', type: 'text' });
    var out = el('div', {});
    var form = el('form', { class: 'm2-filters' }, [field('m2ae', 'Entity type', et), field('m2ai', 'Entity id', ei), field('m2aa', 'Actor id', ai), el('button', { class: 'btn btn--primary btn--sm', type: 'submit', text: 'Show' })]);
    function load(cursor) {
      var holder = el('div', {}); out.appendChild(holder);
      into(holder, get('/audit' + qs({ entityType: et.value.trim(), entityId: ei.value.trim(), actorId: ai.value.trim(), limit: 50, cursor: cursor })), function (d) {
        holder.appendChild(auditTable(list(d, 'items', 'rows', 'audit')));
        moreButton(out, d.next, load);
      });
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); clear(out); load(null); });
    panel.appendChild(form); panel.appendChild(out); load(null);
  }

  function screenHealth(panel) {
    var h = el('div', {}), dl = el('div', {});
    panel.appendChild(card('Service health', [h]));
    panel.appendChild(card('Dead letters and failed webhooks', [dl]));
    into(h, get('/health'), function (d) {
      var x = d.health || d;
      if (x.stripeConnected === false || x.stripe_connected === false) h.appendChild(note('Stripe is not connected in this environment: refunds and immediate cancellations end as “approved, not executed”.', 'm2-note--warn'));
      h.appendChild(kv(x));
    });
    into(dl, get('/dead-letters'), function (d) {
      Object.keys(d).forEach(function (k) { if (Array.isArray(d[k])) dl.appendChild(el('div', {}, [el('h4', { class: 'm2-h4', text: k.replace(/([a-z])([A-Z])/g, '$1 $2') }), autoTable(d[k], k)])); });
      if (!dl.childNodes.length) dl.appendChild(note('None.'));
    });
  }

  function screenLaunch(panel) {
    var box = el('div', {}); panel.appendChild(box);
    function load() {
      into(box, get('/launch'), function (d) {
        var st = d.state || d.launch || d;
        var current = pick(st, 'stage', 'stored');
        var owner = isOwner();
        var head = [];
        if (owner && can('launch.set')) head.push(actBtn('Change stage', function () { actStage(current, load); }));
        box.appendChild(card('Launch stage', [
          el('div', { class: 'm2-stats' }, [
            stat('Stored stage', plain(current)), stat('Effective', plain(pick(st, 'effective'))),
            stat('Ceiling', plain(pick(st, 'ceiling'))), stat('Limit', fmtInt(pick(st, 'limitedCap', 'limited_cap')))
          ]),
          owner ? null : note('Read-only: only an owner can change the stage or the pilot list.')
        ], head));
        box.appendChild(card('History', [table(list(d, 'history'), [
          ['When', function (r) { return fmtWhen(pick(r, 'changedAt', 'changed_at', 'createdAt', 'created_at')); }],
          ['From → to', function (r) { return plain(pick(r, 'fromStage', 'from_stage')) + ' → ' + plain(pick(r, 'toStage', 'to_stage')); }],
          ['By', function (r) { return plain(pick(r, 'changedByName', 'changedBy', 'changed_by')); }],
          ['Approval', function (r) { return plain(pick(r, 'approvalRef', 'approval_ref')); }],
          ['Reason', function (r) { return plain(r.reason); }]
        ], 'Launch history')]));
        var pilots = list(d, 'pilots', 'pilot', 'pilotList');
        var pHead = owner && can('pilot.add') ? [actBtn('Add pilot member', function () { actPilot(true, null, null, load); })] : [];
        box.appendChild(card('Pilot list', [table(pilots, [
          ['Person', function (r) { var pid = pick(r, 'personId', 'person_id'); return personLink(pid, pick(r, 'email') || pid); }],
          ['Added', function (r) { return fmtWhen(pick(r, 'addedAt', 'added_at', 'createdAt', 'created_at')); }],
          ['Added by', function (r) { return plain(pick(r, 'addedByName', 'addedBy', 'added_by')); }],
          ['Actions', function (r) { var pid = pick(r, 'personId', 'person_id'); return owner && can('pilot.remove') ? actBtn('Remove', function () { actPilot(false, pid, pick(r, 'email') || pid, load); }, true) : '—'; }]
        ], 'Pilot list')], pHead));
      });
    }
    load();
  }

  // ================= public surface (used by gadmin.js only) =================
  window.GaiaMembership2 = {
    init: function (b) { bridge = Object.assign(bridge, b || {}); },
    probe: probe,
    enabled: function () { return S.enabled; },
    mount: mount,
    signOut: signOut,
    // exposed for tests/control-center-membership2.test.cjs
    _test: { outcome: outcome, retryable: retryable, money: money, coinsText: coinsText, newRequestId: newRequestId, openAction: openAction, state: S, el: el }
  };
})();
