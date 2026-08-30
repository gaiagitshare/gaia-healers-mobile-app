/* Gaia Healers Player (Path A)
 * A native in-app course player. Fetches the content manifest from the proxy,
 * renders a full-screen player (video + lesson list) with a real back button,
 * and remembers where you left off. Plays the SAME sources the website uses —
 * YouTube embeds and GHL-native public MP4/HLS — with no re-hosting. iOS/Safari
 * plays HLS natively; other browsers lazy-load the vendored hls.js. GHL stays
 * the source of truth for entitlements; this module only plays what the
 * manifest exposes for courses the member owns.
 * API: window.GaiaAcademyPlayer.open(idOrObj) / .has(idOrTitle) / .ready()
 */
(function () {
  'use strict';

  var manifest = null, manifestPromise = null;

  function proxyBase() {
    return String((window.GAIA_SYNC && window.GAIA_SYNC.proxyBase) || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtDur(sec) {
    sec = Number(sec) || 0;
    if (!sec) return '';
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function ytId(src) {
    var s = String(src || '');
    var m = s.match(/(?:youtube\.com\/embed\/|youtu\.be\/|[?&]v=)([\w-]{11})/);
    if (m) return m[1];
    if (/^[\w-]{11}$/.test(s)) return s;
    return null;
  }
  function providerOf(l) {
    if (l.provider) return l.provider;
    if (ytId(l.src)) return 'youtube';
    return /\.m3u8(\?|$)/i.test(l.src) ? 'hls' : 'mp4';
  }

  function loadManifest() {
    if (manifest) return Promise.resolve(manifest);
    if (manifestPromise) return manifestPromise;
    manifestPromise = fetch(proxyBase() + '/api/academy/manifest', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { manifest = (d && d.ok) ? d : { courses: [] }; return manifest; })
      .catch(function () { manifest = { courses: [] }; return manifest; });
    return manifestPromise;
  }

  // Normalize a course title to its distinctive tokens so catalogue titles
  // (e.g. "... Certification Course (12 hour)") match manifest titles
  // (e.g. "... Certification Training") without an exact string.
  function acadKey(str) {
    return String(str || '').toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(course|training|certification|certificate|program|the|a|an|in|person|virtual|online|with|and|for|your|new|model)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function findCourse(idOrTitle) {
    if (!manifest) return null;
    var raw = String(idOrTitle || '').toLowerCase().trim();
    if (!raw) return null;
    var courses = manifest.courses || [];
    var exact = courses.find(function (c) {
      return String(c.id).toLowerCase() === raw
        || String(c.title || '').toLowerCase() === raw
        || (Array.isArray(c.grantMatch) && c.grantMatch.some(function (g) { return String(g).toLowerCase() === raw; }));
    });
    if (exact) return exact;
    // fuzzy fallback: strongest distinctive-token overlap wins (>=60%).
    var k = acadKey(idOrTitle);
    if (!k) return null;
    var kt = k.split(' ').filter(Boolean);
    if (!kt.length) return null;
    var best = null, bestScore = 0;
    courses.forEach(function (c) {
      var ct = acadKey(c.title).split(' ').filter(Boolean);
      if (!ct.length) return;
      if (ct.join(' ') === k) { best = c; bestScore = 1; return; }
      var overlap = kt.filter(function (w) { return ct.indexOf(w) >= 0; }).length;
      var score = overlap / Math.max(kt.length, ct.length);
      if (score > bestScore) { bestScore = score; best = c; }
    });
    return bestScore >= 0.6 ? best : null;
  }
  function has(idOrTitle) { return !!findCourse(idOrTitle); }

  /* hls.js only when the browser can't play HLS natively (iOS/Safari can). */
  var hlsLoading = null;
  function ensureHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsLoading) return hlsLoading;
    hlsLoading = new Promise(function (resolve) {
      var el = document.createElement('script');
      el.src = 'vendor/hls.min.js?v=1';
      el.onload = function () { resolve(window.Hls || null); };
      el.onerror = function () { resolve(null); };
      document.head.appendChild(el);
    });
    return hlsLoading;
  }
  function attachHlsOrSrc(video, src) {
    if (video._hls) { try { video._hls.destroy(); } catch (e) {} video._hls = null; }
    var canNative = !!video.canPlayType('application/vnd.apple.mpegurl');
    var isHls = /\.m3u8(\?|$)/i.test(src);
    if (isHls && !canNative) {
      ensureHls().then(function (Hls) {
        if (Hls && Hls.isSupported()) {
          var hls = new Hls({ enableWorker: true, lowLatencyMode: false });
          hls.loadSource(src); hls.attachMedia(video); video._hls = hls;
        } else { video.src = src; }
      });
    } else {
      video.src = src;
    }
  }

  /* local resume/progress mirror (also synced to the server per member) */
  function pKey(cid, lid) { return 'gaia-acad-pos-' + cid + '-' + lid; }
  function dKey(cid, lid) { return 'gaia-acad-done-' + cid + '-' + lid; }
  function savePos(cid, lid, t) { try { localStorage.setItem(pKey(cid, lid), String(Math.floor(t))); } catch (e) {} }
  function getPos(cid, lid) { try { return Number(localStorage.getItem(pKey(cid, lid))) || 0; } catch (e) { return 0; } }
  function markDone(cid, lid) { try { localStorage.setItem(dKey(cid, lid), '1'); } catch (e) {} }
  function isDone(cid, lid) { try { if (serverDone(cid, lid)) return true; return localStorage.getItem(dKey(cid, lid)) === '1'; } catch (e) { return serverDone(cid, lid); } }

  /* member identity + server-synced progress (the app calls setMember before opening).
   * Playback happens in-app, so the server is the source of truth for progress;
   * localStorage stays as an instant/offline mirror. */
  var member = { email: '', contactId: '', progress: {} };
  function setMember(m) { member = { email: (m && m.email) || '', contactId: (m && m.contactId) || '', progress: (m && m.progress) || {} }; }
  function serverProg(cid) { return (member.progress && member.progress[cid]) || null; }
  function serverPos(cid, lid) { var p = serverProg(cid); return (p && p.pos && Number(p.pos[lid])) || 0; }
  function serverDone(cid, lid) { var p = serverProg(cid); return !!(p && Array.isArray(p.completed) && p.completed.indexOf(lid) >= 0); }
  var _lastPost = 0;
  function postProgress(cid, lid, pos, dur, done) {
    if (!member.email && !member.contactId) return;
    try {
      fetch(proxyBase() + '/api/academy/progress', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ email: member.email, contactId: member.contactId, courseId: cid, lessonId: lid, positionSec: Math.floor(pos || 0), durationSec: Math.floor(dur || 0), done: !!done }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok) { var p = member.progress[cid] = member.progress[cid] || { pct: 0, completed: [], pos: {} }; p.pct = d.pct; p.completed = d.completed || p.completed; }
      }).catch(function () {});
    } catch (e) {}
  }

  var modal = null;
  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    if (modal) {
      var v = modal.querySelector('video');
      if (v && v._hls) { try { v._hls.destroy(); } catch (e) {} }
      modal.remove();
      modal = null;
      document.body.classList.remove('gaia-booking-open');
    }
    document.removeEventListener('keydown', onKey);
  }

  function flatLessons(course) {
    var out = [];
    (course.sections || []).forEach(function (sec) {
      (sec.lessons || []).forEach(function (l) { out.push(l); });
    });
    return out;
  }

  function render(course, startLessonId) {
    close();
    modal = document.createElement('div');
    modal.className = 'gaia-acad';
    var lessons = flatLessons(course);
    var listHtml = (course.sections || []).map(function (sec) {
      return '<div class="gaia-acad__sec"><p class="gaia-acad__seclabel">' + esc(sec.title || 'Lessons') + '</p>'
        + (sec.lessons || []).map(function (l) {
          return '<button type="button" class="gaia-acad__lesson" data-lesson="' + esc(l.id) + '">'
            + '<span class="gaia-acad__play"><i class="ph ph-play" aria-hidden="true"></i></span>'
            + '<span class="gaia-acad__ltext"><strong>' + esc(l.title) + '</strong><small>' + esc(fmtDur(l.durationSec)) + '</small></span>'
            + '<span class="gaia-acad__lcheck" data-check="' + esc(l.id) + '"></span></button>';
        }).join('')
        + '</div>';
    }).join('');
    modal.innerHTML =
      '<div class="gaia-acad__bar">'
      + '<button type="button" class="gaia-acad__back" data-acad-close aria-label="Back to Academy"><i class="ph ph-arrow-left" aria-hidden="true"></i></button>'
      + '<p class="gaia-acad__title">' + esc(course.title) + '</p>'
      + '<button type="button" class="gaia-acad__fs" data-acad-fs aria-label="Fullscreen"><i class="ph ph-corners-out" aria-hidden="true"></i></button></div>'
      + '<div class="gaia-acad__stage" data-stage></div>'
      + '<p class="gaia-acad__nowplaying" data-now></p>'
      + '<div class="gaia-acad__list">' + listHtml + '</div>';
    document.body.appendChild(modal);
    document.body.classList.add('gaia-booking-open');
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', function (e) { if (e.target.closest('[data-acad-close]')) close(); });
    modal.querySelector('[data-acad-fs]').addEventListener('click', function () {
      var el = modal.querySelector('.gaia-acad__video') || modal.querySelector('.gaia-acad__yt') || modal.querySelector('[data-stage]');
      if (!el) return;
      var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitEnterFullscreen;
      if (fn) { try { fn.call(el); } catch (e) {} }
    });

    var stage = modal.querySelector('[data-stage]');
    var now = modal.querySelector('[data-now]');
    var current = null;

    function markChecks() {
      modal.querySelectorAll('[data-check]').forEach(function (c) {
        c.classList.toggle('is-done', isDone(course.id, c.dataset.check));
      });
    }
    function playLesson(l) {
      if (!l) return;
      current = l;
      modal.querySelectorAll('.gaia-acad__lesson').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.lesson === l.id);
      });
      if (now) now.textContent = l.title;
      var prov = providerOf(l);
      if (prov === 'youtube') {
        var id = ytId(l.src);
        stage.innerHTML = '<iframe class="gaia-acad__yt" src="https://www.youtube.com/embed/' + esc(id)
          + '?autoplay=1&rel=0&playsinline=1&modestbranding=1" title="' + esc(l.title)
          + '" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>';
        return;
      }
      if (prov === 'vimeo') {
        var vid = String(l.src).replace(/\D+/g, '');
        stage.innerHTML = '<iframe class="gaia-acad__yt" src="https://player.vimeo.com/video/' + esc(vid)
          + '?autoplay=1&title=0&byline=0&portrait=0" title="' + esc(l.title)
          + '" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>';
        return;
      }
      // native video (mp4 / hls)
      stage.innerHTML = '<video class="gaia-acad__video" playsinline controls preload="metadata"></video>';
      var video = stage.querySelector('video');
      attachHlsOrSrc(video, l.src);
      var resume = serverPos(course.id, l.id) || getPos(course.id, l.id);
      var onMeta = function () {
        if (resume > 2 && resume < (video.duration || 1e9) - 5) { try { video.currentTime = resume; } catch (e) {} }
        video.play().catch(function () {});
        video.removeEventListener('loadedmetadata', onMeta);
      };
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('timeupdate', function () {
        savePos(course.id, l.id, video.currentTime);
        var now = Date.now();
        if (now - _lastPost > 10000 && video.currentTime > 2) { _lastPost = now; postProgress(course.id, l.id, video.currentTime, video.duration, false); }
      });
      video.addEventListener('pause', function () { if (video.currentTime > 2) postProgress(course.id, l.id, video.currentTime, video.duration, false); });
      video.addEventListener('ended', function () {
        markDone(course.id, l.id);
        postProgress(course.id, l.id, video.duration, video.duration, true);
        markChecks();
        var idx = lessons.findIndex(function (x) { return x.id === l.id; });
        if (idx >= 0 && idx + 1 < lessons.length) playLesson(lessons[idx + 1]);
      });
    }
    modal.querySelectorAll('.gaia-acad__lesson').forEach(function (b) {
      b.addEventListener('click', function () {
        playLesson(lessons.find(function (x) { return x.id === b.dataset.lesson; }));
      });
    });
    markChecks();
    var startLesson = (startLessonId && lessons.find(function (x) { return x.id === startLessonId; })) || lessons[0];
    playLesson(startLesson);
  }

  function open(idOrObj, startLessonId) {
    return loadManifest().then(function () {
      var course = (idOrObj && typeof idOrObj === 'object') ? idOrObj : findCourse(idOrObj);
      if (course) render(course, startLessonId);
      return !!course;
    });
  }
  function openLesson(idOrObj, lessonId) { return open(idOrObj, lessonId); }

  window.GaiaAcademyPlayer = { open: open, openLesson: openLesson, has: has, ready: loadManifest, setMember: setMember };
  loadManifest();
})();
