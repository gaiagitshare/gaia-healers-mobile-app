# Gaia Healers redesign QA

Status: Passed for production deployment on 2026-07-21.

## Grounding

- Selected direction: “Living Network” event-led mobile experience.
- Reference: `/Users/ba2ki-goldvest/.codex/generated_images/019f81e3-d8c4-7f22-a881-c9bef56bea12/exec-e08033a0-7355-40a1-a709-42825eb3d565.png`
- Browser: the user’s Chrome session.
- QA viewport: 390 × 844 CSS pixels (iPhone-class portrait).

## Comparison history

1. Initial build: `work/gaia-qa/05-home-final.png`
   - Event hero was visually strong but too tall, delaying Today, Academy, and member access.
2. Side-by-side comparison: `work/gaia-qa/06-reference-vs-build.png`
   - Confirmed the selected palette, typography, imagery, navigation, and event-first hierarchy.
   - Identified the oversized hero as the principal mismatch.
3. Final iteration: `work/gaia-qa/07-home-iteration2.png`
   - Reduced the mobile event hero and type scale.
   - Today, Academy, and the beginning of member access now appear in the first viewport.
4. Final side-by-side: `work/gaia-qa/08-reference-vs-iteration2.png`
   - Passed: visual hierarchy, spacing, card radii, contrast, bottom navigation, safe-area behavior, and selected direction are coherent.

## Functional checks

- Menu opens as a native sheet and exposes every main destination.
- Sign in opens a native email magic-link sheet; no blank education portal page.
- Membership opens in-app with sign-in, Gaia Assist, and discovery-call paths.
- Academy cards respond and route locked access to Membership.
- Community and Profile signed-out states open native sign in.
- Store tabs and live product catalog render at mobile width.
- Chakra guide auto-advances through all seven centres, updates the purpose-specific shop link, and pauses after a manual selection.
- Event action uses the exact live event URL inside the app when an event is published.
- Every route starts at the top instead of restoring the previous screen’s scroll position on mobile Safari.

## Notes

- The local build cannot read the production API because localhost is intentionally excluded from the production CORS allowlist. Production-origin validation is completed after deployment.
- The event hero intentionally shows an honest “details coming soon” state when no live event is published; it never fabricates a date or destination.
