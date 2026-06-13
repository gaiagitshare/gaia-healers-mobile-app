# GHL Community + Membership Sync

## What Was Observed In GHL

Location: `WkKl1K5RuZNQ60xR48k6`

Client Portal:

- Portal URL: `https://education.gaiahealers.com/`
- Users: `1,252`
- Invited: `1`
- Admin areas: Client Portal, Courses, Communities, Credentials, Gokollab Marketplace
- Admin actions: generate magic link, invite to client portal, send login email

Community groups:

| Group | Access | Members | Posts | Admins | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| `[Start Here] All Gaia Healers` | Public | 254 | 28 | 3 | Home, Start Here, Healers Lounge, Ask A Mentor, Wins Wall |
| `The Abundant Healer Collective` | Private | 117 | - | 3 | Membership community |
| `Bio-Well Practitioners` | Public | 381 | 11 | 3 | Orientation, Tech Support, Case Studies, device channels, Leaderboard |
| `BioPulsar Practitioners` | Public | 507 | - | 3 | Aura and chakra practitioner group |
| `Biotekna Practitioners` | Public | 154 | - | 3 | Nervous-system/device education group |
| `Healeex` | Public | 31 | - | 3 | Healeex onboarding and calls |

Tabs used across communities:

- Discussion
- Learning
- Events
- Members
- About
- Leaderboard where available

## Product Direction

The static GitHub Pages app should stay a prototype shell. It must not own passwords, GHL tokens, OpenAI keys, ElevenLabs keys, or admin write permissions.

Member login should be one of:

- Direct handoff to GHL Client Portal: `https://education.gaiahealers.com/`
- Backend-generated magic link after admin approval and rate limits
- Future native app session issued by the Gaia backend after GHL member verification

## Proxy Routes To Add

Read-only routes:

- `GET /api/ghl/client-portal/summary`
- `GET /api/ghl/communities`
- `GET /api/ghl/communities/:groupId/discussion`
- `GET /api/ghl/communities/:groupId/learning`
- `GET /api/ghl/communities/:groupId/events`
- `GET /api/ghl/communities/:groupId/members`
- `GET /api/ghl/newsletters`
- `GET /api/member/me`

Write/proposal routes:

- `POST /api/auth/magic-link/request`
- `POST /api/admin/proposals`
- `POST /api/admin/proposals/:id/approve`
- `POST /api/ghl/messages/draft`
- `POST /api/ghl/tags/propose`
- `POST /api/events/attendees/import/propose`

## Admin Requirements

Before enabling writes:

- Add role-based auth: member, practitioner, faculty, event staff, admin, super-admin.
- Add audit logs for actor, role, source, payload summary, approval, result, and rollback notes.
- Keep Gaia Assist read-only by default.
- Let Gaia Assist draft or propose changes, then require user/admin approval before GHL, Event Manager, Academy, or membership updates.
- Cache normalized community data in the Gaia backend so mobile screens do not depend on GHL latency.

## Newsletter Model

Newsletter preferences should map to GHL Marketing segments:

- Training reminders
- Chakra challenge
- Events and Elevate
- Device/store offers
- Practitioner community highlights

The app can show preferences now, but saving preferences needs an authenticated proxy route.

## Live Meetings

Use GHL calendar/course/session records as the source of truth for live meeting links.

Recommended normalized fields:

- `meetingProvider`: `google_meet`, `zoom`, or `custom`
- `meetingUrl`: stored only in the backend or returned to verified members
- `startsAt`, `endsAt`, `timezone`
- `hostName`, `hostRole`
- `visibility`: member-only, cohort-only, staff-only, or public preview

The static prototype can show a "Live meeting links" placeholder, but real Google Meet or Zoom URLs should only render after member login through the staging proxy.
