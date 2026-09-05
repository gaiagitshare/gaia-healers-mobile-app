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

## Amendment — read-only event context in the Admin shell

The rule above forbids a second Event Manager. It does not forbid *showing* a
person's event history where an operator is already looking at that person.

Contacts → a contact → **Events** lists the attendee records belonging to that
GHL contact. Three properties keep it on the right side of the line:

* the join happens **server-side**, in the proxy, against the Event Manager's
  own `/identity/attendees-by-contact` — the shell never calls the event backend
  (still asserted: only `/auth/*` is reachable from here);
* it is **read-only**. Nothing in the shell authorises, checks in, undoes,
  prints or writes an attendee. A test asserts the absence of those verbs;
* it **computes nothing**. It renders what the Event Manager returned, so the
  two panels cannot arrive at different answers — there is only one answer.

The tripwire's forbidden list therefore names event *actions*, not the word
"attendee". A list of attendee names in the shell is a label; a check-in button
in the shell is a second implementation.
