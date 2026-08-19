# Sign in with Google / Apple — activation checklist

The flows are built, tested, and deployed. They are **credential-gated**: the
buttons appear (and the endpoints work) only once the environment variables
below are set on the proxy. Nothing else in the app changes until then.

The proxy reads config from its systemd env / `.env`. After editing, run:

```bash
systemctl restart gaia-staging-proxy.service
curl -s http://127.0.0.1:8787/api/auth/providers   # expect {"google":true,...}
```

Public base used in redirect URIs: **`https://api.gaiahealers.app`**
(this is `PROXY_PUBLIC_URL`; if it ever changes, the redirect URIs must match).

---

## Google

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client ID → Web application**.
2. **Authorized redirect URI:** `https://api.gaiahealers.app/api/auth/oauth/google/callback`
3. Configure the OAuth consent screen (app name "Gaia Healers", support email, logo). Publish it so any Google user can sign in.
4. Copy the Client ID and Client secret into the proxy env:

```
GOOGLE_OAUTH_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=xxxxxxxx
```

## Apple

Requires the Apple Developer Program ($99/yr).

1. **Identifiers → App IDs**: ensure your app id has "Sign in with Apple" enabled (or use an existing one as the primary).
2. **Identifiers → Services IDs → +**. This Services ID string is the `client_id`.
   - Enable "Sign in with Apple", click Configure.
   - **Domains:** `api.gaiahealers.app`
   - **Return URLs:** `https://api.gaiahealers.app/api/auth/oauth/apple/callback`
3. **Keys → +**, enable "Sign in with Apple", download the `.p8` (once only). Note its **Key ID**.
4. Your **Team ID** is the 10-character id in the top-right of the developer portal.
5. Set the proxy env (the private key is the full contents of the `.p8`; in a
   single-line env var, replace real newlines with `\n` — the code un-escapes them):

```
APPLE_OAUTH_SERVICES_ID=com.gaiahealers.web
APPLE_OAUTH_TEAM_ID=ABCDE12345
APPLE_OAUTH_KEY_ID=ABC123DEFG
APPLE_OAUTH_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIG*...*\n-----END PRIVATE KEY-----
```

---

## Behaviour, by design

- The button appears only when its provider's config is complete.
- Sign-in resolves the verified email to a **GHL contact** and mints the same
  HttpOnly, one-week session as the magic link.
- A verified email with **no** matching GHL contact → sent to the join funnel
  (`join.gaiahealers.com/onboarding`), not signed in.
- **Apple "Hide My Email"** relay addresses cannot match a GHL contact, so those
  users are also routed to the join funnel. (If you want relay users signed in,
  we'd store the Apple `sub` as an identity key — a follow-up.)
- id_tokens are verified (RS256 against the provider JWKS: kid match, alg-confusion
  guard, iss/aud/exp/nonce). State is a signed, self-expiring CSRF token.
