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

---

# Fix workflow (added 10 Nov 2026, second phase)

All corrections go through Ticket Reconciliation's own actions on the server. Two kinds:
**direct** (the reviewer applies it now, low risk) and **propose** (goes to the approval queue;
a platform admin who is NOT the proposer approves, then it is applied once and re-checked).

## Problems on an order — `GET /bookings/{key}/problems`
```
{key, workflow_stage: "fix"|"approve"|"send", summary:[blocker text], warnings:[text],
 problems:[{id (issue id), kind, kind_label, priority (critical|high|medium|low), status, detected (bool),
   stage: flagged|investigating|correction_proposed|confirmed|corrected_still_flagged|reviewed|revalidated,
   what_is_wrong, why_flagged, correct_result, recommended, advice,
   assigned_to, assigned_name, updated_at,
   actions:[{key, label, mode: "direct"|"propose", explain, max_count?, ticket_ids?}],
   evidence:{payments:[{order_id, transaction, status, amount, refunded, products[], paid_at, ticket_id}],
             tickets:[{id,name,email,pass,status,seat,needs_name_check}], paid_for, issued, missing, possible_double_charges, facts},
   history:[{at, actor, kind, text, before, after}],
   proposals:[proposal]}]}
```
Show this in the Review panel as a "Problems & fixes" section ABOVE the purchase/ticket comparison, one
card per problem: the five answers in plain words (What is wrong · Why it was flagged · Correct result ·
What you can do · Evidence), the stage as a small stepper (Flagged → Investigating → Correction proposed
→ Confirmed → Corrected → Revalidated), and one button per action. `detected=false` means the checks no
longer find it: show it collapsed and green ("Fixed — confirmed by re-check").
Top of the panel: a 5-step workflow bar **Review → Fix → Verify → Approve → Send** highlighting
`workflow_stage` ("fix" = Fix, "approve" = Approve; Verify = the Revalidate button).

### Action forms (body fields per action key)
| key | mode | fields to ask | body |
|---|---|---|---|
| correct_holder | direct | ticket (select from evidence.tickets), first name, last name, phone | `{ticket_id, first_name, last_name, phone}` |
| set_delivery_email | direct | new delivery email | `{email}` |
| rebuild_email | direct | — | `{}` |
| hold | direct | tickets (multi, default all in evidence) | `{ticket_ids}` |
| release_contact | direct | — (ticket_ids preset from action) | `{ticket_ids}` |
| flag_duplicate | direct | — | `{}` |
| acknowledge | direct | — | `{}` |
| issue_seat | propose | first name (default "Guest of"), last name (default purchaser), email (optional), count (≤ max_count) | `{first_name, last_name, email, count}` |
| decide_duplicate | propose | radio: "Real extra seat" / "Double charge (refund in GHL)" | `{real_seat: true|false}` |
| change_category | propose | ticket, new pass (GET /pass-options) | `{ticket_id, ticket_type_id}` |
| correct_ticket_email | propose | ticket, new email | `{ticket_id, email}` |
| release | propose | — (ticket_ids preset) | `{ticket_ids}` |
| request_admin | propose | — | `{}` |

**Direct:** `POST /issues/{id}/fix` `{action, body, note (≥5 chars, "what you checked"), confirm: true}` →
`{results, validation:{issues:{id:{still_found,status,title}}, booking:{paid_for,generated,qr_ok,blockers[],recipients[],can_approve,review_state}}}`.
Before calling, show a confirmation dialog: current value → new value, which tickets, "Nothing is emailed".
After: show the validation result plainly ("Re-check: problem fixed ✓" or "Re-check: still found — …").

**Propose:** `POST /issues/{id}/propose` `{action, body, reason (≥10 chars), root_cause}` →
`{proposal}`; 409 = the same correction is already waiting. root_cause select: one_off "Just this order",
mapping "Wrong product-to-ticket mapping", ticket_generation "Ticket not created at purchase",
guest_assignment "Guest seat assigned wrongly", payment_sync "Payment not synced", unknown "Not sure".
The panel should show the proposal's `summary`, `current_value` → `proposed_value` and `steps` before sending
("This will: …") — the server may add steps (e.g. for a missing ticket it also records 'real seat' on the
duplicate-payment case and releases a hold that only waited for the missing seat).

`proposal` = `{id, issue_id, booking, kind, steps:[{action, issue_id, body}], summary, current_value, proposed_value,
evidence, reason, root_cause, state: proposed|applying|applied|applied_still_flagged|failed|rejected|withdrawn,
proposed_by, proposed_by_id, proposed_at, decided_by, decided_at, decision_note, applied_at, results, validation}`

## Approval queue (new tab "Approvals", visible to everyone with read; buttons only when `can_decide`)
`GET /proposals?state=proposed` (or `all`, or comma list) → `{items:[proposal], can_decide}`.
Each card: order (booking → open Review), summary, current → proposed, reason, evidence (payments table),
proposed by/when, root cause, steps. Buttons (admins only, and hidden when `proposed_by_id == me.user_id`, the
server refuses anyway): **Approve and apply** (confirm dialog: "This changes ticket records: …"; note required)
and **Reject** (note required). `POST /proposals/{id}/decide` `{decision: approve|reject|retry, note}` →
`{state, results, validation}`; show the validation result. `retry` only for state `failed`.
Proposer can **Withdraw** a waiting one: `POST /proposals/{id}/withdraw` `{note}`.
Show a count badge on the tab (`state=proposed` count). `/me` now also has `user_id` (see below).

## Needs Attention = work queue `GET /queue?filter=`
filters: open (default) · critical · high · medium · low · mine · awaiting_approval · ready_to_fix · resolved.
→ `{items, count, open, by_category:{label:n}, awaiting_approval}`; item:
`{key, issue_id?, booking?, exhibitor?, order_number, customer, problem, kind, kind_label, severity, recommended_action,
 stage, status (open|in_review|reviewed|awaiting_approval|resolved), assigned_to, assigned_name, assigned_to_me,
 last_update, awaiting_approval, proposals, ready_to_fix, blocks_email}`
Table/cards: Order · Customer · Problem · Severity · Assigned · Status/stage · Recommended action · Last update.
Category chips from `by_category` at the top. Row actions:
- **Assign to me** `POST /issues/{issue_id}/assign {me:true}` (only for items with issue_id); assign to someone:
  `{user_id}` from `GET /reviewers` → `{items:[{id,name,admin}], me}`.
- **Start review / Propose fix / Fix** → open the order's Review panel (Attendee Tickets tab) scrolled to "Problems & fixes".
- **Add note** `POST /issues/{issue_id}/comment {text}`.
- Items without issue_id (exhibitor, delivery, approval-invalidated, flagged): keep the existing
  `POST /attention/{key}` status/assign/note controls, and Open → booking or exhibitor.
- There is NO "mark resolved" button for reconciliation problems: they resolve when the re-check no longer finds
  them (say so in a help line). "Mark reviewed (keep as is)" is the `acknowledge` action where offered.
Replace the old `/attention` usage in the Needs Attention tab with `/queue`. (`/attention` still works and
returns the same items with `related`/`link`.)

## Revalidate `POST /bookings/{key}/revalidate` → `{reconciliation, booking:{...}}` — "Re-check now" button in the Review panel.
