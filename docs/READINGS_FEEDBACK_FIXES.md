# Reading UI feedback

- Link codes have a Copy code button. Clipboard failures fall back to the browser's copy command; failure never claims success. Neither path stores a code.
- Sharing rows wrap practitioner names and dates instead of clipping on phones.
- The summary shows energy/stress bars for the latest three dated scans, preserving precision until display. The longer explanation is expandable. Latest-scan gauges and history charts remain separate, so an average is not mistaken for a single reading.
- Missing/non-finite values are not zero-filled. Three latest valid dated scan rows must each contain both metrics to show an average; otherwise the UI explains why it cannot show one. Zero is a valid value. Averaging is arithmetic, not a claim about clinical reliability.
- Member scan selectors preserve scan IDs and full timestamps. Two different scans on the same day can be compared. The member history still contains the newest 24 available points.
- Practice comparison optionally fetches `get_customer_scan` through the existing authorized MCP reader, projects only dated energy/stress history (newest 200), and lets the practitioner choose two scans. No undocumented date arguments are sent to the partner. The displayed changes do not establish a therapy's effect.
- Files failures show a retry action, never a false empty list. Late file responses cannot overwrite a different client's screen.

## File/guide AI request

Update 5 Oct 2026 (measured with `tools/list`, see STAGING-PROXY.md): the
partner has no file-content tool, but it does have
`get_customer_recommendations` — the AI-generated guides/scripts per customer,
as text. The guides half of the request is therefore buildable. A member-side
consent for it, `guides_to_assist`, is now recorded in "Your data and sharing"
(off by default) ahead of any build; the files half stays impossible.

The implemented integration and recorded partner evidence expose `get_customer_files` as a listing. No file-content retrieval contract is established here. We have not proven that the partner has no additional private endpoints; the current public docs shell does not establish one. Do not invent download URLs, scrape another session, or imply file contents have been read.

Member sharing consent currently covers displaying readings and shared documents, not sending psychological reports to a model for personalization. Existing privacy promises and scan model redaction remain intact. Implementing that request requires a partner-supported, client-scoped file-content API, explicit member permission for that separate use, and the appropriate covered model/data policy. No configuration or consent rules were changed in this PR.

## Verification

`node scripts/test-readings-ui.mjs` with PLAYWRIGHT_MODULE set exercises the real app shell and branch static assets with clearly synthetic API responses at 390, 768 and 1440px. No real account is impersonated and no live reading/model calls are made. It checks clipboard/fallback, same-day selection, invalid same-scan comparison, sharing wrap, and file failure states. `scripts/test-intro-tour.mjs` checks the existing navigation/tour. Backend tests cover normalization, averaging, model redaction, and existing authoritative practitioner authorization.
