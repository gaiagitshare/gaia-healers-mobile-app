# Members see their own Bio-Well results in the Gaia app — spec for Gaia Practitioners

4 October 2026. Agreed with huMan / Gaia Practitioners the same day (option 2
with a **member link code**). Gaia's side is built behind
`GAIA_MEMBER_READINGS_ENABLED` and tested against a fake of their tools; their
staging tools are pending.

## 0. What changed after agreement (supersedes §2 below where they differ)

- **The member asks for a code; the practitioner enters it.** Asking is the
  HIPAA authorization and is timestamped (`consent_code_issued`). Code: 8
  characters from an unambiguous alphabet, **24-hour TTL (their request, 4 Oct),
  single use, case-insensitive**. A typo can only fail.
- **Their server redeems it against Gaia:** `POST https://api.gaiahealers.app/api/practitioners/member-link/redeem
  { code, customer_id, practitioner_id, practitioner_name? }` with
  `Authorization: Bearer <shared link secret>` → `{ gaia_member_id, status: "confirmed", linked_at }`.
  Errors: `404 code_invalid`, `410 code_expired`, `409 already_linked`, `401`.
- **Unlink from either side:** member → Gaia revokes locally first, then calls
  their `unlink_customer_member { customer_id }`; practitioner → their server
  calls `POST …/member-link/revoke { customer_id }`.
- **BAA:** until a BAA-covered AI provider serves those turns, Gaia's existing
  practitioner scan tools no longer narrate values (the Practice card shows
  them; the model is told only that the reading is on screen), and the
  member's *My readings* screen involves no AI at all.
- **Their side, as built (4 Oct):** all on `https://staging-backend.gaiapractitioners.com`
  with Gaia's API key as a bearer — `POST /api/gaia/member-token { gaiaMemberId }`
  → 1-hour token for that one member, used on their member-only MCP
  `/api/member-mcp`; `GET /api/gaia/member-links/{gaia_member_id}` (status);
  `DELETE /api/gaia/member-links/{gaia_member_id}` (unlink). Their revoke call
  to us sends `{ gaia_member_id, customer_id, practitioner_id }` — accepted.
- **Test member for their staging link:** Gaia member id `sgWsiYukX76ekCrxoM1E`.

## 1. Goal

A Gaia Healers member opens the Gaia app and sees **their own** Bio-Well
readings — latest reading, trend over time, before/after a protocol — exactly
the data their practitioner already sees through the existing practitioner MCP,
and nothing else. No second login for the member.

Today the link is practitioner-only: a practitioner connects their Gaia
Practitioners account (OAuth, `mcp.read`) and Gaia Assist reads *their clients'*
records through `list_customers`, `search_customers`, `get_customer`,
`get_customer_scan`, `get_scan_trend`, `compare_protocol_before_after`,
`get_customer_files`, `list_flagged_customers`, `suggest_follow_ups`. A member has
no path.

## 2. Linking model — option 2 from your message, "member ID on the customer record"

We prefer this over "member signs in with a Gaia Practitioners account" because
Gaia members already have one login (Gaia Healers via GHL); a second account on
gaiapractitioners.com is the main reason people would never see their results.

**The link is created by the practitioner, confirmed once, and stored on your
customer record.**

1. **Gaia sends the member identity.** When a practitioner, inside the Gaia app,
   links a client to a Gaia member, Gaia calls a new MCP tool
   `link_customer_member { customer_id, gaia_member_id, gaia_member_email }`
   using the practitioner's own token (so only a practitioner can link their
   own customers — same authorization you apply to `get_customer`).
2. **You store the pending link** on the customer record:
   `gaia_member_id` (our GHL contact id, 20 chars, opaque), `gaia_member_email`
   (for the practitioner to eyeball), `link_status: pending|confirmed|revoked`,
   `linked_at`, `linked_by` (practitioner id).
3. **Practitioner confirms the match** — either in your practitioner UI
   ("Is this Gaia member your client Arman R.? Confirm / Not them") or, if you
   prefer not to build UI, by Gaia calling `confirm_customer_member
   { customer_id }` after the practitioner taps Confirm in the Gaia app. Either
   way the practitioner is the one who says "yes, same person"; Gaia never
   infers a match from a name or an email.
4. **Revocation**: `unlink_customer_member { customer_id }` (practitioner), and
   you should also honour the member side — if we ever stop serving a member
   (account deleted), we call it too.

Why the practitioner confirms rather than email matching: emails differ between
systems constantly (a practitioner types "arman.r@gmail" into Bio-Well, the member
signs in to Gaia with their work address). A wrong match here shows one person
another person's health data. One tap by the practitioner is the cheapest
reliable safeguard.

