# Gaia Staging Proxy Setup

The static app must not call GHL, Event Manager admin APIs, or OpenAI directly. Deploy `staging-proxy/` as a small backend and point the app to it.

## Where To Paste Secrets

Paste these only into your backend host environment variables, never into the static app:

| Variable | Paste this value | Where to get it |
| --- | --- | --- |
| `GHL_API_TOKEN` | LeadConnector/GHL private integration token | GHL/LeadConnector private integration settings |
| `GHL_LOCATION_ID` | Gaia Healers location ID | GHL location URL or API settings |
| `GHL_CLIENT_PORTAL_BASE_URL` | Client portal base URL, e.g. `https://education.gaiahealers.com` | GHL membership/client portal URL |
| `ACADEMY_PROGRESS_BASE_URL` | Backend-only normalized course progress endpoint | Your GHL/Courses connector, membership export service, or internal academy API |
| `ACADEMY_PROGRESS_TOKEN` | Bearer token for `ACADEMY_PROGRESS_BASE_URL` | Your academy connector backend |
| `ACADEMY_PROGRESS_JSON` | Optional staging-only normalized course progress JSON | Temporary backend env var from a GHL Courses/member progress export |
| `ACADEMY_PROGRESS_MEMBER_ID` | Optional staging member/contact id used by the academy connector | GHL contact/member record |
| `ACADEMY_PROGRESS_EMAIL` | Optional staging member email used by the academy connector | GHL contact/member record |
| `MEMBER_HUB_BASE_URL` | Backend-only normalized member hub endpoint | Your GHL membership/community connector or internal member portal API |
| `MEMBER_HUB_TOKEN` | Bearer token for `MEMBER_HUB_BASE_URL` | Your member hub connector backend |
| `MEMBER_HUB_JSON` | Optional staging-only normalized member hub JSON | Temporary backend env var from a GHL membership/community export |
| `MEMBER_HUB_MEMBER_ID` | Optional staging member/contact id used by the member hub connector | GHL contact/member record |
| `MEMBER_HUB_EMAIL` | Optional staging member email used by the member hub connector | GHL contact/member record |
| `EVENT_MANAGER_BASE_URL` | Event API base URL, e.g. `https://ba2ki.com/event-api` | Event Manager deployment |
| `EVENT_MANAGER_TOKEN` | Event Manager admin/read token, if enabled | Event Manager backend/admin setup |
| `EVENT_MANAGER_EVENT_ID` | Elevate event numeric ID | Event Manager admin event detail URL/API |
| `ASSIST_PROVIDER_ORDER` | Comma-separated provider order, e.g. `groq,openrouter,openai` | Gaia Assist staging config |
| `GROQ_API_KEY` | Groq API key for first-choice Gaia Assist responses | Groq console |
| `GROQ_MODEL` | Groq chat model, e.g. `llama-3.3-70b-versatile` | Groq model list |
| `OPENROUTER_API_KEY` | OpenRouter API key for second-choice Gaia Assist responses | OpenRouter dashboard |
| `OPENROUTER_MODEL` | OpenRouter model, e.g. `openrouter/free` | OpenRouter model list |
| `OPENAI_API_KEY` | Optional OpenAI project key for final hosted provider fallback | OpenAI dashboard |
| `OPENAI_MODEL` | OpenAI chat model, e.g. `gpt-4o-mini` | OpenAI model picker |
| `TTS_PROVIDER_ORDER` | Backend voice order, e.g. `openai,elevenlabs,compatible` | Gaia Assist staging config |
| `OPENAI_TTS_MODEL` | Optional OpenAI TTS model, e.g. `gpt-4o-mini-tts` | OpenAI audio model picker |
| `OPENAI_TTS_VOICE` | Optional OpenAI TTS voice, e.g. `alloy` | OpenAI audio docs |
| `GEMINI_API_KEY` | Google AI key for Gemini Live voice (or `GOOGLE_API_KEY`) | Google AI Studio |
| `GEMINI_LIVE_MODEL` | Live model, e.g. `gemini-2.5-flash-native-audio-preview-12-2025` | Gemini Live docs |
| `GEMINI_LIVE_VOICE` | Live voice name, e.g. `Puck`, `Charon`, `Kore` | Gemini Live docs |
| `GAIA_LIVE_VOICE_ENABLED` | Set `true` to enable Gemini Live orb voice | Gaia proxy config |
| `ELEVENLABS_API_KEY` | Optional ElevenLabs key for more natural hosted voice | ElevenLabs dashboard |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID to use for Gaia Assist; Adam premade is `pNInz6obpgDQGcFmaJgB` | ElevenLabs voice library |
| `ELEVENLABS_VOICE_NAME` | Friendly label shown in Gaia Assist, e.g. `Adam` | Your selected ElevenLabs voice |
| `ELEVENLABS_MODEL` | ElevenLabs TTS model, e.g. `eleven_turbo_v2_5` for lower latency | ElevenLabs docs |
| `ELEVENLABS_OUTPUT_FORMAT` | ElevenLabs audio format, e.g. `mp3_22050_32` for fast mobile playback | ElevenLabs docs |
| `ELEVENLABS_STT_MODEL` | ElevenLabs speech-to-text model, e.g. `scribe_v1` | ElevenLabs docs |
| `OPENAI_COMPATIBLE_TTS_BASE_URL` | Optional OpenAI-compatible `/v1/audio/speech` host | TTS provider docs |
| `OPENAI_COMPATIBLE_TTS_API_KEY` | Optional bearer token for that compatible TTS host | TTS provider dashboard |
| `APP_PUBLIC_URL` | Final app URL | GitHub Pages URL |
| `ALLOWED_ORIGINS` | GitHub Pages + GHL origins | Backend host settings |
| `PROXY_PUBLIC_URL` | Public proxy base URL, e.g. `https://ba2ki.com/gaia-proxy` | Your deployed proxy URL |
| `AUTH_SESSION_SECRET` | Strong random secret used to sign Gaia member sessions | Generate server-side |
| `AUTH_SESSION_COOKIE` | Session cookie name, default `gaia_member_session` | Backend config |
| `AUTH_SESSION_TTL_SECONDS` | Session lifetime in seconds | Backend config |
| `AUTH_MAGIC_LINK_TTL_SECONDS` | One-time Gaia access link lifetime in seconds | Backend config |
| `AUTH_ALLOW_DEBUG_LINKS` | Set `true` only for staging if you want the proxy to return a direct auth link instead of sending email | Backend config |
| `AUTH_ALLOW_UNVERIFIED_EMAIL_MAGIC_LINK` | Set `true` only for unsafe staging if you want email-only sign-in without connector verification | Backend config |
| `AUTH_EMBED_SHARED_SECRET` | Optional shared secret used by the embedded GHL app to claim session | Backend config + GHL custom menu URL |
| `AUTH_TRUSTED_REFERRERS` | Comma-separated GHL / client portal origins allowed to auto-claim embedded sessions | Backend config |

