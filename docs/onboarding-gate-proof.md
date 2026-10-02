# PR #180 mandatory onboarding gate proof

Review branch only. No production app deployment, merge or service restart. Two clearly marked QA contacts with reserved `@example.invalid` emails were created and modified in the live GHL location; customer contacts were not modified. An existing-contact sample was read only and only aggregate counts were retained.

## Before: b5b15e1

`gaia-ui.js` initialized authentication asynchronously, then initialized the app router immediately. `initAppShellNavigation()` called `navigate()` / `showView()` for the requested query-string/hash route without checking onboarding. Successful magic-link consumption, embedded claim or session restoration dispatched `gaia:auth`; `gaia-journey.js` then fetched `/api/assist/onboarding` and put an inert overlay over the already active shell. `home.html` also had Today active in its initial HTML. This blocked ordinary clicks after the overlay appeared, but allowed dashboard activation before the GHL response. Member and Academy APIs required a signed session without onboarding eligibility. Thus the original PR did not meet the invariant.

Direct `home.html?view=...`, legacy redirect pages, bookmarks, refresh, new tabs and browser history all entered that same unguarded router. The old local done flag came from a confirmed server answer, but it was only a presentation flag. An Assist window was exempt from the background inert overlay and still had normal context/actions. GHL failures showed a journey recovery overlay, but the underlying route remained active.

## After: authenticated bootstrap and centralized guard

1. Initial HTML hides `#gaia-app-shell` and has no active screen. A local Gaia preparation state appears before authentication resolves. It does not depend on storage or third-party assets.
2. `/api/auth/session` validates the signed cookie and checks the actual matching GHL contact through `memberOnboardingGuard.check(..., true)`. It returns `onboardingStatus: complete | incomplete | unavailable` alongside authentication. Magic-link/embedded session creation also proceeds through the subsequent mandatory profile check.
3. `gaia-app-guard.js` tracks `authenticating → checking_profile → onboarding_required | ready | unavailable`. `gaia:auth` cannot directly grant authenticated dashboard access. A failed session lookup remains unavailable instead of becoming a signed-out visitor.
4. `gaia-journey.js` requests the fresh authenticated `/api/assist/onboarding` profile. Only the server's complete result allows `ready`; incomplete shows the journey and unavailable shows retry/logout. The shell stays hidden and inert. Actual app routes are `home.html?view=today|academy|community|events|store|profile|wellness|bookings|inbox|directory`; legacy `academy.html`, `community.html`, `profile.html` and `biowell.html` redirect to this shell. There is no standalone `/assist` dashboard route; Assist is an embedded panel.
5. `showView()` refuses to activate any screen while the guard is unresolved/incomplete/unavailable. Initial routing, all internal navigation, mobile navigation through the shared router, direct links, and `popstate` use this same function. Eligibility confirmation activates the currently requested route. BFCache restoration rechecks eligibility. New tabs and refreshed pages start unresolved again.
6. The server centrally enforces onboarding for `/api/member/*`, `/api/academy/*`, `/api/wellness/*` and normal Assist lookup/memory/interest endpoints. Incomplete returns `403 onboarding_required`; an unresolvable profile returns `503 onboarding_unavailable`. Signed-session complete results may be memoized for ten minutes for internal API calls. Session bootstrap and profile GET always force a fresh GHL check. Logout and onboarding writes invalidate eligibility; no client flag or request body can create server eligibility.
7. During onboarding, Assist receives only required-journey context with `onboarding_required=true`, saved answers and the next step. It does not receive normal member purchases/access/context. Chat, structured saves and voice onboarding remain usable; normal voice actions, navigation shortcuts and portal launching are blocked. Normal Assist resumes after verified completion.
8. Final Continue sends a validated per-step save. The store validates the required branch-aware path and mapped tags, writes and reads back completion, then returns `complete:true`. The renderer shows the reveal while the member shell stays locked. Enter Gaia unlocks only when that verified result has set `state.done`. A failed final save retains the answer and never unlocks.

Visitors retain the application's existing public experience. Public catalog/directory data and independently hosted external portals are not claimed to be protected by the Gaia member guard. Authenticated member APIs and the normal member shell are guarded.

## Exact completion resolver and legacy proof

`staging-proxy/gaia-onboarding.js:onboardingState(tags, answers)` establishes completion by:

- `gaia_app_onboarding_complete`; or
- existing `gaia_practitioner_form_complete`; or
- a fully valid legacy field path when `gaia_app_onboarding_started` is absent.

