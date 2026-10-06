# Can Gaia Practitioners be the analysis engine? (audit, 6 Oct 2026)

**Question.** Can the Gaia Practitioners platform interpret Bio-Well scans and
produce recommendations that a practitioner approves, so that Gaia Healers only
delivers and coaches? This would replace building our own interpretation
engine.

**Decision (owner, 6 Oct 2026): option B1 approved in principle.**
- **Flow:** the partner does the analysis; the practitioner reviews and
  explicitly approves in Gaia's Practice tab; Gaia stores the approvals;
  Personal Path delivers them; Gaia coaches.
- **Partner AI recommendations stay disabled** until Q1, Q2, Q4 and Q5 are
  answered.
- **Bio-Well is contacted only after the partner replies.**

**Audit conclusion: B, gated by D.**
- The partner already does the sensitive analysis: deterministic flags,
  trends and comparisons, plus AI-generated recommendations per scan.
- It has **no approval step, no member-safe output and no write path**.
- Its AI processing (inputs, provider, agreements) is undocumented.

So the architecture is right, but it needs (1) a small change to complete the
review loop and (2) partner answers before any of their AI output reaches a
member. We should not build a duplicate interpretation engine.

---

## 1. Method

**Partner tool definitions.** Two runs of
`staging-proxy/tools/partner-tools-catalog.mjs` (one call each) recorded the
partner's own descriptions and input and output schemas. There are 22 tools
on staging.

**One recommendation's structure.** Two runs of
`staging-proxy/tools/partner-recommendation-shape.mjs` (key names and types
only, never values) checked 2 customers across 2 practices: **0
recommendation records**.

**Practice-wide count.** One `get_dashboard_summary` call timed out on the
partner side ("Bio-Well did not answer within 30s"). Probing stopped there.

**Totals.** 8 partner calls across 5 runs, each under the 5-call cap. No paid
model calls. No client values were read.

**Code and docs.** Our integration code and docs were read, including
`/root/event/docs/GAIA_PRACTITIONERS_MCP_AUDIT.md`, written from the
partner's OpenAPI spec on 1 Oct.

---

## 2. What the partner provides (tool by tool)

Legend:
- **Raw:** raw scan values in the output.
- **AI:** described by the partner as AI-generated.
- **Det.:** deterministic rules.
- **Appr.:** practitioner approval involved.
- **Member-safe:** intended or safe to show a member.

| Tool | Input | Output | Raw | AI | Det. | Appr. | Member-safe |
|---|---|---|---|---|---|---|---|
| `get_customer_scan` | customerId | Full Bio-Well payload (energy, stress, chakras, organs, meridians, systems; left/right/disbalance) | yes | no | n/a | no | no |
| `get_client_summary` | customerId | Profile + full labelled scan, "**for the model to summarize** (e.g. into a client-facing PDF)" | yes | no (it is input *for* an AI) | n/a | no | no |
| `get_scan_trend` | customerId, summary_only | Energy/stress series, per-area trends, flags | yes | no | **yes**: direction ±5 points; flagged if disbalance ≥ 20% or 3+ worsening sessions in a row; severity elevated 20–40%, high ≥ 40% | no | no |
| `list_flagged_customers` | minSeverity | Customers with `disbalance_high`, `stress_increase`, `energy_decrease` flags | yes (`value`) | no | yes (same thresholds) | no | no |
| `compare_protocol_before_after` | customerId, limit | Before/after pairs (labelled or time-inferred), deltas | yes | no | yes | no | no |
| `get_research_results` / `get_practice_research_analytics` | customerId? | Saved "Compare Research" improved/disimproved results | yes | no | yes | practitioner-saved | no |
| `search_customers_by_scan` | query, direction, sinceDays | Customers whose area worsened or improved | yes | no | yes | no | no |
| `suggest_follow_ups` | — | Follow-up windows from flags + "typical appointment cadence" | flags | no | yes | no | no (practitioner planning) |
| **`get_customer_recommendations`** | customerId | `{id, scan_type, scan_id, recommendations ("Parsed recommendations JSON", untyped), script, video_status, video_url, created_at}` | unknown | **yes** ("AI-generated recommendations/scripts") | no | **no field for it** | **unknown** |
| `list_services` | — | `{id, name, price, description, attributes, systems, duration, repetition}` | no | no | — | practitioner's catalogue | names yes |
| `list_products` | — | `{id, name, price, attributes, systems, description, is_active}`, "**for recommendation context**" | no | no | — | — | names yes |
| `list_appointments` | limit | `{…, service_name, booking_date, status: Pending/Confirmed/Completed/Cancelled}` | no | no | — | — | the member's own, yes |
| `get_customer_files` | customerId | Listing only (name, type, size, date); no content | no | no | — | — | names only |
| profile / customers / orders / reviews / performance / dashboard | various | Practice data | no | no | — | — | no |

