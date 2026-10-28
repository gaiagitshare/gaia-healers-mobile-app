# Elevate 2026 — integration readiness (28 Oct 2026)

Scope: connections only — whether each source is reachable, synchronised,
monitored and proven end to end. No record-level data review (that is the next
phase). Production is untouched; everything new is on staging branches:
Event Manager `staging/integrations` (worktree /root/event-staging), proxy
`staging/event-integrations` (checkout /root/gaia-healers-mobile-app-1).

## The ecosystem

```
ORIGINAL SOURCES                 INTEGRATION                         CENTRAL                 DESTINATIONS
GHL checkouts (Stripe/PayPal) ─► webhook (real time) + 15-min pull ─┐
Shopify gaiahealers.com ───────► webhook (real time) + 15-min pull ─┤
Planning sheet: Vendors ───────► 30-min pull ───────────────────────┤
Planning sheet: Speakers ──────► 30-min pull ───────────────────────┼─► EVENT MANAGER ─┬─► gaiahealers.app (Events tab, live reads)
Planning sheet: Volunteers ────► 30-min pull ───────────────────────┤   (event.db)     ├─► public API /event-api/public/*
Agenda page (elevate…/agenda) ─► 30-min pull (or sheet Schedule tab)┘                  └─► website embeds (iframes on elevate pages)
Door sales / staff (desk) ─────► direct in the Event Manager ─────────────────────────────┘
                           Monitoring: per-source status files → proxy health → System Alerts
```

## Who owns what

| Data | Owner (edit here) | Flows to |
|---|---|---|
| Ticket purchases, refunds | GHL (and Shopify if kept) | Event Manager |
| Exhibitor commercial facts (stage, booth, package, contact, payment) | Planning sheet, Vendors tab | Event Manager → directory, website |
| Exhibitor profile (logo, text, category, publish, scanner) | Event Manager | directory, website |
| Who speaks, company | Planning sheet, Speakers tab | Event Manager |
| Speaker bio, photo, title | Event Manager | app, website |
| Schedule | **Decision needed:** agenda page *or* sheet Schedule tab | Event Manager → app, website |
| Volunteers & guests | Planning sheet | Event Manager (badges) |
| Event details, FAQ, policies | Event Manager | app (website copy is hand-written today) |

## Readiness

Legend: 🟢 connected, synchronised, verified · 🟡 connected but not fully automated or verified · 🔴 disconnected, broken or missing.
"Today" = production now. "After approval" = staging build, proven end to end, waiting for go-ahead.

| Source → Destination | Mode / frequency | Today | Last successful sync (today) | Monitoring | After approval |
|---|---|---|---|---|---|
| GHL checkout → Event Manager (webhook) | real time | 🟢 27 deliveries / 14 d; auth enforced (no secret → 403) | 26 Oct 03:17 UTC (last sale) | reconcile log; misses now counted | 🟢 + per-line amounts; miss alert (24 h window) |
| GHL API → Event Manager (recovery pass) | every 15 min, 5 retries per call | 🟢 1,283 runs / 14 d, 3 failed + recovered | 28 Oct 10:59 UTC | job alert (failed / stale) | 🟢 + status file, "silent" alert |
| GHL refunds → Event Manager | every 15 min | 🟢 any age since 25 Oct | 28 Oct | via recovery pass | 🟢 |
| **Shopify orders → Event Manager** | — | 🔴 no credential; 5 Elevate products on sale | never | none | 🟡 connector built (webhook + 15-min backstop), proven with test orders; needs store token |
| Planning sheet Vendors → Event Manager | every 30 min, 3 retries | 🟡 live, but one duplicated name flips an exhibitor every run, no alert | 28 Oct 11:05 UTC | job alert only | 🟢 duplicates reported not applied, conflict alert |
| Planning sheet Speakers → Event Manager | every 30 min | 🟢 (who/company; bio & photo are app-owned) | 28 Oct 11:05 UTC | job alert | 🟢 + per-source staleness |
| Planning sheet Volunteers/Guests → Event Manager | every 30 min | 🟢 | 28 Oct 11:06 UTC | job alert | 🟢 |
| **Schedule → Event Manager** | — | 🔴 no Schedule tab; app shows 0 sessions | never | none | 🟡 agenda-page mirror built (46 rows), off until source decided; drift alert |
| Event Manager → app (gaiahealers.app) | real-time reads | 🟢 | live | — | 🟢 |
| **Event Manager → website (elevate pages)** | — | 🔴 pages hand-written in GHL | never | — | 🟡 embeds built (agenda, speakers, exhibitors; 5-min cache); need pasting into the GHL pages |
| Monitoring → people | — | 🔴 alerts visible in Admin only (`ALERT_CONTACT_ID` unset) | — | — | 🔴 until a contact is set |
| Legacy: "Sync Gaia Pages" page import, `/webhooks/registration`, `/api/admin/events` | — | 🔴 dead | never | — | remove (not done) |

## Proof (staging, controlled test records — no real service touched)

`backend/test_integration_e2e.py` runs the real proxy, the real sync scripts and
a copy of the Event Manager against fake GHL and Shopify servers. All 10 flows pass:

| Flow | Result |
|---|---|
| F1 GHL purchase → webhook → Event Manager; wrong secret refused | ✅ |
| F2 Purchase the webhook never delivered → 15-min pass records it, status written | ✅ |
| F3 GHL outage → pass fails loudly (unit marked failed) → next pass catches up | ✅ |
| F4 Shopify order → signed webhook → Event Manager; unsigned refused | ✅ |
| F5 Shopify order → 15-min backstop | ✅ |
| F6 Sheet: new exhibitor created; changed booth → public directory → website embed | ✅ |
| F7 Sheet: new speaker → Event Manager | ✅ |
| F8 Agenda page → public agenda (3 days) → website embed; an edit propagates | ✅ |
| F9 Event Manager → app events feed | ✅ |
| F10 Webhook gap raises an alert | ✅ |

Also: per-source unit tests (Shopify 7, source health 6, agenda mirror 16,
vendor duplicates, sheet runner); proxy suite 1,157 pass / 0 fail.

Bugs found and fixed on the way (staging): an imported session with an empty
"featured" flag took the whole public agenda down with a 500 (the sheet's
Schedule importer had the same latent bug); replay-time corrections to tickets
were silently never saved.

## What needs Babak

1. **Approve production deploy** of both staging branches. The Event Manager
   branch also carries the per-line ticket split parked from the data work;
   it can ship or be held back separately.
2. **Shopify:** decide keep or unpublish the 5 Elevate products. If kept: store
   domain, an Admin API token with `read_orders`, a webhook secret, the webhook
   (orders/paid, orders/updated) pointed at `https://api.gaiahealers.app/api/webhooks/shopify-order`,
   and which ticket each product grants.
3. **Schedule source:** the agenda page (turn on `AGENDA_PAGE_SYNC=1`, and
   `AGENDA_PAGE_PUBLISH=1` to show it) or a Schedule tab in the planning sheet.
4. **Website:** paste the three iframe snippets into the GHL elevate pages so
   speakers, exhibitors and agenda follow the Event Manager.
5. **Alerts:** set `ALERT_CONTACT_ID` (who gets notified).
6. **Sheet:** delete the duplicate Bio-Well row (row 43).
