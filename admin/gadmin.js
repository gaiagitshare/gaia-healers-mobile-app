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
    c.innerHTML = '<div class="survey-bar"><select class="select" id="ssel"></select><a class="btn btn--ghost" id="editghl" href="https://crm.gaiahealers.com/v2/location/WkKl1K5RuZNQ60xR48k6/survey-builder/main" target="_blank" rel="noopener">' + svg('ext') + ' Edit in GHL</a></div><div id="smap"></div>';
    if (!sState.surveys.length) {
      api('/surveys').then(function (d) {
        sState.surveys = d.surveys || [];
        if (!sState.id && sState.surveys[0]) sState.id = sState.surveys[0].id;
        fillSel(); loadMap();
      });
    } else { fillSel(); if (sState.map) paintMap(); else loadMap(); }
    function fillSel() {
      var sel = document.getElementById('ssel');
      sel.innerHTML = sState.surveys.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === sState.id ? ' selected' : '') + '>' + esc(s.name || s.id) + '</option>'; }).join('');
      sel.onchange = function () { sState.id = sel.value; sState.map = null; loadMap(); };
    }
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
  function membershipCard(m) {
    var mem = m.membership;
    var derived = deriveTier(m.tags || []);
    var tierLabel = mem ? cap(mem.key) : (derived ? derived.label : null);
    var accKey = mem ? mem.key : (derived ? derived.key : '');
    var head, cells = [];
    if (tierLabel) {
      var status = mem ? cap(mem.status) : derived.status;
      head = '<span class="mtier">' + esc(tierLabel) + '</span>'
        + '<span class="mstatus mstatus--' + statusCls(status) + '">' + esc(status) + '</span>'
        + '<span class="mtag-note">' + (mem ? 'ledger record' : 'by tag') + '</span>';
      cells.push('<div class="memcell"><small>Program joined</small><b>' + fmtDate((mem && mem.started_at) || m.dateAdded) + '</b></div>');
      if (mem && (mem.renews_at || mem.ends_at)) {
        var endLabel = (mem.ends_at && !mem.renews_at) ? 'Ends' : 'Renews';
        cells.push('<div class="memcell"><small>' + endLabel + '</small><b>' + fmtDate(mem.renews_at || mem.ends_at) + '</b></div>');
      } else {
        cells.push('<div class="memcell"><small>Member since</small><b>' + fmtDate(m.dateAdded) + '</b></div>');
      }
    } else {
      head = '<span class="mtier mtier--none">No program tier</span>';
      cells.push('<div class="memcell"><small>Member since</small><b>' + fmtDate(m.dateAdded) + '</b></div>');
    }
    return '<div class="memcard' + (tierLabel ? '' : ' memcard--plain') + '" style="--acc:' + tierAccent(accKey) + '">'
      + '<div class="memcard__hd">' + head + '</div>'
      + '<div class="memgrid">' + cells.join('') + '</div>'
      + billingBlock(m.subscription) + '</div>';
  }
  function mountMembership() {
    var c = document.getElementById('content');
    var tiles = TIERS.filter(function (t) { return !t.hideTile; });
    c.innerHTML = '<div class="sec-label">' + svg('member') + 'Program tiers <span class="faint">(granted by tag)</span></div>'
      + '<div class="tiergrid" id="tiercards"></div>'
      + '<div class="billbar" id="billbar"><div class="billbar__hd"><span class="sec-label" style="margin:0">' + svg('lock') + 'Live subscriptions · Stripe</span><span class="faint" id="billnote">loading…</span></div><div class="billbar__stats" id="billstats"></div></div>'
      + '<div class="sec-label" id="mtitle" style="display:none"></div>'
      + '<div class="rows" id="mrows"><div class="empty">' + svg('member') + '<div>Choose a tier above to see its members.</div></div></div>';
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
  function mountSystem() {
    var c = document.getElementById('content');
    c.innerHTML = '<div class="sysmap" id="sysmap"><div class="smload">' + svg('system') + '<div>Mapping the system…</div></div></div>';
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
    document.getElementById('sysmap').innerHTML =
      kpis
      + '<svg class="sysmap__edges"></svg>'
      + '<div class="smhub" id="smhub"><span class="smhub__k">Gaia Healers 2.0</span><b>' + n(d.members) + '</b><span class="smhub__l">total members</span></div>'
      + '<div class="smrow">' + tiers + payB + access + app + '</div>'
      + '<div class="smfoot">Live from GHL · Stripe · Shopify · updated ' + fmtDate(d.generatedAt) + '</div>';
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
