# Personal Path V1

A member's ranked next steps, built only from rules that interpret **nothing**
about their Bio-Well values, plus what a practitioner explicitly confirms for
them. Owner brief: 6 Oct 2026. Architecture: B1 in
`GAIA_PRACTITIONERS_ANALYSIS_AUDIT.md`.

Screenshots are in `docs/ui-proof/personal-path/`, at 390, 768 and 1440 px:

| File | Shows |
|---|---|
| 1 | One item, several items, caught up, recheck, locked with a free option |
| 2–3 | Tablet and desktop |
| 4–5 | Practitioner flow (recommend → preview → confirm) and the member's view of it |
| 6 | Gaia answering "What's next for me?", and the next step after a completion |
| 7 | The quiet "Next on your path" row on Home |

---

## 1. What is on the path

| Rule | Trigger (no reading values) | Item | Action | Completion |
|---|---|---|---|---|
| P-ONBOARD | Required onboarding not complete | Finish your Gaia setup | Continue setup | Server (the gate) |
| P-NEW | A shared reading is newer than the last one opened | Open your latest reading | Open reading | Server: opening the card marks it seen |
| P-SHARE | Readings are on for them, but none is shared | Connect your Bio-Well reading | How sharing works | Server: link confirmed |
| P-SESSION | A **confirmed** booking (GHL status `confirmed`) within 7 days | Prepare for your upcoming session | View session | Server: the time passes |
| P-COURSE | An accessible course with saved progress, not finished | Continue {course} | Resume | Server: 100% progress. Opening is not completion |
| P-RECHECK | Latest scan ≥ the recheck window (`GAIA_SCAN_RECHECK_DAYS`, 60) | Consider a new Bio-Well scan · "Your latest scan was over 60 days ago. A new scan may give you a more current point of comparison." | Find a scan | Server: a newer scan arrives. Opening the booking page is not booking |
| R:… | A practitioner explicitly confirmed it for this member | {resource} · **Recommended by your practitioner** · the member-safe reason · optional note | Start practice / Open course / [View service] [Book with …] | By kind (section A): the member for practices; the server for courses and scans; no claim for services |

**Ranking:** onboarding → practitioner → new reading → session → learning →
share → recheck. At most 5 items.

- **Required onboarding takes the whole path.** In practice the existing
  onboarding gate blocks every member route until setup is done, so the gate's
  own screen is the first step.
- **A new reading suppresses "recheck".** A reading that just arrived is never
  also called old.
- **Dismissed** ("Not now") and **completed** items stay gone for that key. A
  new scan or a new session is a new key.
- **No discovery items.** When nothing applies, the member sees "You're caught
  up" and nothing is invented.
- **No products in V1.** The catalogue supports them later (`kind`,
  `membership_requirement`, `free_alternative`), but nothing serves them.

**Membership is a lock, never a recommendation.** The item shows first, then
"This is included with Silver." with [See Silver] and
[Show me a free option]. For a course needing a grant, it says "This course
needs access." It never says "upgrade".

---

## 2. Provenance

| `source_type` | `review_state` | Shown as |
|---|---|---|
| `platform_rule` | `not_required` | Suggested by Gaia (no label on the item) |
| `practitioner_manual` | `approved` (on Confirm) / `revoked` | **Recommended by your practitioner** |
| `practitioner_service` | — | the practitioner's own service, offered in their picker |
| `partner_deterministic` | — | practitioner-only "Suggested matches"; never shown to the member |
| `partner_ai` | — | **disabled source.** `servable()` refuses it, and `GAIA_PARTNER_AI_RECOMMENDATIONS` is off |
| `gaia_catalogue` | entry `status` | selectable by practitioners once approved |

Only `practitioner_manual` with `review_state: approved` and no `revoked_at`
can carry the practitioner label (`personal-path.js practitionerItem`, tested).

---

## 3. Catalogue and approval (`path-catalogue.json`, `tools/path-catalogue.mjs`)

**Entry fields:**
- identity: `id`, `kind` (rule | resource), `title`, `description`, `stage`;
- what it opens: `resource` `{kind, id, target}`;
- provenance: `source_type`, `sources[]` `{type: biowell_official | gaia_practitioner | gaia_content | business_rule, ref, doc_version}`;
- review: `status` (pending | approved | rejected | retired), `approval` `{by, role, at, version, note}`, `version`, `active`;
- access: `membership_requirement`, `free_alternative`, `exclusions`.

