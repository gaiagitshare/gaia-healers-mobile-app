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

  function findCourse(idOrTitle) {
    if (!manifest) return null;
    var k = String(idOrTitle || '').toLowerCase().trim();
    if (!k) return null;
    return (manifest.courses || []).find(function (c) {
      return String(c.id).toLowerCase() === k
        || String(c.title || '').toLowerCase() === k
        || (Array.isArray(c.grantMatch) && c.grantMatch.some(function (g) { return String(g).toLowerCase() === k; }));
    }) || null;
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

  /* local resume/progress (Phase 3 syncs this to the server) */
  function pKey(cid, lid) { return 'gaia-acad-pos-' + cid + '-' + lid; }
  function dKey(cid, lid) { return 'gaia-acad-done-' + cid + '-' + lid; }
  function savePos(cid, lid, t) { try { localStorage.setItem(pKey(cid, lid), String(Math.floor(t))); } catch (e) {} }
  function getPos(cid, lid) { try { return Number(localStorage.getItem(pKey(cid, lid))) || 0; } catch (e) { return 0; } }
  function markDone(cid, lid) { try { localStorage.setItem(dKey(cid, lid), '1'); } catch (e) {} }
  function isDone(cid, lid) { try { return localStorage.getItem(dKey(cid, lid)) === '1'; } catch (e) { return false; } }

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
      var resume = getPos(course.id, l.id);
      var onMeta = function () {
        if (resume > 2 && resume < (video.duration || 1e9) - 5) { try { video.currentTime = resume; } catch (e) {} }
        video.play().catch(function () {});
        video.removeEventListener('loadedmetadata', onMeta);
      };
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('timeupdate', function () { savePos(course.id, l.id, video.currentTime); });
      video.addEventListener('ended', function () {
        markDone(course.id, l.id); markChecks();
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

  window.GaiaAcademyPlayer = { open: open, openLesson: openLesson, has: has, ready: loadManifest };
  loadManifest();
})();
