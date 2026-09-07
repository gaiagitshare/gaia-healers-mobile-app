# Gaia Admin — full functional audit

**Date:** 2026-09-07 · **Scope:** the `/admin/` operator shell and every Event
Manager section embedded inside it · **Method:** driving the live production
system, not reading the source and inferring.

Every finding below was reproduced against production before it was believed,
and every fix was re-measured after. Where a check could not be run without
changing real data, that is said plainly rather than papered over.

---

## What was audited

| Surface | Sections |
|---|---|
| Admin shell (`/admin/`) | Contacts · Surveys · Membership · Events · System Map · System Alerts |
| Event Manager (embedded) | Overview · Schedule · Speakers · Sponsors · Exhibitors · Attendees · Check-In · Community · Live · Announcements · Push Notifications · FAQ & Info · Resources · Setup · Ticket Mappings |

**21 screens.** Auth, routing, history, responsive behaviour, search, event
scoping, check-in rules, payments and the exhibitor consolidation were each
exercised as workflows rather than as page loads.

---

## Bugs found and fixed

### 1. No compression on any script, stylesheet or JSON body — *fixed*

`nginx.conf` set `gzip on` but left `gzip_types` commented out, and nginx's
default is `text/html` alone. Every asset and every API response went out raw.

| | Before | After |
|---|---|---|
| Event Manager bundle | 1,297 KB | 381 KB |
| `/events/1/attendees` | 1,078 KB | 97 KB |
| `gadmin.js` | 86 KB | 23 KB |
| `gadmin.css` | 36 KB | 8 KB |

Scoped to the `api.gaiahealers.app` server block rather than added globally, so
the other sites on the box are untouched. Config tested before reload; previous
version kept at `/root/api.gaiahealers.app.bak-gzip-*`.

### 2. Admin navigation unreachable on a phone — *fixed*

Below 760px `gadmin.css` slid the sidebar off-screen and revealed it with
`.side.is-open`. Nothing ever added that class and there was no hamburger, so a
phone could reach Contacts and nothing else — not Membership, not Events, not
System Alerts, not Sign out. The only way through was to type a URL fragment.

Added the missing control: hamburger, scrim, Escape to close, auto-close on
navigation. Desktop unchanged (`display:none` above the breakpoint).

### 3. The attendee list was re-downloaded on every visit — *fixed*

Switching tabs remounts the component, so each visit re-ran every load. Five
visits pulled the full roster five times: **5,265 KB**.

A 20-second read cache now covers the heavy per-event GETs, shares one request
between components mounting together, and is emptied by **any** non-GET —
including one that failed, because a write that errored may still have landed.
Four visits now cost **194 KB**.

Both properties were proven against production: a revisit inside the TTL made
no request, and a `DELETE` of a non-existent id (404, changed nothing) still
forced the next read to be fresh.

### 4. Browser Back and Forward did nothing — *fixed*

`nav()` wrote `location.hash` on every section change, so the browser recorded
history entries — and nothing listened for them. Pressing Back moved the hash to
`#membership` while the screen carried on showing Surveys: the address bar and
the page disagreed.

Added a `hashchange` listener that ignores non-section values and the no-op
where the hash already matches the current view, so clicking a section still
renders exactly once. Verified by walking Contacts → Membership → Surveys and
pressing Back twice and Forward once.

### 5. Dead files served from the admin web root — *fixed*

Confirmed unused by fetching the live page and reading what it actually
requests, not by reading source:

| File | Size | Disposition |
|---|---|---|
| `membership.js` | 47 KB | never loaded — removed |
| `admin.js` | 22 KB | never loaded — removed |
| `gaia-system.css` (admin copy) | 43 KB | never loaded — removed |
| `index.old.html.bak` | 3 KB | a backup in a public directory — removed |

The **root** `gaia-system.css` is untouched: `home.html` does load that one.
Moved to `/root/gaia-admin-removed-*` on the server rather than deleted, and
removed from the repository where tracked.

### 6. Cache headers defeated the versioned URLs — *fixed*

Assets were served `no-cache, must-revalidate` despite already carrying
`?v=NN`, so every load paid a revalidation round-trip for nothing. Now
`index.html` stays `no-cache` (it carries the version number) and the assets it
names are `immutable` for a year. Proven safe by bumping `v=24 → v=25` and
watching the browser fetch the new file.

---

## Verified working — evidence, not assumption

### Auth and access control
- Ten admin endpoints return **401** with no token; two return **401** with a
  forged token. No endpoint answered without credentials.
- The admin shell signs the embedded Event Manager in with the same bearer
  token (single sign-on). An earlier suspicion of an auth-gate bug was **my
  probe omitting the header**, not a defect — with the header every endpoint
  returns 200, without it 401.

### Event-year isolation (2025 vs 2026)
- Event 1: 297 attendees · Event 2: 368 attendees · **0 id overlap**.
- Exhibitors: 52 vs 0, **0 overlap**.
- 12 event-2 emails searched against event 1: **0 results**. 12 event-1
  attendees searched against event 2: **0 results**.
- `ticket-counts` totals match the list lengths exactly.

