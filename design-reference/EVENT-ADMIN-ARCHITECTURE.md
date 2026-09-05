# Event Admin architecture — read this before adding an event feature

Locked 2026-09-04. There is **one** Event Manager. Gaia Healers Admin does not
contain a second one and must never grow one.

## The shape of it

```
api.gaiahealers.app/admin/    →  /var/www/gaia-admin      (the Admin shell)
                                  Contacts · Surveys · Membership · System Map
                                  Events  ──►  <iframe src="/event/">
                                                     │
api.gaiahealers.app/event/    →  /var/www/event         (the Event Manager SPA)
                                  Dashboard · Events · Check-In · Payments Review
                                  every call ──►  /event-api/*
                                                     │
                                            127.0.0.1:8002  (FastAPI)
                                                     │
                                              event.db  (SQLite)
```

The Events area inside the Admin **is** the Event Manager. Not a copy, not a
mirror, not a re-implementation — the same build, loaded in an iframe. Verified
2026-09-04: both surfaces served `main.4cb931c6.js` with the identical SHA-256
`3e92e5e454227a3a`, and `gadmin.js` contained zero references to `attendee`,
`checkin`, `walk-in`, `ticket_type`, `door-report` or `acquisition-report`.

## The rules

1. **Every event feature is built in `/event/` only** — attendees, check-in,
   walk-ins, badges and printing, badge cards, ticket mappings, door payments,
   acquisition and door reporting, payments review. Source: `/root/event`
   on the VPS (backend `main.py`, frontend `frontend/src`).

2. **The Admin shell only hosts and navigates.** Its job for Events is three
   things and nothing else: the nav item, the iframe, and single sign-on. The
   only `/event-api/` calls it is allowed to make are under `/auth/` — login,
   set-password, change-password — because that is what SSO needs.

3. **Never duplicate event logic in `/admin/`.** No attendee list, no check-in,
   no badge rendering, no walk-in form, no reporting, no payments review. If it
   is about an event, it belongs in the Event Manager. A second implementation
   is how two admin panels start disagreeing about who is checked in.

4. **Therefore every Event Manager change appears in both places at once**, with
   no porting, no mirroring and no sync step. That is the whole point of the
   arrangement, and it only holds while rule 3 holds.

5. **Admin-shell features stay in the Admin shell** — Contacts, Membership,
   Surveys, System Map, navigation, branding, sign-in. Those never move into
   the Event Manager.

`tests/event-admin-boundary.test.cjs` enforces rules 2 and 3. If it fails, an
event feature has been started in the wrong place.

## Which door staff use

**Gaia Healers Admin → Events is the official entry point.** Staff should be
told that one URL and nothing else.

`/event/` stays reachable as an **emergency fallback**, deliberately:

- if the Admin shell breaks, the door still has to open on event day;
- it gives real, linkable URLs (`/event/events/1/checkin`), which the embedded
  view cannot — inside the iframe the address bar stays on `/admin/#events`;
- support can say "open this link" and land someone on an exact screen.

It is not deprecated and not scheduled for removal. If it ever becomes
confusing, the low-risk move is a note on `/event/login` pointing staff to the
Admin — not a redirect, which would destroy the linkable-URL property that makes
the fallback worth keeping.

## Two things a future developer should know

**Session expiry inside the iframe.** The SPA redirects to `/event/login` on a
401. Inside the Admin that redirect happens *within the frame*, so the sign-in
form appears embedded. It works; it just looks unusual.

**The camera.** `/event/` sends `Permissions-Policy: camera=(self)`; `/admin/`
sends none, so the browser default (`self`) applies and a same-origin iframe
inherits it. The QR scanner should therefore work embedded. The iframe has no
explicit `allow="camera"` attribute — if a browser ever refuses the camera in
the embedded scanner, adding that attribute in `mountEvents()` is the fix.

## Known gap, not yet addressed

`/root/event` **is not a git repository.** The Admin shell is versioned in this
repo under `admin/`, but the Event Manager — backend and frontend — exists only
on the VPS. Backups are taken (`event.db.pre-*`), but the code has no history
and no remote. Worth fixing before the codebase grows further.

## The boundary, stated as ownership

**Event Admin owns event behaviour. General Admin may read event summaries.**

That is the whole rule. It is about who *performs* an action, not which words
appear on a screen.

### General Admin may

* show which events a contact attended, and their status
* show pass/ticket and current check-in state as a summary
* show a payment or attendance count
* link across to Event Admin

…provided the data is **joined server-side by the proxy** and rendered read-only.

### General Admin may not

check in · undo check-in · scan badges · create, update, delete, revoke or
reinstate an attendee · change a pass or add-on · print or record a badge ·
reconcile event payments · manage exhibitors · manage ticket mappings · grant
event permissions · register a walk-in.

### How it is enforced

`tests/event-admin-boundary.test.cjs` checks the shapes of those capabilities
rather than a list of nouns — a screen can say "attendee" and be innocent, and
can avoid the word entirely while shipping a check-in button. It also asserts:

* the shell issues **no mutating request** (POST/PUT/PATCH/DELETE) at the event
  domain, however the path is spelled;
* the shell calls **no `/event-api/*` route except `/auth/*`** — event data
  arrives through the proxy's own `/api/admin` join, so the shell never becomes
  a second client with its own idea of the truth;
* Events remains an iframe onto the real `/event/`, sharing one session.

The tripwire was verified by planting five realistic violations — a check-in
function, an exhibitor POST, a PUT to `/event-api/attendees/5`, a QR scanner and
an `undoCheckIn` — and confirming each one fails the suite.

### Why the earlier word-list was replaced

It banned the literal string `attendee` anywhere in the shell. That blocked a
read-only attendance summary on a contact — which cannot drift, because it
computes nothing and writes nothing — while doing nothing to stop somebody
implementing check-in under a different name. Ownership is the property worth
enforcing; vocabulary was a proxy for it, and a poor one.
