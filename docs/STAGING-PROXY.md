# Gaia Staging Proxy Setup

The static app must not call GHL, Event Manager admin APIs, or OpenAI directly. Deploy `staging-proxy/` as a small backend and point the app to it.

## Where To Paste Secrets

Paste these only into your backend host environment variables, never into the static app:

| Variable | Paste this value | Where to get it |
| --- | --- | --- |
| `GHL_API_TOKEN` | LeadConnector/GHL private integration token | GHL/LeadConnector private integration settings |
| `GHL_LOCATION_ID` | Gaia Healers location ID | GHL location URL or API settings |
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
| `GEMINI_LIVE_MODEL` | Live model, e.g. `gemini-2.0-flash-live-001` | Gemini Live docs |
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
