# Community UX Map — GHL → Gaia App

## Problem we fixed

The old Community screen showed the same **Client Portal** hero and **Groups** carousel on every tab (Discussion, Learning, Events, Members, Newsletter). Only a small area below changed, which wasted ~60% of the viewport and felt like a static landing page instead of a tabbed app.

## New layout

| Layer | Visible on all tabs? | Purpose |
| --- | --- | --- |
| Header + tab pills | Yes | GHL Community Hub navigation |
| **Compact portal strip** | Yes | One-line link to `education.gaiahealers.com` + tappable stats (members, groups, courses) |
| **Tab panel** | One at a time | Tab-specific content only |

### Tab → GHL source mapping

| App tab | GHL equivalent | Mobile content |
| --- | --- | --- |
| **Discussion** | Communities → group → Discussion + channels | Horizontal group filter + thread feed |
| **Learning** | Communities → Learning + Client Portal → Courses | Course rows grouped by community |
| **Events** | Communities → Events + Elevate registration | Elevate hero + group calendar rows |
| **Members** | Communities → Members | Sample directory + login CTA |
| **Newsletter** | Marketing → segments / email prefs | Segment toggles + portal manage link |

Data today lives in `gaia-ecosystem.js`. Production should read normalized JSON from the Gaia proxy (`GET /api/ghl/communities`, etc.) — see `docs/GHL-COMMUNITY-SYNC.md`.

## GHL structure (location `WkKl1K5RuZNQ60xR48k6`)

```
Client Portal (education.gaiahealers.com)
├── Courses (Academy tab in app)
├── Communities (Community tab)
│   ├── [Start Here] All Gaia Healers — public, channels, onboarding
│   ├── Bio-Well Practitioners — primary device community + leaderboard
│   ├── BioPulsar / Biotekna / Healeex — modality groups
│   └── Abundant Healer Collective — private membership
├── Credentials (Profile tab)
└── Gokollab Marketplace (future)

Each community group tabs:
  Discussion | Learning | Events | Members | About | (Leaderboard)
```

## Recommended app mapping (full product)

| Bottom nav | Primary GHL surface | Notes |
| --- | --- | --- |
| **Today** | Dashboard + Bio-Well scan summary | Personal home, not GHL |
| **Bio-Well** | Device data + chakra map | Links into Bio-Well Practitioners group |
| **G (Assist)** | AI layer over all sources | Read-only; drafts need admin approval |
| **Academy** | GHL Courses + credentials progress | Same courses as Learning tab, user-centric |
| **Community** | GHL Communities hub | Tabbed by GHL group tab type |
| **Profile** | Client Portal member + CE + Elevate pass | Magic link login handoff |

## Phase 2 — cooler features (when proxy is live)

1. **Deep links** — `home.html?view=community&tab=discussion&group=biowell` opens filtered feed (URL param wiring).
2. **Unread badges** — sync post/reply counts per group from GHL webhooks.
3. **Leaderboard tab** — Bio-Well group only; gamify scan uploads and course completion.
4. **Live event cards** — “Happening now” from GHL calendar + Zoom/Meet link after login.
5. **Member search** — typeahead against cached member index post-auth.
6. **Push notifications** — new reply in subscribed channels, training reminders, Elevate check-in.
7. **Cross-link Academy ↔ Community** — course row opens same module in Academy with progress bar.
8. **Private group gate** — Abundant Collective shows lock state until membership verified.

## Design principles applied

- **Compact strip, not hero card** — portal context without dominating the screen.
- **Tab owns the story** — groups only appear on Discussion; courses only on Learning.
- **Tappable stats** — members → portal, groups → Discussion, courses → Academy.
- **Native row patterns** — reuse `gaia-row`, `gaia-stack`, badges for consistency with Profile/Academy.

## Files touched

- `home.html` — panel structure + compact strip
- `gaia-ui.js` — `initCommunityHub()` render + group filter
- `gaia-ecosystem.js` — courses, events, members seed data
- `gaia-shared.css` — community strip, group rail, feed cards
