# Approved partner recommendations → Personal Path

Gaia Practitioners analyses scans and generates recommendations; the
practitioner approves or rejects them there. Gaia Healers shows only the
**approved** ones, as Personal Path steps, and coaches the member through them.
**Display only: no partner recommendation content ever reaches Gaia's AI
provider.** Screenshots are in `docs/ui-proof/partner-recommendations/`.

## 1. Partner schema (measured on staging, 6 Oct 2026)

Member tool `get_my_recommendations` (member MCP, one-member token). The
partner's own description:

> "Recommendations the member's practitioner has approved: ranked
> products/services with a client-safe summary and a link to view/buy or
> book. Pending or rejected ones are never returned, and no scan values are
> included."

- **Input:** `{}`. There are no arguments; the token scopes it to the member.
- **Output:**
  ```
  { count, recommendations: [ { recommendation_id: number, approval_status: "approved", approved_at: string|null,
      created_at: string, practitioner: { id, name },
      items: [ { rank, type: "product"|"service", id, title, summary: string|null, action: { label, url } } ] } ] }
  ```
- **Links seen:** `https://staging.gaiapractitioners.com/shop?product=<id>&buy=1`
  and `/shop?service=<id>`.
- **One linked member on staging:** 1 recommendation with 5 items (4 products,
  1 service). `summary` and `approved_at` were null on these items. The
  partner says the summary exists for new approvals.

## 2. Authorization

| Check | How |
|---|---|
| Who | Only the **session** member, server-side. The path route passes the session member and ignores any id in the query. The tool takes no customer or client id. |
| Linked | No partner call unless that member has a confirmed readings link. |
| Partner-side scoping | The partner mints a one-member token for our `gaiaMemberId`. A token request for an unlinked member is refused ("Member is not linked", verified on staging). |
| Cross-member | Tested: member A never receives member B's items. Analytics and events are keyed by the session member. |

## 3. Gate (fail-closed): retrieval/display only

`GAIA_PARTNER_RECS`:

| Value | Effect |
|---|---|
| `off` (default) | Never called. |
| `staging` | Only when `GAIA_DEPLOYMENT=staging` **and** the partner environment is staging. **The production server never sets `GAIA_DEPLOYMENT=staging`, so production members can never get staging partner data.** |
| `production` | Only when the partner environment is production **and** `GAIA_PARTNER_BAA_CONFIRMED="YYYY-MM-DD: reference"` is set. This is the BAA gate. |
| anything else | Off. |

**What is gone:**
- **`GAIA_PARTNER_AI_RECOMMENDATIONS` no longer exists.** There is no flag
  that sends partner content to an AI.
- **`GAIA_SCAN_NARRATION` is untouched (off)**, as the separate "Gaia AI scan
  access" capability.

The server logs the gate at boot, e.g. `[Gaia Path] partner approved
recommendations: off (off)`.

## 4. Fields kept vs discarded (`partner-recs.js shapeApproved`)

**Kept:**
- recommendation id, approval status (only `approved` passes) and approval
  date, created date;
- practitioner id and name;
- per item: rank, type, item id, title (plain text, ≤120), client-safe
  summary (plain text, ≤300, dropped if it contains a link);
- a **rebuilt** link.

**Discarded before storage:** everything else, including reasoning,
relevance or scores, body systems, scripts, video, scan ids or values, flags,
trends and any unknown field. Tested with planted values.

## 5. URL validation (untrusted input)

- **Accepted:** `https:` only, with the exact host for the environment
  (staging: `staging.gaiapractitioners.com`; production: `gaiapractitioners.com`
  or `www.gaiapractitioners.com`). The path must be exactly `/shop`.
  - A product link may carry only `product=<this item's id>` (plus optional
    `buy=1`).
  - A service link may carry only `service=<this item's id>`.
- **Rejected:** credentials, ports, fragments, other hosts or look-alike
  hosts, extra parameters (redirects), mismatched ids, duplicate parameters,
  `javascript:` or `data:` links, and a staging link in production.
- **Rebuilt:** the link is reconstructed from the validated parts.
- **No safe link means the item is not shown.**
- **In the browser:** the link is re-checked before
  `window.open(url, '_blank', 'noopener,noreferrer')`.

## 6. Personal Path mapping

