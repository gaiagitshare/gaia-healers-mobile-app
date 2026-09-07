# Gaia Healers app — full audit

**Date:** 2026-09-07 · **Target:** https://gaiahealers.app (production) ·
**Method:** driving the live app in a browser — cold and warm loads, every
screen, five viewport widths — rather than reading source and inferring.

No change was made to the app in this pass. Every number below was measured;
where something could not be checked, it says so.

---

## Screens audited — 10

`today` · `wellness` · `academy` · `community` · `events` · `bookings` ·
`inbox` · `profile` · `store` · `directory`

All ten render. Across a full walk with `console.error`, `console.warn`,
`error` and `unhandledrejection` hooks installed: **zero errors, zero warnings,
zero unhandled rejections, zero failed network requests.**

---

## Performance

Cold load, phone viewport (375×812, DPR 2), service worker and caches cleared:

| Metric | Value |
|---|---|
| First contentful paint | **308 ms** |
| DOM content loaded | 291 ms |
| Load complete | 839 ms |
| Resources | 96 |
| **Transferred** | **1,135 KB** |
| Decoded | 3,222 KB |

GitHub Pages serves gzip correctly (`gaia-ui.js` 221 KB → 54 KB). Assets carry
`?v=` version strings; Pages sets `max-age=600`, which is not ours to change.

### Finding 1 — 87% of the cold load is images, and one PNG is 787 KB

`gaia-hero-moon-wide.png` is a photographic illustration shipped as PNG. It is
1024×576 natural, rendered at 349×323 on a phone.

| Encoding | Size | Saving |
|---|---|---|
| PNG (current) | **787 KB** | — |
| JPEG q82 | 154 KB | 80% |
| **WebP q80** | **56 KB** | **93%** |

There are three moon-hero variants in the tree — `gaia-hero-moon-wide.png`
(787 KB), `gaia-hero-moon.png` (233 KB) and `gaia-hero-moon.jpg` (91 KB) — plus
`gaia-elevate-hero.png` (203 KB) alongside `gaia-elevate-poster.jpg` (57 KB).
Of the 1,135 KB cold load, **991 KB is PNG**.

### Finding 2 — the service worker precaches 3.2 MB that can never be matched

`sw.js` precaches 63 files by bare path (`/gaia-ui.js`). `home.html` requests
every one of them with a version query (`/gaia-ui.js?v=20260903b`).
`caches.match(request)` compares the full URL including the query, so **not one
precached entry is ever used.**

Proven live: `cache.match('/gaia-ui.js?v=20260903b')` misses;
the same call with `{ignoreSearch:true}` hits.

Consequences:
- Every first visit downloads the shell **twice** — once by the page, once by
  `cache.addAll(APP_SHELL)` on install. Measured: **63 files, 3,246 KB**.
- Offline still works, but through the runtime handler that caches what it
  fetches — not through the precache.
- Cache storage holds two copies of most assets.

The precache also pulls 1,223 KB of hero PNGs that are never matched, so
findings 1 and 2 compound.

### Finding 3 — the daily-energy endpoint is re-fetched on almost every render

`api/wellness/daily` was called **76 times in one browsing session**. The
payload is 442 bytes, so the cost is not bandwidth — each call took **279–835 ms**.
The daily energy is by definition stable for the day.

### Finding 4 — 5,359 DOM nodes, most of them never looked at

| Screen | Nodes | Built when inactive? |
|---|---|---|
| directory | 3,056 | yes |
| store | 1,189 | yes |
| wellness | 300 | yes |
| today (active) | 167 | — |

The directory's 215 practitioner cards and the store's product rows are built
into the DOM whether or not those screens are visited. Above Lighthouse's
excessive-DOM threshold. A deliberate trade for instant screen switching, and
worth knowing on a low-end phone.

---

## Accessibility

Checked across nine screens.

**Clean:** every image has an `alt` attribute · every button has an accessible
name · every input is labelled · `lang` is set · no heading-level jumps · all
`target="_blank"` links carry `rel="noopener"`.

**Findings:**

| Issue | Detail |
|---|---|
| One link with no accessible name | The Elevate poster on `events` — an `<img alt="">` inside a link with no other text, so a screen reader announces "link" and nothing else |
| 17 touch targets at 35px | Directory filter chips, under the 44px WCAG 2.5.5 / Apple HIG guideline |
| 2 duplicate SVG ids | `gSkyGlow`, `gSkyDisc` — the sky widget renders twice |

---

## Responsive — 375 / 430 / 768 / 1024 / 1440

**No page-level horizontal overflow at any width. Zero genuinely unreachable
controls.** The 152 off-screen controls on `store` at 375px are all inside 11
horizontal scroll containers — product carousels, a legitimate mobile pattern,
confirmed by walking each element's ancestors for a scrollable overflow.

The tab bar is present at every width.

---

## Routing and history

Correct, and better than the admin shell was. Walking store → academy →
community and pressing Back twice and Forward once lands on the right screen
each time, the hash follows, and `document.title` tracks the screen
(`Academy · Gaia Healers`). Deep links work on a fresh load.

---

## PWA

Installable. Service worker registered, active, scoped to the origin. Manifest
complete — name, short_name, `display: standalone`, `start_url: /home.html`,
theme colour, and all three icons resolve (200). 63 shell entries precached,
subject to finding 2.

---

## Store

102 unique product links, all absolute HTTPS, all opening with
`rel="noopener"`. No `NaN`, `undefined` or empty-price text. The single `$0` is
the legitimate Free membership tier.

**Finding:** prices render without thousands separators — `$12194`, `$10497`,
`$2648`. On a commerce screen with four- and five-figure prices this is harder
to read than `$12,194`.

---

## Signed-out experience

Audited as a visitor; no credentials were entered. Every gated screen explains
what signing in gives and offers a real action rather than an empty shell —
Events lists the upcoming conference, Bookings lists bookable sessions,
Community offers Find a Healer, Profile explains the Member Pass. This is
handled well.

**Not audited:** the signed-in experience. That needs member credentials, which
were not used.

---

## Data quality — upstream, not the app

Four practitioner photos on `today` return **404** from
`gaiapractitioners.com` (the host itself is up). The app handles this correctly
— `onerror` hides the image and shows an initials avatar, verified rendering as
`LF`, `PC`, `NF`, `AA`. No broken-image icons reach the user. The fix belongs
upstream in the practitioner directory data.

---

## The iPhone app

**Not in this repository.** There is no Xcode project, no workspace, no
Podfile, no Capacitor config anywhere in the tree. `app-store/` contains
marketing screenshot HTML for store listings, not an application. Any iOS work
needs its source pointed to before it can be audited.

---

## Summary

| Severity | Finding |
|---|---|
| **High** | 787 KB hero PNG — 93% recoverable as WebP |
| **High** | Service worker precaches 3.2 MB that can never be matched |
| Medium | `wellness/daily` fetched 76× per session at ~500 ms each |
| Medium | 5,359 DOM nodes; directory and store built when inactive |
| Low | One link with no accessible name |
| Low | 17 touch targets at 35px |
| Low | Store prices lack thousands separators |
| Low | 2 duplicate SVG ids |
| Upstream | 4 practitioner photos 404 (handled gracefully) |

**Healthy:** zero runtime errors across ten screens · correct routing, history
and titles · no horizontal overflow and no unreachable controls at five widths ·
installable PWA with a valid manifest · solid accessibility fundamentals · safe
outbound links · a signed-out experience that sells rather than blocks.
