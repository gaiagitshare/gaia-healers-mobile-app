# Gaia Healers — Existing Production Visual Assets

**Inventory date:** 2026-09-02
**Purpose:** a complete record of the Gaia Healers visual identity **as it exists in production today**, so the new premium UI direction can be applied *around* the real brand rather than replacing it.

**Nothing in production was modified.** Every file here is a **byte-identical copy** (`cp -p`, verified by MD5). No renaming, no optimisation, no recompression, no rasterising of SVGs. The originals remain exactly where they were.

- **44 files, 5.4 MB** collected across 10 categories
- Source of truth for every entry is the **Original path** column
- Excluded from "production": `NEW/` (gitignored local copy, 0 files tracked in git), `docs/ui-proof/` (QA screenshots), `audits/` (audit captures), `app-store/export/` (generated store screenshots), `prototype/` (my local mockups)

---

## Reading the classification

| Class | Meaning |
|---|---|
| **BRAND** | Official Gaia Healers identity. Protect. Do not regenerate or restyle without explicit approval. |
| **UI** | Artwork the interface depends on. Can evolve, but replacing it changes the product's look. |
| **CONTENT** | Illustrative/photographic imagery. Safest to restyle or swap. |
| **MARKETING** | Store listings and campaign material. Not part of the running app. |
| **DORMANT** | Present and shippable, but no code currently references it. Not the same as obsolete — verify before removing. |

---

## 1. Brand & logo — `01-brand-logo/`

| File | Original path | Format | Size / dims | Used where | Active | Class |
|---|---|---|---|---|---|---|
| `gaia-mark.svg` | `assets/gaia-mark.svg` | SVG | 535 B · 100×100 | `index.html`, `home.html`, `shared-nav.js`, `gaia-ui.js`, `sw.js`, `admin/index.html`, `admin/gadmin.js` | **Yes — 7 refs, the most-referenced asset in the app** | **BRAND** |
| `gaia-logo.png` | `assets/gaia-logo.png` | PNG | 281 KB · 1024×1024 | `sw.js` precache only | Precached, no UI reference found | BRAND |
| `gaia-logo-full.png` | `branding/assets/gaia-logo-full.png` | PNG | 4.8 KB · 355×142 | `branding/*.html`, `ghl-upload-ready/_build/*` | Yes (branding pages) | BRAND |
| `gaia-icon.png` | `branding/assets/gaia-icon.png` | PNG | 71 KB · 1024×1024 | `branding/app-icon.html`, GHL build pages | Yes (7 refs) | BRAND |

**`gaia-mark.svg` is the single most important asset in the repo.** It is the "G" swirl mark: two rounded strokes — an open circle and a diagonal tail — on a 100×100 viewBox, drawn in `currentColor`/white so it inherits theme colour. It appears in the splash header, the app header, the tab bar centre button, and the admin console. It is also **duplicated verbatim** at `admin/gaia-mark.svg` (identical MD5).

The same path data is additionally **inlined** in `index.html` and `home.html` rather than referenced — see `10-inline-svg-extracted/gaia-logo-mark-inline.svg`. Any change to the mark must be made in **three** places: the SVG file, the admin copy, and the inline copies.

---

## 2. App & platform icons — `02-app-icons/`

| File | Original path | Format | Size / dims | Used where | Active | Class |
|---|---|---|---|---|---|---|
| `favicon.ico` | `favicon.ico` (repo root) | ICO | 31 KB · 64×64 | `home.html`, `index.html` | Yes | BRAND |
| `apple-touch-icon.png` | `assets/apple-touch-icon.png` | PNG | 7.5 KB · 180×180 | `home.html`, `index.html`, `gaia-install.js`, `sw.js` | Yes | BRAND |
| `icon-192.png` | `assets/icon-192.png` | PNG | 8.3 KB · 192×192 | `manifest.webmanifest`, both HTML, `sw.js`, `gaia-install.js` | Yes (5 refs) | BRAND |
| `icon-512.png` | `assets/icon-512.png` | PNG | 24 KB · 512×512 | `manifest.webmanifest`, `sw.js` | Yes | BRAND |
| `icon-maskable-512.png` | `assets/icon-maskable-512.png` | PNG | 20 KB · 512×512 | `manifest.webmanifest` (maskable purpose), `sw.js` | Yes | BRAND |
| `app-icon-1024x1024.png` | `branding/export/app-icon-1024x1024.png` | PNG | 282 KB · 1024×1024 | — | **DORMANT** (store submission master) | BRAND |

