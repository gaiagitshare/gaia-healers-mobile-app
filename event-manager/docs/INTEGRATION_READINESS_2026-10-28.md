# Elevate 2026 — integration readiness (28 Oct 2026, final for this phase)

Connections only. No record-level review (duplicates, amounts, badges and
historical corrections belong to the next phase). Nothing in this phase changed
GHL, Shopify, the planning sheet or the website.

## The ecosystem

```
SOURCE (owner edits here)                     INTEGRATION                                CENTRAL          DESTINATIONS
GHL checkouts (Stripe / PayPal) ────────────► webhook, real time + 15-min recovery ─┐
Shopify gaiahealers.com (5 Elevate products) ► webhook, real time + 15-min backstop ┤
Planning sheet · Vendors ───────────────────► every 30 min ────────────────────────┤
Planning sheet · Speakers / Volunteers ─────► every 30 min ────────────────────────┼─► EVENT ─────┬─► gaiahealers.app (Events tab)
Event page · speaker cards ─────────────────► every 30 min ────────────────────────┤   MANAGER    ├─► public API /event-api/public/*
Agenda page · sessions + workshop leaders ──► every 30 min ────────────────────────┘              └─► website embeds (exhibitors)
Door / desk (walk-ins, staff) ──────────────► direct in the Event Manager
Monitoring: per-source status files → proxy health → System Alerts → (ALERT_CONTACT_ID) email
```

Ownership: purchases = GHL / Shopify · exhibitor commercial facts = sheet,
exhibitor profile = Event Manager · speaker line-up, bios, photos = event page
(filled into empty fields only; anything set in the app wins) · schedule and
workshop leaders = agenda page · volunteers/guests = sheet. The agenda page and
the speaker cards are SOURCES, so they stay as they are; the exhibitor embed is
the one that belongs on the website.

## Status

### A. Fully operational in production
| Source → Destination | Method | Frequency | Last successful sync (28 Oct, UTC) | Monitoring |
|---|---|---|---|---|
| GHL checkout → Event Manager | webhook (shared secret; wrong secret 403) | real time | last sale 26 Oct 03:17; 29 deliveries on file | webhook-miss alert (24 h) |
| GHL API → Event Manager (orders, invoices, refunds, attempts) | scheduled pull, 5 retries/call | every 15 min | 12:24 (0 errors) | failure, stale, silent alerts |
| Planning sheet Vendors → Event Manager | scheduled pull, 3 retries | every 30 min | 12:08 (ok; Bio-Well conflict flagged, not applied) | conflict, stale alerts |
| Planning sheet Speakers → Event Manager | scheduled pull | every 30 min | 12:08 | stale alert |
| Planning sheet Volunteers/Guests → Event Manager | scheduled pull | every 30 min | 12:08 | stale alert |
| Event Manager → gaiahealers.app | live API reads | real time | live | — |
| Event Manager → public API + embed pages | live, 5-min cache | real time | live (embeds 200, frame policy set) | — |
| Agenda page watch | scheduled fetch | every 30 min | 12:08 (46 rows) | drift, unreadable alerts |

### B. Implemented, verified on staging, not yet enabled in production
| Integration | What turning it on takes |
|---|---|
| Agenda page → Event Manager (46 sessions, workshop leaders created and linked) | deploy `staging/page-sync` + `AGENDA_PAGE_SYNC=1`, `AGENDA_PAGE_PUBLISH=1` |
| Event page speaker cards → Event Manager (fills Carlin, Roth, Baider, Dr. Davis; no duplicates) | deploy `staging/page-sync` + `SPEAKER_PAGE_SYNC=1`, `SPEAKER_PAGE_PUBLISH=1` |
| Speaker-page watch alerts | merge proxy `staging/speaker-page-watch` |
| Exhibitor embed on the website | add a custom-code block to the GHL "Gaia Healers Elevate Conference" page (funnel ICib74xvODPEJQHFYWOv); GHL's API cannot edit page content, so this is done in the GHL builder |

Staging proof: two full 30-minute cycles with both page mirrors on — cycle 1
applied (46 sessions, 4 speaker profiles, 4 workshop leaders), cycle 2 changed
nothing; every mirror recorded its last success.

### C. Awaiting credentials or configuration
| Integration | Exact requirement |
|---|---|
| Shopify orders → Event Manager (connector live, inert) | In Shopify admin of store `1f57dd.myshopify.com`: an app with Admin API scope `read_orders`; give its Admin API access token (`SHOPIFY_ADMIN_TOKEN`). Create webhooks **Order payment** and **Order update** (JSON) to `https://api.gaiahealers.app/api/webhooks/shopify-order` and give the signing secret (`SHOPIFY_WEBHOOK_SECRET`). Confirm the ticket each product grants — proposed: VIP 10561859911967 → VIP Pass; 3-Day Exhibitor Hall & Speaker Room 10561873346847 → Three Day Event Pass; Fri 10602917396767 → Friday Exhibit Hall; Sat 10602917953823 → Saturday Exhibit Hall; Sun 10602918314271 → Sunday Exhibit Hall. No credential exists today on the server, in any config, or in GHL (GHL has never received a Shopify order). |
| Alerts → a person | `ALERT_CONTACT_ID`. No admin notification is configured anywhere. Proposed: contact `zdO2cv7MWnUifIzsIviE` ("babak Jalali", the GHL account admin Babi Jalali). |

### D. Broken or missing
| Item | Note |
|---|---|
| Keynote designation | No source marks keynotes (not the page, the agenda or the sheet). The app has an `is_featured` flag; somebody has to say who. |
| Legacy "Sync Gaia Pages" importer, `/webhooks/registration`, `/api/admin/events` | Dead paths; harmless; remove later. |

## End-to-end proof (staging, controlled test records)
`backend/test_integration_e2e.py` — real proxy, real sync scripts, a copy of
the Event Manager, fake GHL and Shopify. 11 flows, 23 checks, all pass:
GHL webhook (and wrong secret refused) · GHL recovery pass · GHL outage fails
loudly then catches up · Shopify signed webhook (unsigned refused) · Shopify
backstop · sheet exhibitor added + booth changed → directory → website embed ·
sheet speaker added · event-page speaker added → public API → embed · agenda →
public agenda (3 days) + leaders created + edit reaches embed · app feed ·
webhook gap raises an alert. Proxy suite 1,153 pass / 0 fail.
