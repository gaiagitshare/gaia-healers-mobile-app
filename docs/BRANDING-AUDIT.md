# Branding audit — "Gaia" → "Gaia Healers"

Date: 2026-10-26 · Branch `fix/brand-gaia-healers` · Not merged, not deployed.

The customer-facing brand is **Gaia Healers**. This pass makes every place where
"Gaia" names the company, platform, app, website, account, profile, team or
catalogue read "Gaia Healers", and leaves proper names and code alone.

- Audit script: `scripts/brand-audit.mjs` (`--csv`, `--md`, `--list REPLACE`, `--check`)
- Allowlist of intentional proper-name uses: `scripts/brand-allowlist.json`
- Guard test: `tests/brand-consistency.test.cjs`
- Full inventory (every case-sensitive "Gaia"/"GAIA", after the change): `docs/branding-audit.csv`
- Screenshots: `docs/branding-evidence/`

## How the audit finds customer-facing text

The script does not grep lines. It extracts text structurally and classifies
each occurrence:

| source | what counts as copy | never copy |
|---|---|---|
| `.html` | text nodes; attribute values (title, alt, aria-label, placeholder, meta `content`, `data-*-title/label`); inline `<script>` tokenised as JS; JSON-LD values | `<style>`, HTML comments, class/id/href/src/style/data-* identifiers |
| `.js .mjs .cjs .jsx` | string and template-literal contents | comments, regex literals, identifiers (`GaiaUI`, `window.GAIA`), strings passed to `console.*` |
| `.py` | string tokens (Python's own tokenizer) | comments, docstrings |
| `.json .webmanifest` | values under display keys (`name`, `short_name`, `description`, `title`, `label`, `text`, `reason`, …) | keys, internal fields (`ref`, `trigger`, …) |
| `.svg` | `<text>/<tspan>/<title>` | everything else |
| `app-store/CAPTIONS.md` | the whole file (store copy) | — |

Out of scope (not shipped to customers): `docs/`, `design-reference/`, tests,
`scripts/`, `ops/`, `staging-proxy/{tools,scripts,deploy}/`, `event-manager/{docs,import,scripts}/`,
one-off `patch_*.py`, vendored code, backups.

## Counts

Occurrences of case-sensitive "Gaia" / "GAIA" in the scanned files.

| class | before | after | meaning |
|---|---:|---:|---|
| **REPLACE** | **136** | **0** | bare "Gaia" naming the platform in customer copy — changed to "Gaia Healers" |
| **KEEP_PROPER_NAME** | 142 | 142 | deliberate proper names (below) |
| **TECHNICAL** | 507 | 507 | comments 289, console/log 102, identifiers 62, docstrings 22, HTML comments 6, regex 4, AI-context markers 8, internal JSON fields 7, other listed values 7 |
| OK_BRAND (informational) | 309 | 445 | already "Gaia Healers" (or "Gaia Healer", the certified-person title) |

Plus one manual code fix not counted above: the browser-tab title fallback in
`gaia-ui.js` was `${label || 'Gaia'} · Gaia Healers`, which could render
"Gaia · Gaia Healers"; it is now just "Gaia Healers" when no label exists.

KEEP_PROPER_NAME breakdown: Gaia Assist 33 · Gaia Practitioners 24 · assistant
character ("Ask/Talk to/Type to/Tap/Hear Gaia", "Gaia is thinking…", "Hi, I'm
Gaia", avatar name/voice/animations, mode chooser, name fallback, persona) 67 ·
"Gaia Path" feature 13 · "Gaia Reset" feature 2 · Gaia = planet Earth in the
sky-to-chakra spotlight 1 (spotlight-name fallback).

## Rules applied

1. "Gaia" naming the company / platform / app / website / account / profile /
   session / login / support / team / catalogue / backups / admin → **Gaia Healers**.
2. Possessives: `Gaia's` → `Gaia Healers'`, `Gaia’s` / `Gaia’s` → `Gaia Healers’`.
   All caps: `GAIA` → `GAIA HEALERS`. No "Gaia Healers Healers" (the apply step
   refuses one). The brand is treated as singular ("Gaia Healers keeps no copy").
3. Brand-prefixed product names follow the names the product already uses
   elsewhere: "Gaia Academy" → "Gaia Healers Academy" (page title, in-app title),
   "Gaia Radio" → "Gaia Healers Radio" (in-app title), "Gaia 2.0 Membership" →
   "Gaia Healers 2.0 Membership" (the GHL product names are "Gaia Healers 2.0 CRM …"
   and the Control Center hub already says "Gaia Healers 2.0").
4. Kept as proper names: **Gaia Practitioners** (separate partner platform),
   **Gaia Assist** and the **Gaia assistant character** (rule below), named
   features **Gaia Path** and **Gaia Reset** (owner decision, below), and "Gaia"
   meaning the planet Earth.
5. Never renamed: file names, CSS classes, ids, data attributes, JS/py
   identifiers, localStorage keys, endpoints, env vars, DB tables, GHL tags and
   metadata (`gaia-app-lead`, `gaia-m:`, the contact `source` value
   `Gaia App - …`), URLs and domains.
6. AI prompt text that names the *platform* was updated too, because the model
   repeats it to members ("You are Gaia Healers’ professional concierge…",
   "use relevant verified Gaia Healers context"). Machine markers inside the AI
   context block (`GAIA SESSION STATE`, `CURRENT GAIA PROFILE CHOICES`) are
   parsed/asserted and stay unchanged.

### Assistant-name rule

The app presents its AI assistant as the product **Gaia Assist** whose
character is addressed as **Gaia**: "Ask Gaia", "Talk to Gaia", "Type to Gaia…",
"Tap Gaia to start", "Hear Gaia", "Gaia is thinking…", the avatar's own bubble
("Hi, I'm Gaia. Tap me for ideas…"), and its voice. **The character keeps
"Gaia"**; anything the character or the UI says about the **platform** uses
"Gaia Healers" — e.g. the assistant's fallback replies now say "I’m here as your
Gaia Healers guide", "I can help you find your way around Gaia Healers",
"Contact Gaia Healers Support". The existing greeting already followed this
("Hi, I'm Gaia Assist — your personal guide for your Gaia Healers journey").

## Languages

The app has no i18n layer or translation files; all UI copy is English (`lang="en"`,
manifest `en-US`). The only other language is the Persian crisis-safety reply in
`staging-proxy/assist-safety.js`, which contains no brand name (checked for
"Gaia" and "گایا"). The English twin of that reply was updated
("Gaia Healers' wellness tools are not a substitute…"). Event Manager admin UI
and the proxy's HTML pages are English as well.

## Representative changes (before → after)

| # | where | before | after |
|---|---|---|---|
| 1 | Home hero (gaia-superapp.js) | explore free Gaia tools | explore free Gaia Healers tools |
| 2 | Home hero button | Explore Gaia | Explore Gaia Healers |
| 3 | Home signed-in section heading | Your Gaia | Your Gaia Healers |
| 4 | Membership upsell kicker | Gaia 2.0 Membership | Gaia Healers 2.0 Membership |
| 5 | Membership sheet (gaia-ui.js) | Gaia 2.0 offers Free, Silver, Gold, and Diamond paths | Gaia Healers 2.0 offers Free, Silver, Gold, and Diamond paths |
| 6 | Assistant membership route button | Join Gaia 2.0 | Join Gaia Healers 2.0 |
| 7 | App loading screen (home.html) | Preparing your Gaia experience… | Preparing your Gaia Healers experience… |
| 8 | Community → Live & updates | Gaia Radio | Gaia Healers Radio |
| 9 | Community → Support | Browse verified Gaia practitioners | Browse verified Gaia Healers practitioners |
| 10 | Energy → birth details | Your birth date tells Gaia which chakra is yours | Your birth date tells Gaia Healers which chakra is yours |
| 11 | Energy → sky map disclaimer | mapped through Gaia’s symbolic chakra lens | mapped through Gaia Healers’ symbolic chakra lens |
| 12 | Energy → chakra quiz | the practice and Gaia support that bring it back | the practice and Gaia Healers support that bring it back |
| 13 | Chakra quiz share text | My Gaia focus chakra is … | My Gaia Healers focus chakra is … |
| 14 | Energy Match share | Our Gaia Energy Match is …% | Our Gaia Healers Energy Match is …% |
| 15 | Pulse camera blocked | Open Gaia in your browser for the camera reading | Open Gaia Healers in your browser for the camera reading |
| 16 | Onboarding journey header | Your Gaia journey | Your Gaia Healers journey |
| 17 | Onboarding journey error | We’re having trouble loading your Gaia profile. | We’re having trouble loading your Gaia Healers profile. |
| 18 | Onboarding reveal button | Enter Gaia → | Enter Gaia Healers → |
| 19 | My Readings privacy | Gaia keeps no copy of the readings | Gaia Healers keeps no copy of the readings |
| 20 | My Readings consent list | Your Gaia account itself. | Your Gaia Healers account itself. |
| 21 | Practice journal | Your notes stay on this device. Gaia never sends them anywhere. | … Gaia Healers never sends them anywhere. |
| 22 | Practitioner area | Your Gaia session has expired. | Your Gaia Healers session has expired. |
| 23 | Practitioner area | Could not reach Gaia right now. | Could not reach Gaia Healers right now. |
| 24 | Practitioner link | Your Gaia login stays as it is. | Your Gaia Healers login stays as it is. |
| 25 | Academy hand-off (gaia-member.js) | reopen the Gaia app | reopen the Gaia Healers app |
| 26 | Avatar suggestion | Your Gaia setup is not finished yet. | Your Gaia Healers setup is not finished yet. |
| 27 | Personal Path rule (proxy) | Finish your Gaia setup | Finish your Gaia Healers setup |
| 28 | Store shelf fallback (proxy) | More from Gaia | More from Gaia Healers |
| 29 | Assistant fallback reply (proxy) | I’m here as your Gaia guide. | I’m here as your Gaia Healers guide. |
| 30 | Assistant fallback reply (proxy) | Contact Gaia Support so the team can check your account | Contact Gaia Healers Support so the team can check your account |
| 31 | Assistant prompt (proxy) | ROLE: You are Gaia’s professional concierge | ROLE: You are Gaia Healers’ professional concierge |
| 32 | System-alert e-mail subject (staff) | [Gaia CRITICAL] … | [Gaia Healers CRITICAL] … |
| 33 | System alerts (staff) | No fresh off-site Gaia backup | No fresh off-site Gaia Healers backup |
| 34 | Control Center (admin/gadmin.js) | Gaia (this is the source of truth) | Gaia Healers (this is the source of truth) |
| 35 | Event Manager event page | Published — members see this event in the Gaia app. | … in the Gaia Healers app. |
| 36 | Event Manager door check-in | Recorded as a Gaia door payment. | Recorded as a Gaia Healers door payment. |
| 37 | Event Manager API (main.py) | Gaia-recorded at the door. | Recorded by Gaia Healers at the door. |
| 38 | Exhibitor card page (badge_card.py) | Nothing here is sold through Gaia | Nothing here is sold through Gaia Healers |
| 39 | Store-listing carousel (ghl-upload-ready) | GAIA ACADEMY / Practitioners in the Gaia ecosystem | GAIA HEALERS ACADEMY / Practitioners in the Gaia Healers ecosystem |
| 40 | Onboarding slide (branding/) | Gaia Academy | Gaia Healers Academy |

Unchanged on purpose: "Ask Gaia about this centre", "Talk to Gaia", "Type to
Gaia…", "Gaia is thinking…", "Hi, I'm Gaia…", "Gaia Assist", "Gaia
Practitioners connection needs to be renewed", "Your Gaia Path", "Your Gaia Reset".

Already correct and untouched: `<title>` on every page, meta description,
Open Graph/Twitter tags, JSON-LD, `manifest.webmanifest` (`name` and
`short_name` = "Gaia Healers"), service-worker notification default title,
magic-link and card pages rendered by the proxy.

## Layout

- Mobile nav labels and the manifest `short_name` were already "Gaia Healers";
  nothing in the bottom nav changed.
- Longer strings wrap inside existing flexible containers (hero lede, buttons,
  cards); checked at 390 px and 1280 px in the screenshots.
- The onboarding journey's last node label (`<em>` under the Gaia mark) now reads
  "Gaia Healers" and wraps to two lines (12 px, centred, width = dot + 8 px), like
  the existing "Living Beings" label. No CSS change was needed.

## Screenshots (offline, loopback only)

`origin/main` (before) and this branch (after) served from two loopback static
servers; Chromium (Playwright) with every non-loopback request aborted, the
proxy stubbed as a signed-out visitor (`/api/auth/session` → `{authenticated:false}`,
other proxy calls → 401), intro tour marked seen.

| page | desktop 1280 | mobile 390 |
|---|---|---|
| Home (guest) | [before](branding-evidence/before-today-desktop.png) · [after](branding-evidence/after-today-desktop.png) | [before](branding-evidence/before-today-mobile.png) · [after](branding-evidence/after-today-mobile.png) |
| Community | [before](branding-evidence/before-community-desktop.png) · [after](branding-evidence/after-community-desktop.png) | [before](branding-evidence/before-community-mobile.png) · [after](branding-evidence/after-community-mobile.png) |
| Energy | [before](branding-evidence/before-wellness-desktop.png) · [after](branding-evidence/after-wellness-desktop.png) | [before](branding-evidence/before-wellness-mobile.png) · [after](branding-evidence/after-wellness-mobile.png) |

Console/network comparison, all 12 captures: identical before and after —
0 page errors, 0 HTTP 404s, and the same 21 console "401 Unauthorized" lines
in each, which come from the stubbed signed-out proxy, not from the change.
12 PNGs, 8-bit palette, ~800 KB total.

## Tests

- `node --test tests/*.test.cjs` — pass (includes the new guard).
- `cd staging-proxy && npm ci && npm test` — pass. Four tests asserted old copy and were updated:
  - `test/personal-path.test.js`: rule title is now "Finish your Gaia Healers setup".
  - `test/practice-navigation.test.js`: completed-member guidance now says "the Gaia Healers test".
  - `test/practitioner-link-state.test.js`: "Your Gaia Healers login stays as it is."
  - `test/assist-prompt-budget.test.js`: practitioner prompt ceiling 15,000 → 15,100 chars.
    The brand in the platform references the assistant repeats added 54 chars
    (14,987 → 15,041, ~13 tokens a turn); the ceiling moved by that much and no more.
- Guard: a planted "Explore Gaia" on the home hero made the guard fail with the exact file:line; the plant was removed.

## Needs an owner decision

1. **"Gaia Path"** (13 uses: "Your Gaia Path", "Discover My Gaia Path", "Let’s
   discover your Gaia path") and **"Gaia Reset"** (2) are kept as feature names.
   If they should become "Gaia Healers Path" / "Gaia Healers Reset", delete the two
   allowlist entries and the guard lists every spot.
2. **Personal Path catalogue** (`staging-proxy/path-catalogue.json`): "Finish your
   Gaia setup" (rule P-ONBOARD title; the member sees the title from
   `personal-path.js`, which is updated) and "Gaia's 9-week chakra programme"
   (R-COURSE-CHAKRA-9WK description, shown to practitioners) are approved,
   versioned entries. They should change only through
   `staging-proxy/tools/path-catalogue.mjs` with your approval; left as is.
3. **"Gaia Guest"** ticket-type name: seeded by `event-manager/backend/tools/people_sync.py`
   and stored in the Event Manager database (printed on badges/tickets). Renaming
   it is a data change in the Event Manager, not a code change.
4. GHL contact `source` value `Gaia App - <tool>`: left as is, because GHL
   workflows/smart lists may filter on it. Change only together with those filters.
5. Exported PNGs that still show the old text: `ghl-upload-ready/carousel-03-become-a-gaia-healer.png`,
   `ghl-upload-ready/carousel-04-join-the-global-network.png`, and
   `branding/export/onboarding-04-certification.png`. Their HTML/SVG sources are
   updated; re-run `ghl-upload-ready/_build/export.sh` / `branding/export.sh`
   (they need web fonts, so run with network) and re-upload to GHL if used.
6. Staff-only copy (Control Center, System Alerts, Event Manager admin) was also
   branded "Gaia Healers" for consistency. The alert e-mail subject is now
   "[Gaia Healers …]"; mail filters matching "[Gaia" still match.