### Attendee search — 15 variants, all correct
First name · last name · **surname-first** · full name · email · email local
part · phone as stored · phone digits only · phone last 7 · QR code · lowercase
· uppercase · 3-letter partial · leading/trailing spaces · nonexistent term
(correctly 0 results).

### Check-in and scanning
Read from the decision code and the behavioural suites:
- **Wrong event** — the badge is matched within the event only; a valid badge
  from elsewhere reads as not found and is logged `DENIED`.
- **Refunded / revoked / cancelled** — `DENIED`, with the status named.
- **Anti-passback** — secure by default: `allow_reentry` is off unless an
  organiser opts in, so a second scan is refused.
- **Before / after the event days** — refused, and the day is judged in the
  **event's timezone**, never UTC or the browser's.
- **Exhibitor lead scan** — refuses an invalid token, an invalid QR, an
  attendee from another event, an inactive ticket, and a duplicate scan.
- Every scan writes a `ScanLog` with result and reason, including refusals with
  no attendee attached.

Suites green: door lifecycle, door rehearsal, walk-in lifecycle, walk-in
reconcile, QR permanence, card identity, card permanence, card activation.

### Payments
`test_payments`, `test_invoice_reconcile` (24 checks), `test_refund_mirror`,
`test_future_sales`, `test_map_reconcile` (28 checks) all pass, including *"an
admin JWT cannot post payment data — only the service token can"*. No writes to
GHL were made or attempted.

### Exhibitors
The Vendors → Exhibitors consolidation left **no dead routes and no duplicate
logic**. `/vendors` forwards to the event's Exhibitors screen; the only
remaining "vendor" mentions are code comments and one API function name mapping
to `/exhibitors/{id}/activation-link`.

### Runtime
All 15 Event Manager sections were clicked through with `console.error`,
`console.warn`, `error` and `unhandledrejection` hooks installed: **zero
errors, zero warnings, zero unhandled rejections**. This is one signal among
many, not the conclusion.

### Responsive — 375 / 430 / 768 / 1024 / 1440
Admin shell: **no horizontal overflow at any width**, navigation reachable at
every width. Event Manager: no page-level overflow; the attendee table switches
to a card layout below 900px.

---

## Open findings — not fixed

| # | Finding | Severity | Why not fixed |
|---|---|---|---|
| A | At ~1024px the attendee table's **Actions column sits behind a horizontal scroll** — an operator must scroll sideways to reach Manage. Below 900px the card layout avoids it; above ~1200px there is room. | Medium | A sticky action column changes table behaviour — a design decision, not a bug fix. |
| B | The **embedded Event Manager iframe pushes its own entries into browser history**, so Back can walk through iframe states instead of admin sections. The shell's own history now works; this is the remaining half. | Medium | The fix is `replace` instead of `push` inside the Event Manager router — it changes navigation semantics across all 15 sections and needs its own testing pass. |
| C | `/admin/index.old.html.bak` now returns the admin index rather than 404, because `try_files` falls back to `index.html` for unmatched paths. The backup content is gone. | Low | Cosmetic; returning the SPA shell for an unknown path is normal. |
| D | 8 exhibitors **outside** the 23 confirmed still hold bare-host website values that render as relative links. | Low | Outside the confirmed set; needs the organiser to confirm domains. |

---

## Not testable without touching real data

Stated rather than glossed:

- **Live check-in against a real badge** — would create a real check-in on a
  paying attendee. Covered by the behavioural suites on throwaway fixtures.
- **A real payment, refund or chargeback** — cannot be exercised without moving
  money. Covered by the payment suites and by reading the reconciliation code.
- **Publish/unpublish and delete on real exhibitors** — exercised earlier in
  this project against a throwaway exhibitor that was created and fully removed.
- **Bad/expired admin token** — the 401 path was exercised with a forged token;
  a genuinely expired one was not manufactured.

---

## Changes made

**Server**
- `nginx` `api.gaiahealers.app`: gzip for text, JS, CSS, JSON, SVG; immutable
  caching for versioned `/admin/` assets. Backups at
  `/root/api.gaiahealers.app.bak-{gzip,cache}-*`.
- `/var/www/gaia-admin/`: four unused files moved to `/root/gaia-admin-removed-*`.
- `/var/www/event/`: rebuilt with the read cache.

**Repository**
- `event-manager/frontend/src/utils/api.js` — read cache, in-flight sharing,
  write invalidation.
- `admin/gadmin.js` — hashchange listener; sidebar toggle, scrim, Escape.
- `admin/gadmin.css` — hamburger and scrim styles.
- `admin/index.html` — cache-bust `v=23 → v=25`.
- Deleted: `admin/membership.js`, `admin/admin.js`, `admin/gaia-system.css`.

## Test results

| Suite | Result |
|---|---|
| Event Manager behavioural suites | **19 / 19** |
| Staging-proxy | **426 / 426** |
| Event-admin boundary | **7 / 7** |

`test_phase1` and `test_phase4a` remain excluded: both drive the archived 2025
event and are refused by the archive guard, identically before this work.

## Source-of-truth data

**Unchanged.** No GHL write was made or attempted. No attendee, ticket,
payment, package, scanner permission, token or booth value was modified. The
only production data touched in this pass was a `DELETE` to a deliberately
non-existent attendee id, which returned 404 and changed nothing.