**Member-side MCP** (one-member token, built by the partner on 4 Oct):
`get_my_profile`, `get_my_latest_scan`, `get_my_scan_trend`,
`get_my_before_after`, `list_my_shared_files`.
- **No recommendations or guides tool.** `get_my_recommendations` and
  `get_my_guides` were our guesses, and the partner did not build them.
- **Mostly raw data:** everything except the profile and the files listing
  returns raw values.

**There are no write tools.** OAuth scope is `mcp.read` only. There are no
webhooks; everything is pulled. No tool has an `approved`, `reviewed_at`,
`author` or `edited` field.

---

## 3. "Guides" (`get_customer_recommendations`)

| Question | Answer | Evidence |
|---|---|---|
| Generated per scan? | **Probably.** Each record carries `scan_id` and `scan_type` | Output schema |
| Uses actual Bio-Well values as AI input? | **Unknown, likely.** Being tied to a scan suggests so; `list_products` exists "for recommendation context" | Schemas, descriptions |
| What triggers generation? | Unknown | — |
| Model/provider, privacy arrangements | **Unknown.** Nothing recorded anywhere | — |
| Practitioner sees it before the member? Can edit, approve or reject? | **Unknown, and not exposed.** No status, approval or author field | Output schema |
| Stored? Regenerated? | Stored (it has an `id` and `created_at`); regeneration unknown | Output schema |
| Contents | `recommendations` is untyped JSON, plus a `script` and a generated video (`video_status`, `video_url`). **None found on staging** to inspect | Probe: 0 records |
| Intended for Gaia Healers to consume? | **Not stated.** It is not on the member MCP | Member tool list |

**Our current handling needs correcting:**
- **Wrong label.** The member setting reads "Let Gaia Assist read the guides
  {practitioner} **writes** for you", and the Practice tab says "guides you
  write for them". The partner calls them AI-generated, and nothing shows
  that a practitioner wrote or reviewed them.
- **Weak value filter.** `shapeGuides()` reads only `script` and ignores the
  structured JSON. Its value filter would miss text like "Pancreas 30%".
  Whatever passes still reaches our AI provider when the member opts in.
- **Fix:** relabel, and keep the setting effectively inert until the partner
  answers. No live read has happened yet: there is no `guides_read` audit
  entry.

---

## 4. Suggested services

**How it works.** Partner flags (deterministic: disbalance ≥ 20% etc.)
supply concern names, such as "Liver". These are matched by **string**
against each service's comma-separated `attributes`. The `attributes` use the
same vocabulary as the scan areas, e.g. a lymphatic massage service lists
"Lymphatic System, Liver, Kidneys".

- **Bio-Well data?** Only through the partner's flags.
- **AI?** No.
- **Fixed mapping?** Yes: a name match.
- **Client history?** No.
- **Who writes `attributes`?** Unknown: practitioner or platform default (Q4 below).

**Is it the engine we need?** It is a sound, deterministic,
practitioner-catalogue-based matcher. It is useful as a **suggestion to the
practitioner**, not as a member-facing recommendation on its own.

