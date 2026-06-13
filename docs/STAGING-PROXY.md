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
| `OPENAI_API_KEY` | OpenAI project key for Gaia Assist voice backend | OpenAI dashboard |
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
```

## Deploy

Use any Node 18+ host:

- Render Web Service
- Railway
- Fly.io
- Vercel serverless/function adaptation
- Your VPS behind Nginx

Set the backend deployment URL in `window.GAIA_SYNC_PROXY_URL` when embedding or wrapping the app.

## Production Rules

- No GHL token in `gaia-ecosystem.js`, `gaia-live-sync.js`, or any HTML page.
- No OpenAI key in browser code.
- Event Manager admin writes require authenticated backend endpoints.
- Start with read-only sync until member identity and admin roles are tested.
