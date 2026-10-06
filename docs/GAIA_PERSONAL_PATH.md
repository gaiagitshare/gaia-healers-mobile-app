# Gaia Personal Path — design for approval

Status: **proposal, nothing below is built** except the "What do these mean?"
walk-through and the avatar placement fix (section 10). No recommendation rule
is implemented until the mappings in section 6 are approved with a source.

The loop we are building:

> measure → understand → recommend → act → learn → check progress → adjust

Bio-Well reading + member context → deterministic interpretation → approved
recommendation catalogue → prioritised Personal Path → Gaia guides the member
through it → progress / check-in → updated path.

---

## 1. Authoritative-source audit (what the project actually knows)

**Headline finding: no Bio-Well threshold, band or meaning in either repo has a
stated source.** There is no Bio-Well manual, GDV table, PDF or expert sign-off
anywhere in the code, data or docs. The only measured facts are field names and
shapes, recorded against the partner's staging server
(`docs/PRACTITIONER_AREA_DESIGN.md`, "not taken from documentation").

### 1a. Facts we can use without any approval (pure arithmetic or the partner's own labels)

| Derivable | Where it comes from |
|---|---|
| Scan date and age in days | `latest.scanned_at` |
| Latest energy / stress vs the member's **own** average (3-scan or 90-day) | `average_recent`, `trend.*.average` |
| Highest / lowest chakra **value** in a scan | `latest.chakras[]` |
| Change between two scans | `series`, `comparisons[]` |
| Flagged areas with direction and severity | `trend.flagged[]`: **computed by the partner (Bio-Well / gaiapractitioners)**, passed through untouched |
| Practitioner-written guides / recommendations | `get_my_recommendations` (practitioner-authored, consent-gated) |
| Number of scans, whether a new one is unseen | link status |

### 1b. Already on screen today with **no source** (needs a source or removal)

All arrived in PRs #223–#225 (4 Oct 2026); no source is cited.

| Item | Where | Value |
|---|---|---|
| Energy "comfortable" band | `gaia-my-readings.js` gauge + explainer | 40–70, "most people sit between 40 and 70" |
| Stress "comfortable" band | same | 2–4, "above 4 is worth a conversation" |
| Headline step sizes | `member-link.js readingSummary` | energy ±5, stress ±0.5 vs 90-day average |
| Stale scan | `ageOf` | > 30 days |
| Centre of the week cues (quietest chakra → tool + cue) | `gaia-my-readings.js CENTRE_CUES` | developer table |
| Chakra → colour spray shop search | `gaia-store.js CHAKRA_COLOUR` | developer table (Jul 2026) |
| Chakra practices / journal prompts / themes | `gaia-chakra-data.js`, `wellness-router.js CHAKRA_PATHS` | developer-written, "real correspondences" comment, no reviewer |
| Out-of-balance shown as "%" | member card | unit assumed |

### 1c. Not defined anywhere

- What chakra `alignment` means (scale and direction). The member card never
  shows it, but the explainer mentions "centred or pulled to one side".
- `asymmetry`, organ left/right values, the unit and normal range of `disbalance`.
- The partner's rule for raising a flag and choosing its severity.
- Units disagree: the UI says `J ×10⁻²`, the design doc says "joules ×100".