---

## 5. The privacy gap found during the audit (fix separately)

Our privacy boundary keeps reading values away from the AI provider (no BAA)
for three practitioner tools only (`SCAN_TOOLS`).

Two more tools send client disbalance values to the provider unredacted:
- **`practitioner_flagged_clients`** (`assist-tools.js` around line 647):
  `concerns[].value`.
- **`practitioner_suggested_services`** (around line 602): `concerns[].value`.

**Who is affected:** practitioners asking about their own clients, not
members.

**Fixed and deployed in #278 (6 Oct 2026), across every practitioner
tool, not only these two.**
- **Before:** the AI provider received DOB, sex, phone, email and city
  (`get_client`); email (`find_client`); file names and dates
  (`client_files`); disbalance values, severities and scan dates
  (`flagged_clients`, `suggested_services`); and severities (`follow_ups`).
- **Now:** client id and name, counts, and area names marked "flagged".
- **Fails closed:** a practitioner tool without an explicit model view sends
  only "it is on screen".
- **Partner AI guides:** a disabled source (`GAIA_PARTNER_AI_RECOMMENDATIONS`,
  off).
- **Tested:** `test/practitioner-ai-privacy.test.js` plants unique values in
  every partner answer.

---

## 6. Target architecture

Two ways to close the review loop, cheapest first.

### Option B1 (recommended): review happens in Gaia's Practice tab, and Gaia stores the approvals

```
Bio-Well → Gaia Practitioners: flags, trends, AI recommendations (per scan)
                │ read via existing practitioner OAuth (mcp.read)
                ▼
Gaia Healers Practice tab: "Suggested for Bob"
   ☑ Coherence practice   ☑ Lymphatic massage (your service)   ☐ Course C   ☑ Follow-up scan
   edit wording · add item from the approved catalogue · short note · [Confirm]
                │ server stores the APPROVED items (practitioner id from the session, never the browser)
                ▼
Member Personal Path: "Recommended by your practitioner"   +   "Suggested by Gaia" (platform rules)
                │ public title, stage, state, action only
                ▼
Gaia Assist coaches through it
```

- **Partner change needed is small:**
  - document a stable schema for `recommendations` (item type, title, and
    refs to `list_services` / `list_products` ids);
  - answer the AI and privacy questions.
- **No partner write API needed.**
- **Fits V1:** the Personal Path V1 "practitioner recommends" workflow
  (owner brief, point 7) *becomes* this review screen, pre-filled with the
  partner's suggestions.
- **Data flow:** the raw AI output is shown only to the practitioner, in the
  tab that already shows them their client's readings. The member and Gaia
  Assist get only approved items.

### Option B2: review happens on the partner side, and they expose approved items

- **On the partner side:** a review UI, approval state, and a member MCP tool
  such as:
  ```
  get_my_path → [{ id, title, member_safe_reason, type: practice|service|course|follow_up|product,
                   ref: { kind, id|url }, priority, practitioner_note, approved_by, approved_at, revoked_at, version }]
  ```
  plus `updated_since` or a webhook.
- **Fit:** cleanest if practitioners live in the partner UI, but much more
  partner work.
- **Gaia's side** is identical either way, because Personal Path consumes
  "approved items with provenance".

### Option C (our own interpretation engine)

**Not needed.** The partner already computes flags and trends
deterministically, and B1 or B2 keep the human in the loop.

---

## 7. How Gaia answers members (any option)

| Member asks | Gaia has | Gaia says |
|---|---|---|
| "What's my plan this week?" | Approved path items | Coaches through them: "Your practitioner recommended a short coherence practice. Want me to open it?" |
| "Why was this recommended?" | An approved `member_safe_reason` | That reason, verbatim |
| "Why was this recommended?" | No reason | "This was recommended after your practitioner reviewed your reading. I can open it, or help you message them for more detail." Never reconstructs the reasoning. |
| "Did my stress get worse?" | No values (no BAA) | Doesn't guess. Offers to open My readings, which shows the numbers and the member's own averages, or to message the practitioner. |

