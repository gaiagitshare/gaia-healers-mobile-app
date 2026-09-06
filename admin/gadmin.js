/* Gaia Admin — operator console (vanilla, single-origin with /api/admin). */
(function () {
  'use strict';
  var API = '/api/admin';
  var root = document.getElementById('root');
  var drawerEl = document.getElementById('drawer');
  var scrimEl = document.getElementById('scrim');
  var toastEl = document.getElementById('toast');

  // ---- tiny helpers ----
  function h(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var TOKEN = ''; try { TOKEN = localStorage.getItem('gha_token') || ''; } catch (e) {}
  // Keep the Event admin's own token key ('token') in sync so the embedded
  // /event iframe is signed in with the same session (single sign-on).
  function setToken(t) { TOKEN = t || ''; try { if (t) { localStorage.setItem('gha_token', t); localStorage.setItem('token', t); } else { localStorage.removeItem('gha_token'); localStorage.removeItem('token'); } } catch (e) {} }
  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    return fetch(API + path, Object.assign({ credentials: 'same-origin' }, opts, { headers: headers }))
      .then(function (r) { if (r.status === 401) { setToken(''); loginScreen('Your session expired — sign in again.'); return { ok: false, __401: true }; } return r.json().catch(function () { return {}; }); });
  }
  function evPost(path, body, form) {
    var headers = form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    return fetch('/event-api' + path, { method: 'POST', headers: headers, body: form ? body : JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); });
  }
  var toastT;
  function toast(msg, err) { toastEl.textContent = msg; toastEl.className = 'toast is-on' + (err ? ' err' : ''); clearTimeout(toastT); toastT = setTimeout(function () { toastEl.className = 'toast'; }, 2600); }
  function initials(name) { var p = String(name || '?').trim().split(/\s+/); return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '') || (name || '?')[0]; }

  var ICON = {
    contacts: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    survey: '<path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    event: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    member: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8 7 17M17 7l2.8-2.8"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    tag: '<path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1V2l-2 1-2-1-2 1-2-1-2 1-2-1Z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
    system: '<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="19" r="2.4"/><circle cx="19" cy="19" r="2.4"/><path d="M12 7.4v4M12 11.4 5.8 16.8M12 11.4l6.2 5.4"/>'
  };
  function fmtDate(iso) { if (!iso) return '—'; try { var d = new Date(iso); if (isNaN(d)) return '—'; return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return '—'; } }
  function money(a) { if (a == null || isNaN(a)) return '—'; return '$' + (Number.isInteger(a) ? a : Number(a).toFixed(2)); }
  function svg(name, cls) { return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + '</svg>'; }

  function tagClass(t) {
    if (/_interest$/.test(t)) return 't-interest';
    if (/_owner$|owner$/.test(t)) return 't-owner';
    if (/^community[-_]|-member$|community_feature/.test(t)) return 't-community';
    if (/membership|diamond|gold|silver|free|ahc-/.test(t)) return 't-member';
    return '';
  }

  // ================= STATE / ROUTER =================
  var view = 'contacts';
  function nav(v) { view = v; render(); location.hash = v; }

  function render() {
    root.innerHTML = shell();
    document.querySelectorAll('[data-nav]').forEach(function (el) { el.onclick = function () { nav(el.dataset.nav); }; });
    var lo = document.getElementById('logout'); if (lo) lo.onclick = doLogout;
    var cp = document.getElementById('changepw'); if (cp) cp.onclick = changePasswordModal;
    var ab = document.getElementById('alertbtn');
    if (ab) {
      ab.onclick = openAlerts;
      refreshAlertBadge();
      // The badge has to be right without anybody navigating anywhere.
      if (!window.__alertPoll) window.__alertPoll = setInterval(refreshAlertBadge, 120000);
    }
    if (view === 'contacts') mountContacts();
    else if (view === 'surveys') mountSurveys();
    else if (view === 'membership') mountMembership();
    else if (view === 'events') mountEvents();
    else if (view === 'system') mountSystem();
  }

  function shell() {
    function item(id, label, icon, ext) {
      if (ext) return '<a class="nav__item" href="' + ext + '" target="_blank" rel="noopener">' + svg(icon, 'nav__ico') + label + '<span class="nav__ext">' + svg('ext') + '</span></a>';
      return '<div class="nav__item ' + (view === id ? 'is-active' : '') + '" data-nav="' + id + '">' + svg(icon, 'nav__ico') + label + '</div>';
    }
    var titles = {
      contacts: ['Contacts', 'Search, filter by tag, and edit any contact’s tags & survey answers'],
      surveys: ['Surveys', 'The onboarding questions and how the answers branch'],
      membership: ['Membership', 'Members by tier and status — Diamond, Gold, Silver'],
      events: ['Events', 'Your Event Manager — right inside the admin'],
      system: ['System Map', 'How the whole Gaia Healers system fits together — live']
    };
    var t = titles[view] || ['', ''];
    return ''
      + '<div class="app">'
      + '  <aside class="side">'
      + '    <div class="brand"><img src="gaia-mark.svg" alt=""><div><b>Gaia Healers</b><span>Admin</span></div></div>'
      + item('contacts', 'Contacts', 'contacts')
      + item('surveys', 'Surveys', 'survey')
      + item('membership', 'Membership', 'member')
      + item('events', 'Events', 'event')
      + item('system', 'System Map', 'system')
      + '    <div class="nav__sp"></div>'
      + '    <button class="nav__item alertbtn" id="alertbtn">' + svg('lock', 'nav__ico')
      + '<span>System Alerts</span><span class="alertbtn__n" id="alertn"></span></button>'
      + '    <div class="nav__item" id="changepw">' + svg('lock', 'nav__ico') + 'Change password</div>'
      + '    <div class="nav__item" id="logout">' + svg('logout', 'nav__ico') + 'Sign out</div>'
      + '    <div class="side__foot">Gaia Healers &middot; live from GHL</div>'
      + '  </aside>'
      + '  <main class="main">'
      + '    <div class="top"><div><h2>' + esc(t[0]) + '</h2><div class="sub">' + esc(t[1]) + '</div></div><div class="top__spacer"></div><div id="topright"></div></div>'
      + '    <div class="content" id="content"></div>'
      + '  </main>'
      + '</div>';
  }

  // ================= CONTACTS =================
  // Facets — friendly labels mapped to the underlying tag families (OR within a
  // facet, AND across facets). Everything is live from the tag taxonomy.
  var FACETS = [
    { key: 'tier', label: 'Membership', opts: [
      { l: 'Diamond', t: ['gaia-diamond-active', 'ahc-diamond-active', 'membership_diamond', 'diamond-membership'] },
      { l: 'Gold', t: ['ahc-gold-active', 'ahc-gold-trial'] },
      { l: 'Silver', t: ['ahc-silver-active', 'membership_silver', 'silver-membership'] },
      { l: 'Free', t: ['gaia-free-active', 'ahc-free-active', 'membership_free', 'free-membership'] } ] },
    { key: 'interest', label: 'Interested in', opts: [
      { l: 'BioPulsar', t: ['product_biopulsar_interest'] }, { l: 'Bio-Well', t: ['product_biowell_interest'] },
      { l: 'Healy', t: ['product_healy_interest'] }, { l: 'BioTekna', t: ['product_biotekna_ppg_interest', 'product_biotekna_heg_interest', 'product_biotekna_bia_interest', 'product_biotekna_regmatex_interest', 'product_biotekna_tomeex_interest'] },
      { l: 'BrainTap', t: ['product_braintap_interest'] }, { l: 'Tachyon', t: ['product_tachyon_interest'] },
      { l: 'ASEA', t: ['product_asea_interest'] }, { l: 'LifeWave', t: ['product_lifewave_interest'] },
      { l: 'Colour Energy', t: ['product_colourenergy_interest'] }, { l: 'Quantum Sound', t: ['product_quantum_sound_therapy_interest'] },
      { l: 'Water', t: ['product_biowell_water_interest', 'product_general_water_interest'] } ] },
    { key: 'owns', label: 'Owns', opts: [
      { l: 'Bio-Well', t: ['product_biowell_owner', 'biowell owner', 'biowell-owner'] }, { l: 'BioPulsar', t: ['product_biopulsar_owner', 'biopulsar-owner'] },
      { l: 'Healy', t: ['product_healy_owner'] }, { l: 'BrainTap', t: ['product_braintap_owner'] }, { l: 'HealeeX', t: ['healeex-owner', 'healeex owner'] } ] },
    { key: 'stage', label: 'Practice stage', opts: [
      { l: 'Pre-launch', t: ['practice_stage_prelaunch'] }, { l: 'Early (<1yr)', t: ['practice_stage_early'] }, { l: 'Growth (1–3yr)', t: ['practice_stage_growth'] } ] },
    { key: 'goal', label: 'Healing goal', opts: [
      { l: 'Professional', t: ['interest_professional_healing'] }, { l: 'Personal', t: ['interest_personal_healing'] },
      { l: 'Pets', t: ['interest_pet_health'] }, { l: 'Livestock', t: ['interest_livestock_health'] }, { l: 'Wildlife', t: ['interest_wildlife_health'] } ] },
    { key: 'community', label: 'Community', opts: [
      { l: 'Active', t: ['community-active'] }, { l: 'BioPulsar circle', t: ['community-biopulsar-member'] }, { l: 'Start-here', t: ['community-starthere-access'] } ] },
    { key: 'prac', label: 'Practitioner', opts: [
      { l: 'Form complete', t: ['gaia_practitioner_form_complete'] }, { l: 'Biofield interest', t: ['practitioner_interest_biofield'] }, { l: 'CRM interest', t: ['crm_interest_education'] } ] }
  ];
  var SOURCES = ['Orlando In-Person Exhibit 2026', 'Gaia Healers Elevate Conference (1)', 'Gaia Healers Events', 'Dr. Nima 30-Minute Phone Call', 'Contact Us', 'Gaia Healers app — wellness sign-up'];
  var cState = { query: '', sel: {}, source: '', after: null, contacts: [] };
  FACETS.forEach(function (f) { cState.sel[f.key] = {}; });

  function buildGroups() {
    var groups = [];
    FACETS.forEach(function (f) {
      var tags = []; f.opts.forEach(function (o) { if (cState.sel[f.key][o.l]) tags = tags.concat(o.t); });
      if (tags.length) groups.push(tags);
    });
    return groups;
  }
  function activeCount() { var n = 0; FACETS.forEach(function (f) { n += Object.keys(cState.sel[f.key]).length; }); if (cState.source) n++; return n; }
  var totalMembers = null;
  function setCount(n, matches) { var cc = document.getElementById('ccount'); if (!cc) return; cc.textContent = (n != null ? n.toLocaleString() : '—') + (matches ? (' match' + (n === 1 ? '' : 'es')) : ' members'); }
  function fetchTotal() {
    if (totalMembers != null) { setCount(totalMembers, false); return; }
    api('/contacts', { method: 'POST', body: JSON.stringify({ limit: 1 }) }).then(function (d) { if (d && d.ok) { totalMembers = d.total; setCount(totalMembers, false); if (document.querySelector('.empty--start')) paintPrompt(); } });
  }
  function paintPrompt() {
    var box = document.getElementById('crows'); if (!box) return;
    box.innerHTML = '<div class="empty empty--start">' + svg('search')
      + '<div class="empty__t">Search to find members</div>'
      + '<div class="empty__s">Type a name, email or phone above — or pick a filter — to pull from ' + (totalMembers != null ? ('all ' + totalMembers.toLocaleString()) : 'all') + ' members.</div></div>';
  }

  function mountContacts() {
    var c = document.getElementById('content');
    c.innerHTML = ''
      + '<div class="toolbar">'
      + '  <label class="search">' + svg('search') + '<input id="csearch" placeholder="Search all members — name, email or phone…" autocomplete="off"></label>'
      + '  <div id="ccount" class="count-pill">—</div>'
      + '  <button class="btn btn--ghost btn--sm" id="cexport" title="Export the current list to CSV">' + svg('download') + ' Export</button>'
      + '</div>'
      + '<div class="facetbar" id="facetbar"></div>'
      + '<div class="activebar" id="activebar"></div>'
      + '<div class="rows" id="crows"></div>';
    var bar = document.getElementById('facetbar');
    FACETS.forEach(function (f) {
      var n = Object.keys(cState.sel[f.key]).length;
      var b = h('<button class="facet ' + (n ? 'is-on' : '') + '" data-facet="' + f.key + '">' + esc(f.label) + (n ? '<span class="facet__n">' + n + '</span>' : '') + '<svg class="facet__c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button>');
      b.onclick = function (e) { e.stopPropagation(); openPopover(f, b); };
      bar.appendChild(b);
    });
    var sb = h('<button class="facet ' + (cState.source ? 'is-on' : '') + '" data-facet="source">Source' + (cState.source ? '<span class="facet__n">1</span>' : '') + '<svg class="facet__c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button>');
    sb.onclick = function (e) { e.stopPropagation(); openSourcePopover(sb); };
    bar.appendChild(sb);
    paintActive();
    var s = document.getElementById('csearch'); s.value = cState.query;
    var deb; s.oninput = function () { clearTimeout(deb); deb = setTimeout(function () { cState.query = s.value.trim(); loadContacts(true); }, 350); };
    s.focus();
    var ex = document.getElementById('cexport'); if (ex) ex.onclick = function () { doExport(ex); };
    fetchTotal();
    loadContacts(true);
  }

  function downloadCsv(csv, name) {
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function doExport(btn) {
    var label = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Exporting…';
    api('/contacts/export', { method: 'POST', body: JSON.stringify({ groups: buildGroups(), query: cState.query, source: cState.source }) })
      .then(function (d) {
        btn.disabled = false; btn.innerHTML = label;
        if (!d || !d.ok || d.csv == null) { toast(d && d.reason === 'ghl_unconfigured' ? 'GHL not configured' : 'Export failed', true); return; }
        var stamp = new Date().toISOString().slice(0, 10);
        downloadCsv(d.csv, 'gaia-contacts-' + stamp + '.csv');
        toast('Exported ' + d.count.toLocaleString() + (d.capped ? ' (capped at 5,000)' : '') + ' contact' + (d.count === 1 ? '' : 's'));
      })
      .catch(function () { btn.disabled = false; btn.innerHTML = label; toast('Export failed', true); });
  }

  function paintActive() {
    var box = document.getElementById('activebar'); if (!box) return;
    var chips = [];
    FACETS.forEach(function (f) { Object.keys(cState.sel[f.key]).forEach(function (l) { chips.push('<span class="achip" data-f="' + f.key + '" data-o="' + esc(l) + '"><em>' + esc(f.label) + '</em>' + esc(l) + '<button>' + svg('close') + '</button></span>'); }); });
    if (cState.source) chips.push('<span class="achip" data-src="1"><em>Source</em>' + esc(cState.source.replace(/Gaia Healers /, '')) + '<button>' + svg('close') + '</button></span>');
    box.innerHTML = chips.length ? (chips.join('') + '<button class="achip achip--clear" id="clearf">Clear all</button>') : '';
    box.querySelectorAll('.achip[data-f]').forEach(function (el) { el.querySelector('button').onclick = function () { delete cState.sel[el.dataset.f][el.dataset.o]; refreshFacets(); }; });
    var srcChip = box.querySelector('.achip[data-src]'); if (srcChip) srcChip.querySelector('button').onclick = function () { cState.source = ''; refreshFacets(); };
    var clr = document.getElementById('clearf'); if (clr) clr.onclick = function () { FACETS.forEach(function (f) { cState.sel[f.key] = {}; }); cState.source = ''; refreshFacets(); };
  }
  function refreshFacets() { mountContacts(); }

  var popEl = null;
  function closePopover() { if (popEl) { popEl.remove(); popEl = null; document.removeEventListener('click', closePopover); } }
  function openPopover(f, btn) {
    closePopover();
    var r = btn.getBoundingClientRect();
    popEl = h('<div class="popover"></div>');
    popEl.innerHTML = '<div class="popover__grid">' + f.opts.map(function (o) { return '<label class="opt ' + (cState.sel[f.key][o.l] ? 'is-on' : '') + '"><input type="checkbox" ' + (cState.sel[f.key][o.l] ? 'checked' : '') + ' data-o="' + esc(o.l) + '"><span>' + esc(o.l) + '</span></label>'; }).join('') + '</div>';
    document.body.appendChild(popEl);
    popEl.style.top = (r.bottom + window.scrollY + 8) + 'px';
    popEl.style.left = Math.max(12, Math.min(r.left + window.scrollX, window.innerWidth - popEl.offsetWidth - 12)) + 'px';
    popEl.onclick = function (e) { e.stopPropagation(); };
    popEl.querySelectorAll('input').forEach(function (inp) { inp.onchange = function () { if (inp.checked) cState.sel[f.key][inp.dataset.o] = 1; else delete cState.sel[f.key][inp.dataset.o]; inp.closest('.opt').classList.toggle('is-on', inp.checked); updateFacetBtn(f.key); paintActive(); loadContacts(true); }; });
    setTimeout(function () { document.addEventListener('click', closePopover); }, 0);
  }
  function openSourcePopover(btn) {
    closePopover();
    var r = btn.getBoundingClientRect();
    popEl = h('<div class="popover popover--src"></div>');
    popEl.innerHTML = SOURCES.map(function (s) { return '<label class="opt ' + (cState.source === s ? 'is-on' : '') + '"><input type="radio" name="src" ' + (cState.source === s ? 'checked' : '') + ' data-s="' + esc(s) + '"><span>' + esc(s) + '</span></label>'; }).join('') + '<button class="opt opt--clear" id="srcnone">Any source</button>';
    document.body.appendChild(popEl);
    popEl.style.top = (r.bottom + window.scrollY + 8) + 'px';
    popEl.style.left = Math.max(12, Math.min(r.left + window.scrollX, window.innerWidth - popEl.offsetWidth - 12)) + 'px';
    popEl.onclick = function (e) { e.stopPropagation(); };
    popEl.querySelectorAll('input').forEach(function (inp) { inp.onchange = function () { cState.source = inp.dataset.s; refreshBtns(); paintActive(); loadContacts(true); closePopover(); }; });
    popEl.querySelector('#srcnone').onclick = function () { cState.source = ''; refreshBtns(); paintActive(); loadContacts(true); closePopover(); };
    setTimeout(function () { document.addEventListener('click', closePopover); }, 0);
  }
  function updateFacetBtn(key) {
    var b = document.querySelector('.facet[data-facet="' + key + '"]'); if (!b) return;
    var n = Object.keys(cState.sel[key]).length; b.classList.toggle('is-on', n > 0);
    var nn = b.querySelector('.facet__n'); if (n) { if (nn) nn.textContent = n; else b.insertBefore(h('<span class="facet__n">' + n + '</span>'), b.querySelector('.facet__c')); } else if (nn) nn.remove();
  }
  function refreshBtns() { FACETS.forEach(function (f) { updateFacetBtn(f.key); }); var sb = document.querySelector('.facet[data-facet="source"]'); if (sb) { sb.classList.toggle('is-on', !!cState.source); var nn = sb.querySelector('.facet__n'); if (cState.source) { if (!nn) sb.insertBefore(h('<span class="facet__n">1</span>'), sb.querySelector('.facet__c')); } else if (nn) nn.remove(); } }

  function loadContacts(reset) {
    // Start empty: only pull members once there's a search or a filter.
    var hasFilter = !!(cState.query || activeCount());
    if (!hasFilter) { cState.contacts = []; cState.after = null; setCount(totalMembers, false); paintPrompt(); return; }
    if (reset) { cState.contacts = []; cState.after = null; }
    paintRows(true);
    api('/contacts', { method: 'POST', body: JSON.stringify({ groups: buildGroups(), query: cState.query, source: cState.source, after: cState.after, limit: 30 }) }).then(function (d) {
      if (!d || !d.ok) { paintRows(); toast(d && d.reason === 'ghl_unconfigured' ? 'GHL not configured' : 'Could not load contacts', true); return; }
      cState.contacts = cState.contacts.concat(d.contacts || []);
      cState.after = d.next || null;
      setCount(d.total != null ? d.total : cState.contacts.length, true);
      paintRows();
    });
  }

  function paintRows(loadingFirst) {
    var box = document.getElementById('crows'); if (!box) return;
    if (loadingFirst && !cState.contacts.length) { box.innerHTML = '<div class="skel"></div><div class="skel" style="margin-top:8px"></div><div class="skel" style="margin-top:8px"></div>'; return; }
    if (!cState.contacts.length) { box.innerHTML = '<div class="empty">' + svg('contacts') + '<div>No contacts match.</div></div>'; return; }
    box.innerHTML = cState.contacts.map(function (c) {
      var tags = (c.tags || []).slice(0, 3).map(function (t) { return '<span class="tag ' + tagClass(t) + '">' + esc(t) + '</span>'; }).join('');
      var more = c.tagCount > 3 ? '<span class="tag tag--more">+' + (c.tagCount - 3) + '</span>' : '';
      return '<div class="row" data-id="' + esc(c.id) + '">'
        + '<div class="ava">' + esc(initials(c.name)).toUpperCase() + '</div>'
        + '<div style="min-width:0"><div class="row__name">' + esc(c.name) + '</div><div class="row__mail">' + esc(c.email || c.phone || '—') + '</div></div>'
        + '<div class="row__tags">' + tags + more + '</div></div>';
    }).join('');
    box.querySelectorAll('.row').forEach(function (el) { el.onclick = function () { openContact(el.dataset.id); }; });
    if (cState.after) {
      var b = h('<button class="btn btn--ghost loadmore">Load more</button>');
      b.onclick = function () { b.textContent = 'Loading…'; loadContacts(false); };
      box.appendChild(b);
    }
  }

  // ---- contact drawer ----
  function openDrawer() { drawerEl.classList.add('is-open'); scrimEl.classList.add('is-open'); }
  function closeDrawer() { drawerEl.classList.remove('is-open'); scrimEl.classList.remove('is-open'); }
  scrimEl.onclick = closeDrawer;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  function openContact(id) {
    openDrawer();
    drawerEl.innerHTML = '<div class="spinner"></div>';
    api('/contact?id=' + encodeURIComponent(id)).then(function (d) {
      if (!d.ok) { drawerEl.innerHTML = '<div class="drawer__head"><div class="drawer__name">Not found</div><button class="drawer__x" onclick="">' + svg('close') + '</button></div>'; return; }
      paintDrawer(d.contact);
    });
  }

  function paintDrawer(m) {
    var textFields = (m.fields || []).filter(function (f) { return !Array.isArray(f.value); });
    var choiceFields = (m.fields || []).filter(function (f) { return Array.isArray(f.value); });
    function qa(f) {
      if (Array.isArray(f.value)) return '<div class="qa__item"><div class="qa__q">' + esc(f.name) + '</div><div class="qa__a">' + f.value.map(function (v) { return '<span class="pill">' + esc(v) + '</span>'; }).join('') + '</div></div>';
      return '<div class="qa__item"><div class="qa__q">' + esc(f.name) + '</div><div class="qa__a text">' + esc(f.value) + '</div></div>';
    }
    drawerEl.innerHTML = ''
      + '<div class="drawer__head">'
      + '  <div class="ava">' + esc(initials(m.name)).toUpperCase() + '</div>'
      + '  <div style="min-width:0"><div class="drawer__name">' + esc(m.name) + '</div><div class="drawer__mail">' + esc(m.email || '—') + (m.phone ? ' &middot; ' + esc(m.phone) : '') + '</div></div>'
      + '  <button class="drawer__x" id="dx">' + svg('close') + '</button>'
      + '</div>'
      + '<div class="drawer__body">'
      + '  <div class="sec-label">' + svg('member') + 'Membership</div>'
      + '  ' + membershipCard(m)
      + billingHistory(m)
      + '  <div class="sec-label">' + svg('survey') + 'Course access <span class="faint">(' + ((m.courses || []).length) + ' \u2014 granted by purchase, never by tier)</span></div>'
      + '  ' + coursesCard(m)
      + '  <div class="sec-label">' + svg('member') + 'Events</div>'
      + '  ' + attendanceCard(m)
      + '  <div class="sec-label">' + svg('lock') + 'Membership history</div>'
      + '  ' + auditCard(m)
      + '  <div class="sec-label">' + svg('tag') + 'Tags <span class="faint">(' + (m.tags || []).length + ')</span></div>'
      + '  <div class="tag-edit" id="tagedit"></div>'
      + (choiceFields.length ? '<div class="sec-label">Survey answers</div><div class="qa">' + choiceFields.map(qa).join('') + '</div>' : '')
      + (textFields.length ? '<div class="sec-label">Written responses & fields</div><div class="qa">' + textFields.map(qa).join('') + '</div>' : '')
      + (!m.fields.length ? '<p class="faint" style="margin-top:14px">No survey answers on this contact.</p>' : '')
      + '</div>';
    document.getElementById('dx').onclick = closeDrawer;
    paintTagEditor(m);
  }

  function paintTagEditor(m) {
    var box = document.getElementById('tagedit');
    function draw() {
      box.innerHTML = m.tags.map(function (t) {
        return '<span class="tag-chip ' + tagClass(t) + '">' + esc(t) + '<button data-rm="' + esc(t) + '" title="Remove">' + svg('close') + '</button></span>';
      }).join('') + '<input class="tag-add" placeholder="+ add tag…" id="tagadd">';
      box.querySelectorAll('[data-rm]').forEach(function (b) { b.onclick = function () { writeTag(m, b.dataset.rm, false, draw); }; });
      var inp = document.getElementById('tagadd');
      inp.onkeydown = function (e) { if (e.key === 'Enter') { var v = inp.value.trim(); if (v) writeTag(m, v, true, draw); } };
    }
    draw();
  }

  function writeTag(m, tag, add, redraw) {
    api('/members/tags', { method: 'POST', body: JSON.stringify({ id: m.id, tag: tag, add: add }) }).then(function (d) {
      if (!d.ok) { toast(d.reason === 'scope_required' ? 'PIT needs contacts.write scope' : 'Tag update failed', true); return; }
      if (add) { if (m.tags.indexOf(tag) < 0) m.tags.push(tag); } else { m.tags = m.tags.filter(function (x) { return x !== tag; }); }
      // reflect in the list row too
      var row = cState.contacts.find(function (x) { return x.id === m.id; });
      if (row) { row.tags = m.tags.slice(); row.tagCount = m.tags.length; paintRows(); }
      redraw();
      toast(add ? 'Added “' + tag + '”' : 'Removed “' + tag + '”');
    });
  }

  // ================= SURVEYS =================
  var sState = { surveys: [], id: '', map: null, loading: false };
  function mountSurveys() {
    var c = document.getElementById('content');
    c.innerHTML = '<div class="survey-bar"><select class="select" id="ssel"></select><a class="btn btn--ghost" id="editghl" href="https://crm.gaiahealers.com/v2/location/WkKl1K5RuZNQ60xR48k6/survey-builder/main" target="_blank" rel="noopener">' + svg('ext') + ' Edit in GHL</a></div>'
      + '<div class="scopebox" id="sscope"></div><div id="smap"></div>';
    if (!sState.surveys.length) {
      api('/surveys').then(function (d) {
        sState.surveys = d.surveys || [];
        if (!sState.id && sState.surveys[0]) sState.id = sState.surveys[0].id;
        fillSel(); loadMap();
      });
    } else { fillSel(); if (sState.map) paintMap(); else loadMap(); }
    function fillSel() {
      var sel = document.getElementById('ssel');
      var live = sState.surveys.filter(function (s) { return !isArchived(s); });
      var arch = sState.surveys.filter(isArchived);
      var opt = function (s) {
        return '<option value="' + esc(s.id) + '"' + (s.id === sState.id ? ' selected' : '') + '>'
          + esc(s.name || s.id) + '</option>';
      };
      sel.innerHTML = (live.length ? '<optgroup label="Active">' + live.map(opt).join('') + '</optgroup>' : '')
        + (arch.length ? '<optgroup label="Archived — kept for reference">' + arch.map(opt).join('') + '</optgroup>' : '');
      sel.onchange = function () { sState.id = sel.value; sState.map = null; paintScope(); loadMap(); };
      paintScope();
    }
  }
  function isArchived(s) { return /^\s*archive\b|\barchived\b/i.test(String(s && s.name || '')); }
  function paintScope() {
    var box = document.getElementById('sscope'); if (!box) return;
    var cur = sState.surveys.filter(function (s) { return s.id === sState.id; })[0];
    var archived = cur && isArchived(cur);
    box.innerHTML =
      (archived ? '<div class="scopebox__arch">Archived survey \u2014 shown for reference. It is not collecting responses.</div>' : '')
      + '<p class="scopebox__p"><b>This page shows the questions, not the answers.</b> '
      + 'Gaia reads survey definitions from GHL and draws how they branch. Responses stay in GHL: '
      + 'an individual\u2019s answers appear on their contact record under Contacts, and completion is '
      + 'visible only where GHL sets a tag. Gaia holds no submission log, no timestamps and no '
      + 'per-question reporting, so this page cannot say how many people answered a given question.</p>';
  }

  function loadMap() {
    var box = document.getElementById('smap'); box.innerHTML = '<div class="spinner"></div>';
    api('/survey-map?id=' + encodeURIComponent(sState.id)).then(function (d) { sState.map = d; paintMap(); });
  }

  function classifyPathway(label) {
    var s = label.toLowerCase();
    if (/for living beings|primarily interested in supporting|living being/.test(s)) return 'lb';
    if (/environmental|types of spaces|working with\b(?!.*water)/.test(s)) return 'env';
    if (/working with water|water systems|structuring.*water/.test(s)) return 'water';
    return '';
  }

  function paintMap() {
    var box = document.getElementById('smap'); var d = sState.map;
    if (!d || !d.ok) { box.innerHTML = '<div class="empty">' + svg('survey') + '<div>Could not read this survey’s structure.</div></div>'; return; }
    var qs = d.questions || [];
    // branch driver options from rules
    var opts = []; (d.rules || []).forEach(function (r) { (r.conditions || []).forEach(function (c) { var v = (c.value || '').split(':')[0].trim(); if (v && opts.indexOf(v) < 0) opts.push(v); }); });
    var lanes = { lb: [], env: [], water: [] }, common = [];
    qs.forEach(function (q) { var p = classifyPathway(q); if (lanes[p]) lanes[p].push(q); else common.push(q); });
    function node(q, driver) {
      return '<div class="node' + (driver ? ' node--driver' : '') + '">' + (driver ? '<div class="node__k">Branch question</div>' : '') + '<div class="node__q">' + esc(q) + '</div>' + (driver && opts.length ? '<div class="node__opts">' + opts.map(function (o) { return '<span class="o">' + esc(o) + '</span>'; }).join('') + '</div>' : '') + '</div>';
    }
    function lane(key, title, items) {
      return '<div class="lane lane--' + key + '"><div class="lane__top"><span class="lane__dot"></span>' + esc(title) + '</div>' + (items.length ? items.map(function (q) { return node(q); }).join('') : '<div class="faint" style="font-size:12.5px">—</div>') + '</div>';
    }
    var driverQ = 'I’m most interested in exploring…';
    box.innerHTML = ''
      + '<div class="stat-row"><div class="stat"><b>' + qs.length + '</b><small>questions</small></div><div class="stat"><b>' + (d.rules || []).length + '</b><small>branch rules</small></div><div class="stat"><b>' + opts.length + '</b><small>pathways</small></div></div>'
      + '<div class="map__legend"><span class="muted">The whole survey is asked to everyone, except one branching question that opens a pathway:</span></div>'
      + '<div class="map">'
      + node(driverQ, true)
      + '<div class="connector"></div>'
      + '<div class="branches">'
      + lane('lb', 'Living Beings', lanes.lb)
      + lane('env', 'Environment', lanes.env)
      + lane('water', 'Water', lanes.water)
      + '</div>'
      + '<div class="connector" style="height:34px"></div>'
      + '<div class="map__legend"><span class="muted">…then everyone continues with:</span></div>'
      + '<div class="map__common">' + common.filter(function (q) { return !/exploring/.test(q); }).map(function (q) { return node(q); }).join('') + '</div>'
      + '</div>';
  }

  // ================= EVENTS (embedded, single sign-on) =================
  // ── Events ───────────────────────────────────────────────────────────────
  // This embeds the REAL Event Manager (/event/). It is not a copy and there is
  // no second implementation: same build, same /event-api backend, same
  // database. Everything about attendees, check-in, walk-ins, badges, badge
  // cards, door payments and event reporting is built there and appears here
  // automatically.
  //
  // Do NOT add event logic to this shell. Its whole job for Events is the nav
  // item, this iframe, and keeping the token in sync for single sign-on. The
  // only /event-api calls allowed from here are under /auth/.
  //
  // See design-reference/EVENT-ADMIN-ARCHITECTURE.md.
  // Enforced by tests/event-admin-boundary.test.cjs.
  function mountEvents() {
    try { var tk = TOKEN || localStorage.getItem('gha_token'); if (tk) localStorage.setItem('token', tk); } catch (e) {}
    var c = document.getElementById('content');
    c.classList.add('content--frame');
    c.innerHTML = '<iframe class="eventframe" src="/event/" title="Event Manager"></iframe>';
  }

  // ================= MEMBERSHIP =================
  var TIERS = [
    { key: 'diamond', label: 'Diamond', tags: ['ahc-diamond-active', 'gaia-diamond-active', 'membership_diamond'], accent: 'var(--violet)', status: 'Active' },
    { key: 'gold', label: 'Gold', tags: ['ahc-gold-active'], accent: 'var(--amber)', status: 'Active' },
    { key: 'goldtrial', label: 'Gold · Trial', tags: ['ahc-gold-trial'], accent: 'var(--amber)', status: 'Trial', hideTile: true },
    { key: 'silver', label: 'Silver', tags: ['ahc-silver-active', 'membership_silver'], accent: 'var(--teal)', status: 'Active' }
  ];
  function cap(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function deriveTier(tags) {
    tags = tags || [];
    for (var i = 0; i < TIERS.length; i++) { var t = TIERS[i]; for (var j = 0; j < t.tags.length; j++) { if (tags.indexOf(t.tags[j]) >= 0) return { label: t.label.split(' · ')[0], status: t.status, accent: t.accent, key: t.key }; } }
    return null;
  }
  function tierAccent(key) { key = String(key || '').toLowerCase(); for (var i = 0; i < TIERS.length; i++) { if (TIERS[i].key === key) return TIERS[i].accent; } return 'var(--green)'; }
  function statusCls(st) { st = String(st || '').toLowerCase(); if (/trial/.test(st)) return 'trial'; if (/^active$|succeed|success|^completed$|^paid$/.test(st)) return 'active'; if (/cancel|refund/.test(st)) return 'canceled'; if (/past_due|unpaid|expired|incomplete|fail|declin/.test(st)) return 'canceled'; return 'other'; }
  function billingHistory(m) {
    var b = m.billing; if (!b) return '';
    var subs = b.subscriptions || [], tx = b.transactions || [];
    if (!subs.length && !tx.length) {
      return '<div class="sec-label">' + svg('receipt') + 'Billing history</div><p class="faint" style="margin:2px 2px 14px">No purchases or payments on record.</p>';
    }
    var out = '<div class="sec-label">' + svg('receipt') + 'Billing history</div><div class="bh">';
    out += '<div class="bh-sum"><span class="bh-total">Lifetime paid <b>' + money(b.totalPaid) + '</b></span>'
      + (b.totalRefunded > 0 ? '<span class="bh-ref">Refunded ' + money(b.totalRefunded) + '</span>' : '')
      + '<span class="faint">' + (b.txCount || 0) + ' payment' + (b.txCount === 1 ? '' : 's') + '</span></div>';
    if (subs.length) {
      out += '<div class="bh-lbl">Subscriptions</div>' + subs.map(function (s) {
        var amt = s.amount != null ? (money(s.amount) + (s.interval ? '/' + s.interval : '')) : '';
        return '<div class="bh-row"><span class="mstatus mstatus--' + statusCls(s.status) + '">' + esc(cap(s.status)) + '</span>' + (amt ? '<b>' + esc(amt) + '</b>' : '') + '<span class="bh-prod">' + esc(s.product || '') + '</span><span class="faint bh-when">' + fmtDate(s.startedAt) + '</span></div>';
      }).join('');
    }
    if (tx.length) {
      out += '<div class="bh-lbl">Payments</div>' + tx.map(function (t) {
        return '<div class="bh-row"><b>' + esc(money(t.amount)) + '</b><span class="mstatus mstatus--' + statusCls(t.status) + '">' + esc(cap(t.status)) + '</span>' + (t.refunded > 0 ? '<span class="bh-refchip">−' + esc(money(t.refunded)) + '</span>' : '') + '<span class="bh-prod">' + esc(t.product || '') + '</span><span class="faint bh-when">' + fmtDate(t.createdAt) + '</span></div>';
      }).join('');
    }
    return out + '</div>';
  }
  function billingBlock(sub) {
    if (!sub || !sub.status) {
      return '<div class="bill"><small>Live billing · Stripe</small><div class="bill__none">No recurring subscription on file</div></div>';
    }
    var amt = sub.amount != null ? ('$' + sub.amount + (sub.interval ? ' / ' + sub.interval : '')) : '';
    var bits = [];
    if (sub.startedAt) bits.push('since ' + fmtDate(sub.startedAt));
    if (sub.status === 'trialing' && sub.trialEndAt) bits.push('trial ends ' + fmtDate(sub.trialEndAt));
    return '<div class="bill"><small>Live billing · Stripe</small>'
      + '<div class="bill__row"><span class="mstatus mstatus--' + statusCls(sub.status) + '">' + esc(cap(sub.status)) + '</span>'
      + (amt ? '<b>' + esc(amt) + '</b>' : '')
      + (bits.length ? '<span class="faint">' + esc(bits.join(' · ')) + '</span>' : '') + '</div>'
      + (sub.product ? '<div class="bill__prod">' + esc(sub.product) + '</div>' : '') + '</div>';
  }
  /* Membership, as evidence.
   *
   * A verified membership is one the ledger holds with a source and an evidence
   * id — a subscription, or an operator's own recorded grant. A GHL tier tag is
   * neither: this location carries 105 ahc-gold-active tags against one paying
   * Gold subscription, so a tag proves that somebody was once labelled, not that
   * anybody is being billed. The app's resolver already refuses to promote a
   * tag-only tier, and this panel refuses in the same way — the tags are shown,
   * plainly, under their own heading, and never as the tier.
   */
  var VERIFIED_SOURCES = { ghl_subscription: 'Live subscription', manual: 'Operator grant', admin: 'Operator grant' };
  function membershipCard(m) {
    var mem = m.membership;
    var unv = m.unverifiedTierTags || [];
    var out = '';

    if (mem) {
      var srcLabel = VERIFIED_SOURCES[mem.source] || esc(mem.source || 'unknown source');
      var cells = [];
      cells.push('<div class="memcell"><small>Evidence</small><b>' + esc(srcLabel) + '</b></div>');
      cells.push('<div class="memcell"><small>Started</small><b>' + fmtDate(mem.started_at) + '</b></div>');
      if (mem.renews_at) cells.push('<div class="memcell"><small>Renews</small><b>' + fmtDate(mem.renews_at) + '</b></div>');
      else if (mem.ends_at) cells.push('<div class="memcell"><small>Ends</small><b>' + fmtDate(mem.ends_at) + '</b></div>');
      else cells.push('<div class="memcell"><small>Expiry</small><b>None recorded</b></div>');
      if (mem.billing_cycle && mem.billing_cycle !== 'none') cells.push('<div class="memcell"><small>Billing</small><b>' + esc(cap(mem.billing_cycle)) + '</b></div>');
      if (mem.override_until) cells.push('<div class="memcell"><small>Override until</small><b>' + fmtDate(mem.override_until) + '</b></div>');
      out += '<div class="memcard" style="--acc:' + tierAccent(mem.key) + '">'
        + '<div class="memcard__hd">'
        + '<span class="mtier">' + esc(cap(mem.key)) + '</span>'
        + '<span class="mstatus mstatus--' + statusCls(mem.status) + '">' + esc(cap(mem.status)) + '</span>'
        + '<span class="mtag-note">verified</span>'
        + '</div>'
        + '<div class="memgrid">' + cells.join('') + '</div>'
        + (mem.evidence_id ? '<div class="faint" style="padding:0 12px 10px;font-family:ui-monospace,monospace;font-size:11px">evidence ' + esc(mem.evidence_id) + '</div>' : '')
        + billingBlock(m.subscription) + '</div>';
    } else {
      out += '<div class="memcard memcard--plain">'
        + '<div class="memcard__hd"><span class="mtier mtier--none">No verified membership</span></div>'
        + '<div class="memgrid"><div class="memcell"><small>Contact since</small><b>' + fmtDate(m.dateAdded) + '</b></div></div>'
        + billingBlock(m.subscription) + '</div>';
    }

    if (unv.length) {
      out += '<div class="unvbox">'
        + '<div class="unvbox__hd">Unverified tier tags <span class="faint">(' + unv.length + ')</span></div>'
        + '<div class="unvbox__tags">' + unv.map(function (t) { return '<span class="pill pill--warn">' + esc(t) + '</span>'; }).join('') + '</div>'
        + '<p class="unvbox__note">Legacy GHL labels. They are not billing evidence and do not grant anything — '
        + 'the app shows this person their verified tier only.</p></div>';
    }
    return out;
  }

  /* Course access, kept apart from the tier on purpose. Nothing here is implied
   * by a membership plan: every grant carries the offer or backfill it came
   * from, and a plan changing has never moved one. */
  function coursesCard(m) {
    var cs = m.courses || [];
    if (!cs.length) return '<p class="faint" style="margin:6px 0 14px">No course entitlements on record.</p>';
    var shown = cs.slice(0, 12);
    return '<div class="crslist">' + shown.map(function (c) {
      var via = String(c.matchedBy || '');
      var how = /webhook/i.test(via) ? 'live grant' : (/backfill/i.test(via) ? 'backfill' : (via || 'unknown'));
      return '<div class="crsrow">'
        + '<span class="crsrow__n">' + esc(c.name || c.id) + '</span>'
        + '<span class="crsrow__m">' + esc(how) + '</span>'
        + '<span class="crsrow__d">' + fmtDate(c.updatedAt) + '</span></div>';
    }).join('') + '</div>'
      + (cs.length > shown.length ? '<p class="faint" style="margin:6px 0 0">and ' + (cs.length - shown.length) + ' more</p>' : '');
  }

  /* Attendance, joined live from the Event Manager. Where one GHL contact holds
   * more than one attendee in the same event the ambiguity is stated and left
   * alone — two people on one order and one person who checked out twice look
   * identical from here, and guessing wrong merges two humans. */
  function attendanceCard(m) {
    var a = m.attendance;
    if (!a || !a.count) return '<p class="faint" style="margin:6px 0 14px">Not registered for any event.</p>';
    var warn = a.has_ambiguity
      ? '<div class="idwarn"><b>One contact, more than one attendee</b>'
        + '<p>This GHL contact carries several attendee records in the same event. That is correct for a '
        + 'couple or a bought guest seat, and a duplicate if the same person checked out twice. Gaia does not '
        + 'guess which — decide it here before the door does.</p></div>'
      : '';
    return warn + '<div class="crslist">' + a.attendees.map(function (x) {
      return '<div class="crsrow">'
        + '<span class="crsrow__n">' + esc(x.name || x.email) + (x.shares_contact ? ' <span class="pill pill--warn">shared contact</span>' : '') + '</span>'
        + '<span class="crsrow__m">' + esc(x.event_name || ('event ' + x.event_id)) + '</span>'
        + '<span class="crsrow__d">' + (x.is_checked_in ? 'checked in' : esc(x.status || '')) + '</span></div>';
    }).join('') + '</div>';
  }

  function auditCard(m) {
    var rows = m.audit || [];
    if (!rows.length) return '<p class="faint" style="margin:6px 0 14px">No recorded changes.</p>';
    return '<div class="crslist">' + rows.map(function (e) {
      return '<div class="crsrow">'
        + '<span class="crsrow__n">' + esc(e.action || 'change') + '</span>'
        + '<span class="crsrow__m">' + esc(e.actor || '') + '</span>'
        + '<span class="crsrow__d">' + fmtDate(e.at) + '</span></div>';
    }).join('') + '</div>';
  }

  function mountMembership() {
    var c = document.getElementById('content');
    var tiles = TIERS.filter(function (t) { return !t.hideTile; });
    c.innerHTML = '<div class="sec-label">' + svg('member') + 'Program tiers <span class="faint">(granted by tag)</span></div>'
      + '<div class="tiergrid" id="tiercards"></div>'
      + '<div class="billbar" id="billbar"><div class="billbar__hd"><span class="sec-label" style="margin:0">' + svg('lock') + 'Live subscriptions · Stripe</span><span class="faint" id="billnote">loading…</span></div><div class="billbar__stats" id="billstats"></div></div>'
      + '<div class="sec-label" id="mtitle" style="display:none"></div>'
      + '<div class="rows" id="mrows"><div class="empty">' + svg('member') + '<div>Choose a tier above to see its members.</div></div></div>';
    // Oversight, migrated from the legacy Membership console: every change to
    // anyone's access, and everything that arrived but could not be resolved to
    // a person or a product. Both read-only — the write actions from that
    // console are deliberately not here (see the audit report).
    var mv = document.createElement('div');
    mv.innerHTML = '<div class="sec-label" style="margin-top:22px">' + svg('lock')
      + 'Membership changes <span class="faint">(every grant, end and override, newest first)</span></div>'
      + '<div id="mAudit" class="crslist"><div class="faint" style="padding:10px 12px">Loading…</div></div>'
      + '<div class="sec-label" style="margin-top:22px">' + svg('member')
      + 'Unresolved <span class="faint">(arrived, but could not be matched to a person or product)</span></div>'
      + '<div id="mUnres" class="crslist"><div class="faint" style="padding:10px 12px">Loading…</div></div>';
    c.appendChild(mv);
    api('/membership/audit').then(function (d) {
      var box = document.getElementById('mAudit'); if (!box) return;
      var rows = (d && d.entries) || [];
      if (!rows.length) { box.innerHTML = '<div class="faint" style="padding:10px 12px">No membership changes recorded.</div>'; return; }
      box.innerHTML = rows.slice().reverse().slice(0, 25).map(function (e) {
        return '<div class="crsrow">'
          + '<span class="crsrow__n">' + esc(e.action || 'change')
          + (e.contactId ? ' <span class="faint">' + esc(String(e.contactId).slice(0, 10)) + '</span>' : '') + '</span>'
          + '<span class="crsrow__m">' + esc(e.actor || '') + '</span>'
          + '<span class="crsrow__d">' + fmtDate(e.at) + '</span></div>';
      }).join('');
    }).catch(function () {});
    api('/membership/unresolved').then(function (d) {
      var box = document.getElementById('mUnres'); if (!box) return;
      var rows = (d && d.unresolved) || [];
      if (!rows.length) {
        box.innerHTML = '<div class="faint" style="padding:10px 12px">Nothing unresolved \u2014 every incoming grant matched a person and a product.</div>';
        return;
      }
      box.innerHTML = rows.slice(0, 25).map(function (u) {
        return '<div class="crsrow">'
          + '<span class="crsrow__n">' + esc(u.reason || u.kind || 'unresolved') + '</span>'
          + '<span class="crsrow__m">' + esc(u.source || '') + '</span>'
          + '<span class="crsrow__d">' + fmtDate(u.at || u.receivedAt) + '</span></div>';
      }).join('');
    }).catch(function () {});

    var grid = document.getElementById('tiercards');
    grid.innerHTML = tiles.map(function (t) {
      return '<button class="tiercard" data-tier="' + t.key + '" style="--acc:' + t.accent + '">'
        + '<span class="tiercard__dot"></span>'
        + '<b class="tiercard__n" data-n="' + t.key + '">…</b>'
        + '<span class="tiercard__l">' + esc(t.label) + '</span></button>';
    }).join('');
    tiles.forEach(function (t) {
      api('/contacts', { method: 'POST', body: JSON.stringify({ groups: [t.tags], limit: 1 }) }).then(function (d) {
        var el = document.querySelector('[data-n="' + t.key + '"]'); if (el) el.textContent = (d && d.total != null) ? d.total.toLocaleString() : '0';
      });
    });
    grid.querySelectorAll('.tiercard').forEach(function (b) { b.onclick = function () { selectTier(b.dataset.tier, b); }; });
    // Live billing truth — decoupled from the program tags above.
    api('/subscriptions/summary').then(function (d) {
      var s = (d && d.summary) || {};
      var note = document.getElementById('billnote'); if (note) note.textContent = (s.total || 0) + ' subscriptions ever created · click to list';
      var box = document.getElementById('billstats'); if (!box) return;
      var stat = function (n, l, cls, st) { return '<button class="bstat bstat--' + cls + '" data-status="' + st + '"><b>' + (n || 0) + '</b><span>' + l + '</span></button>'; };
      box.innerHTML = stat(s.active, 'Active', 'active', 'active') + stat(s.canceled, 'Canceled', 'canceled', 'canceled') + stat(s.expired, 'Expired', 'other', 'expired') + (s.other ? stat(s.other, 'Other', 'other', 'other') : '');
      box.querySelectorAll('.bstat').forEach(function (b) {
        b.onclick = function () {
          document.querySelectorAll('.tiercard').forEach(function (x) { x.classList.remove('is-on'); });
          box.querySelectorAll('.bstat').forEach(function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
          listSubscribers(b.dataset.status, b.querySelector('span').textContent);
        };
      });
    });
  }
  function listSubscribers(status, label) {
    var title = document.getElementById('mtitle'); title.style.display = ''; title.textContent = label + ' subscriptions';
    var box = document.getElementById('mrows'); box.innerHTML = '<div class="skel"></div><div class="skel" style="margin-top:8px"></div>';
    api('/subscriptions?status=' + encodeURIComponent(status)).then(function (d) {
      if (!d || !d.ok) { box.innerHTML = '<div class="empty">Could not load subscriptions.</div>'; return; }
      var list = d.subscriptions || [];
      if (!list.length) { box.innerHTML = '<div class="empty">' + svg('member') + '<div>No ' + esc(label.toLowerCase()) + ' subscriptions.</div></div>'; return; }
      box.innerHTML = list.map(function (x) {
        var amt = x.amount != null ? ('$' + x.amount + (x.interval ? '/' + x.interval : '')) : '';
        return '<div class="row" data-id="' + esc(x.contactId) + '">'
          + '<div class="ava">' + esc(initials(x.name)).toUpperCase() + '</div>'
          + '<div style="min-width:0"><div class="row__name">' + esc(x.name || '—') + '</div><div class="row__mail">' + esc(x.email || x.phone || '—') + '</div></div>'
          + '<div class="row__tags"><span class="mstatus mstatus--' + statusCls(x.status) + '">' + esc(cap(x.status)) + '</span>' + (amt ? '<span class="tag t-member">' + esc(amt) + '</span>' : '') + '</div></div>';
      }).join('');
      box.querySelectorAll('.row').forEach(function (el) { el.onclick = function () { openContact(el.dataset.id); }; });
    });
  }
  function selectTier(key, btn) {
    document.querySelectorAll('.tiercard').forEach(function (x) { x.classList.remove('is-on'); });
    if (btn) btn.classList.add('is-on');
    var t = TIERS.find(function (x) { return x.key === key; }); if (!t) return;
    var title = document.getElementById('mtitle'); title.style.display = ''; title.textContent = t.label + ' members';
    var box = document.getElementById('mrows'); box.innerHTML = '<div class="skel"></div><div class="skel" style="margin-top:8px"></div>';
    api('/contacts', { method: 'POST', body: JSON.stringify({ groups: [t.tags], limit: 50 }) }).then(function (d) {
      if (!d || !d.ok) { box.innerHTML = '<div class="empty">Could not load members.</div>'; return; }
      var list = d.contacts || [];
      if (!list.length) { box.innerHTML = '<div class="empty">' + svg('member') + '<div>No ' + esc(t.label) + ' members.</div></div>'; return; }
      box.innerHTML = list.map(function (cc) {
        return '<div class="row" data-id="' + esc(cc.id) + '">'
          + '<div class="ava">' + esc(initials(cc.name)).toUpperCase() + '</div>'
          + '<div style="min-width:0"><div class="row__name">' + esc(cc.name) + '</div><div class="row__mail">' + esc(cc.email || cc.phone || '—') + '</div></div>'
          + '<div class="row__tags"><span class="tag t-member">' + esc(t.label) + '</span><span class="mstatus mstatus--' + (t.status === 'Trial' ? 'trial' : 'active') + '">' + esc(t.status) + '</span></div></div>';
      }).join('');
      box.querySelectorAll('.row').forEach(function (el) { el.onclick = function () { openContact(el.dataset.id); }; });
    });
  }

  // ================= SYSTEM MAP =================
  var TIER_INFO = [
    { key: 'free', name: 'Free', price: '$0 forever', acc: 'var(--muted)', benefits: ['Community circles', 'Free wellness tools', 'Full app access'], link: 'join.gaiahealers.com/onboarding' },
    { key: 'silver', name: 'Silver', price: '$97/mo · $997/yr', acc: 'var(--teal)', benefits: ['Everything in Free', 'Full community + education', 'Directory listing', 'Start certification'], link: 'join.gaiahealers.com/silver' },
    { key: 'gold', name: 'Gold', price: '$497/mo · $4,997/yr', acc: 'var(--amber)', benefits: ['Everything in Silver', 'Practitioner CRM / software', 'Implementation support', 'Lead generation'], link: 'join.gaiahealers.com/gold' },
    { key: 'diamond', name: 'Diamond', price: '$997/mo · $9,997/yr', acc: 'var(--violet)', benefits: ['Everything in Gold', 'Accelerator benefits', 'Early-access opportunities', 'Priority support'], link: 'join.gaiahealers.com/diamond' }
  ];
  function n(v) { return (v == null) ? '—' : Number(v).toLocaleString(); }
  /* System Alerts.
   *
   * Deliberately a badge and a drawer, not another page: an alert is a prompt
   * to go and look at something, and burying it behind a navigation choice
   * would recreate the problem it exists to solve. Only OPEN incidents count
   * toward the badge — an acknowledged one is somebody's current business, and
   * a resolved one is history. */
  var ALERT_SEV = {
    critical: { label: 'Critical', cls: 'crit' },
    warning:  { label: 'Warning',  cls: 'warn' },
    info:     { label: 'Info',     cls: 'info' },
  };
  var aState = { data: null, filter: 'open', subsystem: '' };

  function refreshAlertBadge() {
    api('/alerts').then(function (d) {
      if (!d || !d.ok) return;
      aState.data = d;
      var el = document.getElementById('alertn'); if (!el) return;
      var crit = d.counts.critical, open = d.counts.open;
      if (!open) { el.textContent = ''; el.className = 'alertbtn__n'; return; }
      el.textContent = String(open);
      el.className = 'alertbtn__n is-on' + (crit ? ' is-crit' : '');
    }).catch(function () {});
  }

  function openAlerts() {
    var d = aState.data;
    if (!d) { drawerEl.innerHTML = '<div class="spinner"></div>'; openDrawer(); refreshAlertBadge(); setTimeout(openAlerts, 900); return; }
    var list = (d.incidents || []).filter(function (i) {
      if (aState.filter === 'open') return i.state === 'open' || i.state === 'acknowledged';
      if (aState.filter === 'resolved') return i.state === 'resolved';
      return true;
    }).filter(function (i) { return !aState.subsystem || i.subsystem === aState.subsystem; });

    var chip = function (v, label, on) {
      return '<button class="afilter' + (on ? ' is-on' : '') + '" data-f="' + esc(v) + '">' + esc(label) + '</button>';
    };
    var subs = (d.subsystems || []);
    drawerEl.innerHTML = ''
      + '<div class="drawer__head"><div style="min-width:0">'
      + '<div class="drawer__name">System Alerts</div>'
      + '<div class="drawer__mail">' + n(d.counts.critical) + ' critical &middot; ' + n(d.counts.open) + ' open &middot; checked ' + fmtDate(d.generatedAt) + '</div>'
      + '</div><button class="drawer__x" id="ax">' + svg('close') + '</button></div>'
      + '<div class="drawer__body">'
      + '<div class="afilters">' + chip('open', 'Open', aState.filter === 'open')
      + chip('resolved', 'Resolved', aState.filter === 'resolved')
      + chip('all', 'All', aState.filter === 'all')
      + (subs.length > 1 ? '<span class="afilters__sp"></span>'
          + '<button class="afilter' + (aState.subsystem ? '' : ' is-on') + '" data-s="">All areas</button>'
          + subs.map(function (x) { return '<button class="afilter' + (aState.subsystem === x ? ' is-on' : '') + '" data-s="' + esc(x) + '">' + esc(x) + '</button>'; }).join('')
          : '')
      + '</div>'
      + (list.length ? list.map(function (i) {
          var sv = ALERT_SEV[i.severity] || ALERT_SEV.info;
          return '<div class="acard acard--' + sv.cls + (i.state === 'resolved' ? ' is-done' : '') + '">'
            + '<div class="acard__hd">'
            + '<span class="asev asev--' + sv.cls + '">' + sv.label + '</span>'
            + '<span class="asub">' + esc(i.subsystem) + '</span>'
            + '<span class="astate">' + esc(i.state) + '</span></div>'
            + '<div class="acard__t">' + esc(i.title) + '</div>'
            + '<p class="acard__w">' + esc(i.why) + '</p>'
            + (i.affected && i.affected.label ? '<div class="acard__a">Affected: <b>' + esc(i.affected.label) + '</b></div>' : '')
            + '<div class="acard__m">'
            + '<span>first ' + fmtDate(i.firstDetectedAt) + '</span>'
            + '<span>last ' + fmtDate(i.lastDetectedAt) + '</span>'
            + '<span>' + n(i.occurrences) + '&times;</span>'
            + (i.resolvedAt ? '<span>resolved ' + fmtDate(i.resolvedAt) + '</span>' : '')
            + '</div>'
            + '<div class="acard__e">' + esc(i.evidence || '') + '</div>'
            + (i.notified && i.notified.lastError ? '<div class="acard__n">Notification failed: ' + esc(i.notified.lastError) + '</div>'
               : (i.notified && i.notified.sentAt ? '<div class="acard__n acard__n--ok">Notified ' + fmtDate(i.notified.sentAt) + '</div>' : ''))
            + (i.state === 'open' ? '<button class="btn btn--ghost acard__ack" data-ack="' + esc(i.id) + '">Acknowledge</button>' : '')
            + '</div>';
        }).join('')
        : '<div class="empty">' + svg('system') + '<div>Nothing here. Every monitored condition is healthy.</div></div>')
      + '</div>';
    document.getElementById('ax').onclick = closeDrawer;
    drawerEl.querySelectorAll('[data-f]').forEach(function (b) { b.onclick = function () { aState.filter = b.dataset.f; openAlerts(); }; });
    drawerEl.querySelectorAll('[data-s]').forEach(function (b) { b.onclick = function () { aState.subsystem = b.dataset.s; openAlerts(); }; });
    drawerEl.querySelectorAll('[data-ack]').forEach(function (b) {
      b.onclick = function () {
        api('/alerts/ack', { method: 'POST', body: JSON.stringify({ id: b.dataset.ack }) })
          .then(function () { refreshAlertBadge(); setTimeout(openAlerts, 400); });
      };
    });
    openDrawer();
  }

  function mountSystem() {
    var c = document.getElementById('content');
    c.innerHTML = '<div class="sysmap" id="sysmap"><div class="smload">' + svg('system') + '<div>Mapping the system…</div></div></div>';
    // Fetch incidents first so a component carrying one can say so as it paints.
    if (!aState.data) refreshAlertBadge();
    api('/system-map').then(function (d) {
      if (!d || !d.ok) { document.getElementById('sysmap').innerHTML = '<div class="empty">Could not load the system map.</div>'; return; }
      paintSystem(d);
    });
  }
  function branch(cls, icon, title, inner) {
    return '<div class="smbranch smbranch--' + cls + '"><div class="smbranch__hd">' + svg(icon) + '<b>' + title + '</b></div>' + inner + '</div>';
  }
  function smBar(label, count, max, acc) {
    var pct = max ? Math.round(count / max * 100) : 0;
    return '<div class="smbar"><span class="smbar__l">' + esc(label) + '</span><span class="smbar__t"><span class="smbar__f" style="width:' + pct + '%;background:' + (acc || 'var(--green2)') + '"></span></span><b class="smbar__v">' + n(count) + '</b></div>';
  }
  /* Pipeline health. Every chip is an observation with a timestamp behind it;
   * anything without evidence says "unknown" rather than borrowing a green. */
  var HSTATE = {
    ok:      { label: 'OK',      cls: 'good' },
    running: { label: 'Running', cls: 'good' },
    idle:    { label: 'Idle',    cls: 'idle' },
    stale:   { label: 'Stale',   cls: 'warn' },
    failed:  { label: 'Failed',  cls: 'bad'  },
    error:   { label: 'Error',   cls: 'bad'  },
    unknown: { label: 'Unknown', cls: 'idle' },
  };
  function since(ms) {
    if (ms == null) return '';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60); if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
  // What each component IS, in an operator's terms. The runtime facts come from
  // the health payload; this is the part a timestamp cannot tell you.
  var HMETA = {
    entitlement_ledger:   { what: 'Gaia\u2019s own record of what each person holds \u2014 memberships and course access.',
                            truth: 'Gaia (this is the source of truth)', how: 'Written by the webhook receiver and the reconcile sweep', rw: 'read/write' },
    course_webhook:       { what: 'Receives course and community grants pushed by GHL workflows when something is sold.',
                            truth: 'GHL (Gaia records the grant)', how: 'Pushed, live', rw: 'write into the ledger' },
    membership_reconcile: { what: 'Walks GHL subscriptions and reconciles them against the canonical billing map.',
                            truth: 'GHL billing', how: 'Scheduled sweep', rw: 'write into the ledger' },
    event_mirror:         { what: 'Catches GHL orders the event webhook missed and mirrors payments.',
                            truth: 'GHL orders and transactions', how: 'Scheduled, hourly', rw: 'write into the Event Manager' },
    academy_sync:         { what: 'Refreshes the course catalogue Gaia validates grants against.',
                            truth: 'GHL courses', how: 'Scheduled, daily', rw: 'write into Gaia\u2019s catalogue' },
    event_backup:         { what: 'Snapshots the Event Manager database and keeps 30 days.',
                            truth: 'The Event Manager database', how: 'Scheduled, daily', rw: 'read-only snapshot' },
    ghl_api:              { what: 'The upstream CRM: contacts, tags, subscriptions, orders.',
                            truth: 'GHL', how: 'Queried live on demand', rw: 'read-only from Gaia' },
    event_manager:        { what: 'Attendees, exhibitors, check-in, badges and event payments.',
                            truth: 'The Event Manager (this is the source of truth)', how: 'Live API', rw: 'read/write \u2014 owned by Event Admin' },
  };
  function openHealth(c) {
    var m = HMETA[c.key] || {};
    var st = HSTATE[c.state] || HSTATE.unknown;
    var row = function (k, v) { return v == null || v === '' ? '' : '<div class="hdrow"><span>' + esc(k) + '</span><b>' + esc(String(v)) + '</b></div>'; };
    var counters = '';
    if (c.counters && Object.keys(c.counters).length) {
      counters = '<div class="sec-label" style="margin-top:14px">Counters</div><div class="hdgrid">'
        + Object.keys(c.counters).map(function (k) {
            return '<div class="hdmini"><b>' + n(c.counters[k]) + '</b><span>' + esc(k.replace(/_/g, ' ')) + '</span></div>';
          }).join('') + '</div>';
    }
    drawerEl.innerHTML = ''
      + '<div class="drawer__head"><div style="min-width:0">'
      + '<div class="drawer__name">' + esc(c.label) + '</div>'
      + '<div class="drawer__mail"><span class="smh__s smh__s--in smh--' + st.cls + '">' + st.label + '</span></div>'
      + '</div><button class="drawer__x" id="hx">' + svg('close') + '</button></div>'
      + '<div class="drawer__body">'
      + (m.what ? '<p class="hdwhat">' + esc(m.what) + '</p>' : '')
      + (c.detail ? '<div class="hddetail">' + esc(c.detail) + '</div>' : '')
      + '<div class="sec-label" style="margin-top:14px">Where the truth lives</div>'
      + '<div class="hdrows">'
      + row('Source of truth', m.truth)
      + row('Update method', m.how || c.cadence)
      + row('Read / write', m.rw)
      + row('Cadence', c.cadence)
      + '</div>'
      + '<div class="sec-label" style="margin-top:14px">Evidence</div>'
      + '<div class="hdrows">'
      + row('Last success', c.lastSuccessAt ? fmtDate(c.lastSuccessAt) : (c.lastWriteAt ? fmtDate(c.lastWriteAt) : 'not observed'))
      + row('Last failure', c.lastFailureAt ? fmtDate(c.lastFailureAt) : 'none observed')
      + row('Last run started', c.lastStartAt ? fmtDate(c.lastStartAt) : null)
      + row('Last result', c.lastRunResult ? (c.lastRunResult + (c.lastRunExitCode != null ? ' (exit ' + c.lastRunExitCode + ')' : '')) : null)
      + row('Next run', c.nextRunAt ? fmtDate(c.nextRunAt) : null)
      + row('Last received', c.lastReceivedAt ? fmtDate(c.lastReceivedAt) : null)
      + row('Last authenticated', c.lastAuthenticatedAt ? fmtDate(c.lastAuthenticatedAt) : null)
      + row('Last rejection', c.lastRejectedAt ? fmtDate(c.lastRejectedAt) : null)
      + row('Rejection reason', c.lastRejectionReason)
      + row('Endpoint', c.endpoint)
      + row('Response time', c.ms != null ? c.ms + ' ms' : null)
      + row('Latest archive', c.latestArtifact)
      + row('Archive size', c.latestArtifactBytes != null ? Math.round(c.latestArtifactBytes / 1024) + ' KB' : null)
      + row('Archives kept', c.artifactCount)
      + row('How this is known', c.evidence)
      + '</div>'
      + (c.counts ? '<div class="sec-label" style="margin-top:14px">Records</div><div class="hdgrid">'
          + Object.keys(c.counts).map(function (k) {
              return '<div class="hdmini"><b>' + n(c.counts[k]) + '</b><span>' + esc(k.replace(/([A-Z])/g, ' $1').toLowerCase()) + '</span></div>';
            }).join('') + '</div>'
          + (c.countsNote ? '<p class="faint" style="margin:6px 0 0;font-size:12px">' + esc(c.countsNote) + '</p>' : '') : '')
      + counters
      + (c.plannedAdapter ? '<div class="sec-label" style="margin-top:14px">Planned adapter</div>'
          + '<div class="hdrows">' + row('Registry source', c.plannedAdapter.source)
          + row('Implemented', c.plannedAdapter.implemented ? 'yes' : 'no')
          + '</div><p class="faint" style="margin:6px 0 0;font-size:12px">' + esc(c.plannedAdapter.note || '') + '</p>' : '')
      + '</div>';
    var inc = incidentsFor(c.key);
    if (inc.length) {
      var box = document.createElement('div');
      box.innerHTML = '<div class="sec-label" style="margin-top:14px">Active alerts</div>'
        + inc.map(function (i) {
            return '<div class="hdinc hdinc--' + (i.severity === 'critical' ? 'crit' : 'warn') + '">'
              + '<b>' + esc(i.title) + '</b>'
              + '<span>' + n(i.occurrences) + ' occurrence' + (i.occurrences > 1 ? 's' : '') + ' \u00b7 since ' + fmtDate(i.firstDetectedAt) + '</span></div>';
          }).join('')
        + '<button class="btn btn--ghost" id="toalerts" style="margin-top:8px">Open System Alerts</button>';
      drawerEl.querySelector('.drawer__body').appendChild(box);
      var go = document.getElementById('toalerts');
      if (go) go.onclick = function () { aState.subsystem = ''; aState.filter = 'open'; openAlerts(); };
    }
    document.getElementById('hx').onclick = closeDrawer;
    openDrawer();
  }

  var HEALTH_INCIDENTS = {
    course_webhook:       /^course-webhook:/,
    membership_reconcile: /^membership-reconcile:/,
    event_mirror:         /^event-mirror:/,
    event_backup:         /^event-backup:/,
  };
  function incidentsFor(key) {
    var all = (aState.data && aState.data.incidents) || [];
    var re = HEALTH_INCIDENTS[key];
    if (!re) return [];
    return all.filter(function (i) { return re.test(i.key) && i.state !== 'resolved'; });
  }
  function healthStrip(h) {
    if (!h || !h.components) return '';
    // Sort the things that need a person to the front. A wall of green with one
    // amber chip buried in the middle is how a stopped pipeline goes unnoticed.
    var order = { failed: 0, error: 0, stale: 1, unknown: 2, idle: 3, running: 4, ok: 5 };
    var comps = h.components.slice().sort(function (a, b) {
      return (order[a.state] == null ? 9 : order[a.state]) - (order[b.state] == null ? 9 : order[b.state]);
    });
    return '<div class="smhealth">' + comps.map(function (c) {
      var st = HSTATE[c.state] || HSTATE.unknown;
      var when = c.lastWriteAt || c.lastRunAt;
      var detail = when ? since(c.ageMs) : (c.ms != null ? c.ms + 'ms' : 'no timestamp');
      var lines = [];
      if (c.lastSuccessAt) lines.push('last success ' + fmtDate(c.lastSuccessAt));
      if (c.lastFailureAt) lines.push('last failure ' + fmtDate(c.lastFailureAt));
      if (c.nextRunAt) lines.push('next ' + fmtDate(c.nextRunAt));
      if (c.lastRunResult && c.lastRunResult !== 'success') lines.push('result ' + c.lastRunResult
        + (c.lastRunExitCode != null ? ' (exit ' + c.lastRunExitCode + ')' : ''));
      var tip = (c.evidence || '') + (lines.length ? ' — ' + lines.join(' · ') : '');
      var inc = incidentsFor(c.key);
      var crit = inc.filter(function (x) { return x.severity === 'critical'; }).length;
      return '<button class="smh smh--' + st.cls + (inc.length ? ' has-inc' : '') + '" data-hk="' + esc(c.key) + '" title="' + esc(tip) + '">'
        + '<span class="smh__s">' + st.label + '</span>'
        + '<span class="smh__l">' + esc(c.label)
        + (inc.length ? ' <span class="smh__inc' + (crit ? ' smh__inc--crit' : '') + '">' + inc.length + ' alert' + (inc.length > 1 ? 's' : '') + '</span>' : '')
        + '</span>'
        + '<span class="smh__d">' + esc(detail) + (lines.length ? '<span class="smh__x">' + esc(lines[0]) + '</span>' : '') + '</span></button>';
    }).join('') + '</div>';
  }

  function paintSystem(d) {
    var sub = d.subscriptions || {}, rev = d.revenue || {}, pay = d.tierPaying || {};
    // KPI strip
    var kpi = function (v, l, acc) { return '<div class="smkpi"><b' + (acc ? ' style="color:' + acc + '"' : '') + '>' + v + '</b><span>' + l + '</span></div>'; };
    var kpis = '<div class="smkpis">'
      + kpi(n(d.members), 'Members')
      + kpi(n(rev.activeCount != null ? rev.activeCount : sub.active), 'Active subscribers', '#8fd36a')
      + kpi('$' + n(rev.mrr), 'MRR (monthly)', 'var(--green)')
      + kpi(n(d.practitioners), 'Practitioners', 'var(--blue)')
      + kpi(n(d.surveyComplete), 'Survey completed', 'var(--violet)')
      + '</div>';
    // tiers with tagged + paying
    var tierCard = function (t) {
      var tagged = (t.key === 'gold' || t.key === 'silver' || t.key === 'diamond') ? d.tiers[t.key] : null;
      var paying = pay[t.key];
      var badge = (tagged != null)
        ? '<span class="smtier__n">' + n(tagged) + ' tagged' + (paying != null ? ' · <em>' + n(paying) + ' paying</em>' : '') + '</span>'
        : '<span class="smtier__n smtier__n--free">default</span>';
      return '<div class="smtier" style="--acc:' + t.acc + '">'
        + '<div class="smtier__hd"><b>' + t.name + '</b>' + badge + '</div>'
        + '<div class="smtier__price">' + t.price + '</div>'
        + '<ul class="smtier__b">' + t.benefits.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul></div>';
    };
    var tiers = branch('tiers', 'member', 'Membership Tiers', '<div class="smtiers">' + TIER_INFO.map(tierCard).join('') + '</div>');
    // payments: MRR + breakdown + reconciliation
    var totTagged = (d.tiers.gold || 0) + (d.tiers.silver || 0) + (d.tiers.diamond || 0);
    var totPaying = (pay.gold || 0) + (pay.silver || 0) + (pay.diamond || 0);
    var bd = (rev.breakdown || []).map(function (b) { return '<span class="smchip smchip--num">' + esc(b.label) + ' ×' + b.count + '</span>'; }).join('');
    var payB = branch('pay', 'lock', 'Payments &amp; Revenue',
      '<div class="smnode smnode--live"><b>$' + n(rev.mrr) + ' MRR</b><span>from ' + n(rev.activeCount) + ' active Stripe subscriptions</span>' + (bd ? '<div class="smflow" style="margin-top:6px">' + bd + '</div>' : '') + '</div>'
      + '<div class="smnode"><b>Subscription health</b><div class="smstats"><span class="smstat smstat--good"><b>' + n(sub.active) + '</b>active</span><span class="smstat smstat--bad"><b>' + n(sub.canceled) + '</b>canceled</span><span class="smstat"><b>' + n(sub.expired) + '</b>expired</span></div></div>'
      + '<div class="smnode"><b>Shopify store</b><span>' + n(d.products) + ' products · checkout on Shopify</span></div>'
      + '<div class="smnode smnode--warn"><b>⚠ ' + n(totTagged) + ' tier-tagged, ' + n(totPaying) + ' actually paying</b><span>Gold ' + n(pay.gold) + '/' + n(d.tiers.gold) + ' · Silver ' + n(pay.silver) + '/' + n(d.tiers.silver) + ' · Diamond ' + n(pay.diamond) + '/' + n(d.tiers.diamond) + ' pay. Tier tags come from grants, not Stripe.</span></div>');
    // access: funnel + demand + audience
    var maxInt = Math.max.apply(null, (d.interests || [{ count: 1 }]).map(function (x) { return x.count; }));
    var maxStg = Math.max.apply(null, (d.stages || [{ count: 1 }]).map(function (x) { return x.count; }));
    var access = branch('access', 'survey', 'How Access Is Granted',
      '<div class="smnode"><b>Onboarding survey</b><span>14 steps → interest / goal / device tags · ' + n(d.surveyComplete) + ' completed</span></div>'
      + '<div class="smflow">' + ['Survey', 'Tags', 'Communities + Membership'].map(function (s, i) { return (i ? '<span class="smarrow">→</span>' : '') + '<span class="smchip">' + s + '</span>'; }).join('') + '</div>'
      + '<div class="smsub">Top demand (device interest)</div><div class="smbars">' + (d.interests || []).slice(0, 6).map(function (x) { return smBar(x.label, x.count, maxInt, 'var(--amber)'); }).join('') + '</div>'
      + '<div class="smsub">Audience by practice stage</div><div class="smbars">' + (d.stages || []).map(function (x) { return smBar(x.label, x.count, maxStg, 'var(--blue)'); }).join('') + '</div>');
    // app: counts + community sizes
    var maxCom = Math.max.apply(null, (d.communitiesList || [{ count: 1 }]).map(function (x) { return x.count; }));
    var app = branch('app', 'contacts', 'The App &amp; Ecosystem',
      '<div class="smgrid">'
      + '<div class="smmini"><b>' + n(d.courses) + '</b><span>Courses (Academy)</span></div>'
      + '<div class="smmini"><b>' + n(d.practitioners) + '</b><span>Practitioners</span></div>'
      + '<div class="smmini"><b>' + n(d.products) + '</b><span>Store products</span></div>'
      + '<div class="smmini"><b>' + n(d.communities) + '</b><span>Communities</span></div>'
      + '</div>'
      + '<div class="smsub">Community membership</div><div class="smbars">' + (d.communitiesList || []).map(function (x) { return smBar(x.label, x.count, maxCom, 'var(--violet)'); }).join('') + '</div>'
      + '<div class="smnode"><b>Gaia Assist</b><span>AI concierge — knows this whole system, guides &amp; sells</span></div>');
    // ── Events, entitlements and the jobs that move data ──────────────────
    var ev = d.events || {}, lg = d.ledger || {};
    var eventsB = branch('events', 'member', 'Events &amp; the Door',
      '<div class="smgrid">'
      + '<div class="smmini"><b>' + n(ev.attendees) + '</b><span>Attendees</span></div>'
      + '<div class="smmini"><b>' + n(ev.exhibitors) + '</b><span>Exhibitors</span></div>'
      + '<div class="smmini"><b>' + n(ev.memberCards) + '</b><span>Badge cards</span></div>'
      + '<div class="smmini"><b>' + n(ev.scanLogs) + '</b><span>Scans logged</span></div>'
      + '</div>'
      + '<div class="smflow">' + ['GHL order', 'Webhook', 'Attendee + QR', 'Door'].map(function (x, i) { return (i ? '<span class="smarrow">\u2192</span>' : '') + '<span class="smchip">' + x + '</span>'; }).join('') + '</div>'
      + '<div class="smnode"><b>' + n(ev.paymentEvents) + ' payment attempts mirrored</b><span>'
        + n(ev.paymentsNeedingAttention) + ' need attention \u00b7 ' + n(ev.ticketMappings) + ' active ticket mappings</span></div>'
      + (ev.byEvent || []).map(function (e) {
          return '<div class="smnode"><b>' + esc(e.name) + '</b><span>' + n(e.attendees) + ' attendees' + (e.archived ? ' \u00b7 archived' : '') + '</span></div>';
        }).join(''));

    var entB = branch('ent', 'lock', 'Entitlements Ledger',
      '<div class="smgrid">'
      + '<div class="smmini"><b>' + n(lg.contacts) + '</b><span>Contacts held</span></div>'
      + '<div class="smmini"><b>' + n(lg.memberships) + '</b><span>Verified memberships</span></div>'
      + '<div class="smmini"><b>' + n(lg.courseGrants) + '</b><span>Course grants</span></div>'
      + '</div>'
      + '<div class="smflow">' + ['GHL subscription', 'Proposal', 'Evidence check', 'Ledger'].map(function (x, i) { return (i ? '<span class="smarrow">\u2192</span>' : '') + '<span class="smchip">' + x + '</span>'; }).join('') + '</div>'
      + '<div class="smnode"><b>Course access is never inferred from a tier</b><span>Every grant carries the offer or backfill it came from.</span></div>');

    document.getElementById('sysmap').innerHTML =
      kpis
      + healthStrip(d.health)
      + '<svg class="sysmap__edges"></svg>'
      + '<div class="smhub" id="smhub"><span class="smhub__k">Gaia Healers 2.0</span><b>' + n(d.members) + '</b><span class="smhub__l">total members</span></div>'
      + '<div class="smrow">' + tiers + payB + access + app + eventsB + entB + '</div>'
      + '<div class="smfoot">GHL contacts &amp; tags · GHL/Stripe subscriptions · Gaia\u2019s Shopify and Academy catalogues · built ' + fmtDate(d.generatedAt) + ' \u00b7 cached 10 min</div>';
    document.querySelectorAll('.smh[data-hk]').forEach(function (b) {
      b.onclick = function () {
        var c = (d.health && d.health.components || []).filter(function (x) { return x.key === b.dataset.hk; })[0];
        if (c) openHealth(c);
      };
    });
    requestAnimationFrame(drawEdges);
    if (!window.__smResize) { window.__smResize = true; window.addEventListener('resize', function () { if (document.getElementById('sysmap')) drawEdges(); }); }
  }
  function drawEdges() {
    var wrap = document.getElementById('sysmap'); if (!wrap) return;
    var svgEl = wrap.querySelector('.sysmap__edges'); var hub = document.getElementById('smhub'); if (!svgEl || !hub) return;
    var wr = wrap.getBoundingClientRect();
    svgEl.setAttribute('viewBox', '0 0 ' + wr.width + ' ' + wr.height);
    svgEl.style.width = wr.width + 'px'; svgEl.style.height = wr.height + 'px';
    var hb = hub.getBoundingClientRect();
    var hx = hb.left - wr.left + hb.width / 2, hy = hb.bottom - wr.top;
    var p = '';
    wrap.querySelectorAll('.smbranch').forEach(function (b) {
      var bb = b.getBoundingClientRect();
      var bx = bb.left - wr.left + bb.width / 2, by = bb.top - wr.top;
      var my = hy + (by - hy) * 0.5;
      p += '<path d="M' + hx + ' ' + hy + ' C ' + hx + ' ' + my + ' ' + bx + ' ' + my + ' ' + bx + ' ' + by + '" fill="none" stroke="var(--line2)" stroke-width="2"/>';
      p += '<circle cx="' + bx + '" cy="' + by + '" r="3.5" fill="var(--green2)"/>';
    });
    svgEl.innerHTML = p;
  }

  // ================= AUTH =================
  function doLogout() { setToken(''); location.hash = ''; loginScreen(''); }

  function loginScreen(msg) {
    root.innerHTML = ''
      + '<div class="login"><div class="login__card">'
      + '<img class="login__mark" src="gaia-mark.svg" alt="">'
      + '<h1>Gaia Healers Admin</h1><p>Sign in to manage contacts, tags &amp; surveys</p>'
      + '<form id="lf">'
      + '<div class="field"><input type="email" id="lem" placeholder="Email" autocomplete="username" autofocus></div>'
      + '<div class="field"><input type="password" id="lpw" placeholder="Password" autocomplete="current-password"></div>'
      + '<button class="btn btn--primary btn--full" type="submit">Sign in</button></form>'
      + '<div class="login__err" id="lerr">' + esc(msg || '') + '</div>'
      + '</div></div>';
    document.getElementById('lf').onsubmit = function (e) {
      e.preventDefault();
      var em = document.getElementById('lem').value.trim(), pw = document.getElementById('lpw').value;
      var err = document.getElementById('lerr'); err.textContent = '';
      if (!em || !pw) { err.textContent = 'Enter your email and password.'; return; }
      evPost('/auth/login', 'username=' + encodeURIComponent(em) + '&password=' + encodeURIComponent(pw), true).then(function (r) {
        if (r.status === 200 && r.j && r.j.access_token) { setToken(r.j.access_token); boot(); }
        else { err.textContent = (r.j && r.j.detail) || 'Incorrect email or password.'; }
      });
    };
  }

  function setPasswordScreen(token) {
    root.innerHTML = ''
      + '<div class="login"><div class="login__card">'
      + '<img class="login__mark" src="gaia-mark.svg" alt="">'
      + '<h1>Set your password</h1><p>Create a password for your Gaia Healers Admin account</p>'
      + '<form id="sf">'
      + '<div class="field"><input type="password" id="np1" placeholder="New password (min 8 characters)" autocomplete="new-password" autofocus></div>'
      + '<div class="field"><input type="password" id="np2" placeholder="Confirm new password" autocomplete="new-password"></div>'
      + '<button class="btn btn--primary btn--full" type="submit">Set password</button></form>'
      + '<div class="login__err" id="serr"></div>'
      + '</div></div>';
    document.getElementById('sf').onsubmit = function (e) {
      e.preventDefault();
      var a = document.getElementById('np1').value, b = document.getElementById('np2').value;
      var err = document.getElementById('serr'); err.textContent = '';
      if (a.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
      if (a !== b) { err.textContent = 'Passwords don’t match.'; return; }
      evPost('/auth/set-password', { token: token, new_password: a }).then(function (r) {
        if (r.status === 200 && r.j && r.j.ok) { location.hash = ''; loginScreen('Password set — sign in with your email.'); }
        else { err.textContent = (r.j && r.j.detail) || 'Could not set password.'; }
      });
    };
  }

  function changePasswordModal() {
    var ov = h('<div class="scrim is-open" style="z-index:70;display:grid;place-items:center;padding:20px"></div>');
    var card = h('<div class="login__card" style="width:min(400px,94vw)"><h1 style="font-size:21px">Change password</h1><p>Update your admin password</p>'
      + '<div class="field"><input type="password" id="cc" placeholder="Current password" autocomplete="current-password"></div>'
      + '<div class="field"><input type="password" id="cn" placeholder="New password (min 8)" autocomplete="new-password"></div>'
      + '<div class="login__err" id="cerr"></div>'
      + '<div style="display:flex;gap:10px;margin-top:8px"><button class="btn btn--ghost" id="ccancel" style="flex:1">Cancel</button><button class="btn btn--primary" id="csave" style="flex:1">Save</button></div></div>');
    ov.appendChild(card); document.body.appendChild(ov);
    function close() { ov.remove(); }
    card.querySelector('#ccancel').onclick = close;
    ov.onclick = function (e) { if (e.target === ov) close(); };
    card.querySelector('#csave').onclick = function () {
      var cur = card.querySelector('#cc').value, nw = card.querySelector('#cn').value;
      var err = card.querySelector('#cerr'); err.textContent = '';
      if (nw.length < 8) { err.textContent = 'New password must be at least 8 characters.'; return; }
      evPost('/auth/change-password', { current_password: cur, new_password: nw }).then(function (r) {
        if (r.status === 200 && r.j && r.j.ok) { close(); toast('Password changed'); }
        else { err.textContent = (r.j && r.j.detail) || 'Could not change password.'; }
      });
    };
    setTimeout(function () { var el = card.querySelector('#cc'); if (el) el.focus(); }, 30);
  }

  // ================= BOOT =================
  function boot() {
    var hash = location.hash || '';
    if (hash.indexOf('#set=') === 0) { return setPasswordScreen(hash.slice(5)); }
    if (!TOKEN) { return loginScreen(''); }
    api('/session').then(function (d) {
      if (d && d.__401) return;
      if (d && d.authed) {
        var initial = (location.hash || '').replace('#', ''); if (['contacts', 'surveys', 'membership', 'events', 'system'].indexOf(initial) >= 0) view = initial;
        render();
      } else { setToken(''); loginScreen(''); }
    }).catch(function () { loginScreen('Cannot reach the server.'); });
  }
  boot();
})();
