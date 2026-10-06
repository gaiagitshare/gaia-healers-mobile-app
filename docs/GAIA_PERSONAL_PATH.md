# Gaia Personal Path — design (revision 2)

Status: **architecture approved in principle; the engine is not built.** This
revision applies the owner's corrections of 6 Oct 2026.

Companion documents:
- `READINGS_CLAIMS_INVENTORY.md`: every reading claim, classified A–D, and
  what replaced it.
- `BIOWELL_INTERPRETATION_SOURCE_REQUIREMENTS.md`: what we have, and the
  exact questions for Bio-Well and the partner.

The loop:

> measure → understand → recommend → act → learn → check progress → adjust

Bio-Well reading + member context → descriptive facts → **approved**
catalogue → prioritised Personal Path → Gaia helps the member open and finish
items → progress → updated path.

Ground rules:
- **No interpretation without a source.** No rule may say or imply what a
  value means until its source is recorded and the rule is approved.
- **Commerce is never required.** The Path must work with zero product rules.

---

## 1. Descriptive vs interpretive (applies to every surface)

| Allowed without an interpretation source | Needs a recorded source **and** approval |
|---|---|
| Scan date, age of the scan | normal / abnormal, healthy / unhealthy |
| Member's own averages (3-scan, 90-day) | comfortable, concerning, good, bad, better, worse |
| Signed difference from the member's own average or earlier scans | balanced / imbalanced, when we compute it ourselves |
| Highest and lowest value in a scan, as displayed | what a centre means physically or emotionally |
| Partner/Bio-Well flags, **attributed** to whoever raised them | what a numerical range means |
| Before/after arithmetic | what someone should do *because of* a value |

Enforced by `tests/readings-guide.test.cjs` (UI) and
`staging-proxy/test/member-link.test.js` (server summary).

---

## 2. Architecture

```
partner MCP ──► memberReadings()                      exists; values never stored
                    │
                    ▼
              pathFacts(readings)                     descriptive only: scan_age_days, has_new_reading,
                    │                                 has_readings, flags_present (count), …
                    │                                 no thresholds beyond Gaia product policy (recheck days)
 member context ────┤  (grants, course progress, bookings, prefs, onboarding interests)
                    ▼
              matchRules(catalogue)                   serves ONLY status=approved rules
                    ▼
              buildPath()                             stages, ranking, free-first, locks, done/dismissed
                    ▼
              Path { items[≤5] } ──► My readings · Today · avatar
                    │
                    ▼
              Assist view: { id, title, stage, state, action }     nothing else (section 6)
```

- **Where it runs:** on the proxy, inside the existing authenticated
  member request. The readings are already fetched there and are never
  written to disk.
- **What it stores:** only item ids, states, dates and the catalogue version
  that produced them.
- **Rules are data** (`data/path-catalogue.json`), so code holds no mapping.
- **Fact names:** the engine evaluates descriptive facts. A future
  interpretive fact (for example "stress above own baseline") can be added
  only with a `biowell_official` source entry (section 3), and rules using it
  still need approval.

---

## 3. Catalogue: source and approval are separate

### 3a. Rule record

```jsonc
{
  "id": "P-RECHECK",                  // stable public id; what Gaia may see
  "version": 3,                        // every edit creates a new version
  "title": "Consider a new Bio-Well scan",   // public, member-facing
  "trigger": { "fact": "scan_age_days", "op": ">=", "value": { "policy": "recheck_after_days" } },
  "stage": "recheck",                  // start_now | this_week | learn | work_with | explore | recheck
  "priority": 50,
  "action": { "kind": "booking", "id": "biowell-scan", "fallback": { "kind": "directory", "intent": "scan" } },
  "free_alternative": null,
  "reason_public": "Your latest scan was 60+ days ago. A new scan may give you a more current point of comparison.",
  "kind": "service",                   // practice | learning | service | community | event | product
  "exclusions": [],
  "sources": [ { "type": "business_rule", "ref": "Gaia product policy, recheck window", "doc_version": "2026-10-06" } ],
  "status": "approved",                // draft | in_review | approved | retired
  "approval": { "by": "contact:<reviewer id>", "role": "path_reviewer", "at": "2026-10-07T…", "version": 3 },
  "created_by": "contact:<author id>"
}
```

**Source types:**
- `biowell_official`: needs document, version and date.
- `gaia_practitioner`: needs practitioner id and the item they approved.
- `gaia_content`: Gaia's own material, such as a course or practice.
- `business_rule`: Gaia product policy.

A rule may carry several source entries.

