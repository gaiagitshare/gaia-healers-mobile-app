/* Gaia Healers Membership 2.0 — customer view (preview).
 *
 * Talks only to the member gateway /api/membership2/* on the proxy. The one
 * rule this file shares with gaia-membership-ui.js: the UI RENDERS what the
 * API says and never decides it. No plan names, tier rules, prices, coin
 * amounts or "months free" figures live here; every number comes from the
 * catalogue (/plans) or the member's own overview (/me).
 *
 * Feature probe: the view, and every entry point to it, exist only after
 * GET /api/membership2/plans answers 200. With the gateway off (production
 * today) that path is a 404, nothing is shown, and ?view=membership lands on
 * the existing Store > Membership tab (gaia-ui.js normalizeView).
 *
 * Writes: JSON, credentials included, and a fresh requestId per user action,
 * reused when the same action is retried after a network failure, so the
 * server's idempotency key makes a retry safe.
 */
(function () {
  'use strict';

  const API = '/api/membership2';
  const SUPPORT_URL = 'https://gaiahealers.com/pages/contact-us';
  const RETURN_STATES = {
    done: { tone: 'ok', text: 'Thank you. Your Gaia Healers membership is being set up; it can take a minute to appear.' },
    cancelled: { tone: 'info', text: 'Checkout was cancelled. Nothing has been charged.' },
    coins: { tone: 'ok', text: 'Thank you. Your coins are on their way to your wallet.' },
    migrated: { tone: 'ok', text: 'Thank you. Your move to the new Gaia Healers membership is being set up.' },
  };

  // Captured before the app shell rewrites the URL on boot.
  const initialParams = new URLSearchParams(window.location.search);
  const wantedAtBoot = String(initialParams.get('view') || '').toLowerCase() === 'membership';
  const returnState = initialParams.get('checkout');

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  const base = () => {
    const shared = window.GaiaApi && window.GaiaApi.base && window.GaiaApi.base();
    return String(shared || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  };

  const state = {
    available: null,          // null = probing, true = gateway answers, false = off
    plans: null, coinPacks: [], currency: 'USD',
    env: null,                // { environment, stripeMode } from /plans: drives the staging / test-mode banner
    me: null, coins: null, billing: null,
    auth: null,               // null until the app shell reports the session (gaia:auth), then true / false / 'unavailable'
    signedOut: false, loadError: null, loading: false,
    interval: 'month',
    notice: null,             // { tone, title, body, retry?, support? } for the last action
    busy: '',                 // action key currently in flight
  };
  const pendingIds = new Map(); // action key -> requestId (reused on retry)

  /* ── network ─────────────────────────────────────────────────────────── */

  function newRequestId() {
    const raw = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : Array.from((window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(new Uint8Array(16)) : [], (b) => b.toString(16).padStart(2, '0')).join('') || String(Date.now()) + Math.random().toString(36).slice(2);
    return ('m2-' + raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  }
  const requestIdFor = (action) => {
    if (!pendingIds.has(action)) pendingIds.set(action, newRequestId());
    return pendingIds.get(action);
  };

  async function getJson(path) {
    try {
      const r = await fetch(base() + API + path, { credentials: 'include', headers: { accept: 'application/json' } });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    } catch (_) {
      return { status: 0, body: {} };
    }
  }

  /** Every write goes through here: JSON body, credentials, a requestId. */
  async function postJson(path, action, extra = {}) {
    const requestId = requestIdFor(action);
    try {
      const r = await fetch(base() + API + path, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...extra, requestId }),
      });
      const body = await r.json().catch(() => ({}));
      // A definite answer from the server ends this action; the next click is a new one.
      if (r.status < 500) pendingIds.delete(action);
      return { status: r.status, body };
    } catch (_) {
      return { status: 0, body: {} };     // keep the requestId: a retry is the same action
    }
  }

  /* ── formatting (display only) ───────────────────────────────────────── */

  function money(cents, currency) {
    const n = Number(cents);
    if (!Number.isFinite(n)) return '';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: String(currency || state.currency || 'USD').toUpperCase(), minimumFractionDigits: n % 100 === 0 ? 0 : 2 }).format(n / 100);
    } catch (_) { return (n / 100).toFixed(2); }
  }
  function date(value) {
    const t = Date.parse(value || '');
    return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  }
  const shortDate = (value) => {
    const t = Date.parse(value || '');
    return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  };
  const words = (value) => String(value || '').replace(/[_:.-]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
  const titleWord = (value) => String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const num = (n) => Number(n || 0).toLocaleString();

  const STATUS_TEXT = {
    active: 'Active', trialing: 'Trial', past_due: 'Payment due', unpaid: 'Payment due', paused: 'Paused',
    incomplete: 'Waiting for payment', canceled: 'Cancelled', cancelled: 'Cancelled', ended: 'Ended', expired: 'Ended',
  };
  const INTERVAL_TEXT = { month: 'Monthly', year: 'Annual', none: '' };
  const BUCKET_TEXT = { granted: 'Monthly', goodwill: 'Goodwill', purchased: 'Purchased', legacy: 'Earlier' };

  const planName = (key) => (state.plans || []).find((p) => p.key === key)?.name || titleWord(key);

  /**
   * Per-plan access, from API data only: `plans` is /plans (the gateway returns them in tier order, lowest first),
   * `access` is /me access ([{ key, value }]) and `currentKey` the member's live plan (null: no plan, so the
   * no-payment plan is theirs). Returns what is included, and every benefit of the plans after theirs that they lack,
   * tagged with the first (lowest) plan that includes it. Pure: no state, no DOM (tests run it on its own).
   */
  function accessPanel(plans, access, currentKey) {
    const list = Array.isArray(plans) ? plans : [];
    const labels = {};
    const order = {};   // first appearance in tier order: base benefits first, then what each plan adds
    list.forEach((p) => (p.benefits || []).forEach((b) => { labels[b.key] = b.label; if (!(b.key in order)) order[b.key] = Object.keys(order).length; }));
    const pretty = (key) => String(key || '').replace(/[_:.-]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
    // A benefit with a number (a discount) reads with its value: "Percent off certifications" + 20 -> "20% off certifications".
    const withValue = (label, value) => (typeof value === 'number'
      ? (/^percent off /i.test(label) ? value + '% off ' + label.replace(/^percent off /i, '') : label + ': ' + value) : label);
    let at = currentKey ? list.findIndex((p) => p.key === currentKey) : -1;
    const hasPlan = at >= 0;
    if (!hasPlan) at = list.findIndex((p) => p.prices && p.prices.none != null);
    if (at < 0) at = 0;
    const current = list[at] || null;
    const given = hasPlan
      ? (Array.isArray(access) ? access : []).filter((a) => a && a.value !== false && a.value != null)
      : ((current && current.benefits) || []).map((b) => ({ key: b.key, value: true }));
    const have = new Set(given.map((a) => a.key));
    const included = given.map((a) => ({ key: a.key, label: withValue(labels[a.key] || pretty(a.key), a.value) }))
      .sort((x, y) => (order[x.key] ?? 1e9) - (order[y.key] ?? 1e9));
    const locked = [];
    const seen = new Set();
    list.slice(at + 1).forEach((p) => (p.benefits || []).forEach((b) => {
      if (have.has(b.key) || seen.has(b.key)) return;
      seen.add(b.key);
      locked.push({ key: b.key, label: b.label, unlocksWith: p.name, planKey: p.key });
    }));
    return { current, hasPlan, included, locked, everything: locked.length === 0 };
  }
  // end accessPanel

  /* ── derived views of API data (no decisions) ────────────────────────── */

  const memberships = () => (state.me && Array.isArray(state.me.membership)) ? state.me.membership : [];
  const liveMembership = () => memberships().find((m) => m.hasAccess) || null;
  const legacyLive = () => ((state.me && state.me.legacy) || []).filter((l) => l.state === 'active' || l.state === 'under_review');
  const openOffers = () => ((state.me && state.me.migrationOffers) || []).filter((o) => ['offered', 'accepted', 'checkout_started'].includes(o.status));

  /** Cents per coin, read from the wallet's own coins/usd pairs (the API's rate); null when no bucket shows it. */
  function coinCents() {
    const w = state.me && state.me.wallet;
    if (!w) return null;
    for (const b of Object.values(w)) {
      if (b && typeof b === 'object' && Number(b.coins) > 0 && typeof b.usd === 'string') {
        const usd = Number(b.usd.replace(/[^0-9.]/g, ''));
        if (Number.isFinite(usd)) return (usd * 100) / Number(b.coins);
      }
    }
    return null;
  }

  /** "Included in your plan" / "Not in your plan" for the member's plan (or the no-payment plan when they have none). */
  function accessHtml(currentKey) {
    const a = accessPanel(state.plans, state.me && state.me.access, currentKey);
    if (!a.current) return '';
    const coins = Number(a.current.monthlyCoins) || 0;
    const rate = coinCents();
    const coinItem = coins > 0
      ? '<li class="g-m2__acc-item"><i class="ph ph-coins" aria-hidden="true"></i><span>' + esc(num(coins) + ' coins every month')
        + (rate != null ? ' <span class="g-m2__acc-usd">(' + esc(money(Math.round(coins * rate))) + ' in value)</span>' : '') + '</span></li>' : '';
    const inc = '<section class="g-m2__acc g-m2__acc--in" aria-labelledby="m2-acc-in">'
      + '<h3 class="g-m2__acc-h" id="m2-acc-in">Included in your plan <span class="g-m2__acc-plan">' + esc(a.current.name) + '</span></h3>'
      + '<ul class="g-m2__acc-list" aria-labelledby="m2-acc-in">' + coinItem
      + a.included.map((b) => '<li class="g-m2__acc-item"><i class="ph ph-check-circle" aria-hidden="true"></i><span>' + esc(b.label) + '</span></li>').join('') + '</ul></section>';
    if (a.everything) {
      return '<div class="g-m2__access">' + inc + '<section class="g-m2__acc g-m2__acc--all" aria-labelledby="m2-acc-out"><h3 class="g-m2__acc-h" id="m2-acc-out">Not in your plan</h3>'
        + '<p class="g-m2__acc-done"><i class="ph ph-seal-check" aria-hidden="true"></i> You have everything Gaia Healers membership includes.</p></section></div>';
    }
    const groups = [];
    a.locked.forEach((b) => { const g = groups.find((x) => x.name === b.unlocksWith); if (g) g.items.push(b); else groups.push({ name: b.unlocksWith, items: [b] }); });
    const out = '<section class="g-m2__acc g-m2__acc--out" aria-labelledby="m2-acc-out">'
      + '<h3 class="g-m2__acc-h" id="m2-acc-out">Not in your plan</h3>'
      + groups.map((g, gi) => '<h4 class="g-m2__acc-tier" id="m2-acc-g' + gi + '">Unlocks with ' + esc(g.name) + '</h4>'
        + '<ul class="g-m2__acc-list g-m2__acc-list--locked" aria-labelledby="m2-acc-g' + gi + '">'
        + g.items.map((b) => '<li class="g-m2__acc-item is-locked"><i class="ph ph-lock-simple" aria-hidden="true"></i><span>' + esc(b.label)
          + ' <span class="g-m2__acc-tag">Unlocks with ' + esc(b.unlocksWith) + '</span></span></li>').join('') + '</ul>').join('')
      + '<div class="g-m2__row">' + btn('Compare plans to upgrade', 'data-m2-upgrade', 'primary') + '</div></section>';
    return '<div class="g-m2__access">' + inc + out + '</div>';
  }

  /* ── copy for server answers ─────────────────────────────────────────── */

  function legacyTierName() {
    const l = legacyLive()[0];
    return l && l.tier ? 'Gaia Healers ' + titleWord(l.tier) + ' membership' : 'Gaia Healers membership';
  }

  const NOT_OPEN = { tone: 'info', title: 'Not open yet', body: 'New Gaia Healers memberships are not open to everyone yet. Nothing has been charged. We will let you know as soon as you can join.' };
  const CHANGE_PLAN = { tone: 'info', title: 'Change your plan below', body: 'You already have a Gaia Healers membership. Pick another plan or billing period in the plan list to see exactly what changes and when.' };
  const BILLING_OFF = { tone: 'warn', title: 'Billing isn’t connected in this environment', body: 'Checkout is temporarily unavailable, so nothing has been charged. Please try again later.', retry: true, support: true };
  const SERVICE_DOWN = { tone: 'warn', title: 'Membership is temporarily unavailable', body: 'Please try again shortly. Nothing has been charged or changed.', retry: true, support: true };

  function reasonNotice(reason) {
    switch (reason) {
      case 'pilot_only': case 'migration_not_open': case 'membership2_off': case 'limited_cap_reached':
        return NOT_OPEN;
      case 'legacy_member_use_migration':
        return { tone: 'info', title: 'You already have a membership', body: 'You already have a ' + legacyTierName() + ', billed through your existing plan. Your Gaia Healers account team can move you to the new plans without double billing.', support: true };
      case 'existing_customer':
        return CHANGE_PLAN;
      case 'no_subscription':
        return { tone: 'info', title: 'No plan to change yet', body: 'Choose a plan first; you can change it any time after.' };
      case 'coins_need_membership2':
        return { tone: 'info', title: 'Coin packs come with a membership', body: 'Coin packs are available once you have a Gaia Healers Membership 2.0 plan.' };
      default:
        return { tone: 'warn', title: 'Temporarily unavailable', body: 'This isn’t available right now. Nothing has been charged. Please try again later.', retry: true, support: true };
    }
  }

  /** Plain-language notice for any checkout-like answer. Returns null for ok. */
  function noticeFor(r) {
    const b = r.body || {};
    if (r.status === 0) return { tone: 'error', title: 'Can’t reach Gaia Healers', body: 'Check your connection and try again. Nothing has been charged.', retry: true, support: true };
    if (r.status === 401) return { tone: 'info', title: 'Please sign in', body: 'Sign in to your Gaia Healers account to continue.', signIn: true };
    if (b.code === 'SERVICE_UNAVAILABLE') return SERVICE_DOWN;
    if (b.code === 'PROVIDER_UNAVAILABLE') return BILLING_OFF;
    if (b.ok && b.url) return null;
    switch (b.status) {
      case 'migration_required':
        return reasonNotice('legacy_member_use_migration');
      case 'review_required':
        return { tone: 'info', title: 'A quick check first', body: 'Your account needs a quick check by the Gaia Healers team before a new membership can start. Nothing has been charged.', support: true };
      case 'change_plan_required':
        return CHANGE_PLAN;
      case 'already_subscribed':
        return { tone: 'info', title: 'You already have this plan', body: 'This plan is already active on your account.' };
      case 'change_pending':
        return { tone: 'info', title: 'A plan change is already waiting', body: 'Your membership already has a plan change on the way. You can keep your current plan from My membership, then choose again.' };
      case 'not_changeable':
        return b.reason === 'cancel_scheduled'
          ? { tone: 'info', title: 'Your cancellation is scheduled', body: 'Plans can’t be changed while a cancellation is scheduled. Contact us if you’d like to stay on a different plan.', support: true }
          : { tone: 'info', title: 'This plan can’t be changed right now', body: 'Your membership needs to be active to change plans. Nothing has been charged.', support: true };
      case 'preview_expired':
        return { tone: 'info', title: 'Please check the amount again', body: 'The price shown has expired. Choose the plan again to see the current amount. Nothing has been charged.' };
      case 'no_pending_change':
        return { tone: 'info', title: 'Nothing to cancel', body: 'There is no scheduled plan change on your membership.' };
      case 'not_cancellable':
        return { tone: 'info', title: 'This change is waiting for payment', body: 'An upgrade waiting for payment can’t be cancelled here. If the payment isn’t completed, it lapses on its own and your plan stays as it is.' };
      case 'failed':
        return { tone: 'error', title: 'The plan change didn’t go through', body: 'Nothing has changed on your membership. Please try again or contact us.', support: true };
      case 'not_available':
        return reasonNotice(b.reason);
      default: break;
    }
    if (r.status === 404) return { tone: 'warn', title: 'Not available', body: 'This option is no longer available. Please refresh the page.', retry: true };
    return { tone: 'error', title: 'Something went wrong', body: 'We couldn’t complete that. Nothing has been charged. Please try again.', retry: true, support: true };
  }

  /* ── loading ─────────────────────────────────────────────────────────── */

  let probePromise = null;
  function probe() {
    if (!probePromise) {
      probePromise = getJson('/plans').then((r) => {
        const ok = r.status === 200 && r.body && r.body.ok !== false && Array.isArray(r.body.plans);
        state.available = ok;
        if (ok) {
          state.plans = r.body.plans.slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
          state.coinPacks = Array.isArray(r.body.coinPacks) ? r.body.coinPacks : [];
          state.currency = r.body.currency || 'USD';
          state.env = typeof r.body.environment === 'string' ? { environment: r.body.environment, stripeMode: String(r.body.stripeMode || '') } : null;
        }
        return ok;
      });
    }
    return probePromise;
  }

  async function loadMember() {
    // Ask /me only for a signed-in session: a visitor never sends a request that can only 401.
    if (state.auth === null) { state.loading = true; render(); return; }
    if (state.auth === 'unavailable') { state.loading = false; state.loadError = 'network'; render(); return; }
    if (state.auth === false) { state.loading = false; state.signedOut = true; state.me = null; render(); return; }
    state.loading = true; state.loadError = null;
    render();
    const me = await getJson('/me');
    if (me.status === 401) {
      state.signedOut = true; state.me = null; state.coins = null; state.billing = null;
    } else if (me.status === 200 && me.body && me.body.ok !== false) {
      state.signedOut = false; state.me = me.body;
      const [coins, billing] = await Promise.all([getJson('/me/coins'), getJson('/me/billing')]);
      state.coins = coins.status === 200 ? (coins.body.items || []) : null;
      state.billing = billing.status === 200 ? (billing.body.items || []) : null;
    } else {
      state.loadError = me.status === 0 ? 'network' : (me.body && me.body.code === 'SERVICE_UNAVAILABLE' ? 'service' : 'server');
    }
    state.loading = false;
    render();
  }

  /* ── actions ─────────────────────────────────────────────────────────── */

  function setNotice(n) { state.notice = n; render(); focusNotice(); }
  function focusNotice() {
    window.requestAnimationFrame(() => {
      const el = document.querySelector('[data-m2-notice]');
      if (el && el.focus) el.focus({ preventScroll: false });
    });
  }

  function safeRedirect(url) {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'https:') return false;
      window.location.assign(u.toString());
      return true;
    } catch (_) { return false; }
  }

  async function runCheckout(action, path, payload) {
    if (state.busy) return;
    state.busy = action; state.notice = null; render();
    const r = await postJson(path, action, payload);
    state.busy = '';
    const n = noticeFor(r);
    if (!n && safeRedirect(r.body.url)) return;
    setNotice(n ? { ...n, retryAction: n.retry ? { action, path, payload } : null } : { tone: 'error', title: 'Something went wrong', body: 'Checkout could not start. Nothing has been charged.', support: true });
  }

  function choosePlan(planKey, interval) {
    if (legacyLive().length) { setNotice(reasonNotice('legacy_member_use_migration')); return; }
    const avail = state.me && state.me.availability;
    if (avail && avail.newMembership === false) { setNotice(reasonNotice(avail.newMembershipReason)); return; }
    runCheckout('checkout:' + planKey + ':' + interval, '/checkout', { planKey, interval });
  }

  function buyPack(packKey) {
    const avail = state.me && state.me.availability;
    if (avail && avail.coinPacks === false) { setNotice(reasonNotice(avail.coinPacksReason)); return; }
    runCheckout('coins:' + packKey, '/coins/checkout', { packKey });
  }

  async function cancelMembership(subId) {
    if (state.busy) return;
    state.busy = 'cancel'; state.notice = null; render();
    const preview = await postJson('/subscriptions/' + encodeURIComponent(subId) + '/cancel-preview', 'cancel-preview:' + subId);
    state.busy = '';
    if (preview.status !== 200 || !preview.body.accessEndsAt) { setNotice(noticeFor(preview) || { tone: 'error', title: 'Something went wrong', body: 'We couldn’t check your cancellation date. Nothing has changed.', retry: false, support: true }); return; }
    const ends = date(preview.body.accessEndsAt);
    const sub = memberships().find((m) => m.id === subId);
    const ask = 'Cancel your ' + (sub ? sub.plan_name + ' ' : '') + 'membership?';
    const detail = 'You keep full access until ' + ends + '. You won’t be charged again after that.';
    const yes = window.GaiaNotice && window.GaiaNotice.confirm
      ? await window.GaiaNotice.confirm(ask, { detail, confirmLabel: 'Cancel membership', cancelLabel: 'Keep membership' })
      : window.confirm(ask + '\n' + detail);
    if (!yes) { pendingIds.delete('cancel:' + subId); render(); return; }
    state.busy = 'cancel'; render();
    const r = await postJson('/subscriptions/' + encodeURIComponent(subId) + '/cancel', 'cancel:' + subId);
    state.busy = '';
    if (r.status === 200 && r.body.ok !== false) {
      const end = date(r.body.accessEndsAt) || ends;
      state.notice = { tone: 'ok', title: 'Your cancellation is scheduled', body: 'You keep access until ' + end + '. You won’t be charged again.' };
      await loadMember(); focusNotice(); return;
    }
    setNotice(noticeFor(r) || { tone: 'error', title: 'Something went wrong', body: 'Your membership was not cancelled. Please try again.', support: true });
  }

  /**
   * Plan change: the server decides what kind of change it is and when it applies.
   * 1. change-preview -> plain-language confirm with the server's amount and date;
   * 2. change {planKey, interval, prorationDate, requestId} -> outcome notice and a refresh.
   */
  async function changePlanTo(planKey, interval) {
    if (state.busy) return;
    const live = liveMembership();
    if (!live) return;
    const action = 'change:' + planKey + ':' + interval;
    const base = '/subscriptions/' + encodeURIComponent(live.id);
    state.busy = action; state.notice = null; render();
    const pv = await postJson(base + '/change-preview', 'change-preview:' + planKey + ':' + interval, { planKey, interval });
    state.busy = '';
    if (pv.status !== 200 || !pv.body || pv.body.status !== 'ok') {
      const n = noticeFor(pv) || { tone: 'error', title: 'Something went wrong', body: 'We couldn’t check this change. Nothing has changed.', support: true };
      setNotice({ ...n, retryAction: n.retry ? { change: [planKey, interval] } : null });
      return;
    }
    const p = pv.body;
    const toName = (p.to && p.to.planName) || planName(planKey);
    const fromName = (p.from && p.from.planName) || live.plan_name;
    const toLabel = toName + (p.to && p.from && p.to.interval !== p.from.interval ? ' (' + (INTERVAL_TEXT[p.to.interval] || '').toLowerCase() + ')' : '');
    const now = p.timing === 'after_payment';
    const ask = now ? 'Upgrade to ' + toLabel + '?' : 'Change to ' + toLabel + '?';
    const detail = now
      ? 'You’ll be charged ' + money(p.amountDueNowCents, p.currency) + ' today and get ' + toName + ' right after payment. Your renewal date stays the same.'
      : 'Your plan changes to ' + toLabel + ' on ' + date(p.effectiveAt) + '; you keep ' + fromName + ' until then. Nothing is charged today and nothing is refunded.';
    const yes = window.GaiaNotice && window.GaiaNotice.confirm
      ? await window.GaiaNotice.confirm(ask, { detail, confirmLabel: now ? 'Pay and upgrade' : 'Schedule the change', cancelLabel: 'Not now' })
      : window.confirm(ask + '\n' + detail);
    if (!yes) { pendingIds.delete(action); render(); return; }
    state.busy = action; render();
    const r = await postJson(base + '/change', action, { planKey, interval, ...(p.prorationDate ? { prorationDate: p.prorationDate } : {}) });
    state.busy = '';
    if ((r.status === 200 || r.status === 201) && r.body && r.body.status === 'ok') {
      const c = r.body.change || {};
      state.notice = r.body.outcome === 'scheduled'
        ? { tone: 'ok', title: 'Plan change scheduled', body: 'Your plan changes to ' + toLabel + ' on ' + date(c.effectiveAt || p.effectiveAt) + '. You keep ' + fromName + ' until then.' }
        : r.body.outcome === 'payment_required'
          ? { tone: 'warn', title: 'Payment required', body: 'Your bank needs one more step before the upgrade. You keep ' + fromName + ' until the payment is complete; if it isn’t, nothing changes.' }
          : { tone: 'ok', title: 'Thank you', body: 'Your payment is being confirmed. ' + toName + ' appears here right after, usually within a minute.' };
      await loadMember(); focusNotice(); return;
    }
    const n = noticeFor(r) || { tone: 'error', title: 'Something went wrong', body: 'Your plan was not changed. Please try again.', support: true };
    setNotice({ ...n, retryAction: n.retry ? { change: [planKey, interval] } : null });
  }

  async function keepCurrentPlan(subId) {
    if (state.busy) return;
    const m = memberships().find((x) => x.id === subId);
    const ask = 'Keep your ' + (m ? m.plan_name + ' ' : '') + 'plan?';
    const detail = 'The scheduled change is cancelled. Your membership continues as it is today.';
    const yes = window.GaiaNotice && window.GaiaNotice.confirm
      ? await window.GaiaNotice.confirm(ask, { detail, confirmLabel: 'Keep my current plan', cancelLabel: 'Go back' })
      : window.confirm(ask + '\n' + detail);
    if (!yes) return;
    state.busy = 'keep:' + subId; state.notice = null; render();
    const r = await postJson('/subscriptions/' + encodeURIComponent(subId) + '/change/cancel', 'keep:' + subId);
    state.busy = '';
    if (r.status === 200 && r.body && r.body.status === 'ok') {
      state.notice = { tone: 'ok', title: 'You’re keeping your current plan', body: 'The scheduled change was cancelled. Nothing else changes.' };
      await loadMember(); focusNotice(); return;
    }
    const n = noticeFor(r) || { tone: 'error', title: 'Something went wrong', body: 'The scheduled change is still in place. Please try again.', support: true };
    setNotice({ ...n, retryAction: n.retry ? { keep: subId } : null });
  }

  async function acceptOffer(offerId) {
    if (state.busy) return;
    state.busy = 'accept:' + offerId; state.notice = null; render();
    const r = await postJson('/migration/' + encodeURIComponent(offerId) + '/accept', 'accept:' + offerId);
    state.busy = '';
    if (r.status === 200 && r.body.ok !== false) {
      state.notice = { tone: 'ok', title: 'Offer accepted', body: 'Next, continue to checkout to set up the new plan. You won’t be billed twice.' };
      await loadMember(); focusNotice(); return;
    }
    setNotice(noticeFor(r) || { tone: 'error', title: 'Something went wrong', body: 'The offer was not accepted. Please try again.', retry: false, support: true });
  }

  /* ── rendering ───────────────────────────────────────────────────────── */

  const root = () => document.getElementById('m2-root');
  const btn = (label, attrs, kind = 'primary', busy = false) =>
    '<button type="button" class="g-btn g-btn--' + kind + ' g-btn--sm" ' + attrs + (busy ? ' disabled aria-busy="true"' : '') + '>' + esc(busy ? 'Please wait…' : label) + '</button>';
  const supportLink = () => '<a class="g-m2__support" href="' + SUPPORT_URL + '" target="_blank" rel="noopener">Contact Gaia Healers Support</a>';
  const section = (id, title, inner, extra = '') =>
    '<section class="g-m2__sec" aria-labelledby="m2-h-' + id + '"' + extra + '><h2 class="g-m2__h" id="m2-h-' + id + '">' + esc(title) + '</h2>' + inner + '</section>';

  function noticeHtml() {
    const n = state.notice;
    if (!n) return '';
    return '<div class="g-ann g-ann--' + (n.tone === 'ok' ? 'success' : n.tone === 'error' || n.tone === 'warn' ? 'warn' : 'info') + ' g-m2__notice" data-m2-notice tabindex="-1">'
      + '<span class="g-ann__title">' + esc(n.title) + '</span><span class="g-ann__body">' + esc(n.body) + '</span>'
      + '<span class="g-m2__notice-actions">'
      + (n.retryAction ? btn('Try again', 'data-m2-retry', 'secondary') : '')
      + (n.signIn ? btn('Sign in', 'data-m2-signin', 'secondary') : '')
      + (n.support ? supportLink() : '')
      + '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-m2-dismiss>Dismiss</button>'
      + '</span></div>';
  }

  function intervalToggle() {
    const intervals = ['month', 'year'].filter((i) => (state.plans || []).some((p) => p.prices && p.prices[i] != null));
    if (intervals.length < 2) return '';
    return '<div class="g-tabs g-m2__toggle" role="group" aria-label="Billing period">'
      + intervals.map((i) => '<button type="button" class="g-tab' + (state.interval === i ? ' is-active' : '') + '" aria-pressed="' + (state.interval === i) + '" data-m2-interval="' + i + '">' + (i === 'month' ? 'Monthly' : 'Annual') + '</button>').join('')
      + '</div>';
  }

  function priceBlock(plan) {
    const prices = plan.prices || {};
    const iv = state.interval;
    if (prices[iv] != null) {
      const amount = Number(prices[iv]);
      let extra = '';
      if (iv === 'year' && prices.month != null && Number(prices.month) > 0) {
        const perMonth = money(Math.round(amount / 12));
        const freeMonths = Math.round((12 * Number(prices.month) - amount) / Number(prices.month));
        extra = '<span class="g-m2__price-note">' + esc(perMonth) + ' a month, billed yearly</span>'
          + (freeMonths >= 1 ? '<span class="g-badge g-badge--on g-m2__save">' + esc(freeMonths + (freeMonths === 1 ? ' month' : ' months') + ' free') + '</span>' : '');
      }
      return '<p class="g-m2__price"><span class="g-m2__amount">' + esc(money(amount)) + '</span><span class="g-m2__per">' + (iv === 'year' ? '/ year' : '/ month') + '</span></p>' + extra;
    }
    if (prices.none != null) {
      const amount = Number(prices.none);
      return '<p class="g-m2__price"><span class="g-m2__amount">' + esc(amount === 0 ? 'Free' : money(amount)) + '</span></p>';
    }
    return '<p class="g-m2__price g-m2__price--na">Not offered ' + (iv === 'year' ? 'yearly' : 'monthly') + '</p>';
  }

  function planAction(plan) {
    const prices = plan.prices || {};
    const live = liveMembership();
    if (live && live.plan_key === plan.key && (live.billing_interval === state.interval || prices[state.interval] == null)) return '<p class="g-m2__plan-state">Your current plan</p>';
    if (prices[state.interval] == null) return prices.none != null ? '<p class="g-m2__plan-state">No payment needed</p>' : '';
    if (state.signedOut) return btn('Sign in to choose', 'data-m2-signin', 'secondary');
    if (!state.me) return '';
    if (legacyLive().length) return '<p class="g-m2__plan-state">Your account team can move you</p>';
    if (live) {
      if (live.source === 'legacy_import') return '<p class="g-m2__plan-state">Your account team can move you</p>';
      if (live.pendingChange) return '<p class="g-m2__plan-state">A plan change is waiting</p>';
      const same = live.plan_key === plan.key;
      const label = same ? (state.interval === 'year' ? 'Switch to annual billing' : 'Switch to monthly billing') : 'Switch to ' + plan.name;
      return btn(label, 'data-m2-change-to="' + esc(plan.key) + '" aria-label="' + esc(label + ', ' + (state.interval === 'year' ? 'annual' : 'monthly') + ' billing') + '"', 'secondary', state.busy === 'change:' + plan.key + ':' + state.interval);
    }
    const key = 'checkout:' + plan.key + ':' + state.interval;
    return btn('Choose ' + plan.name, 'data-m2-choose="' + esc(plan.key) + '" aria-label="Choose the ' + esc(plan.name) + ' plan, ' + (state.interval === 'year' ? 'annual' : 'monthly') + ' billing"', 'primary', state.busy === key);
  }

  // Long benefit lists fold after the first few so four plans stay comparable; all labels come from the API.
  const FOLD_AFTER = 8;
  function benefitsHtml(list) {
    const li = (b) => '<li><i class="ph ph-check" aria-hidden="true"></i><span>' + esc(b.label) + '</span></li>';
    const head = '<ul class="g-m2__benefits">' + list.slice(0, FOLD_AFTER).map(li).join('') + '</ul>';
    if (list.length <= FOLD_AFTER) return head;
    return head + '<details class="g-m2__more"><summary>Show all ' + list.length + ' benefits</summary><ul class="g-m2__benefits">' + list.slice(FOLD_AFTER).map(li).join('') + '</ul></details>';
  }

  function plansHtml() {
    const plans = state.plans || [];
    const live = liveMembership();
    const avail = state.me && state.me.availability;
    const head = (avail && avail.newMembership === false && !live && !legacyLive().length)
      ? '<p class="g-m2__hint"><i class="ph ph-info" aria-hidden="true"></i> ' + esc(reasonNotice(avail.newMembershipReason).title) + ': you can compare plans now; joining opens later.</p>' : '';
    const noPlan = state.me && !live && !legacyLive().length;
    const cards = plans.map((p, i) => {
      const current = live ? live.plan_key === p.key : Boolean(noPlan && p.prices && p.prices.none != null);
      const prev = i > 0 ? plans[i - 1] : null;
      const prevKeys = new Set(((prev && prev.benefits) || []).map((b) => b.key));
      const adds = prev ? (p.benefits || []).filter((b) => !prevKeys.has(b.key)) : (p.benefits || []);
      return '<article class="g-card g-m2__plan' + (current ? ' is-current' : '') + '" aria-label="' + esc(p.name) + (current ? ' (your plan)' : '') + '">'
        + '<header class="g-m2__plan-head"><h3 class="g-m2__plan-name">' + esc(p.name) + '</h3>' + (current ? '<span class="g-badge g-badge--on">Your plan</span>' : '') + '</header>'
        + priceBlock(p)
        + (Number(p.monthlyCoins) > 0 ? '<p class="g-m2__coins"><i class="ph ph-coins" aria-hidden="true"></i> ' + esc(num(p.monthlyCoins)) + ' coins every month</p>' : '')
        + (prev ? '<p class="g-m2__adds">Everything in ' + esc(prev.name) + ', plus:</p>' : '')
        + benefitsHtml(adds)
        + '<div class="g-m2__plan-act">' + planAction(p) + '</div>'
        + '</article>';
    }).join('');
    return section('plans', 'Compare plans', intervalToggle() + head + '<div class="g-m2__plans">' + cards + '</div>');
  }

  function dashboardHtml() {
    if (state.signedOut) {
      return section('mine', 'My membership', '<div class="g-card g-m2__card"><p>Sign in to see your membership, coins and billing.</p>' + btn('Sign in', 'data-m2-signin') + '</div>');
    }
    if (!state.me) return '';
    const subs = memberships();
    const m = liveMembership() || subs[0];
    if (!m) {
      if (legacyLive().length) return '';            // the legacy section below is their membership
      return section('mine', 'My membership', '<div class="g-card g-m2__card"><p class="g-m2__lead">You don’t have a Gaia Healers Membership 2.0 plan yet.</p>'
        + '<p class="g-card__meta">Compare the plans below to see what each one includes.</p>' + accessHtml(null) + '</div>');
    }
    const status = STATUS_TEXT[m.status] || words(m.status);
    const rows = [
      ['Plan', m.plan_name || planName(m.plan_key)],
      ['Status', status + (m.hasAccess ? '' : ' (no access)')],
      ['Billing', INTERVAL_TEXT[m.billing_interval] ?? words(m.billing_interval)],
    ];
    if (m.cancel_at) rows.push(['Access ends', date(m.cancel_at)]);
    else if (m.status === 'trialing' && m.trial_end) rows.push(['Trial ends', date(m.trial_end)]);
    else if (m.current_period_end && m.hasAccess) rows.push(['Renews on', date(m.current_period_end)]);
    const banner = m.cancel_at
      ? '<div class="g-ann g-ann--warn g-m2__banner" role="status"><span class="g-ann__title">Cancellation scheduled</span><span class="g-ann__body">Your ' + esc(m.plan_name) + ' membership ends on ' + esc(date(m.cancel_at)) + '. You keep access until then and won’t be charged again.</span></div>' : '';
    const canCancel = m.hasAccess && !m.cancel_at && ['active', 'trialing', 'past_due'].includes(m.status);
    const changeBanner = pendingChangeHtml(m);
    return section('mine', 'My membership', banner + changeBanner
      + '<div class="g-card g-m2__card"><dl class="g-m2__dl">' + rows.filter((r) => r[1]).map((r) => '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>').join('') + '</dl>'
      + (m.hasAccess ? accessHtml(m.plan_key) : '')
      + '<div class="g-m2__row">' + (m.hasAccess && !m.pendingChange && !m.cancel_at && m.source !== 'legacy_import' && !legacyLive().length ? btn('Change plan', 'data-m2-change', 'secondary') : '')
      + (canCancel ? btn('Cancel membership', 'data-m2-cancel="' + esc(m.id) + '"', 'ghost', state.busy === 'cancel') : '') + '</div>'
      + '</div>');
  }

  /** The pending plan change, in plain words from the server's answer (/me membership[].pendingChange). */
  function pendingChangeHtml(m) {
    const c = m.pendingChange;
    if (!c) return '';
    const to = (c.toPlanName || planName(c.toPlan)) + ((c.toInterval && c.toInterval !== m.billing_interval) ? ' (' + (INTERVAL_TEXT[c.toInterval] || words(c.toInterval)).toLowerCase() + ')' : '');
    const banner = (tone, title, body, actions) => '<div class="g-ann g-ann--' + tone + ' g-m2__banner" role="status"><span class="g-ann__title">' + esc(title) + '</span><span class="g-ann__body">' + esc(body) + '</span>'
      + (actions ? '<span class="g-m2__notice-actions">' + actions + '</span>' : '') + '</div>';
    if (c.status === 'scheduled') {
      return banner('info', 'Plan change scheduled', 'Your plan changes to ' + to + ' on ' + date(c.effectiveAt) + '. You keep ' + m.plan_name + ' until then. Nothing is charged before that date.',
        btn('Keep my current plan', 'data-m2-keep="' + esc(m.id) + '"', 'secondary', state.busy === 'keep:' + m.id));
    }
    if (c.status === 'pending_payment' && c.paymentRequired) {
      const pay = c.paymentUrl && /^https:\/\//.test(c.paymentUrl) ? '<a class="g-btn g-btn--primary g-btn--sm" href="' + esc(c.paymentUrl) + '" target="_blank" rel="noopener">Complete payment</a>' : '';
      return banner('warn', 'Payment required', 'Your upgrade to ' + to + ' starts right after payment. Until then you keep ' + m.plan_name + '. If the payment isn’t completed, nothing changes.', pay + supportLink());
    }
    return banner('info', 'Your plan change is on its way', 'Your upgrade to ' + to + ' is being confirmed. It appears here as soon as the payment is confirmed; you keep ' + m.plan_name + ' until then.', btn('Refresh', 'data-m2-reload', 'ghost'));
  }

  function legacyHtml() {
    const rows = legacyLive();
    const offers = openOffers();
    if (!rows.length && !offers.length) return '';
    const cards = rows.map((l) => '<div class="g-card g-m2__card">'
      + '<p class="g-m2__lead">Gaia Healers ' + esc(titleWord(l.tier || 'member')) + ' membership</p>'
      + '<p>Billed through your existing plan' + (l.paidThrough ? ', paid through ' + esc(date(l.paidThrough)) : '') + '.</p>'
      + (l.state === 'under_review' ? '<p class="g-card__meta">Our team is checking this membership. Nothing changes for you in the meantime.</p>' : '')
      + '<p class="g-card__meta">You don’t need to buy a new plan. Your Gaia Healers account team can move you to the new plans without double billing.</p>'
      + '<p class="g-card__meta">Your current plan stays as it is until you choose to move.</p>'
      + '</div>').join('');
    const offerCards = offers.map((o) => {
      const target = planName(o.target_plan) + ' (' + (INTERVAL_TEXT[o.target_interval] || words(o.target_interval)).toLowerCase() + ')';
      const action = o.status === 'offered'
        ? btn('Accept offer', 'data-m2-accept="' + esc(o.id) + '"', 'primary', state.busy === 'accept:' + o.id)
        : btn('Continue to checkout', 'data-m2-migrate="' + esc(o.id) + '"', 'primary', state.busy === 'migrate:' + o.id);
      return '<div class="g-card g-m2__card g-m2__offer"><p class="g-m2__lead">Your move to ' + esc(target) + '</p>'
        + '<p>' + (o.from_tier ? 'From your ' + esc(titleWord(o.from_tier)) + ' membership. ' : '')
        + (o.billing_starts_at ? 'Billing on the new plan starts on ' + esc(date(o.billing_starts_at)) + ', so you won’t pay twice.' : 'You won’t pay twice for the same period.') + '</p>'
        + '<div class="g-m2__row">' + action + '</div></div>';
    }).join('');
    return section('legacy', 'Your current membership', cards + offerCards);
  }

  function coinsHtml() {
    if (!state.me || !state.me.wallet) return '';
    const w = state.me.wallet;
    const tile = (label, b) => '<div class="g-m2__tile"><span class="g-m2__tile-k">' + esc(label) + '</span><span class="g-m2__tile-v">' + esc(num(b && b.coins)) + '</span><span class="g-m2__tile-usd">' + esc((b && b.usd) || '') + '</span></div>';
    const items = Array.isArray(state.coins) ? state.coins : null;
    const hist = items === null ? '<p class="g-card__meta">Coin history isn’t available right now.</p>'
      : !items.length ? '<p class="g-card__meta">No coin activity yet.</p>'
        : '<ul class="g-m2__list">' + items.map((i) => {
          const net = Object.values(i.byBalance || {}).reduce((s, v) => s + Number(v || 0), 0);
          return '<li><span class="g-m2__list-main">' + esc(words(i.reason || i.kind)) + '</span><span class="g-m2__list-meta">' + esc(shortDate(i.at)) + '</span><span class="g-m2__list-amt' + (net < 0 ? ' is-neg' : '') + '">' + esc((net > 0 ? '+' : '') + num(net)) + '</span></li>';
        }).join('') + '</ul>';
    return section('coins', 'Coins', '<div class="g-card g-m2__card"><div class="g-m2__tiles' + (w.goodwill ? ' g-m2__tiles--4' : '') + '">'
      + tile('Monthly', w.granted) + (w.goodwill ? tile('Goodwill', w.goodwill) : '') + tile('Purchased', w.purchased) + tile('Earlier', w.legacy) + '</div>'
      + (w.goodwill ? '<p class="g-card__meta">Goodwill coins are a gift from the Gaia Healers team. They never expire.</p>' : '')
      + (Array.isArray(w.spendOrder) && w.spendOrder.length ? '<p class="g-card__meta">Coins are used in this order: ' + esc(w.spendOrder.map((k) => BUCKET_TEXT[k] || words(k)).join(', ')) + '.</p>' : '')
      + '<p class="g-m2__total">Total: <strong>' + esc(num(w.total && w.total.coins)) + ' coins</strong> (' + esc((w.total && w.total.usd) || '') + ')</p>'
      + (w.nextGrantAt ? '<p class="g-card__meta">Next monthly coins: ' + esc(date(w.nextGrantAt)) + '</p>' : '')
      + '<p class="g-m2__sub">History</p>' + hist + '</div>');
  }

  function packsHtml() {
    const packs = state.coinPacks || [];
    if (!packs.length) return section('packs', 'Coin packs', '<div class="g-card g-m2__card"><p>Coin packs are coming soon.</p></div>');
    return section('packs', 'Coin packs', '<div class="g-m2__packs">' + packs.map((p) => '<div class="g-card g-m2__card g-m2__pack">'
      + '<p class="g-m2__lead">' + esc(num(p.coins)) + ' coins' + (Number(p.bonus_coins) > 0 ? ' + ' + esc(num(p.bonus_coins)) + ' bonus' : '') + '</p>'
      + '<p class="g-m2__amount">' + esc(money(p.price_cents, p.currency)) + '</p>'
      + (state.signedOut ? btn('Sign in to buy', 'data-m2-signin', 'secondary') : state.me ? btn('Buy coins', 'data-m2-pack="' + esc(p.key) + '" aria-label="Buy ' + esc(num(p.coins)) + ' coins"', 'primary', state.busy === 'coins:' + p.key) : '')
      + '</div>').join('') + '</div>');
  }

  function billingHtml() {
    if (!state.me) return '';
    const items = Array.isArray(state.billing) ? state.billing : null;
    const what = (w) => w === 'coin_pack' ? 'Coin pack' : /^membership:/.test(String(w)) ? planName(String(w).slice(11)) + ' membership' : words(w);
    const list = items === null ? '<p class="g-card__meta">Billing history isn’t available right now.</p>'
      : !items.length ? '<p class="g-card__meta">No payments yet.</p>'
        : '<ul class="g-m2__list">' + items.map((i) => '<li><span class="g-m2__list-main">' + esc(what(i.what)) + '<span class="g-m2__list-type">' + esc(words(i.type)) + '</span></span><span class="g-m2__list-meta">' + esc(shortDate(i.at)) + '</span><span class="g-m2__list-amt">' + esc(money(i.amountCents, i.currency)) + '</span></li>').join('') + '</ul>';
    return section('billing', 'Billing history', '<div class="g-card g-m2__card">' + list
      + '<p class="g-m2__secure"><i class="ph ph-lock-simple" aria-hidden="true"></i> Invoices and payment methods are managed securely by Stripe. Gaia Healers never sees or stores your card details.</p></div>');
  }

  /** Anything but production with live Stripe (as /plans reports it) gets a small test-mode marker. */
  function envBannerHtml() {
    const e = state.env;
    if (!e || (e.environment === 'production' && e.stripeMode === 'live')) return '';
    return '<p class="g-m2__env" role="note" data-m2-env><strong>' + esc(e.environment === 'production' ? 'TEST MODE' : 'STAGING / TEST MODE') + '</strong> '
      + esc(e.stripeMode === 'live' ? 'This is not the live app.' : 'Payments here are not real.') + '</p>';
  }

  function errorHtml() {
    if (!state.loadError) return '';
    return '<div class="g-ann g-ann--warn g-m2__notice" role="alert"><span class="g-ann__title">' + (state.loadError === 'network' ? 'Can’t reach Gaia Healers' : state.loadError === 'service' ? 'Membership is temporarily unavailable' : 'Your membership couldn’t load') + '</span>'
      + '<span class="g-ann__body">Please try again. If it keeps happening, our support team can help.</span>'
      + '<span class="g-m2__notice-actions">' + btn('Try again', 'data-m2-reload', 'secondary') + supportLink() + '</span></div>';
  }

  function render() {
    const el = root();
    if (!el || state.available !== true) return;
    const active = document.activeElement;
    const keep = active && el.contains(active) ? (active.getAttribute('data-m2-interval') ? '[data-m2-interval="' + active.getAttribute('data-m2-interval') + '"]' : null) : null;
    el.setAttribute('aria-busy', String(state.loading));
    el.innerHTML = envBannerHtml() + '<div class="g-page__head"><p class="g-page__kicker">Preview</p>'
      + '<h1 class="g-page__title">Gaia Healers Membership 2.0</h1>'
      + '<p class="g-page__sub">Compare plans, see your coins and manage your membership in one place.</p></div>'
      + '<div class="g-m2__live" role="status" aria-live="polite">' + (state.loading ? 'Loading your membership…' : '') + '</div>'
      + noticeHtml() + errorHtml()
      + dashboardHtml() + legacyHtml() + plansHtml() + coinsHtml() + packsHtml() + billingHtml()
      + '<p class="g-m2__foot">Questions about your membership? ' + supportLink() + '</p>';
    if (keep) el.querySelector(keep)?.focus();
  }

  /** "Compare plans to upgrade": to the plan list, focus on its first choice. */
  function showPlans() {
    window.requestAnimationFrame(() => {
      const h = document.getElementById('m2-h-plans');
      if (h && h.scrollIntoView) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const first = document.querySelector('[data-m2-choose], [data-m2-change-to], [data-m2-interval]');
      if (first && first.focus) first.focus({ preventScroll: true });
    });
  }

  /** "Change plan": the choices are the plan list (plan + Monthly / Annual toggle). */
  function showChoices() {
    state.notice = CHANGE_PLAN; render();
    window.requestAnimationFrame(() => {
      const h = document.getElementById('m2-h-plans');
      if (h && h.scrollIntoView) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const first = document.querySelector('[data-m2-change-to], [data-m2-interval]');
      if (first && first.focus) first.focus({ preventScroll: true });
    });
  }

  function onClick(e) {
    const t = e.target.closest('button, a');
    if (!t || !root()?.contains(t)) return;
    const d = t.dataset;
    if (d.m2Interval) { state.interval = d.m2Interval; render(); }
    else if (d.m2Choose) choosePlan(d.m2Choose, state.interval);
    else if (t.hasAttribute('data-m2-upgrade')) showPlans();
    else if (d.m2Pack) buyPack(d.m2Pack);
    else if (d.m2Cancel) cancelMembership(d.m2Cancel);
    else if (d.m2Accept) acceptOffer(d.m2Accept);
    else if (d.m2Migrate) runCheckout('migrate:' + d.m2Migrate, '/migration/' + encodeURIComponent(d.m2Migrate) + '/checkout', {});
    else if (d.m2ChangeTo) changePlanTo(d.m2ChangeTo, state.interval);
    else if (d.m2Keep) keepCurrentPlan(d.m2Keep);
    else if (t.hasAttribute('data-m2-change')) showChoices();
    else if (t.hasAttribute('data-m2-signin')) window.GaiaAuth?.open?.();
    else if (t.hasAttribute('data-m2-reload')) loadMember();
    else if (t.hasAttribute('data-m2-dismiss')) { state.notice = null; render(); }
    else if (t.hasAttribute('data-m2-retry')) {
      const ra = state.notice && state.notice.retryAction;
      state.notice = null;
      if (ra && ra.change) changePlanTo(ra.change[0], ra.change[1]);
      else if (ra && ra.keep) keepCurrentPlan(ra.keep);
      else if (ra) runCheckout(ra.action, ra.path, ra.payload); else render();
    }
  }

  /* ── entry points (only once the probe succeeds) ─────────────────────── */

  function entryCard(where) {
    return '<a class="g-card g-card--interactive g-m2-entry" href="home.html?view=membership" data-m2-entry="' + where + '">'
      + '<i class="ph ph-sparkle" aria-hidden="true"></i><span class="g-m2-entry__body"><span class="g-m2-entry__title">Gaia Healers Membership 2.0 — preview</span>'
      + '<span class="g-m2-entry__sub">See the new plans, coins and your membership dashboard.</span></span><span aria-hidden="true">›</span></a>';
  }
  function mountEntry(id, followId) {
    const slot = document.getElementById(id);
    const follow = document.getElementById(followId);
    if (!slot || !follow) return;
    slot.innerHTML = entryCard(id);
    const sync = () => { slot.hidden = follow.hidden; };
    sync();
    new MutationObserver(sync).observe(follow, { attributes: true, attributeFilter: ['hidden'] });
  }

  /* ── routing ─────────────────────────────────────────────────────────── */

  let loadedOnce = false;
  function onRoute(view) {
    if (view !== 'membership') return;
    if (state.available !== true) { window.GaiaAppShell?.go?.('store', { tab: 'membership', replace: true }); return; }
    render();
    if (!loadedOnce) { loadedOnce = true; loadMember(); }
  }

  function showReturnToast() {
    const r = RETURN_STATES[returnState];
    if (!r) return;
    window.GaiaNotice?.toast?.(r.text, { tone: r.tone });
    state.notice = { tone: r.tone === 'ok' ? 'ok' : 'info', title: r.tone === 'ok' ? 'Thank you' : 'Checkout cancelled', body: r.text, keep: true };
    try {
      const u = new URL(window.location.href); u.searchParams.delete('checkout');
      window.history.replaceState(window.history.state, '', u.pathname + (u.search || ''));
    } catch (_) { /* ignore */ }
  }

  window.GaiaMembership2 = Object.freeze({ available: () => state.available === true });

  probe();
  document.addEventListener('gaia:auth', (e) => {
    const d = (e && e.detail) || {};
    const next = d.unavailable ? 'unavailable' : Boolean(d.authenticated);
    const changed = next !== state.auth;
    state.auth = next;
    if (!changed) return;
    state.me = null; state.coins = null; state.billing = null; state.signedOut = false; state.notice = state.notice && state.notice.keep ? state.notice : null;
    if (state.available && window.GaiaAppShell?.currentView?.() === 'membership') { loadedOnce = true; loadMember(); } else loadedOnce = false;
  });
  document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', onClick);
    window.addEventListener('gaia:route', (e) => onRoute(e && e.detail && e.detail.view));
    probe().then((ok) => {
      if (!ok) {                                        // gateway off: nothing appears anywhere
        // gaia-ui.js already sent ?view=membership to the Store; make sure it is the Membership tab
        // (the shell drops a Store tab from the URL while the profile check runs).
        if (wantedAtBoot) {
          const toTab = () => window.GaiaStoreTabs?.activate?.('membership');
          if (window.GaiaAppShell?.currentView?.() === 'store') toTab();
          const once = (e) => { if (e?.detail?.view === 'store') { toTab(); window.removeEventListener('gaia:route', once); } };
          window.addEventListener('gaia:route', once);
        }
        return;
      }
      mountEntry('m2-entry-store', 'store-memberships');
      mountEntry('m2-entry-you', 'member-me');
      if (wantedAtBoot) {
        showReturnToast();
        window.GaiaAppShell?.go?.('membership', { replace: true });
      } else if (window.GaiaAppShell?.currentView?.() === 'membership') onRoute('membership');
    });
  });
})();
