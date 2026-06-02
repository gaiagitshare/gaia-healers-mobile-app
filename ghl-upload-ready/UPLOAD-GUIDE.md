# Gaia Healers — GHL Branded Mobile App Builder Upload Guide

**App name:** Gaia Healers  
**Primary color:** `#66CC33`  
**Dark accent:** `#4DA626`  
**Source design:** Gaia Healers V3 · [gaiahealers.com](https://gaiahealers.com)

All files in this folder are final upload assets. Internal HTML used only for PNG export lives in `_build/` (do not upload).

---

## Brand colors (enter in GHL)

| Token | HEX | Use |
|-------|-----|-----|
| Primary green | `#66CC33` | Primary brand color, buttons, highlights |
| Dark green | `#4DA626` | Accents, pressed states, eyebrows |
| Background | `#FFFFFF` | Light surfaces |
| Text | `#1C1C1E` | Primary copy |

---

## File → GHL field mapping

| GHL field / section | Upload this file | Size | Notes |
|---------------------|------------------|------|-------|
| **App Icon** | `app-icon-1024x1024.png` | 1024 × 1024 | Square. G icon only on `#66CC33`. No text. |
| **Carousel slide 1** | `carousel-01-see-energy-before-symptoms-show.svg` (preferred) or `.png` | 392 × 440 | See recommended title below |
| **Carousel slide 2** | `carousel-02-powerful-tools-complete-insights.svg` or `.png` | 392 × 440 | |
| **Carousel slide 3** | `carousel-03-become-a-gaia-healer.svg` or `.png` | 392 × 440 | |
| **Carousel slide 4** | `carousel-04-join-the-global-network.svg` or `.png` | 392 × 440 | |
| **Google Play feature graphic** | `play-store-banner-1024x500.png` | 1024 × 500 | Feature / promo banner |

> GHL lists carousel assets at **392 × 440 px** and prefers **SVG** when supported; PNG fallbacks are included for the same dimensions.

---

## Recommended carousel titles (GHL text fields)

Use these as the **on-screen titles** or **carousel captions** in the builder (copy may differ slightly from artwork headlines):

| Slide | Recommended title | Short subtitle (optional) |
|-------|-------------------|---------------------------|
| 1 | See energy before symptoms show | Bio-Well™ readiness & early biofield signals |
| 2 | Powerful tools, complete insights | Bio-Well, BioPulsar & BioTekna in one portal |
| 3 | Become a Gaia Healer | Certification from Orientation to Advanced L2 |
| 4 | Join the global network | 1,233+ practitioners · communities & trainings |

---

## App identity (GHL settings)

| Setting | Suggested value |
|---------|-----------------|
| Display name | Gaia Healers |
| Subtitle / tagline | Bio-Well & Practitioner Portal |
| Primary color | `#66CC33` |
| Secondary / accent | `#4DA626` |

---

## Re-export PNGs (optional)

If you edit `_build/` HTML templates:

```bash
chmod +x ghl-upload-ready/_build/export.sh
./ghl-upload-ready/_build/export.sh
```

Requires Chromium via Playwright (`npx playwright install chromium` once).

---

## Verify dimensions before upload

```bash
cd ghl-upload-ready
for f in *.png; do sips -g pixelWidth -g pixelHeight "$f"; done
```

Expected:

- `app-icon-1024x1024.png` → 1024 × 1024  
- `carousel-*.png` → 392 × 440 each  
- `play-store-banner-1024x500.png` → 1024 × 500  

SVG carousels declare `width="392" height="440"` in the file.

---

## Related assets (not in this folder)

Larger splash and onboarding screens (1080 × 1920) remain in `branding/export/` — see `branding/GHL-UPLOAD.md` if your GHL workflow still uses those fields.
