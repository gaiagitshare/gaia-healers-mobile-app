/** Gaia — the digital badge card behind the printed QR.
 *
 * The sticker on a physical badge carries one short URL. Scanned by staff it
 * checks the person in; scanned by any phone camera it opens THIS card. The
 * card is empty until its owner claims it here, and every field is opt-in:
 * nothing from checkout (email, phone) is shown unless they switch it on.
 *
 * Two entry points:
 *   1. Inside the ticket sheet — "Your badge card": status, preview, editor.
 *   2. A scanned link (?card=TOKEN): connect with that person, or with
 *      &claim=1, open the editor for the owner's own card.
 */
(function () {
  'use strict';

  function proxyBase() {
    const localOverride = /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname)
      ? new URLSearchParams(window.location.search).get('apiBase') : '';
    if (localOverride && /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(localOverride)) return localOverride.replace(/\/+$/, '');
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase)
      || (window.GAIA_APP_URLS && window.GAIA_APP_URLS.production && window.GAIA_APP_URLS.production.proxy)
      || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(path, body, method) {
    const options = { credentials: 'include', headers: { Accept: 'application/json' }, method: method || (body ? 'POST' : 'GET') };
    if (body) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    try {
      const response = await fetch(proxyBase() + path, options);
      if (response.status === 401) return { ok: false, authenticated: false, reason: 'auth_required' };
      return await response.json();
    } catch (_) {
      return { ok: false, reason: 'unreachable' };
    }
  }

  const state = { card: null, eventId: null, saving: false };

  // ── Inside the ticket sheet ───────────────────────────────────────────────

  function prettyUrl(url) {
    return String(url || '').replace(/^https?:\/\//i, '');
  }

  function blockHtml(card) {
    const status = card.public
      ? '<span class="g-card__pill is-on">Public</span>'
      : '<span class="g-card__pill">Not set up</span>';
    const views = card.public && card.views
      ? '<span class="g-card__views">Opened ' + esc(card.views) + (card.views === 1 ? ' time' : ' times') + '</span>' : '';
    return '<div class="g-card" data-card-block>'
      + '<div class="g-card__head"><h3 class="g-card__title">Your badge card</h3>' + status + views + '</div>'
      + '<p class="g-card__lead">The QR on your printed badge opens a digital card with the details <em>you</em> choose to share — '
      + 'so a new contact can save you in one tap.</p>'
      + '<a class="g-card__url" href="' + esc(card.card_url) + '" target="_blank" rel="noopener">' + esc(prettyUrl(card.card_url)) + '</a>'
      + '<div class="g-card__actions">'
      + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-card-edit>' + (card.public ? 'Edit my card' : 'Set up my card') + '</button>'
      + '<a class="g-btn g-btn--secondary g-btn--sm" href="' + esc(card.card_url) + '" target="_blank" rel="noopener">Preview</a>'
      + '</div></div>';
  }

  async function inject(eventId, shell) {
    const panel = shell && shell.querySelector('.g-ticket__panel');
    if (!panel || panel.querySelector('[data-card-block]')) return;
    const card = await api('/api/events/' + encodeURIComponent(eventId) + '/card');
    if (!card || card.ok !== true || !document.body.contains(panel)) return;
    state.card = card; state.eventId = eventId;
    const upg = panel.querySelector('.g-upg');
    const html = blockHtml(card);
    if (upg) upg.insertAdjacentHTML('beforebegin', html);
    else panel.insertAdjacentHTML('beforeend', html);
    panel.querySelector('[data-card-edit]').addEventListener('click', () => openEditor(eventId));
  }

  // ── The editor ────────────────────────────────────────────────────────────

  function field(label, name, value, hint, attrs) {
    return '<label class="g-card__field"><span>' + esc(label) + '</span>'
      + '<input type="text" name="' + name + '" value="' + esc(value) + '" ' + (attrs || '') + ' />'
      + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>';
  }
  function toggle(label, name, on, hint) {
    return '<label class="g-card__toggle"><span><b>' + esc(label) + '</b>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span>'
      + '<input type="checkbox" name="' + name + '"' + (on ? ' checked' : '') + ' /><i aria-hidden="true"></i></label>';
  }

  function editorHtml(card) {
    const f = card.fields || {};
    const initials = String(card.name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
    return '<div class="g-card__panel" role="dialog" aria-modal="true" aria-label="Your badge card">'
      + '<button type="button" class="g-ticket__close" data-card-close aria-label="Close">&times;</button>'
      + '<p class="g-ticket__event">' + esc(card.event_name || '') + '</p>'
      + '<h2 class="g-card__h2">Your badge card</h2>'
      + '<form class="g-card__form" data-card-form>'
      + '<div class="g-card__photo">'
      + '<div class="g-card__avatar" data-card-avatar>' + (f.photo_url ? '<img src="' + esc(f.photo_url) + '" alt="" />' : esc(initials || 'G')) + '</div>'
      + '<label class="g-btn g-btn--secondary g-btn--sm g-card__upload">' + (f.photo_url ? 'Change photo' : 'Add photo')
      + '<input type="file" accept="image/*" data-card-photo hidden /></label>'
      + '<small data-card-photo-hint>Square works best. Stored at 512px, without location data.</small>'
      + '</div>'
      + '<p class="g-card__name">' + esc(card.name) + '</p>'
      + field('Name on the card', 'display_name', f.display_name, 'Leave empty to use the name on your ticket: ' + (card.name || ''))
      + field('Headline', 'headline', f.headline, 'One line under your name — what you do, for whom.', 'maxlength="90"')
      + field('Company / practice', 'company', f.company, '')
      + field('Title / role', 'title', f.title, '')
      + field('City', 'city', f.city, '')
      + '<label class="g-card__field"><span>A line about you</span><textarea name="bio" maxlength="400" rows="2">' + esc(card.bio || '') + '</textarea></label>'
      + field('Interests', 'tags', (f.tags || []).join(', '), 'Up to four, comma-separated — e.g. Reiki, Sound healing')
      + '<label class="g-card__field"><span>Offerings / services</span><textarea name="services" rows="3" placeholder="One per line — e.g. 1:1 Reiki session">' + esc((f.services || []).join('\n')) + '</textarea><small>Up to six. Shown as a list on your card.</small></label>'
      + field('Booking link', 'booking_url', f.booking_url, 'Becomes a "Book with you" button at the top of your card.', 'inputmode="url" placeholder="calendly.com/you or your booking page"')
      + '<div class="g-card__field"><span>Card colour</span><div class="g-card__themes">'
      + (card.themes || ['gaia']).map((t) => '<label class="g-card__theme g-card__theme--' + esc(t) + '"><input type="radio" name="theme" value="' + esc(t) + '"' + ((f.theme || 'gaia') === t ? ' checked' : '') + ' /><i aria-hidden="true"></i><span>' + esc(t) + '</span></label>').join('')
      + '</div></div>'
      + '<h4 class="g-card__sub">Links</h4>'
      + field('Website', 'website', f.website, '', 'inputmode="url" placeholder="yourwebsite.com"')
      + field('Instagram', 'instagram', f.instagram, '', 'placeholder="@handle"')
      + field('LinkedIn', 'linkedin', f.linkedin, '', 'placeholder="profile name or URL"')
      + field('Facebook', 'facebook', f.facebook, '', 'placeholder="page name or URL"')
      + field('TikTok', 'tiktok', f.tiktok, '', 'placeholder="@handle"')
      + field('YouTube', 'youtube', f.youtube, '', 'placeholder="@channel or URL"')
      + field('WhatsApp', 'whatsapp', f.whatsapp, 'Number with country code. Shown as a tap-to-chat link.', 'inputmode="tel" placeholder="+1 407 555 0100"')
      + '<h4 class="g-card__sub">Contact details</h4>'
      + '<p class="g-card__note">These come from your ticket and stay private unless you switch them on.</p>'
      + toggle('Show my email', 'show_email', f.show_email, card.email_on_file || '')
      + (card.phone_on_file ? toggle('Show my phone', 'show_phone', f.show_phone, card.phone_on_file) : '')
      + '<div class="g-card__publish">'
      + toggle('Card is public', 'public', card.public, 'Anyone who scans your badge can open it. Off = the link shows only your name.')
      + '</div>'
      + '<p class="g-card__status" data-card-status aria-live="polite"></p>'
      + '<div class="g-card__actions"><button type="submit" class="g-btn g-btn--primary">Save</button>'
      + '<a class="g-btn g-btn--secondary" href="' + esc(card.card_url) + '" target="_blank" rel="noopener">Preview</a></div>'
      + '</form></div>';
  }

  function closeEditor() {
    const open = document.querySelector('.g-card__sheet');
    if (open) open.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(ev) { if (ev.key === 'Escape') closeEditor(); }

  async function openEditor(eventId) {
    closeEditor();
    const sheet = document.createElement('div');
    sheet.className = 'g-ticket g-card__sheet';
    sheet.innerHTML = '<div class="g-ticket__panel g-ticket__panel--loading"><p>Loading your card…</p></div>';
    document.body.appendChild(sheet);
    document.addEventListener('keydown', onKey);
    sheet.addEventListener('click', (ev) => { if (ev.target === sheet) closeEditor(); });
    let card = state.card && String(state.eventId) === String(eventId) ? state.card : null;
    if (!card) card = eventId ? await api('/api/events/' + encodeURIComponent(eventId) + '/card') : await api('/api/card');
    if (!card || card.ok !== true) {
      sheet.innerHTML = '<div class="g-ticket__panel"><button type="button" class="g-ticket__close" data-card-close aria-label="Close">&times;</button>'
        + '<h2>Card unavailable</h2><p class="g-card__note">' + (card && card.authenticated === false
          ? 'Sign in to set up your badge card.' : 'We could not load your card just now. Your ticket is unaffected.') + '</p></div>';
      sheet.querySelector('[data-card-close]').addEventListener('click', closeEditor);
      return;
    }
    state.card = card; state.eventId = eventId;
    sheet.innerHTML = editorHtml(card);
    bindEditor(sheet, eventId);
  }

  function bindEditor(sheet, eventId) {
    sheet.querySelector('[data-card-close]').addEventListener('click', closeEditor);
    const form = sheet.querySelector('[data-card-form]');
    const status = sheet.querySelector('[data-card-status]');
    const say = (text, tone) => { status.textContent = text; status.className = 'g-card__status' + (tone ? ' is-' + tone : ''); };

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (state.saving) return;
      state.saving = true; say('Saving…');
      const data = new FormData(form);
      const body = {};
      ['display_name', 'headline', 'company', 'title', 'city', 'bio', 'website', 'booking_url', 'instagram', 'linkedin', 'facebook', 'tiktok', 'youtube', 'whatsapp'].forEach((k) => { body[k] = String(data.get(k) || ''); });
      body.tags = String(data.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4);
      body.services = String(data.get('services') || '').split(/\n|,/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
      body.theme = String(data.get('theme') || 'gaia');
      body.show_email = data.get('show_email') === 'on';
      body.show_phone = data.get('show_phone') === 'on';
      body.public = data.get('public') === 'on';
      const result = eventId ? await api('/api/events/' + encodeURIComponent(eventId) + '/card', body) : await api('/api/card', body);
      state.saving = false;
      if (result && result.ok === true) {
        state.card = result;
        say(result.public ? 'Saved. Your card is live.' : 'Saved. Your card stays private until you make it public.', 'good');
        refreshBlock();
        renderProfileHosts();
      } else {
        say(result && result.authenticated === false ? 'Please sign in again.' : 'Could not save. Please try again.', 'bad');
      }
    });

    const photo = sheet.querySelector('[data-card-photo]');
    photo.addEventListener('change', async () => {
      const file = photo.files && photo.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { say('That photo is over 5MB.', 'bad'); return; }
      say('Uploading photo…');
      try {
        const photoPath = eventId ? '/api/events/' + encodeURIComponent(eventId) + '/card/photo' : '/api/card/photo';
        const response = await fetch(proxyBase() + photoPath, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
        });
        const result = await response.json();
        if (result && result.ok && result.url) {
          sheet.querySelector('[data-card-avatar]').innerHTML = '<img src="' + esc(result.url) + '" alt="" />';
          if (state.card && state.card.fields) state.card.fields.photo_url = result.url;
          say('Photo updated.', 'good');
        } else {
          say((result && (result.detail || result.reason)) ? 'Could not upload: ' + (result.detail || result.reason) : 'Could not upload that photo.', 'bad');
        }
      } catch (_) { say('Could not upload that photo.', 'bad'); }
    });
  }

  function refreshBlock() {
    const block = document.querySelector('[data-card-block]');
    if (!block || !state.card) return;
    block.outerHTML = blockHtml(state.card);
    const next = document.querySelector('[data-card-block]');
    if (next) next.querySelector('[data-card-edit]').addEventListener('click', () => openEditor(state.eventId));
  }

  // ── A scanned badge link (?card=TOKEN[&claim=1]) ─────────────────────────

  function toast(text, tone) {
    const el = document.createElement('div');
    el.className = 'g-card__toast' + (tone ? ' is-' + tone : '');
    el.setAttribute('role', 'status');
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('is-in'), 20);
    setTimeout(() => { el.classList.remove('is-in'); setTimeout(() => el.remove(), 400); }, 5200);
  }

  // Sign-in is the app's own magic-link flow (window.GaiaAuth). The email goes
  // to the address on the ticket; opening it proves the person. We wait for
  // the session to appear, then finish what the scan started.
  async function waitForSession(maxMs) {
    const until = Date.now() + (maxMs || 10 * 60 * 1000);
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await api('/api/auth/session');
      if (s && s.authenticated) return true;
    }
    return false;
  }
  function requireSignIn(reason) {
    toast(reason, 'warn');
    if (window.GaiaAuth && typeof window.GaiaAuth.open === 'function') window.GaiaAuth.open('');
    return waitForSession();
  }

  let handled = false;
  async function handleScannedLink() {
    if (handled) return;
    const params = new URLSearchParams(window.location.search);
    const token = String(params.get('card') || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(token)) return;
    handled = true;
    const claim = params.get('claim') === '1';

    let session = await api('/api/auth/session');
    if (!session || !session.authenticated) {
      const ok = await requireSignIn(claim
        ? 'Sign in with the email on your ticket to set up your badge card.'
        : 'Sign in to connect — the request is sent from your own badge.');
      if (!ok) return;
    }

    if (claim) {
      // The URL never grants editing. The proxy re-proves ownership from the
      // session against the badge behind this token.
      const own = await api('/api/card/claim', { token });
      if (own && own.ok && own.owner && own.event_id) {
        openEditor(own.event_id);
        toast(own.claimed ? 'This is your badge — edit your card below.' : 'This is your badge — set up your card below.', 'good');
      } else if (own && own.ok && !own.owner) {
        toast('This badge belongs to someone else. You can connect with them from your own account.', 'warn');
      } else {
        toast('Could not check this badge right now. Please try again.', 'warn');
      }
      return;
    }

    const mine = await api('/api/events/mine');
    const events = ((mine && mine.events) || []).filter((e) => e.phase !== 'past');
    const target = events[0] || ((mine && mine.events) || [])[0];
    if (!target) { toast('No ticket found on this account.', 'warn'); return; }
    const result = await api('/api/events/' + encodeURIComponent(target.id) + '/networking', { action: 'connectByToken', token });
    if (result && result.ok === true) {
      toast(result.already
        ? 'You and ' + (result.target_name || 'this person') + ' are already ' + (result.status === 'accepted' ? 'connected.' : 'in touch — request pending.')
        : 'Connection request sent to ' + (result.target_name || 'this person') + '.', 'good');
    } else if (result && result.reason === 'networking_disabled') {
      toast('Networking opens once the organiser turns it on for this event.', 'warn');
    } else if (result && result.reason === 'cannot_connect_to_self') {
      toast('That’s your own badge — add &claim=1 or open your ticket to edit your card.', 'warn');
    } else {
      toast('This person is not reachable for connections yet.', 'warn');
    }
  }

  document.addEventListener('gaia:superapp-rendered', handleScannedLink);
  document.addEventListener('DOMContentLoaded', () => setTimeout(handleScannedLink, 800));

  // ── "My badge card" in the person's profile ──────────────────────────────
  // Anywhere a [data-badgecard-host] exists (the You / profile view), list the
  // person's badge cards with the exact QR that is on their badge, so a new
  // member sees the card they just created, can share it, and can edit it
  // without going through the ticket sheet.
  async function renderProfileHosts() {
    const hosts = document.querySelectorAll('[data-badgecard-host]');
    if (!hosts.length) return;
    // The card is the person's, not a ticket's: no event id, and it keeps
    // answering after every event they attended has ended or been removed.
    const c = await api('/api/card');
    hosts.forEach((host) => {
      if (!c || c.ok !== true) { host.innerHTML = ''; return; }
      const evs = (c.events || []).map((e) => '<li><span class="g-cardtile__dot"></span>'
        + esc(e.label) + '<span class="g-cardtile__role">' + esc(e.role || 'Participant') + '</span></li>').join('');
      host.innerHTML = '<section class="g-cardtile__wrap"><p class="g-super-kicker">Your badge</p><h2 class="g-cardtile__h2">My badge card</h2>'
        + '<article class="g-cardtile">'
        + '<div class="g-cardtile__qr">' + (c.qr_image ? '<img src="' + esc(c.qr_image) + '" alt="Your badge QR" />' : '') + '</div>'
        + '<div class="g-cardtile__body">'
        + '<p class="g-cardtile__name">' + esc((c.fields && c.fields.display_name) || c.name) + '</p>'
        + '<a class="g-card__url" href="' + esc(c.card_url) + '" target="_blank" rel="noopener">' + esc(prettyUrl(c.card_url)) + '</a>'
        + '<p class="g-cardtile__state">' + (c.public
            ? '<span class="g-card__pill is-on">Public</span>' + (c.views ? ' <span class="g-card__views">Opened ' + esc(c.views) + 'x</span>' : '')
            : '<span class="g-card__pill">' + (c.claimed_at ? 'Private' : 'Not set up') + '</span>') + '</p>'
        + '<div class="g-card__actions"><button type="button" class="g-btn g-btn--primary g-btn--sm" data-cardtile-edit>'
        + (c.public || c.claimed_at ? 'Edit my card' : 'Set up my card') + '</button>'
        + '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-cardtile-share>Share</button></div>'
        + '</div></article>'
        + (evs ? '<ul class="g-cardtile__events">' + evs + '</ul>' : '')
        + '<p class="g-cardtile__hint">This is the same QR printed on your badge. It keeps working after the event ends \u2014 edit your card any time and nothing is reprinted.</p></section>';
      host.querySelector('[data-cardtile-edit]').addEventListener('click', () => { state.card = c; state.eventId = 0; openEditor(0); });
      host.querySelector('[data-cardtile-share]').addEventListener('click', async () => {
        try {
          if (navigator.share) await navigator.share({ title: c.name + ' \u2014 Gaia Healers badge card', url: c.card_url });
          else { await navigator.clipboard.writeText(c.card_url); toast('Link copied.', 'good'); }
        } catch (_) { /* dismissed */ }
      });
    });
  }

  document.addEventListener('gaia:superapp-rendered', renderProfileHosts);
  document.addEventListener('gaia:profile-rendered', renderProfileHosts);
  document.addEventListener('DOMContentLoaded', () => setTimeout(renderProfileHosts, 600));

  window.GaiaCard = { inject, openEditor, closeEditor, renderProfileHosts };
})();