---

## 8. Summary

**Exists today:**
- Partner deterministic flags, trends, before/after and research
  comparisons.
- AI recommendations per scan (none on staging; content untyped).
- Practitioner service and product catalogues with area attributes.
- Appointments with status.
- Our practitioner OAuth (read), the member link, and the Practice tab.
- Deterministic suggested services.

**Usable today, without partner changes:**
- Platform Path rules: onboarding, new reading, recheck, upcoming session
  (now also from partner `list_appointments` status), continue course.
- A practitioner "recommend to client" flow from **our** approved catalogue
  and the practitioner's **own services**, pre-filled with
  suggested-services matches.
- Showing the practitioner the partner's flags (already done).

**Needs a partner change or answers:**
- Using `get_customer_recommendations` as pre-filled suggestions:
  - a schema for `recommendations` (B1);
  - answers on AI inputs, provider and agreements (Q1–Q3).
- Member-side approved output (B2 only).
- Who writes service `attributes` (Q7).
- Where the flag thresholds come from (Q8).

**Still needs Bio-Well documentation:**
- Any member-facing *interpretation* of values: definitions, ranges,
  centres, before/after wording.
- Whether the partner's 20% / 40% and ±5 thresholds are Bio-Well's (else
  they are the partner's own and must be labelled so).

**Still needs a BAA** (or an equivalent agreement for the processor):
- Gaia Assist reading values ("Compare my last three readings", "Why did my
  stress change?").
- Sending partner AI recommendation text to our AI provider: the guides
  setting.
- The two unredacted practitioner tools above, if values are to keep
  reaching the model.
- Enabling `GAIA_SCAN_NARRATION`.

---

## 9. Questions for the Gaia Practitioners developer

1. Is `get_customer_recommendations[].recommendations` generated from the
   scan identified by `scan_id`? Exactly which inputs go to the model:
   labelled values (stress, energy, chakras, organs, meridians, systems),
   customer sex and DOB, `list_services`, `list_products`, earlier scans?
2. Which model and provider generates it, in which region? Is a data
   processing agreement or BAA in place for that processing, and what is the
   provider's retention?
3. What triggers generation: each scan sync, or a practitioner action? Is a
   record ever regenerated or overwritten (same `id`), or always a new one?
4. Does the practitioner see the recommendation in your UI before the client
   can? Can they edit, approve or reject it? If so, is that state stored, and
   could the MCP expose it (`status`, `reviewed_by`, `reviewed_at`,
   `edited_text`)?
5. What is the JSON schema of the `recommendations` field? Item types
   (practice / service / product / follow-up)? Do items reference
   `list_services` or `list_products` by `id`?
6. Are `script` and `video_url` delivered to the client today (email, app,
   portal)? Are they intended as client-facing content?
7. Are `attributes` and `systems` on `list_services` / `list_products`
   entered by the practitioner, or set by the platform? Who curates the
   "platform products" in `list_products`?
8. Are the flag rules (disbalance ≥ 20%; elevated 20–40%; high ≥ 40%;
   direction ±5 points; 3 consecutive worsening sessions) Bio-Well's
   published guidance or your platform's own? If Bio-Well's, which document?
9. Would you add a member-scoped `get_my_path` (approved items only, schema
   in section 6), or a write scope so Gaia can store practitioner approvals
   against your recommendation ids? Or are you happy for Gaia to be the
   system of record for approvals (option B1)?
10. `get_dashboard_summary` timed out with "Bio-Well did not answer within
    30s": do practice-level tools call Bio-Well live? When will production
    MCP parity with staging be ready?
11. When your platform returns flags, trends, suggested services or
    AI-generated recommendations, which fields do you consider
    safe/intended for display directly to the client, and which are
    practitioner-only?

The ready-to-send message is in `PARTNER_QUESTIONS_MESSAGE.md`.
