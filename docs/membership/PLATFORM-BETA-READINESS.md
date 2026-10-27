# Integrated beta readiness — 27 October 2026

This development branch combines the existing Membership 2.0 stack through
`feat/membership2-plan-access`, the fixes in PR #308, and the existing security
fixes from PRs #287–#290, #292, #294 and #297. It does not merge any PR into main,
turn on production membership, configure a provider, or deploy production.

## Additional fixes

- Explicit partner authorization refusal purges cached recommendations and the
  member-token cache. Stale recommendations remain an outage fallback only;
  401/403/404/410 and structured link/authorization errors fail closed.
- The beta is versioned in `beta/`, with a synthetic course fixture and CI.
  Real paid-course sources, learner records, credentials and workspace files
  are excluded. Its catalog is checked against the membership service catalog.
- Expired subscriptions/grace periods cannot expose paid benefits through app
  read models. Beta course access uses explicit workspace-scoped fixture grants;
  the real Academy's GHL/manual-grant authorization remains unchanged.
- Each workspace has a distinct stable member identity. Profile changes, course
  progress and membership state are shared across native beta pages and app APIs.
- Native videos save and resume position; lesson completion is separate.
  Embedded providers do not currently expose their position to this runtime.
- Personal Path uses the production rule engine with workspace course progress,
  persists dismissals, and refuses self-certified course/booking completion.
- Tablet icon navigation has accessible names; mobile controls and focus states
  are clearer; lesson navigation no longer hides later lessons sideways.

## Evidence from this run

| Verification | Result |
| --- | --- |
| Membership service, throwaway PostgreSQL | 260 passed, 0 failed, 0 skipped |
| Proxy suite, external HTTP blocked | 1,221 passed, 0 failed, 8 skipped |
| Frontend suite | 205 passed, 0 failed, 0 skipped |
| Beta unit/contract suite | 92 passed, 0 failed, 0 skipped |
| Beta security checks | 243/243 |
| Existing visitor browser journey | 48/48 |
| Existing learning browser journey | 59/59 |
| Existing sandbox browser journeys | 140/140 |
| New consistency browser checks, 1440/768/390 | 105/105 |
| Real original videos | 2/2 played; 7 provider requests, cap 8 |
| Frontend-only Pages build | 106 files; 142 local references checked |
| Public HTTPS checks | 52 passed, 0 failed, 1 existing server-version warning |

Proxy skips: seven live Assist checks require deployment credentials, and one
published-survey mapping check is conditional. They are not counted as passes.
Original video checks sampled the GHL CDN and Google storage; they do not prove
all 121 lessons or YouTube/Vimeo playback. No real Stripe, GHL mutation or paid AI
request was made. Event Manager signing/secret regressions and Python parsing
also passed against temporary databases; its frontend builds with existing lint
warnings. The live Event Manager was not changed.

## Provider status and release gates

| System | Implemented / internally verified | Current external boundary |
| --- | --- | --- |
| Practitioner OAuth/MCP | Built and proven against real Gaia Practitioners staging on 2–6 Oct 2026 (OAuth connect, token refresh, profile-based verification, MCP tools, member link and readings, approved recommendations); state/device/identity, refresh, revocation and role checks also tested with local mocks. 27 Oct: the live deployment's staging credentials and an existing connection are valid (OAuth metadata 200, unauthenticated MCP 401, stored token unexpired) | Every MCP call currently answers -32001 until the practitioner accepts the AI data-sharing terms in their Gaia Practitioners dashboard (MCP Connection); Gaia now reports that as its own state. The beta's test proxy has no practitioner credentials (by design). Pending-role policy still needs partner confirmation |
| Member readings | Code redemption, scoped tools, unlink, error and file filters tested | No real client record accessed during this run |
| Approved recommendations | Existing measured `get_my_recommendations` contract, field/link allowlists, cache isolation, privacy and failures tested | Current real-provider verification not performed; production gate remains disabled pending authorization/readiness |
| GHL | Adapter, retry/dead-letter/reconciliation and grant-confirmation tests pass | Benefit-to-offer/group map is empty; workflows, snapshot, SSO and provider setup require configuration/confirmed contracts |
| Stripe | Signature verification, replay/order, ledger, failure/recovery, plan changes and refund tests pass | No configured test credential; no real sandbox call; Connect seller/refund/dispute topology remains a decision gate |
| Academy | Grant authorization and beta progress/playback tested; two real MP4 samples played | Source has empty/unmapped courses and missing proposal specialties; embeds need normal-browser acceptance |
| Assist / Personal Path | Context, privacy, ownership, approved-source separation and rule engine tested offline | Paid-provider behavior is not claimed as verified; sensitive scan narration stays disabled |
| Wallet / memberships | PostgreSQL ledger/state machine and local beta journeys pass | The beta's payment/provider fixtures are not production settlement or DB reconciliation evidence |
| Legacy migration | Opt-in migration and duplicate-billing safeguards tested with fictional identities | Real cohort overlap, individual offers and communications require owner/provider work; no real rows changed |

The beta workspace is the single source for its native pages and projected app
APIs. It is deliberately isolated from the Membership 2.0 service's seeded demo
accounts and is **not** the production relational store. The browser chooser's
fixed tier demos remain read-only previews. Do not interpret a passing fixture
journey as a completed external provisioning, payment or identity rollout.

Specification decisions 5–9 and 12 still need their respective owner/provider
inputs. Coin pack prices remain indicative. Real grant mappings must be confirmed;
a plan label must never substitute for a confirmed production course grant.

## Release recommendation

**Conditional GO for fictional management/staff beta testing. NO-GO for production
or a claim of fully verified real-provider integration.** Resolve provider access,
commercial decisions, content and operational/approval gates, then rerun bounded
staging acceptance before requesting production authorization. Keep feature flags
fail closed. Use the existing rollback runbook, and review the combined branch
alongside the original stacked PRs before deciding a merge strategy.