**Duplicate:** `apple-touch-icon.png` exists identically at the repo root **and** in `assets/`. The root copy is the one browsers probe by convention; `assets/` is the one the HTML references. Both are byte-identical — keep both, they serve different lookups.

---

## 3. Splash & onboarding artwork — `03-splash-artwork/`

| File | Original path | Format | Size / dims | Active | Class |
|---|---|---|---|---|---|
| `splash-screen-1080x1920.png` | `branding/export/` | PNG | 339 KB | DORMANT | BRAND |
| `splash-screen-1284x2778.png` | `branding/export/` | PNG | 355 KB | DORMANT | BRAND |
| `onboarding-01-welcome.png` | `branding/export/` | PNG | 260 KB · 1080×1920 | DORMANT | BRAND |
| `onboarding-02-biowell.png` | `branding/export/` | PNG | 342 KB | DORMANT | BRAND |
| `onboarding-03-community.png` | `branding/export/` | PNG | 303 KB | DORMANT | BRAND |
| `onboarding-04-certification.png` | `branding/export/` | PNG | 337 KB | DORMANT | BRAND |

These are **exported stills** of the onboarding concept, produced for store listings and native-wrapper splash screens. **The live splash does not use them** — it is built from live SVG + CSS (see section 10). They are valuable as a record of the intended look.

---

## 4–8. UI & content imagery

| File | Original path | Format | Size / dims | Used where | Active | Class |
|---|---|---|---|---|---|---|
| `gaia-chakra-meditation.webp` | `assets/` | WebP | 40 KB · 621×906 | `gaia-member.js`, `gaia-reshape.css`, `sw.js` | Yes | UI |
| `gaia-chakra-meditation.png` | `assets/` | PNG | 417 KB · 621×906 | `gaia-ui.js`, `gaia-chakra-data.js`, `gaia-member.js` | Yes | UI |
| `chakra-all-in-one.webp` | `assets/` | WebP | 43 KB · 1200×800 | — | **DORMANT** | UI |
| `gaia-hero-moon.png` | `assets/` | PNG | 233 KB · 1024×1024 | `gaia-superapp.js`, `sw.js` | Yes | UI |
| `gaia-hero-moon-wide.png` | `assets/` | PNG | 787 KB · 1024×576 | `gaia-superapp.js`, `sw.js` | Yes | UI |
| `gaia-hero-moon.jpg` | `assets/` | JPG | 91 KB · 720×749 | `gaia-fit.css` | Yes | UI |
| `gaia-hero-moon-tall.jpg` | `assets/` | JPG | 105 KB · 720×1209 | — | **DORMANT** | UI |
| `pulse-finger.webp` | `assets/` | WebP | 68 KB · 720×513 | `gaia-pulse.js`, `sw.js` | Yes | UI |
| `pulse-tap.webp` | `assets/` | WebP | 36 KB · 720×459 | `gaia-pulse.js`, `sw.js` | Yes | UI |
| `gaia-elevate-hero.png` | `assets/` | PNG | 203 KB · 426×358 | `gaia-fit.css`, `gaia-superapp.js`, `sw.js` | Yes | CONTENT |
| `gaia-event-hero.webp` | `assets/` | WebP | 61 KB · 1280×901 | both HTML, `gaia-reshape.css`, `gaia-superapp.js`, `sw.js` — **also the OG share image** | Yes (5 refs) | CONTENT |
| `gaia-elevate-poster.jpg` | `assets/` | JPG | 57 KB · 760×639 | — | **DORMANT** | CONTENT |

**`pulse-finger.webp` / `pulse-tap.webp`** are the Energy Pulse instruction illustrations — owner-supplied renders, cropped and edge-feathered to transparent WebP. They belong to the **frozen** Pulse tool. Presentation-only changes are permitted; the measurement engine is not.

**The moon rasters are decorative headers only.** They are *not* the moon the app draws in the sky card — see section 10.

---

## 9. Marketing & store — `09-marketing-store/`

Four carousel slides (SVG **and** PNG at 392×440) plus `play-store-banner-1024x500.png`. Titles: *see-energy-before-symptoms-show*, *powerful-tools-complete-insights*, *become-a-gaia-healer*, *join-the-global-network*. All **DORMANT** — no app code references them; they exist for store listings. **The SVG versions are editable source** and are the most reusable marketing assets in the repo.

---

## 10. Inline SVG artwork — `10-inline-svg-extracted/` ⚠️ most important section

**This is the artwork that does not exist as files.** It lives inside `index.html` and `gaia-sky.js`, is drawn live, and would be invisible to any file-based asset audit. It is original Gaia Healers work and the core of the premium feel.