## Local Test

```bash
cd staging-proxy
cp ../.env.example .env
# fill .env in your backend shell, not in git
PORT=8787 node server.js
```

Then in the browser console on the static app:

```js
localStorage.setItem('gaia-sync-proxy-url', 'http://localhost:8787')
location.reload()
```

The app reads only:

```text
GET {proxy}/api/app/bootstrap
GET {proxy}/api/academy/progress
GET {proxy}/api/member/hub
GET {proxy}/api/auth/session
GET {proxy}/api/auth/me
GET {proxy}/api/auth/magic-link/consume
POST {proxy}/api/auth/magic-link/request
POST {proxy}/api/auth/embedded/claim
POST {proxy}/api/auth/logout
POST {proxy}/api/assist/chat
POST {proxy}/api/assist/voice
POST {proxy}/api/assist/transcribe
POST {proxy}/api/assist/tts
GET {proxy}/api/assist/voices
```

`/api/assist/chat` accepts JSON:

```json
{
  "prompt": "Prepare my Elevate badge",
  "intent": "event",
  "source": "quick-action",
  "page": "home.html"
}
```

`/api/assist/voice` is a staging-safe voice handoff route for already-transcribed browser text. `/api/assist/transcribe` accepts short browser-recorded audio from the static app and transcribes it on the proxy with ElevenLabs STT first, then OpenAI Whisper if configured. The frontend never receives provider keys.

## Academy Course Progress

The public app reads course progress from:

```text
GET {proxy}/api/academy/progress
```

That route returns a safe, normalized shape only:

```json
{
  "ok": true,
  "configured": true,
  "liveData": true,
  "source": "academy-progress-api",
  "summary": {
    "enrolled": 8,
    "completed": 2,
    "inProgress": 1,
    "averageProgress": 38,
    "nextCourseTitle": "Bio-Well Advanced Level 1",
    "nextLessonTitle": "Module 4 · Scan interpretation lab",
    "nextLessonUrl": "https://..."
  },
  "courses": [
    {
      "id": "biowell-advanced-l1",
      "title": "Bio-Well Advanced Level 1",
      "status": "in_progress",
      "progressPercent": 62,
      "completedLessons": 9,
      "totalLessons": 15,
      "continueUrl": "https://..."
    }
  ]
}
```

Use `ACADEMY_PROGRESS_BASE_URL` for the real connector. If the live GHL membership/course API is not available for direct reads, the proxy now returns `portalOnlyFields` and a secure portal URL instead of fake progress. For staging only, paste a real exported normalized payload into `ACADEMY_PROGRESS_JSON`; do not commit it.

## Member Hub Sync

The app shell now expects one normalized member-hub payload for the rest of the GHL memberships surface:

```text
GET {proxy}/api/member/hub
```

That route is intended to unify:

- client portal summary
- communities and discussion previews
- course/dashboard cards
- live meetings and calendar sessions
- newsletter preferences
- marketplace/device/product cards
- credentials and access notes

Use `MEMBER_HUB_BASE_URL` for the real connector. If unset, the proxy attempts direct GHL contact/profile reads using `GHL_API_TOKEN` + `GHL_LOCATION_ID`, then marks unavailable areas with `portalOnlyFields` instead of faking gated data. For staging only, paste a real exported normalized payload into `MEMBER_HUB_JSON`; do not commit it.