The legacy field rule requires valid Primary Interests and these common fields: `why_join`, `business_length`, `invest_timing`, `growth_needs`, `devices_owned`, `client_needs`, `can_offer`, `want_receive`. Living Beings requires `living_beings_who` and `living_beings_support`; Environment requires `environment_areas` and `environment_spaces`; Water requires `water`. Only selected branches count. Every value must validate against the authoritative schema, with explicit storage-label compatibility. Final notes and additional Other text are optional. Three interest tags never constitute proof.

An app-started record without a completion marker stays incomplete even if all fields were written. Required mapped tags are checked on resume and final validation, so a partial field/tag write is not skipped. This started marker is written before the first app field mutation.

The live read-only sample contained 98 non-QA contacts: zero app completion markers, one `gaia_practitioner_form_complete`, zero additional full valid legacy field paths, and 97 partial/unproven records. The form-marked record had 13 custom fields and 11 valid fields of its 14-field current path. Its explicit historical marker is therefore essential: requiring all current fields would wrongly re-onboard this older member. No additional completion marker was observed. This establishes the marker's presence in real data; the GHL workflow configuration and every historical submission were not exhaustively inspected. No ambiguous partial records were marked complete.

On a deterministic legacy complete read, `onboarding-store.js` safely adds the app completion tag and confirms it by contact readback. Failed compatibility backfill is logged and retried on a later fresh check; the established legacy completion still allows entry and never forces repetition. A legacy explicit completion marker also remains sufficient if field metadata is temporarily unavailable.

## Live GHL and actual server evidence

[Actual server/API results](../output/playwright/onboarding/ghl-gate-api-results.json) come from the PR server running on localhost port 8957 in an isolated temporary data directory, with signed QA sessions and the actual GHL API:

| Controlled live contact state | Bootstrap / resume | Protected member API |
|---|---|---:|
| Completed | complete | 200 |
| Empty onboarding fields | incomplete; Primary Interests | 403 |
| Partial answers | incomplete; Living Beings | held |
| Full legacy answers without app completion tag | complete; tag backfill confirmed | eligible |
| Verified final save | complete:true | 200 |

[Store/API readback results](../output/playwright/onboarding/ghl-gate-store-results.json) confirm all three branches, all 16 custom fields, mapped workflow tags, completion and legacy backfill. These live tests found and fixed a real integration problem: Other Devices is a `TEXTBOX_LIST` object keyed by the metadata's six slot IDs. The writer now uses those IDs and the reader respects their order. Empty objects no longer appear as `[object Object]`; a live Other Device answer was saved and confirmed. Client Needs published values were accepted by GHL despite its differing metadata options.

These checks verify persisted GHL fields/tags and the actual application gate. They do not claim delivery or side effects from every downstream CRM automation, or an end-to-end magic-link email delivery test. QA contact identifiers are kept privately on the server for cleanup; no customer identities or credentials appear in committed evidence.

## Automated and browser evidence

New tests cover central path classification, positive-only signed-session memoization, fresh bootstrap overriding cached eligibility, GHL failure, incomplete/partial API denial, completed API entry, legacy backfill and backfill failure, keyed Other Devices values, pending/unavailable browser states and failed session restoration. Existing membership authorization tests now explicitly provide completed GHL profile fixtures; no production test bypass was added.

Full suite: **565 backend passed, 15 optional integration tests skipped; 92 frontend passed.** Dedicated live GHL checks above ran separately and passed. The complete responsive onboarding flow also passed at 360, 390, 430 and 1280 pixels.

[Browser gate results](../output/playwright/onboarding/gate-browser-results.json) cover pending authentication without a dashboard flash, restored sessions in a new tab, direct Today/Academy/Community/Events/Store/Profile/Energy/Bookings/Inbox/Directory links, legacy HTML redirect pages, refresh, spoofed localStorage, internal navigation, back/forward, existing completion, partial resume, onboarding Assist, GHL failure, final-save failure and confirmed unlock. Browser scenarios use synthetic authenticated/GHL fixtures with the actual frontend; live contact state and API enforcement are separately verified above.

[Gate video](../output/playwright/onboarding/gate-motion/gaia-gate.mp4) shows completed session → dashboard, new session → onboarding before dashboard, partial session → resume, direct Academy entry held in onboarding, and final verified completion → requested dashboard. [Gallery](../output/playwright/onboarding/index.html) includes the new gate screenshots.

Reproduce with `node scripts/onboarding-preview.mjs` and Playwright CLI `run-code` using `scripts/onboarding-gate-browser-qa.js`. `scripts/onboarding-gate-record.js` records the five required scenes. The live checks used private provider configuration, reserved-domain QA contacts and an isolated local server; production was not restarted.
