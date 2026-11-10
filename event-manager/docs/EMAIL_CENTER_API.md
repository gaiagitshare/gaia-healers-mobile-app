# Email Center API (Event Manager, 10 Nov 2026)

All under the panel's API base (same as other admin calls in `frontend/src/utils/api.js`),
prefix `/events/{eventId}/email-center`. JWT auth as everywhere else. Timestamps are UTC ISO
strings; **the UI shows them in Dubai time (Asia/Dubai, GST, UTC+4)**, labelled "GST".

Errors: FastAPI `{"detail": "..."}` with 400/403/404/409. 409 = a safety rule refused (show the
detail text verbatim; it is written for people).

## Who can do what (`GET /me`)
```
{read, review, send, export, exhibitors, scanner_links, reconcile, platform_admin, user,
 sending: {enabled, switch:"on"|"off", global_mode, reason, fake_gateway},
 sending_changed_by, sending_changed_at}
```
- `read`: may open the Email Center. `review`: Verify/Approve/Flag/Hold, Needs-Attention marks.
  `send`: send/resend/retry/batches/outcome/refresh. `export`: CSV.
- `exhibitors`: Exhibitor Emails tab (hide the tab when false). `scanner_links`: scanner email/link.
- `reconcile`: may open Ticket Reconciliation (`/events/{id}/reconcile` panel section). Only show
  "Open in Ticket Reconciliation" links when true; otherwise show the case text inline.
- `platform_admin`: may flip the sending switch (`POST /controls`).
- `sending.enabled=false` → every Send button disabled with `sending.reason` shown.
  `fake_gateway=true` → show a banner "Test mode: emails go to a simulated mailbox, nothing is sent".

## Overview `GET /overview`
```
attendee: {orders, tickets, tickets_paid_for, emails, pending_review, verified, approved, ready_to_send,
           held, needs_correction, blocked, changed_since_review, late_orders, missing_email,
           emails_by_status:{not_sent,accepted,delivered,opened,clicked,failed,bounced,unknown},
           sent, delivered, opened, clicked, failed, bounced, unknown, accepted_no_evidence,
           not_in_ticket_emails}
exhibitor: {stands, missing_contact, profiles_activated, scanning_enabled, setup_sent, setup_delivered,
            scanner_sent, scanner_delivered, failed, first_scans, leads}
sending: {...as in /me}, needs_attention: n, batches: [batch views of running/paused runs], built_at
```
Statuses mean (show a legend): **Accepted** = GHL took it, no delivery evidence yet. **Delivered /
Opened / Clicked** = reported by GHL (opened is indicative: Apple Mail can pre-open). **Unknown** =
the send got no clear answer: never resend blind, check GHL first. `not_in_ticket_emails` = staff,
volunteer and guest tickets (not part of ticket emails).

## Attendee Tickets
`GET /bookings?filter=&q=` → `{items:[booking], count, filters:[...]}`
filters: pending_review, verified, approved, ready, can_approve, blocked, held, needs_correction,
changed, not_sent, sent, delivered, failed, multi, late, missing_email.

A **booking** = one purchaser and every ticket they paid for (the "order" in the UI; it can span
several GHL order numbers). List item:
```
key ("B204"), order_number, order_ids[], purchaser_name, purchaser_email, ticket_types[],
paid_for, tickets_generated, payment_status (paid|refunded|check|no_payment_record), amount_paid,
qr_status (ok|problem), reconciliation (clear|warning|open_case|held),
review_state (pending_review|verified|approved|held|needs_correction), changed_since_review,
delivery (not_sent|partially_sent|accepted|delivered|opened|clicked|failed|bounced|unknown),
critical:[{code, detail, issue_id?}], warnings:[{code, detail}], fingerprint,
late_order, held, can_approve, sendable, retryable, last_sent, attempts, last_error,
units:[{unit_key, source, recipient, ticket_ids, order_ids, delivery, attempts, last_update,
        provider_status, provider_checked_at, result, held_ticket_ids}],
tickets:[{id, name, email, ticket_type, pass, includes, status, qr_present, qr_valid, is_buyer,
          seat, needs_name_check, held, unit_key, checked_in, checked_in_at}]
```
Table columns: Order number · Purchaser · Email · Ticket type · Purchased (paid_for) · Generated ·
Payment · QR · Reconciliation · Verification (review_state) · Email status · Last sent · Actions
(Review). Highlight rows where `paid_for != tickets_generated` or `critical.length`.

`GET /bookings/{key}` (detail, for the Review panel) = the list item plus:
```
payments:[{order_id,type,status,amount,refunded,currency,products[],paid_at,buyer_name,buyer_email,ticket_id}],
issues:[{id,kind,priority,status,title,explanation,recommendation}],
review:{state,reviewed_by,reviewed_at,approved_by,approved_at,note},
review_log:[{at,actor,action,from,to,note}],
history:[{unit_key,kind,recipient,state,message_id,result,reason,at,actor,template}],
tickets[i] also has qr_code, ticket_url (View ticket), qr_image_url (img src)
```
Review panel layout: left "What they bought" (payments: products, amounts, order numbers, expected
ticket quantity = paid_for); right "What we generated" (each ticket: holder, type/pass, includes =
access days, QR image + code, status, held?, checked in?). Big comparison line at top:
"Paid for N · Generated M" green when equal, red otherwise. Then: Recipient(s) per email (units),
blockers (critical, red), warnings (amber), reconciliation cases, email history, review log.

`GET /bookings/{key}/preview` → `{emails:[{unit_key, recipient, subject, html, from, tickets, delivery} | {unit_key, error}]}`
Show each email in a sandboxed `<iframe srcDoc>` (phone-width toggle 390px / desktop 640px).