## Member Auth Flow

The app now supports a real Gaia proxy session layer.

Preferred production flow:

1. Member is already authenticated in GHL Client Portal or receives a Gaia access link.
2. Gaia proxy verifies or receives trusted member identity.
3. Gaia proxy sets an HTTP-only session cookie on `ba2ki.com`.
4. GitHub Pages frontend calls the proxy with `credentials: include`.
5. Proxy resolves the current member and fetches member-specific academy / hub data.

Routes:

- `GET {proxy}/api/auth/session`
- `POST {proxy}/api/auth/logout`
- `POST {proxy}/api/auth/magic-link/request`
- `GET {proxy}/api/auth/magic-link/consume?token=...`
- `POST {proxy}/api/auth/embedded/claim`

### Embedded GHL mode

When the app is launched from a GHL custom menu or client portal surface, pass member context in the app URL when possible, for example:

```text
https://gaiagitshare.github.io/gaia-healers-mobile-app/home.html?store=1&embedded=ghl&email={{contact.email}}&contactId={{contact.id}}&name={{contact.full_name}}&locationId={{location.id}}&bridge=YOUR_SHARED_SECRET
```

The frontend will post those values to `POST /api/auth/embedded/claim` and the proxy will set the member session cookie if:

- the referrer is trusted
- the location id is allowed
- optional `AUTH_EMBED_SHARED_SECRET` matches the `bridge` or `sharedSecret` query param

This is the fastest way to make the app feel seamless inside GHL.

### Standalone magic-link mode

For the public hosted app, `POST /api/auth/magic-link/request` is the right pattern. The proxy must verify the member first through `MEMBER_HUB_BASE_URL`, `ACADEMY_PROGRESS_BASE_URL`, or another backend connector before sending or returning a one-time Gaia access link.

`/api/assist/tts` is optional backend TTS. The browser tries backend voice providers through this proxy route and falls back to browser `SpeechSynthesis` if hosted voice is unavailable, out of quota, or not configured. The frontend never receives OpenAI, ElevenLabs, OpenRouter, Groq, or provider keys.

Gaia Assist provider fallback order is controlled by:

```text
ASSIST_PROVIDER_ORDER=groq,openrouter,openai
TTS_PROVIDER_ORDER=openai,elevenlabs,compatible
ELEVENLABS_MODEL=eleven_turbo_v2_5
ELEVENLABS_OUTPUT_FORMAT=mp3_22050_32
```

The proxy tries each configured provider in order. Quota, rate-limit, auth, or model errors are logged by provider name without printing secrets, then the next provider is attempted. If every provider fails, the proxy returns a local safe fallback response.

The static app now defaults to the deployed staging proxy automatically:

```text
https://ba2ki.com/gaia-proxy
```

The `proxy=` query parameter still works when you need to override staging for local or future production testing.

## Deploy

Use any Node 18+ host:

- Render Web Service
- Railway
- Fly.io
- Vercel serverless/function adaptation
- Your VPS behind Nginx

Current staging proxy deployment:

```text
https://ba2ki.com/gaia-proxy
```

Set the backend deployment URL in `window.GAIA_SYNC_PROXY_URL` only when embedding or wrapping the app needs to override the default.

For GHL iframe embeds, use the query parameter because the iframe is cross-origin:

```text
https://gaiagitshare.github.io/gaia-healers-mobile-app/home.html?store=1&proxy=https%3A%2F%2Fba2ki.com%2Fgaia-proxy
```

## Deployed VPS Service

The current VPS deployment uses:

```text
Systemd service: gaia-staging-proxy.service
App directory: /root/gaia-staging-proxy
Local port: 8787
Public route: https://ba2ki.com/gaia-proxy/
Nginx config: /etc/nginx/sites-available/ba2ki
```

## Production Rules

- No GHL token in `gaia-ecosystem.js`, `gaia-live-sync.js`, or any HTML page.
- No OpenAI key in browser code.
- No Groq or OpenRouter key in browser code.
- Event Manager admin writes require authenticated backend endpoints.
- Start with read-only sync until member identity and admin roles are tested.

## Assistant Smoke Tests

```bash
curl -fsS https://ba2ki.com/gaia-proxy/health

curl -fsS \
  -H 'Origin: https://gaiagitshare.github.io' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Prepare my Elevate badge","intent":"event","source":"curl"}' \
  https://ba2ki.com/gaia-proxy/api/assist/chat
```

The response includes `provider`, `model`, and `attempts` so staging can confirm whether Groq, OpenRouter, OpenAI, or the local fallback answered.

For spoken replies, the UI logs:

- speech started
- speech ended
- speech error

The Assist panel also shows the current voice provider: `openai`, `elevenlabs`, `compatible`, or `browser` for SpeechSynthesis fallback. Use the panel's voice settings to choose provider, browser voice name, speed, mute, and stop.

In the browser console, Gaia Assist logs:

- mic permission requested/granted or denied
- recording started/stopped
- request sent to proxy
- proxy response received
- OpenAI/voice warnings or errors
