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
  //
  // 'journey' used to be here pointing at #home-challenge, which is not on this
  // screen -- open('journey') could only ever return false. Removed rather than
  // left as a name that reads as supported.
  const TOOL_HOST = { chakra: 'home-chakraquiz', cosmic: 'home-cosmic', match: 'home-match', moon: 'home-moon', colour: 'home-colourtest', sky: 'data-sky-host', numerology: 'data-numerology-host' };

  // Which of these Gaia Assist is allowed to open by name, and which it is
  // deliberately not. Three places have to agree on this: the dispatcher below,
  // the navigate tool's enum in gaia-realtime-voice.js, and the &tool= line in
  // the proxy's GAIA_KNOWLEDGE. They are separate files in separate deploy
  // units, so a contract test compares them rather than a shared import.
  //
  // Cosmic Map and Moon Rituals were listed as deliberately-not-Assist while the
  // omission was reviewed. It was, and they are in: both are ordinary panels on
  // this screen with nothing special about them, so leaving Assist unable to say
  // their names was the odd part. NOT_ASSIST_TOOLS stays, empty, because it is
  // half of the contract -- the place a future tool goes when it should not be
  // routed to, rather than a list that gets deleted and then reinvented.
  const ASSIST_TOOLS = ['pulse', 'breath', 'numerology', 'sky', 'colour', 'chakra', 'match', 'cosmic', 'moon'];
  const NOT_ASSIST_TOOLS = [];
  function itemFor(name) {
    // hasOwnProperty, not a truthy lookup. TOOL_HOST is a plain object, so
    // TOOL_HOST['constructor'] returns a function off Object.prototype rather
    // than undefined -- and ?tool=constructor then built the selector
    // '#function Object() { [native code] }', threw during module init, and
    // took the whole accordion down with it. Every panel on the Energy screen
    // stopped opening because of one word in a query string.
    if (!Object.prototype.hasOwnProperty.call(TOOL_HOST, name)) return null;
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
    // The Assist contract, readable at runtime so a test can check the shipped
    // build rather than only the source.
    assistTools: ASSIST_TOOLS.slice(),
    notAssistTools: NOT_ASSIST_TOOLS.slice(),
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