### 3b. Rules the engine enforces

1. **Approval gates serving.** Only `status = approved` is served, and only
   when `approval.version == version`. Editing an approved rule creates a new
   draft version. The previous approved version keeps serving until the new
   one is approved or the rule is retired.
2. **Sources match triggers.** A rule whose trigger uses a reading-derived
   interpretive fact must carry a `biowell_official` source. Without one it
   cannot be approved; the approval call refuses it.
3. **Products need content approval.** `kind: product` additionally needs a
   `gaia_content` or `biowell_official` source naming the mapping (section 7).
4. **Two people.** The author cannot approve their own version.
5. **Audit trail:** `data/path-catalogue-audit.jsonl`, append-only. Each line
   is `{ at, actor, role, action: create|edit|submit|approve|reject|retire, id, version, hash }`.
   The approval screen shows the diff between versions.

### 3c. The reviewer role

- **No hard-coded reviewer.** Reviewers are signed-in Gaia members whose
  contact id holds the `path_reviewer` role. The role list is kept in the
  Control Center and audited like the rules.
- **Why not the admin password:** the Control Center today uses one shared
  admin password, which cannot identify *who* approved. Approval therefore
  goes through the reviewer's own member sign-in.
- **Bootstrapping:** the first reviewers are added by the owner.

---

## 4. Ranking

1. **Stages in order:** Start now → This week → Learn → Work with someone →
   Explore → Recheck.
2. **Size:** one item per stage, at most five in all. More items sit behind
   "See more".
3. **Within a stage:** practitioner-approved items first (once verifiable,
   section 8), then free before paid, owned before locked, shorter before longer.
4. **Products:** only in Explore, never the first item, and never on a path
   without a free item (section 7).
5. **Done and dismissed items:**
   - Done: the item is replaced by the rule's continuation, if one exists.
   - Dismissed: hidden for 30 days (configurable).
   - New scan: the path is regenerated and dismissals are kept.
6. **Recheck** stays in its stage, with the policy wording in section 5.
7. **Never:** diagnosis, treatment or cure words, urgency, scarcity, or
   ranking by price.

---

## 5. Recheck window

