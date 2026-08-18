/** Gaia — People: the attendee directory and connections.
 *
 * Off by default twice over. The organiser turns networking on per event, and
 * even then nobody appears until they put themselves in — a directory of
 * ticket buyers is something people join, not something that happens to them.
 *
 * What the directory shows is what a conference badge shows: name, company,
 * role, and a line they wrote. Email crosses over exactly once, when both
 * sides have agreed — a connection request, accepted. Declining tells the
 * asker nothing.
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

  const state = { eventId: null, directory: null, connections: null, available: null };

  async function call(eventId, action, extra) {
    try {
      const response = await fetch(proxyBase() + '/api/events/' + encodeURIComponent(eventId) + '/networking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, ...(extra || {}) }),
      });
      return await response.json();
    } catch (_) {
      return { ok: false, reason: 'network' };
    }
  }

  async function load(eventId) {
    state.eventId = eventId;
    const [directory, connections] = await Promise.all([
      call(eventId, 'directory'),
      call(eventId, 'connections'),
    ]);
    state.directory = directory && directory.ok ? directory : null;
    state.connections = connections && connections.ok ? connections : null;
    // Distinguish "not available here" from "available, person not joined":
    // disabled events and non-ticket-holders get no tab at all.
    state.available = Boolean(directory && (directory.ok
      || (directory.reason !== 'networking_disabled'
        && directory.reason !== 'no_ticket_for_event'
        && directory.reason !== 'auth_required')));
    return state;
  }

  const available = () => state.available === true || Boolean(state.directory);

  function personCard(person) {
    const connection = person.connection;
    let action;
    if (!connection) {
      action = '<button type="button" class="g-btn g-btn--secondary g-btn--sm" data-people-connect="'
        + esc(person.attendee_id) + '">Connect</button>';
    } else if (connection.status === 'accepted') {
      action = '<span class="g-people__state is-good">Connected</span>';
    } else if (connection.status === 'pending' && connection.direction === 'sent') {
      action = '<span class="g-people__state">Requested</span>';
    } else if (connection.status === 'pending') {
      action = '<span class="g-people__state">Awaiting your reply below</span>';
    } else {
      // Declined: shown to the decliner as nothing at all, and to the asker as
      // a plain Connect that will simply never resolve — refusal is private.
      action = '<span class="g-people__state">Requested</span>';
    }
    return '<article class="g-people__card">'
      + '<div class="g-people__who">'
      + '<h4>' + esc(person.name || 'Attendee') + '</h4>'
      + (person.job_title || person.company
        ? '<p>' + esc([person.job_title, person.company].filter(Boolean).join(' · ')) + '</p>' : '')
      + (person.bio ? '<p class="g-people__bio">' + esc(person.bio) + '</p>' : '')
      + '</div>' + action + '</article>';
  }

  function requestRow(person, incoming) {
    return '<article class="g-people__card">'
      + '<div class="g-people__who"><h4>' + esc(person.name || 'Attendee') + '</h4>'
      + (person.company ? '<p>' + esc([person.job_title, person.company].filter(Boolean).join(' · ')) + '</p>' : '')
      + '</div>'
      + (incoming
        ? '<span class="g-people__respond">'
          + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-people-respond="'
          + esc(person.connection_id) + '" data-accept="1">Accept</button>'
          + '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-people-respond="'
          + esc(person.connection_id) + '" data-accept="0">Decline</button></span>'
        : '<span class="g-people__state">Waiting</span>')
      + '</article>';
  }

  function connectedRow(person) {
    return '<article class="g-people__card">'
      + '<div class="g-people__who"><h4>' + esc(person.name || 'Attendee') + '</h4>'
      + (person.company ? '<p>' + esc([person.job_title, person.company].filter(Boolean).join(' · ')) + '</p>' : '')
      // The exchanged address — the one place it appears, because both agreed.
      + (person.email ? '<p class="g-people__email"><a href="mailto:' + esc(person.email) + '">'
        + esc(person.email) + '</a></p>' : '')
      + '</div><span class="g-people__state is-good">Connected</span></article>';
  }

  function panelHtml() {
    const dir = state.directory;
    if (!dir) return '';
    const me = dir.me || { visible: false, bio: '' };
    const connections = state.connections || { incoming: [], outgoing: [], accepted: [] };

    const joinPanel = '<div class="g-people__join' + (me.visible ? ' is-on' : '') + '">'
      + (me.visible
        ? '<p><strong>You are in the directory.</strong> Other attendees can find you and ask to connect.</p>'
          + '<label class="g-people__biolabel"><span>Your line</span>'
          + '<input type="text" maxlength="400" value="' + esc(me.bio) + '" placeholder="What should people ask you about?" data-people-bio /></label>'
          + '<button type="button" class="g-btn g-btn--ghost g-btn--sm" data-people-leave>Leave the directory</button>'
        : '<p><strong>Meet the people here.</strong> Join the directory and other attendees can '
          + 'find you by name, company and role. Your email stays private until you accept a connection.</p>'
          + '<button type="button" class="g-btn g-btn--primary g-btn--sm" data-people-join>Join the directory</button>')
      + '</div>';

    const section = (title, rows) => (rows
      ? '<div class="g-people__group"><h3>' + esc(title) + '</h3>' + rows + '</div>' : '');

    return '<section class="g-people">'
      + joinPanel
      + section('Wants to connect with you',
        (connections.incoming || []).map((p) => requestRow(p, true)).join(''))
      + section('Your connections',
        (connections.accepted || []).map(connectedRow).join(''))
      + section('Waiting for a reply',
        (connections.outgoing || []).map((p) => requestRow(p, false)).join(''))
      + (me.visible
        ? section('At this event', (dir.people || []).map(personCard).join('')
          || '<p class="g-people__empty">Nobody else has joined the directory yet.</p>')
        : '')
      + '</section>';
  }

  function bind(root, eventId, rerender) {
    root.querySelector('[data-people-join]')?.addEventListener('click', async () => {
      await call(eventId, 'profile', { visible: true, bio: '' });
      await load(eventId);
      rerender();
    });
    root.querySelector('[data-people-leave]')?.addEventListener('click', async () => {
      const bio = root.querySelector('[data-people-bio]')?.value || '';
      await call(eventId, 'profile', { visible: false, bio });
      await load(eventId);
      rerender();
    });
    const bio = root.querySelector('[data-people-bio]');
    if (bio) {
      let timer = null;
      bio.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => call(eventId, 'profile', { visible: true, bio: bio.value }), 600);
      });
    }
    root.querySelectorAll('[data-people-connect]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        await call(eventId, 'connect', { targetAttendeeId: Number(button.dataset.peopleConnect) });
        await load(eventId);
        rerender();
      });
    });
    root.querySelectorAll('[data-people-respond]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        await call(eventId, 'respond', {
          connectionId: Number(button.dataset.peopleRespond),
          accept: button.dataset.accept === '1',
        });
        await load(eventId);
        rerender();
      });
    });
  }

  window.GaiaPeople = { load, available, panelHtml, bind, get state() { return state; } };
}());
