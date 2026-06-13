# Gaia Healers Client Portal — Mobile Prototype V2

Mobile-first prototype of the **Gaia Healers Client Portal** — aligned with the live ecosystem at `crm.gaiahealers.com` / `education.gaiahealers.com`.

**1,233+ practitioners** · Bio-Well certification · Modality communities · Continuing education

No backend. Static HTML + Tailwind CSS (CDN).

## V2 focus

Built around the real platform — not generic wellness copy:

| Pillar | In-app |
|--------|--------|
| Bio-Well | Energy trends, chakra trends, scan history, practicum progress |
| Practitioner communities | Bio-Well, BioPulsar, Biotekna, Healeex, All Gaia Healers, Abundant Healer |
| Certifications | Orientation → Basic → Advanced L1/L2 roadmap, exams, Credentials |
| Events | Elevate 2026 command center, GHL attendee import, QR check-in, badges, exhibitors |
| Gaia Assist | Push-to-talk voice helper prototype for scans, events, academy, and GHL follow-up |
| Continuing education | CE hours, modality courses, catalog |
| Member growth journey | Visual path on Home |

**Experience targets:** Oura (biofield metrics) · LinkedIn (practitioner network) · Coursera (certification paths)

## Screens

| File | Role |
|------|------|
| `index.html` | Client Portal intro (4-step) |
| `home.html` | Today dashboard |
| `biowell.html` | Bio-Well GDV analysis |
| `academy.html` | Certification Academy |
| `community.html` | Communities, directory, events |
| `profile.html` | Membership, CE, credentials, activity |

## Shared assets

- `gaia-shared.css` — V2 design tokens
- `gaia-ui.js` — Onboarding, coach mark, community tabs, Gaia Assist prototype
- `gaia-ecosystem.js` — CRM/GHL/event/assistant constants and future API handoff point
- `shared-nav.js` — Bottom navigation

## Run locally

```bash
cd Gaia-Healers-App
python3 -m http.server 8080
```

Open http://localhost:8080 — use a private window or clear `sessionStorage` to see onboarding.

## GHL mobile branding (upload-ready PNGs)

**Folder:** [`branding/export/`](branding/export/) · Guide: [`branding/GHL-UPLOAD.md`](branding/GHL-UPLOAD.md)

| Asset | File |
|-------|------|
| App Icon | `app-icon-1024x1024.png` |
| Splash | `splash-screen-1080x1920.png` (+ optional `splash-screen-1284x2778.png`) |
| Onboarding ×4 | `onboarding-01-welcome.png` … `onboarding-04-certification.png` |

Re-export: `./branding/export.sh`

## App Store screenshots (1290 × 2796)

- Preview: [`app-store/index.html`](app-store/index.html)
- Marketing copy: [`app-store/CAPTIONS.md`](app-store/CAPTIONS.md)
- Exported PNGs: [`app-store/export/`](app-store/export/) — run `./app-store/export.sh` (requires local server + Playwright)

## Docs

- [`docs/UX-AUDIT.md`](docs/UX-AUDIT.md) — V1 audit & benchmarks
- [`docs/V2-REDESIGN.md`](docs/V2-REDESIGN.md) — V2 source mapping from CRM

## Version

**v2.0** — Ecosystem-accurate content · **v2.1 visual** — Premium UI pass (Oura / Apple Health / Linear-inspired design system via `gaia-shared.css` + `gaia-config.js`)
