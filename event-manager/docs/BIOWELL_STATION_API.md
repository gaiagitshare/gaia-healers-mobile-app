# Bio-Well station & dashboard API (10 Nov 2026)

Prefix `/events/{eventId}/biowell` on the panel's API base (same axios instance as everything else).
Errors are `{detail: "plain sentence"}`; show `detail` verbatim (written for staff).
Times are UTC ISO; show them in the event's local time like other screens (or Dubai GST like the Email Center — either is fine, label it).

Permissions (from `GET /events/{id}/my-capabilities` → `capabilities`):
- `biowell.station` → the Station screen. A user whose only role is `biowell_station`
  (capabilities exactly `event.read`, `biowell.station`) must see ONLY the station
  (like the Ticket Email Manager email-only mode already in EventWorkspace.js).
- `biowell.read` → the Bio-Well dashboard (organisers/admins).

## Station flow (one screen, big buttons, phone/iPad first)
1. **Scan**: camera QR scanner (reuse the html5-qrcode scanner already used in
   `ExhibitorScan.js` / `CheckIn.js`) + a text box to type a code.
   `POST /lookup {code}` → person `P`:
   ```
   {ticket_id, name, pass, ticket_status, checked_in, is_guest, guest_of (buyer name or null),
    profile_email, profile_email_usable (bool), shared_contact (bool), email_problem (sentence or null),
    pending_email: {email, since, can_send} | null, profile_activated (bool), profile_url,
    results_link: "linked"|"code_waiting"|"not_linked", link_store_unavailable (bool),
    recent_sessions: [{session_id, at, station, status}]}
   ```
   404/400 → show the detail ("No ticket for this event matches that code").
2. **Confirm name**: show name, pass, "Guest of <buyer>" chip if is_guest, recent sessions
   ("seen at the station 2 times today"). Button **"Yes, this is them — start"**:
   `POST /sessions {ticket_id, station, client_key}` where client_key = a fresh random id
   generated when the person is shown (reuse it for retries/double taps). → session `S`:
   ```
   {session_id, station, staff, status, created_at, email_status ("ok"|"pending"|"verified"|"needs_email"),
    profile_status ("activated"|"not_activated"), consent_status ("none"|"code_issued"|"linked"),
    error, person: P, next_step: "plain sentence for the staff member"}
   ```
   Station name: a small setting stored in localStorage (default "Bio-Well station"), e.g. "Booth 21", "Scan table 2".
3. **Email** card: show `person.profile_email` and whether usable; if `email_problem` show it
   in amber. Field "Their own email" + button **"Send code to this email"** →
   `POST /sessions/{id}/email {email}` → `S` (+ `code_sent`, `message`). 409/400/503 → show detail.
   When `person.pending_email` exists: show "Code sent to …", a 6-digit input + **"Confirm"** →
   `POST /sessions/{id}/verify {code}` → `S` (+ `message`), plus **"Send the code again"**
   (`POST /sessions/{id}/resend`) and **"Use a different email"** (`POST /sessions/{id}/cancel-email`).
   Explain under the field: "We email a 6-digit code. Nothing changes until they enter it.
   Their ticket and purchase stay exactly as they are."
4. **Profile** card: if `profile_activated` false → big QR of `person.profile_url` (generate the QR
   client-side; the panel already has a QR lib used by ShareQr.jsx / qrcode.react — reuse) with the
   text "Scan with your phone camera → Activate → enter the code from your email → choose a password".
   If true → "Profile active ✓".
5. **Results** card: from `consent_status`: none → "On their phone: Your Bio-Well readings → Share with
   my practitioner → give the code to the practitioner"; code_issued → "Code waiting — the
   practitioner enters it in Gaia Practitioners"; linked → "Linked ✓ — readings appear in their
   profile when published". Never show any result. If `person.link_store_unavailable` say
   "Link status unavailable right now".
6. Always show `next_step` prominently at the top of the session (one sentence).
7. **Refresh** button (`GET /sessions/{id}`) and **Done** / **Couldn't finish** (`POST /sessions/{id}/close
   {outcome: "done"|"abandoned", note}`) → back to Scan. Auto-refresh the session every 10 s while open.

## Dashboard (People → Bio-Well) — `biowell.read`
`GET /overview` →
```
{station: {sessions, people, open, with_error},
 email: {changes_requested, verified, pending, expired, cancelled, contacts_created},
 people_processed: {profile_activated, consent_code_requested, results_linked, not_linked_yet},
 partner: {environment ("staging"|"production"|...), host, readings_enabled, connected, available,
           links_confirmed, links_revoked, codes_issued_total, last_code_issued, last_link_confirmed,
           last_reading_opened, last_partner_check},
 contact_creation_enabled (bool), note}
```
Cards for those numbers (label exactly what they are; show `note` under them: Gaia does not count scans).
A banner if `partner.environment !== "production"`: "Results connection: STAGING (test system) — real
attendees' readings will not appear until it is switched to production."
`GET /sessions?filter=problems|` → `{items:[{session_id, at, station, staff, status, name, ticket_id, guest,
email_status, profile, results, error, next_step}], count}` — table with filter chips All / Needs attention,
search by name. Row click → a read-only detail with next_step. (Retrying = staff reopen the person at the
station; an admin can also use the station screen.)