- **What it is:** an **initial Gaia product policy** of 60 days.
- **Where it lives:** configured on the server (`GAIA_SCAN_RECHECK_DAYS`,
  bounded to 7–730). It is sent to the app with the link status and the
  readings, and is not hard-coded in the UI. *(Built in #276.)*
- **Wording:** "Your latest scan was 60+ days ago. A new scan may give you a
  more current point of comparison."
- **Never:** "stale", "expired" or "out of date".
- **Bio-Well:** we do not claim Bio-Well defines an interval. Q-T4 asks
  whether it does.

---

## 6. What Gaia sees

| Gaia receives (per item) | Gaia never receives |
|---|---|
| `id` (e.g. `P-RECHECK`) | raw reading values |
| public `title` | facts or signals computed from readings |
| `stage` | trigger, thresholds, rule logic |
| state: `suggested`, `started`, `done`, `dismissed` | the private reason derived from values |
| `action` (deep link Gaia may open) | practitioner identity, unless independently authorised |

- **Fact line** (about 30 tokens):
  `PERSONAL PATH: P-RECHECK "Consider a new Bio-Well scan" (recheck, suggested); P-CONT-12 "Continue: Bio-Well Orientation" (learn, started).`
- **Tool:** `open_path_item(id)` opens the item's action. **"Why this?"**
  opens the item's on-screen explanation; Gaia does not explain it herself.
- **No new protected data:** Gaia's prompt already knows whether readings
  are shared; the fact line adds nothing reading-derived beyond the public
  title.
- **Unchanged:** `GAIA_SCAN_NARRATION`, the You-page promise, and the
  existing reading rules in the prompt.

---

## 7. Products

**Allowed in v1 only if every one of these holds:**
- **Placement:** only in Explore; never the first item; a free option shown
  first where one exists.
- **Approval:** an approved mapping with a recorded source and reviewer. The
  existing `CHAKRA_COLOUR` shop search does not qualify (inventory item 17).
- **No effect claims:** nothing like "this product will improve / treat /
  fix your reading", and no urgency or scarcity.
- **Labelled clearly:** education or wellness products are distinguished from
  practitioner services.

**With no approved mappings at launch, v1 ships without products.** Nothing
in the engine depends on commerce.

---

## 8. Membership

- **Not a recommendation:** there is never a rule like "high stress →
  upgrade".
- **Locked items:** when a recommended resource needs more access, the
  recommendation shows first, then **"This is included with Silver."** with
  [See Silver] and [Show me a free option].
- **Lock wording comes from real access:** course access is per grant, so
  "included with Silver" is said only when the policy actually includes it;
  otherwise "Needs course access".

---

## 9. Personal Path v1: only rules defensible now

| Id | Trigger (non-interpretive) | Stage | Action | Source | Ready |
|---|---|---|---|---|---|
| P-NEW | A reading newer than the last one opened | start_now | Open reading + walk-through | business_rule | **yes** |
| P-RECHECK | Latest scan ≥ recheck window | recheck | Book a scan (linked practitioner if bookable, else directory `intent:'scan'`) | business_rule (Gaia policy) | **yes** |
| P-SHARE | Signed in, readings not shared | start_now | How sharing works / book a scan | business_rule | **yes** |
| P-PREP | Session with their practitioner within 7 days | this_week | "Prepare for your session": open readings; note questions | business_rule | **yes** |
| P-CONT | A course started and not finished (academy progress) | learn | Continue at the saved lesson | business_rule | **yes** |
| P-PRAC-SVC | Practitioner explicitly recommends a service or resource to this client (new tick-box in Practice) | work_with | View service / book | gaia_practitioner | **build first** (practitioner UI) |
| P-GUIDE | Practitioner guide available, consent on | start_now | Open guide | gaia_practitioner | **blocked**: the partner says guides are AI-generated; need Q-P3 |
| P-INTEREST | Onboarding interest (member-stated) → course in the same category | learn | Open course | gaia_content | needs owner sign-off of the mapping |

**Not activated:** R6–R10 from revision 1 (stress vs own average,
energy vs own average, centre-based practices, centre-based products,
interest tagging). Each waits for its Bio-Well source and/or Gaia expert
approval.

---

## 10. Data quality (traced to sources)

| Finding | Authoritative source | Action |
|---|---|---|
| Broken "Learn more" links: `wellness&tab=biowell` (Solar Plexus, Heart), `community&tab=learning` (Throat) | App routes (`gaia-ui.js`): neither tab exists | **Fixed in #276:** they point to the Academy, as Root and Third Eye already did. No per-centre content target exists to point at. |
| Ask-Gaia chakra prompts asked her to interpret scans she cannot see | `GAIA_SCAN_NARRATION` off; You-page promise | **Fixed in #276:** "What practices does the app have for the {centre} centre?" |
| "Crystal Quartz Tachyon Energy Chakra Set" shown as a Silver **course** | GHL: it is in the GHL offer list that `courses.json` syncs (`source: ghl-workflow`), alongside "Bio-Well 3.0 Device … + Certification" (a device bundle). Its description is a physical product's. Silver comes from our price/title guess (`server.js:735-737`, `:891-893`), not GHL. | **Prepared, not applied:** the authoritative fix is in GHL (remove it from course offers, or mark it as a product). If GHL keeps it, add an explicit `not_a_course` list in the sync, owned by the owner. Not guessed here. |
| Two chakra challenges | **9-Week Chakra Challenge**: a real Gaia programme in the GHL Academy (manifest `086ab8c3…`), run Feb–Apr 2026: week 1 intro, weeks 2–8 Root→Crown (Brow), week 9 review. **8-Week Chakra Challenge**: an app feature written by a developer (commit 1d2fff3, 2026-07-05) with an invented "Integration" week. | **Not guessed.** The GHL programme is the authoritative Gaia programme. Owner decision: retire the app challenge, rename it to make clear it is a self-guided practice, or align it to the 9-week programme. |
| Empty product tags | Shopify: `tags` is empty on almost every product in `data/store-catalog.json` | Prepared: a tag vocabulary for the owner to apply in Shopify (`centre:root…crown`, `type:spray|oil|crystal|device|book`, `use:practice|education`). Only *approved* tags can be used by Path rules. |
| Course `accessLevel` guessed from price and title | `server.js:735-737`, `:891-893` | Display only; real access is per grant. Path lock wording uses grants and policy (section 8). |
| Readings units: `J ×10⁻²` (UI) vs "joules ×100" (doc); disbalance "%" assumed; alignment explained but never shown | No source | "%" and the alignment wording **removed in #276**; units are question Q-E2. |

---

## 11. Analytics (no reading data)

**Pattern:** the existing onboarding funnel (`onboarding-funnel.js`). That
means a hashed contact id (`sha256('gaia-path:' + id)`, 16 hex characters),
an event key, ids and timestamps, kept in `data/path-events.jsonl` and
rotated after 180 days.

**Every event is `{ t, who_hash, event, item_id?, stage?, rule_version? }`.
Never** values, facts, signals, triggers, reasons, practitioner identity,
product prices or free text.

| Event | Extra fields |
|---|---|
| `path_viewed` | `surface` (readings / today / avatar), `items` (count) |
| `recommendation_opened` | `item_id`, `stage` |
| `recommendation_completed` | `item_id`, `stage`, `via` (course_progress / tool / booking / manual) |
| `recommendation_dismissed` | `item_id`, `stage` |
| `free_alternative_selected` | `item_id` |
| `membership_required_shown` | `item_id`, `level` (public plan key) |
| `membership_opened` | `item_id` |
| `scan_rebook_opened` | `item_id` (`P-RECHECK`), `route` (practitioner / directory) |

**Questions this answers, without readings:**
- **Did the path help?** Completion rate per item; return within 7 and 30 days.
- **Did they follow it?** Opened → completed per stage.
- **Did they book another scan?** `scan_rebook_opened`, joined with a booking
  confirmation where the booking system reports one.
- **Did they start learning?** `recommendation_opened` for learn items,
  joined with academy progress.
- **Did it lead to membership or product interest?** `membership_required_shown`
  → `membership_opened`, and later checkout events (counts only).

Reports show aggregates only, and are suppressed below 5 members per cell.

---

## 12. Exact UX (v1)

My readings, under "In short":

```
YOUR GAIA PATH
START NOW        Open your new reading · walk-through                 [Open]   ⋯
THIS WEEK        Prepare for your session with Sam Rivera · Thu 10:00  [Open]   ⋯
LEARN            Continue: Bio-Well Orientation · lesson 4 of 13       [Continue] ⋯
                 (locked case) This is included with Silver.  [See Silver] [Show me a free option]
RECHECK          Your latest scan was 60+ days ago. A new scan may give you
                 a more current point of comparison.                   [Book a scan] ⋯
                 Wellness suggestions, not a diagnosis.  ⋯ = Done · Not now · Why this?
```

- **"Why this?"** shows `reason_public` and the source label ("Gaia
  policy", "From Sam Rivera").
- **Today:** a single row, "Next on your path", with the first item.
- **Avatar:** the chip "What's next on my path?" points at the first item.
  After completion: "Done. Next on your path: …".

---

## 13. Shipped in #276 (no thresholds, no AI)

- **Walk-through:** "What do these mean?" (avatar chip and the Home button)
  walks through the member's own card. All seven steps are descriptive per
  section 1, and the last step sends meaning to the practitioner.
- **Avatar placement:** beside, below or above the target, under the visible
  top bar and above the tab bar. On a phone the target is lifted under the
  top bar. If there is still no room, Gaia goes compact (bubble only); she
  waits for scrolling to settle.
  - **Verified:** 28 steps (390 px and 1440 px, recent and 4-month-old
    readings): 0% overlap with the ringed section, never under the top bar
    or over the tab bar.
- **Readings card:** neutral copy (inventory items 1–12 and 16).
- **Recheck policy:** configurable on the server.
- **Chakra data:** broken links and interpretive prompts fixed.

## 14. What ships when

- **A. Ship now (no outside approval):**
  - everything in #276;
  - the Path framework: catalogue with source/approval/audit, reviewer
    role, engine, path store, UI, analytics;
  - v1 rules P-NEW, P-RECHECK, P-SHARE, P-PREP and P-CONT, each approved
    in-app by a reviewer as `business_rule`;
  - the practitioner "recommend to client" tick-box (P-PRAC-SVC).
- **B. Needs Bio-Well documentation:** definitions, units, ranges, centre
  interpretation, disbalance, variability, before/after and rescan wording
  (Q-E/S/C/B/T/L). Rules on stress/energy versus own average or on centres
  (old R6–R9).
- **C. Needs Gaia expert or owner approval:**
  - every content and product mapping, including `CHAKRA_COLOUR` and centre
    practices;
  - chakra practice copy;
  - the interest → course mapping (P-INTEREST);
  - 9- versus 8-week challenge;
  - the crystal set in GHL;
  - Shopify tags;
  - the practitioner-view display scales.
- **Needs the partner:** P-GUIDE (Q-P3), and flag attribution (Q-P1).
- **D. Needs the BAA / AI path:**
  - Gaia discussing or comparing actual values;
  - explaining *why* a reading-based item was chosen in conversation;
  - any `GAIA_SCAN_NARRATION` change;
  - member opt-in for reason text to reach the model.