| Extracted copy | Original location | What it is |
|---|---|---|
| `gaia-logo-mark-inline.svg` | `index.html` (and `home.html`) | The "G" mark, inlined rather than referenced |
| `splash-scene-0-welcome-brand-orb.html` | `index.html` scene 0 | Brand orb: CSS rings + sparks around the mark |
| `splash-scene-1-biowell-biofield.svg` | `index.html` scene 1 | **Bio-Well biofield** — sacred-geometry aura rings |
| `splash-scene-2-practitioner-network.svg` | `index.html` scene 2 | Practitioner network constellation |
| `splash-scene-3-academy-credentials.svg` | `index.html` scene 3 | Academy credential seal |
| `splash-scene-4-events-assist-voice.svg` | `index.html` scene 4 | Events + Gaia Assist voice waveform |
| `moonSvg-generator.js` | `gaia-sky.js:55` | **The true-phase moon** (see below) |

All five scene SVGs validate as standalone XML (I added `xmlns` where the inline form omitted it) and can be opened directly.

### The moon is real astronomy, not art

`moonSvg(illumination, waxing, tint)` in `gaia-sky.js` draws the moon **to its actual phase**: a lit disc plus a shadow ellipse whose horizontal radius *is* the terminator, driven by the live illuminated fraction from the server. At half phase the ellipse correctly collapses to a straight line.

**This is a genuine Gaia Healers original and should not be replaced with stock moon imagery.** The concept pack's moon is a static picture; yours is computed and correct every night. Keep the computation; restyle only the surrounding card.

---

## Duplicates found

| Files | Status |
|---|---|
| `assets/gaia-mark.svg` ↔ `admin/gaia-mark.svg` | Identical. Intentional — admin is a separate page. **Both must be updated together.** |
| `apple-touch-icon.png` (root) ↔ `assets/apple-touch-icon.png` | Identical. Intentional — different lookup paths. |
| `branding/export/app-icon-1024x1024.png` ↔ `ghl-upload-ready/app-icon-1024x1024.png` | Identical. Build artefact copy. |
| `branding/assets/gaia-icon.png` ↔ `ghl-upload-ready/_build/assets/gaia-icon.png` | Identical. Build artefact copy. |
| Entire `NEW/gaia-healers-mobile-app/` tree | **Gitignored local copy of an older repo state** — 0 files tracked. Not production. Excluded from this inventory. Its `icon-192.png` (29 KB) and `icon-512.png` (141 KB) **differ** from the current ones, confirming it is stale. |

---

## Dormant assets (present, shippable, unreferenced)

`chakra-all-in-one.webp` · `gaia-hero-moon-tall.jpg` · `gaia-elevate-poster.jpg` · all six `branding/export/` splash & onboarding PNGs · `app-icon-1024x1024.png` · all nine `ghl-upload-ready/` marketing files.

**None of these are recommended for deletion.** Store masters and marketing source are needed at submission time even though the app never loads them. `gaia-logo.png` is a special case: it is precached by `sw.js` but has no UI reference — worth confirming before any cleanup.

---

## What the new concept pack actually is

`~/Desktop/gaia-healers-visual-assets.zip` — inspected read-only, **not extracted into this repo**.

It contains **14 files, 8.9 MB: all flattened PNG reference boards.** There are no individual icons, no SVGs, no usable source assets. Its own manifest states: *"These PNGs are generated visual references, not exact production SVG source"* and *"Use the existing app icon system where possible; recreate icons as clean SVG/CSS rather than cropping raster icons from screenshots."*

**Consequence:** the pack cannot replace anything mechanically. It is a *direction* to build toward using the real assets inventoried here plus the app's existing Phosphor icon set. Its stated product hierarchy (Courses → Events → Bookings → Community → member content → public tools) and its frozen-Pulse constraint match the direction already agreed.

---

## Recommendation: keep vs. restyle

**Keep untouched (recognisable Gaia Healers identity):**
`gaia-mark.svg` and its inline copies · the full app-icon set and favicon · the five splash scene SVGs · the true-phase moon generator · the Pulse instruction illustrations.

**Safe to restyle around:** card surfaces, backgrounds, gradients, spacing, typography, decorative glows — none of which live in these files.

**Candidates for new artwork:** the dormant raster heroes (`chakra-all-in-one`, `gaia-elevate-poster`, `gaia-hero-moon-tall`) and any new decorative elements the direction calls for.

**Do not crop icons out of the concept PNGs.** The app already ships Phosphor (1,530 icons, 67 in use) — the pack's own manifest says the same.