**When an entry is served:** only if it is approved **at its current
version**, active, has at least one source, and is not partner AI. Editing an
entry bumps its version, so it needs approval again.

**Approval tool** (local file, no network):
```
node tools/path-catalogue.mjs list | approve <id> --reviewer <contactId> | reject | retire
```
- **Reviewers are a role,** not a name in code: the contact ids in
  `GAIA_PATH_REVIEWERS`.
- **The author cannot approve their own entry.**
- **Audit trail:** every action is appended to
  `data/path-catalogue-audit.jsonl` as `{at, actor, role, action, id, version, hash}`.
- Commit the changed catalogue so the approval travels with the code. An
  in-app reviewer screen (behind authenticated reviewer identity) is the next
  step; the data model already supports it.

**In this PR:**
- **The six V1 rules** are approved with source "Owner brief 2026-10-06
  (Personal Path V1)".
- **The five Gaia resources** (breathing practice, energy check, follow-up
  scan, Bio-Well Orientation, 9-Week Chakra Challenge) are **pending**. They
  can't reach members or practitioners until a reviewer approves them. Until
  then, practitioners can recommend only their own services.

---

## 4. Practitioner workflow and authorization

**Inside a linked client's Practice view**, "Recommend to client":
- Pick from **Your services** (their own `list_services`) or **Gaia resources**
  (approved catalogue entries).
