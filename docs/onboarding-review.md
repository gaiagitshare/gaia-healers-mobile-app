# Visual onboarding review

When a member signs in, the existing exact-email GHL lookup resolves their contact. The app checks the contact before loading the member panel. Completion markers bypass the journey; incomplete members get a visual introduction and resume from saved custom fields. Visitors retain the public app and Assist.

The server supplies the safe UI schema from `staging-proxy/gaia-onboarding.js`. Both the full-screen journey and embedded Assist cards use the same renderer, branch rules, and `/api/assist/onboarding` endpoint. Clicking Continue saves directly without an AI call. Voice retains `save_onboarding_step`; text retains the existing hidden markers and streaming filter. All paths now write the same GHL fields.

## Corrected mappings and behavior

- Resolve all 16 existing field IDs by exact field key from live location metadata. The published survey corrects the supplied Client Needs field key; see the GHL verification below.
- Five formerly single-select steps now allow multiple selections. Canonical business, infrastructure, and Other labels match the correction. Primary interests and the clinic typo have explicit display-to-storage mappings.
- Reject unknown steps, unsupported selections, inactive branches, and premature completion. Normalized/explicit legacy label compatibility remains for conversational answers; arbitrary substring matches cannot save.
- Save custom fields and existing workflow tags, then read back to confirm the answer and every required tag. Failed writes retain the visual selection and expose retry. Contact reads and writes have timeouts.
- Removing a previously selected branch clears its answer fields, verifies the clearing, and preserves workflow tags. **Owner decision for a future change:** whether deselected branches should also remove their historical tags. This PR preserves them as instructed.
- Persist Other Devices in the mapped text-list field (up to six entries); other free text retains the notes path. Final notes remain optional.
- Completion accepts `gaia_app_onboarding_complete`, `gaia_practitioner_form_complete`, or valid historical answers for every required question on the selected path when the app-started marker is absent. New app journeys require the authoritative completion tag. The old three-tag heuristic is removed. Explicit completion tags still bypass the gate if custom-field metadata is temporarily unavailable.
- Completing the visual journey saves final notes, adds and confirms the app completion tag, invalidates cached Assist context, and reveals a deterministic Gaia Path summary. Enter Gaia unlocks the panel without rechecking stale local state.
- No contact information is re-asked; the introduction uses the GHL first name. There is no new phone/address requirement, since the app has no existing mandatory requirement for those fields.
- Same-origin `/api/` responses are excluded from service-worker caching; decorative assets retain the existing cache behavior.

## Review artifacts

[Open the screenshot gallery](../output/playwright/onboarding/index.html). It contains 12 states at each of 360, 390, 430, and 1280 pixels: intro, primary interests with 0/1/3 selected, a question per branch, save failure, resume, completion top/bottom, and embedded Assist. All contacts are synthetic.

The real app was run locally against `scripts/onboarding-preview.mjs`. Browser QA exercised the full branched journey, failed-save retry, completion, reload bypass, cross-device-style resume, historical completion, visitor bypass, and saving through the embedded cards. No horizontal overflow was found. Reduced-motion styles and semantic pressed states are included; background navigation is inert and hidden from assistive technology while gated.

Reproduce the preview:

```sh
node scripts/onboarding-preview.mjs
# Open http://127.0.0.1:4178/home.html?proxy=http://127.0.0.1:4178
```

`scripts/onboarding-browser-qa.js` contains the Playwright CLI `run-code` function used for the screenshots. It runs against the synthetic local server, blocks external requests, and disables service-worker registration for independent scenario resets.

## Validation and remaining release checks

Run `npm test` in `staging-proxy`, and `node --test` for each `tests/*.cjs`. New store and endpoint tests cover fields, branching, resume, completion, failure/retry, voice/text-compatible values, exact contact resolution, ambiguous emails, cross-site protection, and ignored client-supplied contact/tag targets.

Live GHL location metadata and the published survey were checked read-only. All 16 mapped fields already exist; no duplicate fields were created. **No production GHL contact was read or changed.** A dedicated live test contact remains required to verify text-list storage shape, option acceptance, field clearing, and downstream completion/interest workflows. The implementation uses HighLevel’s documented PUT contact custom-field API and existing tag/notes helpers.

A small existing test-path bug was also fixed: `assist-tools-contract.test.js` used URL `.pathname` as a filesystem path, which fails in a checkout whose directory name contains spaces. It now uses `fileURLToPath`.

**Branch and PR only. Do not merge, deploy, or restart production until visual approval and the maintainer’s live GHL check.**

## Guidance and motion pass

See [the second-pass review](assist-guidance-review.md) for shared behavior instructions, verified navigation limits, live model samples, measured voice boundaries and the motion recording. The user prioritized behavior and guidance over further voice optimization.
