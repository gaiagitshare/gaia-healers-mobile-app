# Gaia Healers Real Data Sync Plan

This prototype is currently static HTML/CSS/JS. Before Apple Developer release work, the app needs a real staging backend that safely reads Gaia data without exposing private tokens in the mobile app, GitHub, or browser.

## Current Prototype Sources

- Gaia website: public brand, product, event, and content reference.
- GHL/CRM: registration, contacts, memberships, course/customer state.
- Event Manager: `/root/event` FastAPI app for event sync, GHL CSV attendee import, QR check-in, badge PDF generation, exhibitors, and lead retrieval.
- Gaia Assist: adapted from SnapBOS Assist as a push-to-talk assistant pattern with explicit review before any save/import/change.

## Required Production Architecture

Use a small backend proxy between the mobile app and private systems:

```text
Gaia mobile app
  -> Gaia API proxy
      -> GoHighLevel API
      -> Event Manager API
      -> Education / credential source
      -> OpenAI Realtime / assistant backend
```

The app should never contain:

- GHL private API keys
- GitHub tokens
- OpenAI API keys
- Event admin JWTs
- Apple credentials

## Phase 1: Staging API

Create a staging API with these read endpoints:

- `GET /api/app/me`
- `GET /api/app/today`
- `GET /api/app/biowell`
- `GET /api/app/academy`
- `GET /api/app/community`
- `GET /api/app/events/elevate-2026`

Each endpoint should return the exact JSON shape currently represented in `gaia-ecosystem.js`, so the frontend can swap from static data to live data with minimal UI changes.

## Phase 2: Event Sync

Connect to the existing Event Manager:

- Read active events from `/event-api/events` through the proxy.
- Read public event details from `/event-api/public/events/{event_id}` where possible.
- Keep GHL as the registration/payment source.
- Use Event Manager for attendee import, badge status, check-in status, exhibitors, and lead counts.

For mobile testing, start read-only:

- Show attendee/pass/badge status.
- Show check-in readiness.
- Show exhibitor lead counts.
- Do not let the app mutate check-in, imports, or leads until admin auth is designed.

## Phase 3: GHL Sync

Use GHL only from the backend proxy:

- Contacts and membership status
- Course purchase/access tags
- Event registration/ticket status
- Follow-up task status
- Practitioner directory metadata

Recommended rule: cache normalized app data in your own database, then refresh from GHL on a schedule/webhook. Do not make every mobile screen depend directly on GHL API latency.

## Phase 4: Gaia Assist

Ship assistant in two layers:

- Prototype layer: current `gaia-ui.js` panel and suggested actions.
- Real layer: backend-only OpenAI Realtime session endpoint with short-lived auth, explicit user confirmation, and no always-listening mode.

Assistant writes must stay gated:

- Propose
- Let user review/edit
- Confirm
- Then call the backend

## Release Readiness Checklist

- GitHub branch reviewed and merged.
- GitHub Pages or staging domain available for mobile web testing.
- Staging API deployed with test GHL/Event credentials stored as GitHub/Vercel/server secrets.
- No private tokens in repo, browser source, or built assets.
- Event Manager CORS locked to staging/app domains.
- Test account matrix: member, non-member, event attendee, exhibitor, admin.
- Mobile QA on Safari iOS and Chrome Android.
- Apple Developer account created.
- App wrapper decision made: native Swift shell, Capacitor, or GHL mobile app surface.
- Privacy policy updated for CRM, event data, voice, and biofield/wellness disclaimers.