## 3. Reading the member's own data — a member-scoped MCP

Gaia's server needs to read **one customer's** data on behalf of **the member
who is that customer**, without a practitioner being online.

**Auth:** a server-to-server credential for Gaia Healers (client-credentials
grant on your OAuth server, scope `members.read`), separate from the per-
practitioner `mcp.read` tokens. Gaia keeps it server-side only; the app never
sees it.

**Tools (all take `gaia_member_id`; all answer only for a `confirmed` link):**

| tool | returns | mirrors |
|---|---|---|
| `get_member_customer { gaia_member_id }` | `{ customer_id, practitioner: { id, name }, has_biowell_card, link_status, linked_at }` | `get_customer`, minus contact details we already hold |
| `get_member_scan { gaia_member_id, which?: latest \| scan_id }` | the same scan shape as `get_customer_scan` | `get_customer_scan` |
| `get_member_scan_trend { gaia_member_id, window?: 30d \| 90d \| all }` | same as `get_scan_trend` | `get_scan_trend` |
| `compare_member_before_after { gaia_member_id, protocol_id? }` | same as `compare_protocol_before_after` | `compare_protocol_before_after` |
| `get_member_files { gaia_member_id }` | documents the practitioner marked **shareable with the client** | `get_customer_files` with a visibility filter |

**Answers for a member with no confirmed link:** `404 { code: "member_not_linked" }`
— never an empty scan list, so Gaia can say "ask your practitioner to link your
account" rather than "you have no readings".

**Scope rule (the whole point):** a `members.read` token can only ever return
data for the `gaia_member_id` it is asked about, and only through a confirmed
link. It must not be able to list customers, search, or read another
customer's record. If you'd rather not add a new grant type, an alternative is
per-member tokens minted by Gaia's server through a token-exchange endpoint —
tell us which is less work on your side.

## 4. What Gaia shows the member

Reusing what the practitioner tools already render:

- **You → My readings** (and a line on Today when a new reading exists):
  latest reading card — `scanned_at`, `stress`, `energy`, the 7 chakras with
  alignment, `most_out_of_balance` (same `slimScan` shape we use today);
  a trend card (same as the practitioner's `trend` card); before/after when a
  protocol exists; shareable documents.
- Gaia Assist gets two member-scoped tools, `my_latest_reading` and
  `my_reading_trend`, offered only in the `member`/`practitioner` session states
  and only when the member has a confirmed link — never to a visitor. Same
  "facts come from the tool, never from memory" rule as the practitioner tools.
- Wording stays reflective, not clinical: Bio-Well readings are shown as what
  the practitioner recorded, with the practitioner's name, and Gaia never
  interprets them as diagnosis (our existing SAFETY FIRST / HEALTH rules apply).

## 5. Privacy and consent

- The member sees only their own confirmed record. The practitioner keeps
  everything they have today.
- Documents: only those the practitioner marked shareable; default not shared.
- Gaia stores on our side only: `customer_id`, `link_status`, `linked_at`,
  practitioner id — no scan data is cached beyond the request; our usage log
  records counts, never content.
- Member can see in the app *which practitioner* linked them and *when*, and
  can ask the practitioner to unlink.
- Audit: please log link / confirm / unlink / member-read events on your side
  with timestamps; we log the same.

## 6. Errors Gaia will handle

`member_not_linked` (404), `link_pending` (409), `link_revoked` (410),
`forbidden_scope` (403), rate limit (429 with `Retry-After`). Anything else is
shown as "readings unavailable right now", never as a wrong result.

## 7. Environments and rollout

- Build and test on **staging** first (our side already points there; our
  readiness tool verifies your metadata/docs/MCP). Test accounts:
  `test1@gaiapractitioners.com` / client `testa@…`, linked to a Gaia test member.
- Production: needs your production OAuth + MCP rollout (not live as of 4 Oct)
  and a production client registration for Gaia Healers. Our switch is three
  config values.
- Credentials go through the Vaultwarden vault you set up, not chat.

## 8. What we need from you to start

1. Agreement on option 2 and on the practitioner-confirm step (yours or ours).
2. The five member tools + three link tools above, on staging, with the
   `members.read` server credential (or your preferred alternative).
3. Field names on the customer record (`gaia_member_id`, `link_status`, …) so
   both sides log the same thing.
4. One confirmed test link on staging so we can run our offline fixtures
   against a real shape before any production call.

We'll build the Gaia side (screen, tools, tests) in parallel against fixtures;
our estimate is about a week once your staging tools exist.
