/** Gaia — Favourites and My Schedule.
 *
 * A conference agenda is a list of everything happening. My Schedule is the
 * much shorter list of what *you* decided to do, and by the second morning it
 * is the only one anybody opens.
 *
 * It lives on the server, against the person rather than the device. Someone
 * plans their conference on a laptop the night before and works from a phone in
 * the corridor the next day; a schedule kept in localStorage would not make that
 * trip, and a hallway between talks is exactly when nobody will rebuild it.
 *
 * Clashes are shown, never prevented. Two talks in the same hour is a normal
 * thing to want — you are choosing between them, or catching half of each — and
 * refusing the save would be the app overruling a decision it cannot see.
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

  // Per event: the saved ids, and the full schedule once asked for.
  const state = { eventId: null, savedIds: null, schedule: null, busy: new Set() };

  async function api(path, body) {
    const options = {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    };
    if (body !== undefined) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(proxyBase() + path, options);
      return await response.json();
    } catch (_) {
      return { ok: false, reason: 'network' };
    }
  }

  /** Load the schedule for an event. Returns null when the person holds no ticket. */
  async function load(eventId) {
    const data = await api('/api/events/' + encodeURIComponent(eventId) + '/schedule');
    if (!data || data.ok !== true) {
      state.eventId = eventId;
      state.savedIds = null;   // distinct from "none saved"
      state.schedule = null;
      return null;
    }
    state.eventId = eventId;
    state.savedIds = new Set(data.saved_ids || []);
    state.schedule = data;
    return data;
  }

  const isSaved = (sessionId) => Boolean(state.savedIds && state.savedIds.has(Number(sessionId)));
  /** Whether this visitor may save at all — i.e. holds a ticket for this event. */
  const canSave = () => state.savedIds instanceof Set;

  async function toggle(eventId, sessionId) {
    const id = Number(sessionId);
    if (state.busy.has(id)) return null;
    state.busy.add(id);
    try {
      const action = isSaved(id) ? 'unsave' : 'save';
      const result = await api('/api/events/' + encodeURIComponent(eventId) + '/schedule',
        { sessionId: id, action });
      if (result && Array.isArray(result.saved_ids)) {
        state.savedIds = new Set(result.saved_ids);
        // The schedule is now stale; it reloads next time it is opened.
        state.schedule = null;
      }
      return result;
    } finally {
      state.busy.delete(id);
    }
  }

  /** The save control for one agenda row. Absent entirely for non-ticket-holders. */
  function saveButtonHtml(sessionId) {
    if (!canSave()) return '';
    const saved = isSaved(sessionId);
    return '<button type="button" class="g-save' + (saved ? ' is-on' : '') + '"'
      + ' data-save-session="' + esc(sessionId) + '"'
      + ' aria-pressed="' + (saved ? 'true' : 'false') + '"'
      + ' title="' + (saved ? 'Saved to My Schedule' : 'Save to My Schedule') + '">'
      + '<span class="g-save__icon" aria-hidden="true">' + (saved ? '★' : '☆') + '</span>'
      + '<span class="g-save__label">' + (saved ? 'Saved' : 'Save') + '</span>'
      + '</button>';
  }

  function timeLabel(iso, timezone) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: timezone || 'UTC', hour: 'numeric', minute: '2-digit',
      }).format(new Date(iso));
    } catch (_) { return ''; }
  }

  function dayLabel(key, timezone) {
    if (key === 'unscheduled') return 'Not yet scheduled';
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: timezone || 'UTC', weekday: 'long', day: 'numeric', month: 'long',
      }).format(new Date(key + 'T12:00:00Z'));
    } catch (_) { return key; }
  }

  function sessionRow(session, timezone, byId) {
    const when = [timeLabel(session.start_time, timezone), timeLabel(session.end_time, timezone)]
      .filter(Boolean).join(' – ');
    const speakers = (session.speakers || []).map((s) => s.name).filter(Boolean).join(', ');
    const clashes = (session.clashes_with || [])
      .map((id) => byId[id] && byId[id].title).filter(Boolean);

    return '<article class="g-mysch__item' + (clashes.length ? ' has-clash' : '') + '">'
      + '<div class="g-mysch__time">' + esc(when || '—') + '</div>'
      + '<div class="g-mysch__body">'
      + '<h4 class="g-mysch__title">' + esc(session.title) + '</h4>'
      + (speakers ? '<p class="g-mysch__who">' + esc(speakers) + '</p>' : '')
      + (session.room ? '<p class="g-mysch__where">' + esc(session.room) + '</p>' : '')
      + (clashes.length
        // Named, not just flagged: "clashes with something" makes a person go
        // hunting for which.
        ? '<p class="g-mysch__clash">Overlaps ' + esc(clashes.join(', ')) + '</p>'
        : '')
      + '</div>'
      + saveButtonHtml(session.id)
      + '</article>';
  }

  function panelHtml(timezone) {
    const data = state.schedule;
    if (!data) return '';

    if (!data.saved_count) {
      return '<section class="g-mysch g-mysch--empty">'
        + '<h3>Your schedule is empty</h3>'
        + '<p>Save any session from the agenda and it will appear here — '
        + 'on whichever device you open Gaia with.</p></section>';
    }

    const byId = {};
    (data.days || []).forEach((day) => (day.sessions || []).forEach((s) => { byId[s.id] = s; }));

    return '<section class="g-mysch">'
      + '<div class="g-mysch__head">'
      + '<h3>My schedule</h3>'
      + '<span class="g-mysch__count">' + data.saved_count
      + (data.saved_count === 1 ? ' session' : ' sessions') + '</span>'
      + '</div>'
      + (data.clash_count
        ? '<p class="g-mysch__warn">Some of these overlap. Both are kept — '
          + 'you may be choosing between them.</p>'
        : '')
      + (data.days || []).map((day) => '<div class="g-mysch__day">'
        + '<h4 class="g-mysch__dayhead">' + esc(dayLabel(day.date, timezone)) + '</h4>'
        + (day.sessions || []).map((s) => sessionRow(s, timezone, byId)).join('')
        + '</div>').join('')
      + '</section>';
  }

  /**
   * Wire every save control inside a container.
   *
   * Re-reads its own button rather than re-rendering the page, so the agenda
   * does not jump under the finger that just tapped it.
   */
  function bind(root, eventId, onChange) {
    root.querySelectorAll('[data-save-session]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = button.dataset.saveSession;
        button.disabled = true;
        const result = await toggle(eventId, id);
        button.disabled = false;
        if (!result || result.ok !== true) return;
        const saved = isSaved(id);
        button.classList.toggle('is-on', saved);
        button.setAttribute('aria-pressed', saved ? 'true' : 'false');
        button.querySelector('.g-save__icon').textContent = saved ? '★' : '☆';
        button.querySelector('.g-save__label').textContent = saved ? 'Saved' : 'Save';
        button.title = saved ? 'Saved to My Schedule' : 'Save to My Schedule';
        if (typeof onChange === 'function') onChange(saved, id);
      });
    });
  }

  window.GaiaMySchedule = {
    load, toggle, isSaved, canSave, saveButtonHtml, panelHtml, bind,
    get state() { return state; },
  };
}());
