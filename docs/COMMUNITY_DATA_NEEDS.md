# Community: what the app knows today, and what a social page would need

*Written 6 October 2026 with the UX pass (PR #273). Owner: Babak.*

The Community page in the app is a **gateway**: it shows which circles a member
belongs to and opens them where they live. It does not show posts, activity or
conversations, because the app does not have them. Nothing on the page is made
up to look social.

## What the app has today

| What the page shows | Where it comes from |
| --- | --- |
| Which circles are open, locked, requested or coming soon | GHL contact tags, through `/api/member/access` (`communities.unlocked / locked`) |
| Where each circle opens | `DEEPLINK.communityUrls` in `staging-proxy/server.js` (a Mighty Networks space, or the Gaia Healers portal as a fallback) |
| Events | The Event Manager, through `/api/events` |
| Message summaries and unread counts (Inbox) | GHL conversations, through `/api/member/notifications` |
| Gaia Radio | A link to music.gaiahealers.com |

The circles themselves (posts, comments, members) live on the community
platform (a Mighty Networks space at lightworkersapp.com, or the GHL portal). The app opens them in its in-app
window.

## What each "social" feature would need

| Feature | Data needed | Likely source | Notes |
| --- | --- | --- | --- |
| **Recent activity** in my circles | Per circle: latest post title, author first name, time, and a deep link to the post | The community platform API (Mighty Networks, or GHL Communities), read server-side with the member's own access | Must respect circle membership exactly: a member sees activity only for circles they are in. |
| **Unread conversations** | Count of unread threads, last message preview, time | Already partly available: `/api/member/notifications` returns `unread` per conversation. The Inbox shows it today. | A small "N unread" on the Community page's Inbox row is possible with no new backend. |
| **Latest posts** (across Gaia Healers) | Public or all-member posts: title, excerpt, time, link | The community platform's API, or an admin-curated feed in the existing announcements (`/api/app/bootstrap` → `announcements`) | The announcements route already exists and is admin-controlled; it is the safest first step. |
| **Community events** | Events tagged to a circle | Event Manager: add a `community` field to an event, and filter `/api/events` by it | Today events are global, not per circle. |

## Recommendation

1. Use what exists first: the Inbox row on Community now shows the unread count (done in this PR).
2. Ask the community platform (Mighty Networks / GHL) whether they offer a member-scoped
   read API for posts. Without it, a native feed is not possible without scraping,
   which we should not do.
3. Until then, keep Community a clear gateway: your circles, how each one opens,
   what's on, and who can help.
