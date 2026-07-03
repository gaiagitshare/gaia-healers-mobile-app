# Gaia Member App — Architecture Map

Goal: Gaia is a **full member app/website** (native experience) with GHL as the backend.
Every section is fed by the normalized `/api/member/*` layer — the frontend never
talks GHL directly. This map defines what is native vs deep-linked, what can be
sold/booked in-app, what scopes/API power it, and what still needs manual URLs.

Legend — **Native** = rendered inside Gaia from live data · **Deep-link** = opens a
GHL/portal page · **Sell/Book** = transaction can happen in-app · **Scope** = GHL
token scope (all 21 granted) · **Manual** = exact member URL still needed.

---

## 1. My Access / Memberships
- **Data:** `/api/member/access`, `/api/member/communities` (live tags)
- **Native:** ✅ access grid (unlocked / locked / unknown) — live from `community-*-member` tags
- **Deep-link:** each card → its community page (see §3)
- **Sell/Book:** locked cards → upgrade/request (future: store/offer link)
- **Scope:** `contacts` ✅ · **Manual:** community URLs (2 confirmed, 4 pending)

## 2. Courses / Academy
- **Data:** `/api/member/courses` (placeholder — **no GHL LMS API**, 404) + tag hints
- **Native:** ⚠️ partial — catalog/hub + progress *placeholders* only (real lessons/progress not exposed by GHL)
- **Deep-link:** Academy hub → `/courses` ✅ confirmed · per-course → **pending**
- **Sell/Book:** course purchases via Store (§6)
- **Scope:** none help (no courses API) · **Manual:** per-course URLs pending

## 3. Communities
- **Data:** `/api/member/access` (membership) — content (posts/rosters) **not in any API**
- **Native:** ✅ membership state; ❌ post/feed content (impossible via API)
- **Deep-link:** community page — `all-gaia` ✅, `biopulsar` ✅; `biowell`/`biotekna`/`healeex`/`abundant` **pending**
- **Scope:** `contacts` ✅ · **Manual:** 4 community URLs pending

## 4. Events
- **Data:** `/api/member/events` (community events — **no API**) + `/appointments` (bookings)
- **Native:** ⚠️ limited — community/live-session events not in API; Elevate/Orlando exist as funnels
- **Deep-link:** event funnels (Elevate Conference, Orlando Exhibit, Gaia Healers Events) → **pending confirmation**
- **Sell/Book:** event registration via forms/funnels
- **Scope:** `calendars` ✅ · **Manual:** event funnel URLs pending

## 5. Bookings
- **Data:** `/api/member/appointments` (live) + `bookingLinks[]` (generated)
- **Native:** ✅ member's appointments list + "Book a session" cards
- **Sell/Book:** ✅ **in-app booking** via GHL widget — `…/widget/bookings/{slug}` (Bio-Well Scan/Demo/Healeex combo confirmed live)
- **Scope:** `calendars` ✅ · **Manual:** none (generated); optionally curate more calendars from 287

## 6. Store / Products
- **Data:** `/api/member/products` (owned tags + paid orders + subscriptions), `/api/member/purchases`
- **Native:** ✅ "My products / devices" + purchase & subscription history (live)
- **Deep-link:** store/catalog → **pending** (products have no member URL; candidate funnel `/store-blueprint`)
- **Sell/Book:** ✅ possible — products + prices + payments scopes granted; needs store URL / embedded checkout
- **Scope:** `products`, `products/prices`, `payments/*` ✅ · **Manual:** store URL pending

## 7. Forms / Surveys
- **Data:** `/api/member/forms` (live submissions + generated widget `openUrl`)
- **Native:** ✅ completed/available forms & surveys list
- **Sell/Book:** ✅ **fill in-app** — `…/widget/form/{id}` · `…/widget/survey/{id}` (generated, live)
- **Scope:** `forms`, `surveys` ✅ · **Manual:** none (generated from id)

## 8. Profile
- **Data:** `/api/member/profile` (contact + custom fields, incl. Bio-Well serial) + `/activity`
- **Native:** ✅ full profile — identity, membership tier, practitioner status, devices, recent activity (live)
- **Deep-link:** portal account settings → **pending** (optional)
- **Scope:** `contacts`, `customFields` ✅ · **Manual:** portal profile URL (optional)

## 9. Gaia AI
- **Data:** Gemini Live voice + chat, personalized from session + member context
- **Native:** ✅ fully native; Phase 4 expands to memberships / certs / products / appointments / access rights
- **Deep-link:** none · **Scope:** Gemini (proxy) + member data · **Manual:** none

---

## Cross-cutting summary

| Bucket | Sections |
|---|---|
| **Native in Gaia (live now)** | My Access, Bookings list, Products/Purchases, Forms/Surveys, Profile, Activity, Gaia AI |
| **Deep-link to GHL** | Community pages, Course pages, Store, Event funnels, Portal account |
| **Sell / Book inside Gaia** | Bookings (widgets ✅), Forms/Surveys (widgets ✅), Store checkout (scopes ✅, URL pending), Event registration |
| **Needs GHL scopes/API** | **All 21 scopes granted** — nothing further. Course lessons/progress + community post content are **impossible** (no API) → deep-link only |
| **Needs manual URL confirmation** | 4 community URLs (biowell, biotekna, healeex, abundant), per-course URLs, store URL, event funnel URLs |

## Confirmed deep-links (wired)
- `all-gaia` → `https://education.gaiahealers.com/gaia-healers-community`
- `biopulsar` → `https://education.gaiahealers.com/biopulsar-community`
- Academy hub → `https://education.gaiahealers.com/courses`
- Bookings → `https://api.leadconnectorhq.com/widget/bookings/{scans|bio-welldemo|healeex-bio-well-combo}`
- Forms/Surveys → `https://api.leadconnectorhq.com/widget/{form|survey}/{id}` (generated)

## Build order (structure-first)
1. ✅ Phase 2/2b — normalized `/api/member/*` data layer (live)
2. ✅ Phase 3 — deep-link fields (`openUrl`) + 3 confirmed URLs
3. ⏳ Confirm remaining manual URLs (communities, courses, store, events) → drop into `DEEPLINK` config
4. ⏳ Phase 4 — Gaia AI personalization from the full data layer
5. ⏳ Phase 5 — UX redesign around these 9 sections
6. ⏳ Phase 6 — full production audit
