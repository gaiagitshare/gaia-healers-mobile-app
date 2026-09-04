# Gaia Healers — Visual Implementation Proposal

**Date:** 2026-09-02 · **Status:** proposal only, nothing coded from this document yet
**Companion:** [`existing-gaia-assets/ASSET-INVENTORY.md`](existing-gaia-assets/ASSET-INVENTORY.md)

## Governing rules for this work

**Real assets are the source of truth.** The concept pack informs *layout, hierarchy, spacing, card treatment, typography, polish, colour balance and organisation* — nothing else. Where a real Gaia asset exists, it is used.

**Protected — never replaced with generated artwork:**
`gaia-mark.svg` and the inline logo copies · the five splash scene SVGs · the `moonSvg()` true-phase generator · `pulse-finger.webp` / `pulse-tap.webp` · `gaia-event-hero.webp` and `gaia-elevate-hero.png` · every app icon and the favicon.

**Frozen — not touched by any item below:** the Energy Pulse measurement engine (camera PPG, DSP, thresholds, sampling, filtering, confidence, flow) and all astronomy/wellness calculations.

**No new visual identity.** Green stays primary; `--g-purple`, `--g-gold`, `--g-teal` stay as the accent system they already are.

## The single most useful finding

**The app already has the components this direction needs.** `.g-super-row` is a proper list row (52px icon / content / 24px chevron, 88px min-height). `.g-card`, `.g-page__head`, `.g-btn--primary/secondary/ghost/sm` all exist. `.g-quick` and `.g-upnext` were added in the member-first work.

**So almost none of this proposal is new components — it is applying existing ones consistently.** That is why the performance risk throughout is near zero: it is largely markup reorganisation against CSS that already ships.

## Already built locally (uncommitted, branch `feat/v2-home-and-tools`)

Member-first Home order · Quick Access + Upcoming · Energy Tools page · compact sky card. **77 tests pass.** Where a screen below is already done, it says so.

---

# 1. Member Home

| | |
|---|---|
| **Stays as-is** | The hero with `gaia-chakra-meditation` artwork and its greeting. The event carousel using `gaia-event-hero.webp`. `primaryMemberAction`, `upgradeCard`, "Your access" services grid, `nextBookingCard`, the sync note. All data logic. |
| **Reordered** | **Done.** `hero → Quick Access → Upcoming → event → daily → membership action → upgrade → Your access → sky → free tools → next booking → sync`. Free tools moved *below* membership content. |
| **Restyled** | Section rhythm: one consistent kicker + heading + optional "View all" across every band (several use different spacing today). Tighten vertical gaps — Home is currently a long scroll of full-width blocks. |
| **Real asset reused** | `gaia-chakra-meditation.webp/png`, `gaia-event-hero.webp`, `gaia-mark.svg` (header), `moonSvg()` (sky card). |
| **New asset required?** | **No.** Quick Access uses Phosphor icons already in the app. |
| **Performance** | Neutral. Reorder only; no new requests. Quick Access + Upcoming add ~2 KB of CSS. |
| **Scope** | Shared. Grids already collapse 4→2 and 3→1 on mobile. |

# 2. Guest / Public Home

| | |
|---|---|
| **Stays as-is** | **Order unchanged — deliberately.** Tools stay high; that is correct for conversion. `daily → event carousel → free tools → sky → authPrompt → bookings`. |
| **Reordered** | Nothing. |
| **Restyled** | Two things only: (a) make the free-tools band state plainly that it is **free, no account, nothing uploaded** — the honest promise is the strongest conversion line the app has; (b) give `authPrompt` the same card treatment as the member sections so the "join" moment feels designed rather than appended. |
| **Real asset reused** | Same as member Home. |
| **New asset required?** | **No.** |
| **Performance** | Neutral. Copy and CSS only. |
| **Scope** | Shared. |

# 3. Navigation