- Partner matches (their services whose areas match the partner's flags)
  appear as **Suggested matches**, with "Use this" to pre-fill the choice.
  They are never recommendations until confirmed.
- **Member-facing reason** is editable; the default is "Your practitioner
  recommended this as part of your current wellness plan."
- **Optional note:** plain text, no links or markup, 280 characters at most.
- **Preview for member → Confirm recommendation.** Confirm is disabled until
  a preview, and any edit disables it again. The server requires
  `confirm: true`.
- Existing recommendations are listed, each with **Revoke**.

**Server rules** (`path-routes.js`):

| Check | Rule |
|---|---|
| Practitioner identity | From the session's verified OAuth link (`linkState === 'connected'`, `practitioner_id` from the token row). Never from the browser. |
| Client | The browser sends a partner `customer_id` only as a selector. The server resolves the Gaia member through a **confirmed link whose `practitioner_id` matches**. Anything else (B's client, a forged id) is a 404 that looks like "nothing there". |
| Resource | Must be an approved catalogue entry or a service in the practitioner's own fresh `list_services`. |
| Revoke | Only the practitioner who made it (same partner id). Anyone else's looks like 404. |
| Recorded | Practitioner contact and partner id, member id, customer id, resource snapshot, member-safe reason, note, catalogue version, created, revoked. |
| Cross-site | The existing guard blocks cookie-bearing writes from other origins. |

---

## 5. Gaia

**Gaia receives one line, built from public path fields only.**

What she gets: the item id, title, stage, state, provenance label, the
approved member-safe reason (practitioner items only), the action label, and
any lock label. For example:

```
PERSONAL PATH (for "what next / my plan": item 1 is the next step; …):
1. [R:rec_…] "Coherence breathing practice" (start_now, Recommended by your practitioner;
   reason: Your practitioner recommended this as part of your current wellness plan.; action: Start practice)
2. [P-NEW] "Open your latest reading" (start_now, Suggested by Gaia; action: Open reading) …
```

What she never gets:
- reading values or derived signals, scan ids, scan dates, triggers or rules;
- the practitioner's note, their name or id, the member id;
- session titles, or partner AI output.

**How she answers:**
- **"What's next / my plan?":** item 1. Without an approved reason she says:
  "Your practitioner recommended this after reviewing your information; I can
  open it or help you contact them."
- **Never:** she never guesses why something was recommended or links it to
  readings.
- **Caught up:** she says so and invents nothing.
- **Cost:** the instruction lives inside this per-member line, not in the
  static rules. That keeps the practitioner prompt within its size budget, and
  sessions without a path pay nothing.

**The avatar (no model involved):**
- The **"What's next for me?"** chip appears on Home, Today and You. She says
  "Your practitioner recommended: … Want to start?" or "Your next step: …",
  with the action chip.
- **After completion:** "Nice, that's done. Your next step: …".
- **Empty path:** "You're caught up. You can explore today's energy check,
  continue learning, or ask me anything."

---

## 6. Analytics

**Storage:** `data/path-events.jsonl`, following the onboarding-funnel
pattern.

**Every event is** `{t, who: sha256('gaia-path:'+contact)[0:16], event, …}`.

**Event names** (anything else is a 400):
- `path_viewed`
- `recommendation_opened`, `recommendation_completed`, `recommendation_dismissed`
- `free_alternative_selected`
- `membership_required_shown`, `membership_opened`
- `scan_rebook_opened`

**Fields** (whitelisted by pattern; anything else is dropped):
- `item_id`: the rule id or `R`, never a scan date or recommendation id;
- `stage`, `surface`, `items` (count), `level` (plan key);
- `via` (user/backend), `route`, `source` (`platform_rule` / `practitioner_manual`).

**Never logged:** reading values, signals, notes, reasons or practitioner
identity. Tested with planted values.

**What it can answer:**
- **Followed?** Opened → completed, per stage.
- **Returned?** `path_viewed` by the same hash over days.
- **Rebooked?** `scan_rebook_opened`, joined later with booking confirmations.
- **Learning?** Course items opened, joined with academy progress.
- **Membership interest?** `membership_required_shown` → `membership_opened`.

---

## 7. Privacy

**Path storage holds no reading data.** It keeps recommendation records and
per-item states only (`path-recommendations.json`, `path-state.json`, mode
0600). The tests assert no energy, stress, chakra, disbalance, severity, flag
or scan-id field is stored.

**The path never reads scan values or partner AI.** `personal-path.js` and
`path-routes.js` are tested to contain no call to `memberReadings`,
`get_customer_scan`, `get_scan_trend`, `get_customer_recommendations` or
`list_flagged_customers`.

**What the page gets:** public item fields only. No practitioner or member
ids, and never another member's recommendations.

**Partner data:** "Suggested matches" use data already on the practitioner's
own screen, and nothing from them goes to the member or to Gaia.

**Unchanged:** `GAIA_SCAN_NARRATION` stays off, and the partner AI
recommendations source stays disabled.

---

## 8. Tests

**Backend: 1120 pass, 0 fail.**

`test/personal-path.test.js` (15 tests, the engine):
- no readings; feature off; new reading (and no "old" at the same time);
- old reading with policy wording and configurable days;
- session: confirmed only, within 7 days, the soonest;
- course: accessible, started, not finished;
- several triggers ranked, capped at 5; no triggers;
- dismissed and completed, plus a new key after a new scan;
- onboarding priority;
- catalogue gating (unapproved, inactive, re-versioned, sourceless, partner AI);
- the repo catalogue: rules approved, resources pending, no products;
- provenance (partner_ai, pending, revoked never labelled);
- membership lock with free option, and course lock;
- Gaia view excludes the note, ids, scan date, session title and practitioner name.

`test/path-routes.test.js` (11 tests, the routes):
- **Visitor:** gets 401.
- **Options:** connected practitioner and own client only; B's client and
  forged ids give 404; unverified link and plain member give 403.
- **Recommend:** confirm required; draft resource, someone else's service,
  links, HTML and over-long text refused; duplicates refused.
- **Member view:** the member sees the label, reason and note, and no ids.
- **Revoke:** owner only.
- **Completion:** a course is completed by the server only; a practice can be
  completed by the member; another member can't touch it.
- **Dismissal** persists.
- **Events:** whitelisted.
- **Planted values:** no reading value, note or reason in analytics; no
  reading field in storage.
- **Gaia line:** carries no note or ids.
- **Gate:** the routes are behind the onboarding gate.

**Frontend:** all pass, including `tests/personal-path-ui.test.cjs`
(escaping, no AI, calm wording and no warning colours, provenance, preview
before confirm, Gaia's path chips).

**Browser run** (390/768/1440, real path routes in-process, sample people):
all five member states, the practitioner flow, the member's view of it,
Gaia's "What's next" and the follow-up after completion.

**Paid AI calls:** none.

---

## 9. Data cleanup: exact changes needed at the source

Not masked in code. These belong in GHL and Shopify:

| Finding | Where it must change | Exact change |
|---|---|---|
| "Crystal Quartz Tachyon Energy Chakra Set" shows as a Silver **course** | **GHL**: it sits in the offer list `courses.json` syncs (`source: ghl-workflow`), next to "Bio-Well 3.0 Device … + Certification" | Remove it from course offers, or mark it as a physical product, in GHL. The "Silver" comes from our sync guessing levels from price and title (`server.js` ~735 and ~891), not from GHL. |
| Guessed "Silver" labels on catalogue courses | **GHL + our sync** | Set each course's access level explicitly in GHL (a custom field, or a tag such as `access:silver`). Then drop the price/title guess in `normalizeCatalogCourse` and show no level when GHL gives none. (Code change prepared for after GHL has the data.) |
| Two chakra challenges | **Owner decision** | The 9-Week Chakra Challenge (GHL Academy course `086ab8c3…`, run Feb–Apr 2026) is Gaia's authoritative programme. The app's 8-week challenge (`wellness-router.js CHALLENGE`, developer-written, 2026-07-05) is not. Either retire the app version, rename it as a self-guided practice, or align it to the 9-week structure. Nothing is changed until decided. |
| Empty Shopify tags | **Shopify admin** | Proposed vocabulary for the owner: `centre:root…crown`, `type:spray\|oil\|crystal\|device\|book`, `use:practice\|education`. Products enter the Path only through approved catalogue mappings, not tags alone. |
| Stale chakra "Learn more" links | fixed in #276 | — |

---

## 10. Blocked on Bio-Well documentation

Nothing in V1 depends on these. Each needs the Bio-Well source, plus partner
answers first (Q8 in the partner message):
- any rule from values: stress or energy versus the member's own average,
  quietest or active centres, disbalance, before/after changes (old R6–R10);
- member-facing definitions, units and ranges ("What these mean" stays
  method-only);
- whether the partner's 20% / 40% / ±5 thresholds are Bio-Well's, which
  decides how flags are attributed;
- the rescan interval and before/after wording (Gaia's 60 days stays product
  policy).

## 11. What a BAA (or equivalent processing agreement) would make possible

- **Conversation about values:** Gaia discussing actual readings, e.g.
  "Compare my last three scans", "Why did my stress change?", "What improved
  since my previous scan?".
- **Explaining a selection:** Gaia explaining *why* a reading-based item was
  chosen, from the underlying analysis rather than the approved
  member-safe reason only.
- **Narration:** turning `GAIA_SCAN_NARRATION` on for practitioners (values
  read aloud in the Practice view).
- **Partner AI suggestions to the AI provider:** reading the partner's AI
  recommendations into Gaia's context. This also needs partner answers Q1, Q2,
  Q4 and Q5, and practitioner approval of each item.
- **Pre-filled review:** practitioner review pre-filled from the partner's AI
  suggestions (B1 full form). It needs the partner schema (Q5); the review
  screen and provenance model in this PR are already shaped for it.

## 12. Decisions for the owner

1. **Approve the Gaia resources** practitioners may recommend: the five
   pending entries, or others.
   ```
   node tools/path-catalogue.mjs approve R-BREATH --reviewer <your contactId>
   ```
   Set `GAIA_PATH_REVIEWERS` first.
2. **"Confirmed" bookings.** V1 counts only GHL appointments whose status is
   `confirmed`. If your calendars leave bookings as `new`, say so and I'll
   include them.
3. **The two chakra challenges** (section 9).


---

# Acceptance pass (6 Oct 2026)

## A. Completion strategy, per action/resource kind

The strategy is fixed in code by kind (`personal-path.js COMPLETION_BY_KIND`).
A catalogue entry cannot choose or weaken it, and an unknown kind gets
`none` (dismiss only). Only `member` shows "I did this"; the server refuses a
member completion for any other kind (409).

| Kind | Examples | Strategy | Completed when | Member "I did this"? |
|---|---|---|---|---|
| tool / practice / view | breathing practice, energy check | `member` | the member says so | **yes** |
| course | Continue a course, a recommended course | `course_progress` | academy progress reaches 100% (server) | no; opening is not completion |
| readings | Open your latest reading | `reading_seen` | the readings card is opened and the server records "seen" | no; never implies Gaia understood the values |
| share_readings | Connect your Bio-Well reading | `link_confirmed` | the practitioner confirms the link | no |
| bookings | Prepare for your upcoming session | `appointment_status` | the confirmed appointment's time passes (GHL) | no |
| service | a practitioner's own service | `practitioner_booking` | **not auto-completed in V1**: their bookings live on the partner platform and are not linked to the recommended service, so there is no authoritative signal. It stays until the practitioner revokes it or the member chooses "Not now". | no; [View service] [Book with …] instead |
| scan | Consider a new scan, a recommended scan | `new_scan` | a scan newer than the recommendation arrives | no; opening the booking page is not booking |
| plans | membership | `entitlement` | the entitlement ledger | no |
| onboarding | Finish your Gaia setup | `onboarding_gate` | the onboarding gate | no |
| product (later) | — | `order` | an order record | never |

## B. GHL booking status: what `new` means here

Measured read-only on 6 Oct with 5 GHL calls: calendar settings, plus status
**counts** only. No names, times or contacts were printed.

- **All 287 calendars have `autoConfirm: true`** (281 active, 6 inactive).
  GHL therefore creates real bookings as `confirmed`.
- **The app's own booking calendars** (`scans`, `bio-welldemo`,
  `healeex-bio-well-combo`) over the last 365 and next 120 days hold only
  `confirmed` and `cancelled`. **`new` does not occur in our data.**
- **Conclusion:** `new` can appear only if a calendar is switched to manual
  confirmation. There it would mean a request not yet accepted, so it is
  **not** treated as confirmed.
- **Keep `confirmed`-only.** No real upcoming booking is lost under the current
  configuration. `cancelled`, `showed`, `noshow` and `invalid` are never
  "upcoming".

## C. The five pending Gaia resources (for content review)

None is approved. None can be selected by practitioners until a reviewer
approves it.

**R-BREATH: "Coherence breathing practice"**
- **Description:** "A guided 5-second-in, 5-second-out breathing practice in the Energy tools. Free."
- **Type:** tool (self-guided).
- **Comes from:** `gaia-breath.js` (Gaia app; developer-written copy).
- **Action:** Energy page → opens the breathing tool (`GaiaTools.open('breath')`).
- **Membership / free alternative:** none needed / — (it is free).
- **Intended use:** a short calming practice between sessions.
- **Claims in its content:**
  - The intro says: "This resonance pace is widely used to steady the heart rhythm and settle the nervous system."
  - It also says: "not a measurement and not medical treatment".
- **Assessment:** self-guided, free, collects nothing, carries a disclaimer.
  **But the heart-rhythm and nervous-system sentence is an unsourced
  physiological claim.** Suggest softening it (e.g. "Many people use this slow
  pace to feel calmer") or citing a source before approval.

**R-ENERGY-CHECK: "Daily energy check"**
- **Description:** "The daily check-in on the Energy page. Free."
- **Type:** view (self-guided).
- **Comes from:** Energy page, daily check (`gaia-daily.js`; text from `wellness-router.js CHAKRA_PATHS` / `gaia-chakra-data.js`).
- **Action:** `home.html?view=wellness&tab=check`.
- **Membership / free alternative:** none / —.
- **Intended use:** a daily reflection habit between sessions.
- **Claims:** daily intention and practice text based on birth-date chakra
  symbolism (e.g. "Ground and steady… lengthen your exhale"). Framed as "a
  reflective tradition—not a measured energy score, diagnosis, or
  prediction". The chakra copy is developer-written, with no reviewer on
  record.
- **Assessment:** low risk (self-guided, free, framed as reflection).
  **The reviewer should read the seven `CHAKRA_PATHS` texts first.**

**R-SCAN: "A follow-up Bio-Well scan"**
- **Description:** "Find or book a Bio-Well scan."
- **Type:** scan.
- **Comes from:** Gaia booking routes and the directory's "scan" intent.
- **Action:** the directory, filtered to Bio-Well practitioners (`GaiaDirectory.open({intent:'scan'})`). Completed when a newer scan arrives.
- **Membership / free alternative:** none (the scan price is the practitioner's) / —.
- **Intended use:** the practitioner wants a re-scan.
- **Claims:** none beyond "Choose a practitioner near you, then take a time on their calendar."
- **Assessment:** no claims, but it **opens all Bio-Well practitioners, not
  necessarily the recommending one.** A practitioner who wants the client back
  should recommend their own scan service instead. Consider approving it only
  as "a scan anywhere".

**R-COURSE-BW-ORIENTATION: "Bio-Well Orientation (course)"**
- **Description:** "Getting started with Bio-Well: account, software and reports. Needs course access."
- **Type:** course.
- **Comes from:** GHL Academy (manifest `fccceb1a…`). It has 13 lessons on account setup, software, calibration, reports and filters.
- **Action:** opens the course player.
- **Membership / free alternative:** a course grant, not a plan level / none.
- **Intended use:** a client who owns or uses a Bio-Well device.
- **Claims:** technical how-to titles. The videos have not been reviewed.
- **Assessment:** aimed at device owners and practitioners, not typical
  clients. Most members lack access and would see "This course needs access."
  Approve only if that use case matters.

**R-COURSE-CHAKRA-9WK: "9-Week Chakra Challenge (course)"**
- **Description:** "Gaia's 9-week chakra programme (GHL Academy). Needs course access."
- **Type:** course.
- **Comes from:** GHL Academy (manifest `086ab8c3…`). These are live-session recordings from Feb to Apr 2026; week 1 is "value of the program to practitioners".
- **Action:** opens the course player.
- **Membership / free alternative:** a course grant / none. The app's 8-week challenge is not offered as one until the 9- vs 8-week decision.
- **Intended use:** a client who wants structured chakra practice.
- **Claims:** recorded sessions, not reviewed. Part of it is framed for
  practitioners.
- **Assessment:** Gaia's authoritative programme. **The reviewer should
  watch or skim the recordings** and decide whether it suits clients.

## D. Next administrative improvement: reviewer UI (not in #279)

**The flow:** Catalogue → **Pending review** → inspect the resource (exact
member-facing title, description, action/deep link, the content it opens),
its sources, and any claims → **Approve / Reject** with a note → the record
stores reviewer identity, timestamp and version.

**Rules carried over from the engine:**
- **Edits reset approval:** editing an approved entry, or its wording or
  action, creates a new version in **pending review**. The previous approved
  version keeps serving until the new one is approved, or the entry is
  retired.
- **Individual identity:** the reviewer signs in with their own Gaia member
  account and holds the `path_reviewer` role. **The shared Control Center
  password is never an approval identity.**
- **Two people:** the author cannot approve their own version.
- **Audit:** every action goes to the append-only audit log. The screen shows
  the diff between versions.
- **Until then:** `tools/path-catalogue.mjs` provides the same rules from the
  command line.

## E. Exactly what Gaia Assist receives for the path

`assistView()` / `assistLine()`, per item:
- `id`
- `title`
- `stage`
- `state` (active or opened)
- `from` ("Recommended by your practitioner" or "Suggested by Gaia")
- `member_safe_reason` (practitioner items only, when approved)
- `action` (its label)
- `needs` (the lock label, if any)

Example:

```
1. [R:rec_…] "Coherence breathing practice" (start_now, Recommended by your practitioner;
   reason: Your practitioner recommended this as part of your current wellness plan.; action: Start practice)
2. [P-NEW] "Open your latest reading" (start_now, Suggested by Gaia; action: Open reading)
3. [P-SESSION] "Prepare for your upcoming session" (coming_up, Suggested by Gaia; action: View session)
```

**Not sent:**
- **The practitioner's note.** The member sees it on screen, but it is not
  approved for the AI provider, so it is not sent.
- **People:** the practitioner's name or id, the member id.
- **Dates and titles:** scan dates or ids, session titles or times.
- **Logic and data:** triggers, rule logic, values, derived signals, and any
  partner AI output.

**Deterministic answers in the avatar, with no model involved:**

| Ask | Answer |
|---|---|
| What's next for me? | "Your practitioner recommended: X. Want to start?" or "Your next step: X." |
| Why is this recommended? | Practitioner item: "Your practitioner's reason: “{member_safe_reason}”". Without a reason: "Your practitioner recommended this after reviewing your information. I can open it for you, or help you contact them for more detail." Gaia suggestion: its own public reason. |
| Show me a free option | opens the approved free alternative |
| I did this | self-guided items only; then "Nice, that's done. Your next step: …" |
| What comes after this? | "After that: X." |

## F. After the partner's answers (6 Oct): three origins, one boundary

**What the partner developer confirmed** (owner's summary):
- **The pipeline:** Gaia Practitioners already runs scan → Claude analysis →
  up to 5 ranked product/service recommendations (with ids, relevance,
  matched systems, reasoning and a video script) → practitioner
  approve/reject/regenerate.
- **The trust boundary:** pending and rejected items are practitioner-only;
  approved items are intentionally member-facing.
- **Compliance:** their Claude processing of scan data is **not yet under an
  Anthropic BAA/enterprise plan**.
- **Thresholds:** the flag thresholds (20% elevated, 40% high, ±5
  improving/worsening, 3 worsening sessions, stress +2, energy −15) are
  **Gaia Practitioners' own triage rules, not Bio-Well methodology**.

**What follows for Gaia Healers:**

| Origin | Shown as | Source in code | State |
|---|---|---|---|
| Gaia / platform rules | Suggested by Gaia | `platform_rule` | **live in #279** |
| Manual practitioner choice (an approved Gaia resource or their own service) | Recommended by your practitioner | `practitioner_manual` | **live in #279** (separate source; useful for Gaia practices, courses and services) |
| Gaia Practitioners **approved** recommendation | Recommended by your practitioner | `partner_ai` (approved on their side) | **not built.** It will come only from their forthcoming member tool that returns approved items only. Gated by `GAIA_PARTNER_AI_RECOMMENDATIONS` (off) until their BAA is in place. |

- **No duplicate review.** We will **not** import pending partner
  recommendations, and won't make practitioners approve them a second time
  in our Practice tab.
- **Fields we'll ask for** in their member tool: id, type, product/service
  id, title, rank (if member-safe), member-safe reasoning, approved
  status/date, practitioner, action/link. **Not** body-system matches.
- **Their reasoning stays out of our AI provider, even after their BAA.** The
  member-safe reason is displayed directly, and Gaia answers "Why?"
  deterministically from that field, exactly as for manual recommendations
  today (section E).
- **Flags are labelled as triage signals.** In code and docs they are
  "Gaia Practitioners triage signals", never "Bio-Well interpretation". The
  member card already says "Flagged by your practitioner's scan platform; the
  labels are theirs."

**Readings boundary** (pinned by `test/member-readings-ai-boundary.test.js`):

| Data | Member UI | Gaia's AI provider |
|---|---|---|
| Member readings, trends, triage flags (partner member access) | **shown** in You → My readings (authorised display) | **never sent.** The context has only "readings are shared" and "a new one is waiting". The page sends only the screen name and an item id with each message. |

`GAIA_SCAN_NARRATION` stays off. `GAIA_PARTNER_AI_RECOMMENDATIONS` stays off.

## G. Final cleanup (6 Oct 2026, owner)
- **R-BREATH:** description is now "Take a few minutes for slow, paced
  breathing." The unsourced heart-rhythm and nervous-system claims were
  removed from `gaia-breath.js` (intro and end-of-session copy). It is
  **approved at version 2** (reviewer: owner; the instruction is recorded in
  the audit log).
- **Still pending:** R-ENERGY-CHECK, R-SCAN, R-COURSE-BW-ORIENTATION and
  R-COURSE-CHAKRA-9WK.
- **The reading item** is now "Open your latest reading" (P-NEW, version 2,
  re-approved). Opening completes the navigation step only; nothing implies
  the member, or Gaia, understood or interpreted it.
- **Unchanged:** `confirmed`-only appointments. `GAIA_PARTNER_AI_RECOMMENDATIONS`
  and `GAIA_SCAN_NARRATION` stay off.
- **Partner AI recommendations** are not integrated until their approved-only
  member tool exists **and** the partner confirms its Anthropic BAA/compliant
  production arrangement.
