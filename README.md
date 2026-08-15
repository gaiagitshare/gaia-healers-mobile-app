# Gaia Healers Super App

Production PWA for Gaia Healers members: [gaiahealers.app](https://gaiahealers.app/home.html).

The app is a responsive service hub for membership access, courses, communities,
events, bookings, purchases, messages, wellness tools, and Gaia Assist. GoHighLevel
(GHL) remains the source of truth for member identity and entitlements.

## Architecture

- `home.html` is the single public app shell.
- `gaia-superapp.js` renders Today, Journey, Events, Bookings, and Inbox.
- `gaia-member.js` reads normalized authenticated `/api/member/*` contracts.
- `gaia-live-sync.js` reads public bootstrap data from `api.gaiahealers.app`.
- `staging-proxy/server.js` is the production API/proxy and the only layer that
  communicates with GHL, the event service, and AI providers.
- `shared-nav.js` provides the responsive Today / Journey / Assist / Inbox /
  Profile navigation.
- `gaia-ecosystem.js` contains public, non-personal defaults only. It must never
  contain sample progress, member records, feeds, purchases, or wellness readings.

## Data truth

The app shows authenticated data only when the corresponding member API returns it:

- membership and access: `/api/member/access`
- profile: `/api/member/profile`
- course grants: `/api/member/courses`
- communities: `/api/member/communities`
- appointments: `/api/member/appointments`
- conversations: `/api/member/notifications`
- devices, purchases, products, forms, and activity: their matching member routes
- confirmed public event: `/api/app/bootstrap` and `/api/member/events`

GHL does not expose lesson-level course progress, community post feeds, or
community live-session feeds through the public API. Those experiences open the
authorized GHL workspace; the app does not fabricate them.

## App routes

- `?view=today` — service hub and confirmed next event
- `?view=journey` — verified Learn / Practice / Connect access
- `?view=academy` — real course grants and authorized Academy workspace
- `?view=community` — real community entitlements
- `?view=events` — confirmed event and member appointments
- `?view=bookings` — GHL appointments and verified booking forms
- `?view=inbox` — read-only GHL conversation summaries
- `?view=wellness` — public chakra tools and verified wellness profile data
- `?view=store` — live catalog and official membership tiers
- `?view=profile` — member account, purchases, devices, forms, and sign-out

## Local verification

Run the static app:

```bash
python3 -m http.server 8765
```

Run the API separately from `staging-proxy/` with the required secrets and
`ALLOWED_ORIGINS=http://127.0.0.1:8765`, then open:

```text
http://127.0.0.1:8765/home.html?view=today&proxy=http://127.0.0.1:8787
```

Minimum release checks:

```bash
git diff --check
node --check gaia-superapp.js
node --check gaia-member.js
node --check gaia-ui.js
node --check shared-nav.js
node --check staging-proxy/server.js
curl -fsS https://api.gaiahealers.app/health
```

Test mobile and desktop navigation, signed-out states, authenticated member
entitlements, PWA installation, and production API responses before each release.