| | |
|---|---|
| **Stays as-is** | The 7-item tab bar (Today, Energy, Academy, **Assist centre button**, Community, Shop, You). The centre Assist button using `gaia-mark.svg` is a genuine brand signature — keep exactly. Top bar with brand stack. |
| **Reordered** | Nothing in the tab bar. |
| **Restyled** | **The real problem is not styling — it is that 5 of 11 views have no navigation entry:** Journey, **Events**, **Bookings**, Inbox, Directory. Events and Bookings are core member value reachable only by deep link. Recommendation: surface them via Quick Access on Home (**done**) and add them to the "You" screen's list, rather than expanding the tab bar — 7 items is already the mobile ceiling. |
| **Real asset reused** | `gaia-mark.svg` (centre button), Phosphor for tab icons. |
| **New asset required?** | **No.** |
| **Performance** | Neutral. |
| **Scope** | Mobile = tab bar. Desktop currently uses the same bar; a sidebar is **explicitly out of scope** — it was prototype-only and this app is mobile-first. |

# 4. Academy

| | |
|---|---|
| **Stays as-is** | `g-page__head` (kicker/title/sub), `academySummary`, all course-grant and credential logic, the GHL portal links. |
| **Reordered** | Continue-learning first, then all courses, then credentials. Today the summary caption leads. |
| **Restyled** | Course rows → the existing `.g-super-row` with a progress bar in the row body (the pattern already proven in `.g-upnext`). Credentials → `.g-card` with the certificate icon. This is the screen that gains most from consistency: it currently mixes its own patterns. |
| **Real asset reused** | `g-page__head`, `.g-super-row`, `.g-card`. No imagery needed — courses carry their own titles. |
| **New asset required?** | **No.** |
| **Performance** | Neutral to positive — replaces bespoke markup with shipped CSS. |
| **Scope** | Shared. |

# 5. Events

| | |
|---|---|
| **Stays as-is** | All event data, the Elevate registration flow, QR/badge logic, `eventFeatureCarousel`. |
| **Reordered** | Featured/next event first, then upcoming list. |
| **Restyled** | **This screen is a 9-line empty shell** (`#events-body`) filled by `gaia-superapp.js` — it has no `g-page__head` while Academy, Community and Profile do. Add the shared head for consistency, then render the list as `.g-super-row` with a date/status on the right. |
| **Real asset reused** | **`gaia-elevate-hero.png` and `gaia-event-hero.webp` — the real Elevate branding.** Explicitly *not* generated event art. |
| **New asset required?** | **No.** |
| **Performance** | Neutral. Both images already precached by the service worker. |
| **Scope** | Shared. |

# 6. Bookings

| | |
|---|---|
| **Stays as-is** | The booking catalogue and its GHL widget links (Bio-Well scan, demo, discovery call, coaching), `upcomingAppointments`. |
| **Reordered** | Your next session first (when one exists), then the catalogue. |
| **Restyled** | Same as Events — a 9-line shell with no page head. Add it, then the catalogue as `.g-super-row` with duration and "Free" where true. The next-session card reuses the `.g-upnext` treatment already built. |
| **Real asset reused** | `.g-super-row`, `.g-card`, Phosphor. |
| **New asset required?** | **No.** |
| **Performance** | Neutral. |
| **Scope** | Shared. |

# 7. Community

| | |
|---|---|
| **Stays as-is** | Circles, Find a Healer, Gaia Radio, messages, the three stacked sections and the `GaiaCommunityTabs` scroll-to behaviour added earlier. Directory map logic. |
| **Reordered** | Nothing structural. |
| **Restyled** | Circle entries → `.g-super-row` with member counts and activity on the right. **Highest-value performance item lives here:** the Leaflet map stack (**54.9 KB gzipped**) loads on *every* page of the app but is only needed for Find a Healer. Load it when the directory opens. |
| **Real asset reused** | `.g-super-row`, Phosphor. |
| **New asset required?** | **No.** |
| **Performance** | **Best win in the proposal: −55 KB on every page load**, and it is a loading change, not a visual one. Risk: must confirm the map still initialises when lazily loaded. |
| **Scope** | Shared. |

# 8. Gaia Assist

| | |
|---|---|
| **Stays as-is** | The sheet, voice pipeline, the stereo fix, intent routing, and the pulse/breathing intents added earlier. **The centre-button mark is brand — untouched.** |
| **Reordered** | Nothing. |
| **Restyled** | Suggestion chips get the same pill treatment as `.g-btn--pill` so Assist stops looking like a separate app. Reply text gets the body-copy scale used elsewhere. |
| **Real asset reused** | `gaia-mark.svg`. |
| **New asset required?** | **No** — and specifically **do not** generate an "Assist avatar". The mark is the identity. |
| **Performance** | Neutral. |
| **Scope** | Shared. |

