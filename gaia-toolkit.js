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

  const TOOL_HOST = { chakra: 'home-chakraquiz', cosmic: 'home-cosmic', match: 'home-match', moon: 'home-moon', journey: 'home-challenge', colour: 'home-colourtest', sky: 'data-sky-host' };
  const tool = new URLSearchParams(window.location.search).get('tool');
  let openItem = items[0];
  if (tool && TOOL_HOST[tool]) {
    const host = TOOL_HOST[tool] === 'data-sky-host' ? container.querySelector('[data-sky-host]') : container.querySelector('#' + TOOL_HOST[tool]);
    const it = host && host.closest('[data-tk]');
    if (it) openItem = it;
  }
  items.forEach((i) => setOpen(i, i === openItem));
})();
