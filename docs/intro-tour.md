# Intro tour

`gaia-ui.js` owns the sequence, target validation, navigation and cleanup. The avatar replays this same implementation rather than maintaining a second list. The automatic tour remains for first-run visitors on Home; members can replay it through Gaia. Required onboarding takes precedence: no tour runs while the app guard blocks entry.

## Sequence

1. Home button: return to Home.
2. Visitors only: the actual free Energy check entry on Home.
3. Energy screen: the visible Energy check / Horoscope / Chakra match switcher.
4. Members with loaded course grants only: Academy and their available learning.
5. You screen: account/access for members, sign-in and saved progress for visitors.
6. Verified connected practitioners only: the visible Practice tab on You. Both membership and the practitioner status event must agree, and integration availability must not be false. GHL tags never add this tour step.
7. Gaia avatar: shortcuts and suggested next steps.

There are five visitor steps, four to five regular member steps, and five to six connected practitioner steps depending on available courses. Targets that are absent, hidden, inert, unreadable, or cannot be scrolled into the viewport are skipped. A target is rechecked on entry and on subsequent layout changes. The tour does not grant access or change the backend authorization policy.

## Lifecycle

Next and Back use bounded rendering waits. Exit and Escape work during these waits. Exit/Done restores the entry screen, URL and scroll position. External routing, browser history, auth changes, onboarding and pagehide close the tour without overriding the user's new destination. Starting again first cleans up the previous run. All observers, animation frames and listeners are removed on close. Refresh does not restore an overlay.

Cards choose a non-overlapping position where space permits, account for the visual viewport, and track scroll, resize and DOM/element-size changes. Small viewports permit a scrolling card. The spotlight targets visible controls, not the old full-height navigation wrapper.

## Regression checks

Node tests: `staging-proxy/test/intro-tour.test.js`, plus avatar, Home/Today and practitioner contract suites.

Browser checks: install/use Playwright outside production, then run:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/test-intro-tour.mjs
```

The script loads current public static markup and intercepts this branch's changed assets. All API responses are controlled fixtures; paid Assist routes are blocked. It tests every guest/practitioner step at 390, 768 and 1440px, course/member conditions, Back/Next/Done, exact target intersections, non-overlapping placement when possible, invalid/hidden/offscreen/removed targets, Exit during transitions, external navigation and tab/history changes, rotation, repeated starts, refresh, and incomplete onboarding. It does not impersonate a real account or prove partner OAuth.