**Recommendation:** ask Bio-Well (or Gaia's lead practitioner) for the official
interpretation guide. Until then, keep the on-screen bands **labelled as Gaia's
display bands**, or remove them, and build every rule on 1a only.

---

## 2. What exists vs what must be built

| Layer | Exists today | To build |
|---|---|---|
| Reading data | Full member payload (`/my-readings`), partner flags, practitioner guides | nothing |
| Interpretation | `readingSummary` (own-average wording), walk-through (this PR) | `pathSignals()`: named, versioned signals from 1a only |
| Resources | Energy tools (all free), 14 catalogue courses + 12 manifest courses, 8 communities, directory with Bio-Well filter, 3 booking links, events, 105 Shopify products, 4 membership levels | a **resource registry** with stable ids (today ids differ between `courses.json` and the manifest; store tags are empty) |
| Recommendations | `CENTRE_CUES`, `CHAKRA_COLOUR`, `practitioner_suggested_services` (practitioner-authored attribute matching) | the **approved catalogue** (section 5) |
| Path / ranking | `suggestedNextStep()` for Assist (one line, fixed order) | `buildPath()` ranking and staging |
| Progress | course progress, daily check-ins, challenge check-ins, practice journal (device only), member prefs (6 fixed booleans) | `member-path` store: per-item status, no values |
| Gaia | avatar chips and SUGGEST table, Assist member facts | a PATH fact line, an `open_path_item` tool, path chips |
| Membership | `resolveMemberAccess` (level, next level, gains), per-course grants | lock reasons on path items |

---

## 3. Architecture

```
Bio-Well partner ──► memberReadings()                  (exists; values never stored)
                          │
                          ▼
                    pathSignals(readings)              L1  deterministic, versioned, unit-tested
                          │  e.g. scan_age_days=158, stress_vs_own_avg=up,
                          │       quietest_centre=solar_plexus, partner_flag(liver, worsening)
                          ▼
 approved catalogue ──► matchRecommendations()         L2  only status=approved entries
                          │
 member context ──────► buildPath()                    L3  rank, stage, lock, de-duplicate,
 (grants, level,          │                                apply done/dismissed
  progress, prefs)        ▼
                     Path { items[≤5] }  ──► My readings "Your Gaia Path" · Today row · avatar
                          │
                          ▼
                 Assist sees titles + status only      L4  never signals, reasons or values
```

- **Runs on the proxy**, inside the existing `/my-readings` request: the
  readings are already fetched there. Same promise as today: values are never
  written to disk; the path store keeps only recommendation ids and statuses.
- **L1 signals are the only place readings become words.** Every signal is a
  named function with a unit test and a version, so a later expert-approved
  threshold changes one constant, not the UI.
- **The catalogue is data**, `data/path-catalogue.json`, editable later in the
  Control Center. Code never contains a mapping.

---

## 4. Data model

### 4a. Catalogue entry

```jsonc
{
  "id": "stress-above-own-average",
  "version": 1,
  "trigger": { "signal": "stress_vs_own_avg", "op": "eq", "value": "up" },
  "reason": "Your latest stress reading is higher than your own recent average.",   // member-facing, reviewed copy
  "stage": "start_now",            // start_now | this_week | learn | work_with | explore | recheck
  "priority": 70,                  // 0–100 within the stage
  "practice":  { "kind": "tool",   "id": "breath" },
  "learning":  { "kind": "lesson", "id": "<manifest course>/<lesson>" },
  "service":   { "kind": "practitioner", "id": "linked" },
  "product":   null,               // optional, never the first item
  "free_alternative": { "kind": "tool", "id": "breath" },
  "membership_requirement": "from_resource",   // derived live from grants/resolver, never hard-coded
  "exclusions": ["no_scan_within_days:365"],
  "approval": { "status": "draft", "by": null, "at": null },   // draft | approved | retired
  "source": { "type": "gaia_expert", "ref": null }             // bio_well_doc | gaia_expert | practitioner | business_rule
}
```

### 4b. Member path state (`data/member-path.json`, keyed by contactId)

```jsonc
{ "items": { "stress-above-own-average:tool:breath":
    { "status": "done", "at": "2026-10-06T…", "scan": "2026-10-03" } },   // suggested | started | done | dismissed | snoozed
  "catalogue_version": 3 }
```

No values, only the scan **date** the item was made for. "Done" comes from
existing signals where possible: course progress, daily or challenge
check-ins, a booking. The breath tool needs a small "completed" event.

### 4c. Path output (to the page)

```jsonc
{ "basis": { "scanned_at": "2026-04-25", "age_days": 164, "stale": true },
  "items": [ { "stage": "start_now", "rec": "stress-above-own-average", "title": "Coherence Breathing", "minutes": 3,
               "reason": "…", "source_label": "Gaia practice library", "free": true, "locked": null,
               "open": { "view": "wellness", "tool": "breath" } } ] }
```

---

## 5. Ranking rules

1. Stages in order: **Start now → This week → Learn → Work with someone → Explore → Recheck**.
2. At most one item per stage, at most five in all. The rest sit behind "See more".
3. **"Recommended by your practitioner"** (their guides) outranks everything in its stage.
4. Inside a stage: free before paid, owned before locked, shorter before longer.
5. Products appear only under **Explore**, never as the only item, and never
   without a free item on the same path.
6. Done → the next item of the same recommendation ("continue"). Dismissed →
   hidden 30 days. A new scan → regenerate, keeping dismissals.
7. A scan older than the recheck window shows a banner at the top ("based on
   your scan from April 25"). The Recheck item stays in its stage.
8. Never: diagnosis words, "treats", "fixes", "heals", or ranking by price.

---

## 6. Proposed recommendation taxonomy — **for approval, none implemented**

Every row uses only resources that exist today. "Source" says who must sign it off.

| # | Trigger (from 1a only) | Stage | Points to (existing) | Source needed | Ready? |
|---|---|---|---|---|---|
| R1 | No readings shared | start_now | Share-with-practitioner flow; "Book a Bio-Well scan" (`biowell-scan` booking, directory filter `intent:'scan'`) | business rule | **yes**, business decision only |
| R2 | New reading unseen | start_now | Open readings and the walk-through; "Questions for your practitioner" | business rule | **yes** |
| R3 | Scan older than *N* days (proposed 60) | recheck | Book a Bio-Well scan with the linked practitioner, else directory | business rule (N) | needs N |
| R4 | Practitioner guide present (consent on) | start_now / this_week | The guide's own items, labelled "Recommended by {practitioner}" | practitioner | **yes**, already practitioner-authored |
| R5 | Partner flag, direction *worsening* | work_with | Linked practitioner; their services matched by `practitioner_suggested_services` (practitioner-authored attributes) | practitioner | **yes**, mechanism exists |
| R6 | Stress above own average (latest vs 3-scan avg) | start_now | Coherence Breathing (free). Learn: Bio-Well Advanced L1 "Stress Scan" lesson (grant-gated) | Gaia expert | draft |
| R7 | Energy below own average | this_week | **No sourced resource identified.** Experts to propose | Gaia expert | open |
| R8 | Quietest centre = X | this_week | X's practice from `gaia-chakra-data.js`; 9-Week Chakra Challenge week for X; Chakra Match for X | Gaia expert (also signs off the existing practice copy) | draft |
| R9 | Quietest centre = X | explore | X colour spray (existing `CHAKRA_COLOUR` search), chakra crystal set | Gaia expert + owner (commerce) | draft |
| R10 | Onboarding interest "stress and nervous system" | learn | Matching course or community, **once tagged** | owner | needs tagging |
| R11 | Comparison: change after sessions | work_with | "Talk it through with {practitioner}", with the before/after dates | business rule | **yes** |

Note on existing live mappings: `CENTRE_CUES` (quietest centre → tool) and
`CHAKRA_COLOUR` (chakra → spray search) are already live without a source. I
propose they move into the catalogue as R8 and R9 drafts, so they are
reviewed once along with everything else.

---

## 7. Exact UX

### My readings: new "Your Gaia Path" section, under "In short"

```
YOUR GAIA PATH                         based on your scan from Apr 25 · 5 months ago
┌ A new scan would show where you are now.  [Book a scan]                            ┐

START NOW            Coherence Breathing · 3 min · Free            [Start]   ⋯
                     Why this? ▸
THIS WEEK            Solar Plexus practice · 10 min · Free          [Open]    ⋯
LEARN                Chakra Challenge · Week 4 · Included with Silver
                     You're on Free.  [See Silver benefits]  [Keep exploring free]
WITH YOUR PRACTITIONER   "My stress rose while energy fell. What would you look at next?"
                     Sam Rivera  [Message]  [Book]
EXPLORE              Related from the Gaia shop ▸   (collapsed by default)
RECHECK              Your next Bio-Well scan  [Book]

These are wellness suggestions, not a diagnosis.  Done ✓ · Not now · Why this?
```

- **"Why this?"** opens the reason and its source label ("Part of Gaia's Solar
  Plexus material", "Recommended by Sam Rivera").
- **⋯** menu: Done, Not now, Don't suggest this.
- Lock wording comes from the member's real grants. Course access is
  per-grant, not by level, so "Included with Silver" appears only when the
  policy says so.

### Today

One row: "Next on your path: Coherence Breathing · 3 min" with **Start**.

### Gaia (avatar and Assist)

- **Chip "What's next on my path?"** points at the next item; Start opens it.
- **After completion:** "You finished that. Continue with Week 4, or see why it
  was suggested?" The reason is shown on screen, never spoken from the model.
- **Assist fact line** (~30 tokens): `PERSONAL PATH: next "Coherence Breathing"
  (free, 3 min); 4 items; 1 done this week.` No trigger, reason, signal or value.
- **New tool `open_path_item(index)`.** "Why?" → Gaia opens the item's "Why
  this?" on screen.

---

## 8. Privacy decision Babak must make (Layer 4)

Even without values, "your path prioritises stress regulation" is **derived
from health data**. Proposal:

- **Default:** Assist receives item **titles and statuses only**. The reason
  stays on screen. The You page promise "never reads your reading values" stays
  true; I suggest clarifying it to "never reads your readings or why your path
  suggests something".
- **Option:** a member consent switch, "Let Gaia talk about why my path
  suggests things", like the guides switch. It still sends no values, but
  sends the reason text. Needs your decision; it is not proposed as default.
- **`GAIA_SCAN_NARRATION`:** unchanged and off. Real conversational analysis
  ("compare my last three scans") waits for a BAA-covered provider (Layer 5).

---

## 9. Data hygiene found during the audit (fix regardless)

- **Stale deep links in `gaia-chakra-data.js` `learnHref`:** `wellness&tab=biowell`
  is not a tab, and `community&tab=learning` does not exist.
- **Mis-filed product:** "Crystal Quartz Tachyon Energy Chakra Set" is in
  `courses.json` as a silver course.
- **Two chakra challenges:** a 9-week course (Brow week) and the app's 8-week challenge.
- **Course `accessLevel` is guessed** from price and a title regex. Grants are
  what actually unlock courses.
- **Store data is unusable for matching:** Shopify `tags` are empty on almost
  every product, so there is nothing to match on.
- **Member prefs can't hold path state:** they accept only six fixed booleans,
  so the path needs its own store.
- **Readings card copy:** the unit is inconsistent (J ×10⁻² vs joules ×100);
  alignment is explained but never shown; the "%" on disbalance is assumed.

---

## 10. Shipped in this PR (no thresholds, no AI)

- **"What do these mean?"** now walks through the member's own card, section by
  section: In short → latest scan (date, age, own 3-scan average) → seven
  centres (most active / quietest) → most out of balance → last 90 days
  (partner flags) → before/after sessions → definitions.
  - Wording is fixed, and it adds no ranges or meanings.
  - It ends by sending questions of meaning to the practitioner.
  - Steps are built by `GaiaMyReadings.guide()`; Gaia only points.
- **Avatar placement:** when pointing, Gaia and her bubble are measured and
  placed beside, below or above the target. On a phone the target is lifted
  under the top bar to make room. She waits for smooth scrolling to settle
  before measuring.
  - Checked at 390 px and 1440 px: no overlap with the ringed section on six
    of seven steps.
  - Exception: on a phone, the open definitions plus the bubble are taller than
    the screen, so she uses her corner.

## 11. Build order after approval

1. **Signals and path engine** (L1, L3), plus path store and UI, with only the
   **ready** rows R1, R2, R4, R5, R11 and R3 (once N is set). About 1 week.
2. **Resource registry:** stable ids, the fixes in section 9, and course/product tags. About 3–4 days.
3. **Expert-approved rows** R6–R10 as they are signed off. Data only, no code.
4. **Gaia:** Assist fact line, `open_path_item`, avatar chips and completion follow-ups. About 3 days.
5. **Measurement:** path opened, item started/done/dismissed, bookings and
   purchases after a path item (counts only, no values).

## 12. Decisions needed

1. **Expert reviewer:** who approves catalogue rows and chakra copy (Dr. Nima? Bio-Well?).
2. **Display bands:** source the 40–70 / 2–4 bands, relabel them as Gaia's display bands, or remove them.
3. **Recheck window N:** proposed 60 days.
4. **Layer 4 default:** titles-only, as proposed, or add the consent option.
5. **Commerce:** whether products appear on the path at all in v1 (proposed: Explore only, collapsed).
6. **BAA:** whether to pursue it now for Layer 5.
