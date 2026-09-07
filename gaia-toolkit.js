/** Gaia — Energy toolkit accordion.
 * Turns the long stack of energy tools into tidy, tappable cards: tap a title to
 * expand the tool, tap again (or open another) to fold. Single-open keeps the
 * page short. Opens the tool named by ?tool=, else the first (Chakra Balance).
 */
(function () {
  'use strict';
  const container = document.querySelector('[data-toolkit]');
  if (!container) return;
  const items = Array.prototype.slice.call(container.querySelectorAll('[data-tk]'));
  if (!items.length) return;

  function setOpen(item, open) {
    item.classList.toggle('is-open', open);
    const head = item.querySelector('.g-tk__head');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  items.forEach((item) => {
    const head = item.querySelector('.g-tk__head');
    if (!head) return;
    head.addEventListener('click', () => {
      const willOpen = !item.classList.contains('is-open');
      items.forEach((i) => { if (i !== item) setOpen(i, false); });
      setOpen(item, willOpen);
      if (willOpen) window.requestAnimationFrame(() => { try { item.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {} });
    });
  });

  // Keyed by the ?tool= value. 'sky' and 'numerology' are addressed by their
  // host attribute rather than an id, because their panels are filled in by
  // their own modules after this runs.
  const TOOL_HOST = { chakra: 'home-chakraquiz', cosmic: 'home-cosmic', match: 'home-match', moon: 'home-moon', journey: 'home-challenge', colour: 'home-colourtest', sky: 'data-sky-host', numerology: 'data-numerology-host' };
  function itemFor(name) {
    const key = TOOL_HOST[name];
    if (!key) return null;
    const host = key.indexOf('data-') === 0 ? container.querySelector('[' + key + ']') : container.querySelector('#' + key);
    return host ? host.closest('[data-tk]') : null;
  }

  function openPanel(name) {
    const it = itemFor(name);
    if (!it) return false;
    items.forEach((i) => setOpen(i, i === it));
    window.requestAnimationFrame(() => { try { it.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {} });
    return true;
  }

  const tool = new URLSearchParams(window.location.search).get('tool');
  const openItem = tool ? itemFor(tool) : null;
  items.forEach((i) => setOpen(i, i === openItem));

  // One opener for every Energy tool, so anything that wants to send a person
  // to a specific tool -- a deep link, a card, or Gaia Assist's navigate tool --
  // has a single call to make instead of knowing which module owns which. The
  // accordion panels open here; the two full-screen tools own their own modals.
  window.GaiaTools = {
    // Only what this page can actually open: a couple of TOOL_HOST keys
    // belong to panels that do not exist on every build of the screen.
    get names() {
      return Object.keys(TOOL_HOST).filter(itemFor)
        .concat(window.GaiaPulse ? ['pulse'] : [], window.GaiaBreath ? ['breath'] : []);
    },
    open(name) {
      const key = String(name || '').trim().toLowerCase();
      if (key === 'pulse') { if (window.GaiaPulse) { window.GaiaPulse.open(); return true; } return false; }
      if (key === 'breath') { if (window.GaiaBreath) { window.GaiaBreath.open(); return true; } return false; }
      const opened = openPanel(key);
      // The quizzes need starting as well as revealing, or the panel shows the
      // intro card and the person still has to find the button.
      if (opened && key === 'colour' && window.GaiaQuiz) { try { window.GaiaQuiz.start(); } catch (_) {} }
      if (opened && key === 'chakra' && window.GaiaChakraQuiz) { try { window.GaiaChakraQuiz.start(); } catch (_) {} }
      return opened;
    },
  };
})();