# 9. Wellness tools section

| | |
|---|---|
| **Stays as-is** | **The Energy Pulse measurement engine — frozen, untouched.** All wellness/astronomy calculations. The check/horoscope/chakras tabs. The "self-discovery toolkit" accordion. |
| **Reordered** | **Done** — new "All tools" tab gives the free tools a destination of their own. |
| **Restyled** | **Done** — tool tiles with the app's own tint system, the free/device-only promise stated plainly, and saved pulse readings shown back as a sparkline. Remaining: apply the same tile treatment to the Home free-tools strip so the two agree. |
| **Real asset reused** | `pulse-finger.webp`, `pulse-tap.webp`, `gaia-chakra-meditation`, `moonSvg()`, Phosphor tool icons. |
| **New asset required?** | **No.** |
| **Performance** | Tiny CSS addition. **Note:** lazy-loading tool scripts would save ~55 KB, but 34 KB of that is the Pulse files — **excluded to respect the freeze** unless you say otherwise. |
| **Scope** | Shared. |

# 10. Profile / You

| | |
|---|---|
| **Stays as-is** | Membership resolution, access lists, sign-in/out, practitioner tools, billing links. |
| **Reordered** | Identity card → membership → your access → **Events / Bookings / Inbox / Journey (the views with no tab entry)** → practitioner tools → sign out. |
| **Restyled** | Everything to `.g-super-row`. This screen is the natural home for the orphaned views, which fixes the navigation gap without touching the tab bar. |
| **Real asset reused** | `.g-super-row`, `.g-card`, Phosphor. |
| **New asset required?** | **No.** |
| **Performance** | Neutral. |
| **Scope** | Shared. |

---

## Cross-cutting: what actually makes it feel premium

Ranked by effect per unit of risk.

1. **One row component everywhere.** Events, Bookings, Community, Academy and You all render lists differently today. Putting them all on `.g-super-row` is the single biggest coherence gain, and it ships existing CSS.
2. **One section header everywhere.** Kicker + title + optional "View all". Events and Bookings are missing `g-page__head` entirely.
3. **One spacing scale.** Section gaps currently vary. Pick the Home rhythm and apply it.
4. **Typography discipline.** The editorial serif for titles, sans for UI — already in the app, applied inconsistently.
5. **Restrained luminous borders** on cards, as `.g-quick` now does — the "dark glass" of the direction, achieved with `color-mix` on existing tokens. No new colours.

## Performance items (measured, from the audit)

| Item | Saving | Risk | Visual change |
|---|---|---|---|
| Subset Phosphor (67 of 1,530 icons used) | **~145 KB** | Low — icon list is enumerable | **None** |
| Lazy-load Leaflet map stack | **~55 KB** | Low-med — verify init | **None** |
| Self-host Inter | 1 request, ~121 ms | Low | None (fixes offline) |
| Lazy-load non-Pulse tool scripts | ~21 KB | Low | None |

**Baseline: 400 KB gzipped, 95 requests, FCP ~1.0 s.** The first two alone take it to roughly **200 KB with nothing on screen changing.**

## New assets genuinely required

**None.** Every screen above is deliverable with existing production assets plus the Phosphor set already shipping. The only place new artwork would be warranted later is replacing the three *dormant* rasters (`chakra-all-in-one`, `gaia-elevate-poster`, `gaia-hero-moon-tall`) — and none is currently referenced, so it is not blocking.

## Proposed sequence

1. **Review + ship what is already built** (member-first Home, Energy Tools, compact sky card) — 77 tests green.
2. **Performance pass** — Phosphor subset + Leaflet lazy-load, with before/after numbers. No visual change, ~50% payload cut.
3. **Row + header consistency** — Events, Bookings, then Community, Academy, You. One PR per screen.
4. **Profile/You reorganisation** — closes the navigation gap for the 5 orphaned views.
5. **Polish pass** — spacing scale, typography, card borders.

Each step is independently shippable and reversible. Nothing in steps 1–5 touches the Pulse engine, the astronomy calculations, the splash concept, or the brand identity.