`POST /bookings/{key}/review` body `{action: verify|approve|flag|hold|reset, note, fingerprint}`
- Always send the `fingerprint` from the detail you displayed. 409 = it changed: reload the panel.
- `flag` and `hold` need a note. `approve`/`verify` refused (409) while `critical` is non-empty:
  disable those buttons and say why.

`POST /bookings/{key}/send` body `{fingerprint}` → `{key, state: sent|held|refused|skipped|failed|unknown|partial, reason?, units?}`
- Resend: `{resend: true, resend_reason: "...", fingerprint}` (only when delivery is accepted/delivered/opened/clicked/bounced).
- Retry definite failure: `{retry: true, fingerprint}` (when `retryable`).
- Confirm dialog before every send: recipient(s), number of tickets, template "Official ticket email".

`POST /bookings/{key}/outcome` body `{unit_key, outcome: "not_sent"|"sent", note}` — only for a unit
whose delivery is `unknown`: "I checked GHL: it was / was not sent". Then retry becomes possible.

## Batches (Send selected / Send all approved / Retry failed)
`POST /batches/preview` body `{keys:[...]} | {all_approved:true} | {retry:true, keys|all_approved}`
→ `{mode, orders, emails, tickets, recipients, excluded:[{key,order_number,purchaser,reason}],
     warnings:[{key,detail}], template:{name,sha}, items:[{key,order_number,purchaser,emails}],
     confirm_token, sending:{...}, sender}`
Confirmation screen must show: exact orders, emails, tickets, recipients, excluded list with reasons,
sending administrator (`sender`), template name + sha, warnings; a checkbox "I have checked these
numbers" and a button "Send N emails". Then:
`POST /batches` body `{same selector..., confirm_token}` → `{batch_id}`. 409 = list changed: re-preview.
`GET /batches` (recent), `GET /batches/{id}` → `{id, kind, state: queued|running|paused|done|cancelled|interrupted,
  created_by, created_at, total, tally:{queued,working,sent,held,skipped,failed,unknown,error,...}, items:[{key,state,result,updated_at}], note}`
Poll every 3 s while running. Buttons: Pause (`POST /batches/{id}/pause`), Resume (`/resume`, for
paused or interrupted), Cancel (`/cancel`). Show progress bar sent/total.

Exhibitor batches use the same endpoints with `{exhibitor_kind: "setup"|"scanner", ids:[...]}`.

## Exhibitor Emails (`exhibitors` permission)
`GET /exhibitors` → `{items:[{id, company_name, booth_number, contact_name, contact_email, email_valid,
  payment_status, package, amount_due, amount_paid, amount_mismatch, eligible_for_scanning,
  profile_activated_at, setup_link (activated|valid|created_not_tracked|expired|none),
  setup_link_created_at, setup_link_expires_at, scanning_enabled, scanner_link_available,
  first_scan_at, leads,
  setup:{status, attempts, last_sent, sent_by, last_error, provider_status, eligible},
  scanner:{status, attempts, last_sent, sent_by, last_error, provider_status, eligible}}]}`
status: not_sent | sent_manually | accepted | delivered | opened | clicked | failed | bounced | unknown.
Columns: Booth · Company · Contact · Email (or red "Missing contact" + Edit) · Payment · Profile setup ·
Scanner on/off · Scanner link · Setup email · Scanner email · Last sent · First scan · Leads · Actions.
Never show the scanner token in the table.
- `GET /exhibitors/{id}/preview?kind=setup|scanner` → `{subject, html, recipient}`
- `POST /exhibitors/{id}/send` `{kind, resend_reason?}` → `{state: accepted|rejected|unknown|refused|skipped, reason?}`
  (refused reasons: missing_contact_email, scanning_not_enabled, no_ghl_contact, several_ghl_contacts,
  contact_do_not_disturb, profile_already_set_up). For `no_ghl_contact` offer "Copy link" + "Mark sent manually".
- `POST /exhibitors/{id}/link` `{kind}` → `{url, created}` — copy to clipboard. Setup: reused while valid,
  created only if none (say "A new setup link was created" when created=true). Scanner: never rotated.
- `POST /exhibitors/{id}/manual` `{kind, note}` — "I sent it myself".
- `PATCH /exhibitors/{id}/contact` `{contact_name, contact_email}`.
- `POST /exhibitors/{id}/outcome` `{kind, outcome: not_sent|sent, note}` for status unknown.
Scanner on/off is NOT changed here (say: "Switch scanning on in Exhibitors").

## Delivery History `GET /history?q=&kind=tickets|exhibitors`
`{items:[{type: ticket|exhibitor, id, related (order/unit key or company), attempt (initial|retry|resend|test|settled|setup|scanner),
  recipient, state, provider_status, provider_checked_at, message_id, result, reason, at, actor, template, tickets?}], count}`
Append-only; newest first. Search box + type filter. Export: `GET /export.csv?what=history`.

## Needs Attention `GET /attention`
`{items:[{key, problem, severity: critical|high|medium|low, related, recommended_action,
  link:{booking?, reconcile_issue?, exhibitor?}, kind, status: open|in_progress|resolved, assigned_to, note, updated_by, updated_at}]}`
`POST /attention/{key}` `{status, assigned_to, note}` (review permission). Items disappear by
themselves when the underlying problem is fixed. Link → open the booking's Review panel / the
exhibitor row / Ticket Reconciliation (if `reconcile`).

## Controls
`GET /controls` → sending state. `POST /controls` `{sending: "on"|"off", reason}` platform admin only.
Show on Overview as a clear switch card: "Email Center sending: OFF — no email can be sent".
`POST /refresh-status` → asks GHL now about recent emails (send permission).
`GET /export.csv?what=orders` → bookings CSV.
