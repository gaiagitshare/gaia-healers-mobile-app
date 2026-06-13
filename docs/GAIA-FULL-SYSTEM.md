# Gaia Full System Design

## Goal

Build Gaia as a full operator platform, not only a static member prototype:

- Member app for Bio-Well, academy, events, membership, devices, community, and Gaia Assist.
- Admin cockpit for GHL, classes, lectures, events, products, and AI safety controls.
- Staging proxy / backend as the only place where private tokens live.

## SnapBOS Pattern To Reuse

SnapBOS Assist uses a good production pattern:

- Context aggregator: gathers safe workspace facts before the AI responds.
- Capability registry: defines what the AI can read, draft, propose, or execute.
- Voice provider layer: realtime/OpenAI voice, TTS proxy, STT proxy, browser fallback.
- Admin flags: turn context, proactive suggestions, TTS, and rollout audience on/off without SSH.
- Usage + audit logs: track model calls, cost, actions, outcomes, and errors.
- Confirmation gates: AI proposes writes, but users/admins approve before changes happen.

## Gaia Backend Modules

Recommended backend modules:

| Module | Scope |
| --- | --- |
| Identity + roles | Member, practitioner, faculty, exhibitor, staff, admin, super admin |
| GHL connector | Contacts, opportunities, tags, workflows, campaigns, event registrations |
| Academy connector | Courses, lessons, lectures, quizzes, CE credits, certificates |
| Event connector | Events, attendees, QR check-in, badges, exhibitors, lead retrieval |
| Device/store connector | Bio-Well purchases, device ownership, support, training bundles |
| Body map | Chakra/body-point trends stored from scan summaries, not medical diagnosis |
| Gaia Assist | Chat, voice, TTS, context, memory, proposals, admin flags |
| Audit + approvals | Every AI write/action requires role checks and audit logs |

## Admin Cockpit

The admin panel should include:

- GHL command: contacts, event registrants, lead sources, tags, follow-up drafts.
- Classes + lectures: upload lectures, assign courses, issue CE credits, manage credentials.
- Events: GHL import, badge PDFs, QR check-in dashboard, exhibitor scan links, leads export.
- Devices: Bio-Well device ownership, warranty/support, onboarding status, shop bundle access.
- Membership: plans, renewals, community access, practitioner verification.
- AI controls: provider order, voice/TTS, proactive suggestions, approval rules, audit logs.

## AI Safety

Gaia Assist should be smart with the system but not reckless:

- Read-only by default.
- Write actions return a proposal.
- User/admin confirms before saving to GHL, Event Manager, Academy, or membership records.
- Medical/wellness guardrails: Bio-Well/chakra language is educational and trend-based.
- No secret keys in the app or GitHub Pages.

## Build Order

1. Keep the current static app + staging proxy for visual and voice testing.
2. Add auth and roles to the proxy.
3. Add a database for members, device ownership, body-map trends, audit logs, and AI memory.
4. Add normalized GHL/Event/Academy connectors behind backend routes.
5. Replace static cards with authenticated live data.
6. Build real admin cockpit screens.
7. Add native iOS wrapper once flows are stable.