| Partner item | Path step | Stage | Action | Completion |
|---|---|---|---|---|
| service | "Recommended by your practitioner" · title · client-safe summary (else "Your practitioner recommended this as part of your current wellness plan.") | Start now (with practitioner items) | **Book** ↗ on Gaia Practitioners | `practitioner_booking`: none today. Never "I did this". |
| product | same, with quieter styling | **Also recommended**: always after the steps; **never first**. With no other steps, shown beside "You're caught up". | **Buy** ↗ (or View) | `order`: only an authoritative order record. Opening or buying is not completion. |

- **Provenance:** `source_type: partner_approved`, `review_state: approved`. The
  key is `PR:<recommendation_id>:<type>:<item id>`.
- **De-duplication:** when a manual practitioner recommendation and an
  approved partner item name the **same service of the same practitioner**,
  one step is shown: the partner item, which has the Book link and summary.
  The manual record is kept, not deleted.

## 7. Lifecycle (`approvedForMember`)

- **Fresh:** within 10 minutes, the list comes from the cache (no partner call).
- **Successful read:** it **replaces** the list, so a revoked or
  no-longer-approved item disappears, a changed summary updates, and
  duplicates collapse.
- **Outage or timeout:** the last good list is kept for up to 24 hours, then
  nothing. An outage never erases good data early, and never breaks the rest
  of the path (tested).
- **Unavailable product or service** (no valid link): the item is dropped and
  counted in the log (counts only).

## 8. Gaia

- **Gaia's AI line for a partner item is generic:**
  `[PR] "A recommendation from your practitioner (details on their screen)" (stage, Recommended by your practitioner; action: Book)`.
  No title, summary, link, practitioner, ids or rank.
- **Answers come from the avatar's fixed rules, not a model:**
  - **What's next:** "Your practitioner recommended: {title}. Want to start?" A product is never the next step: with products only, the answer is "You're caught up…".
  - **Why:** "From your practitioner's recommendation: “{client-safe summary}”", or the fixed line when there is no summary.
  - **Book/Buy:** opens the validated link.
- **No Assist tool reads partner recommendations.** `get_my_recommendations`
  is named only in `partner-recs.js` (tested).

## 9. Old guides architecture: removed

- **Code:** `memberGuides`, `shapeGuides`, `guidesForModel`,
  `partnerAiRecommendationsEnabled` (member-link.js), the
  `PRACTITIONER GUIDES` prompt lines and guides cache (server.js), and the
  `guides_to_assist` preference.
- **App:** the "Let Gaia Assist use suggestions" member setting, the
  practitioner "opted in" tags and count.
- **Support:** the guide-reads alert and usage-report counter, and
  `test/member-guides.test.js`.
- **Stored data:** old stored `guides_to_assist` values are simply ignored.

## 10. Tests

- **`test/partner-recs.test.js`** (7 tests):
  - the gate matrix;
  - URL validation (15 hostile cases plus the staging/production split);
  - the field allow-list with planted hidden fields;
  - lifecycle: fresh, replace, revoke, summary change, outage, expiry, zero, unlinked, disabled, wrong deployment;
  - product never first and products alone; de-duplication;
  - the AI boundary, including "the tool can never be an Assist tool".
- **`test/path-routes.test.js`** (+2 tests): session-only scoping, no
  cross-member access, no completion claims, no content in analytics, a
  generic Gaia line, and the outage.
- **`test/practitioner-ai-privacy.test.js`:** the old guides route is gone,
  and no partner recommendation text can reach the prompt or a tool result.
- **Frontend:** `tests/personal-path-ui.test.cjs` covers links, products,
  completion, the why wording, and that the old setting is gone.
- **Staging acceptance** (`tools/partner-recs-qa.mjs`, 3 partner calls): the
  real integration read 5 items, kept 5 and dropped 0, with all links valid;
  the partner refused an unlinked token.

## 11. Turning it on in production (after the partner confirms the BAA)

1. Verify the BAA status with the partner in writing.
2. Run a staging acceptance with `tools/partner-recs-qa.mjs` (staging
   deployment).
3. When the partner's production member tool exists, set
   `GAIA_PARTNER_RECS=production` and
   `GAIA_PARTNER_BAA_CONFIRMED="<date>: <reference>"` on the production
   service, with the partner environment set to production. Restart, then
   smoke-test.
