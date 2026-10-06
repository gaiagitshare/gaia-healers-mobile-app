# Reading claims inventory

Every threshold, range, judgement or interpretation about Bio-Well readings
found in the app, with where it lives on `main` today, its classification, and
what PR #276 shows instead.

**Classification**
- **A.** Directly supplied by Bio-Well or the partner API.
- **B.** Sourced from authoritative Bio-Well documentation.
- **C.** Practitioner- or Gaia-authored and approved.
- **D.** Currently unsourced.

**Result:** nothing in the app is B or C. Every interpretive item is D. The
only A items are the figures themselves and the partner's flag labels. No
source has been invented for anything below.

## Member-facing: My readings, Home, Today

| # | Claim on `main` | Location (`main`) | Class | In #276 (neutral replacement) |
|---|---|---|---|---|
| 1 | Energy gauge band "comfortable 40–70", green when inside | `gaia-my-readings.js:373` (gauge), `:232` (caption), `:220-221` (tone) | D | Gauge shows the figure, the scale and **"3-scan average 54.3"** (or the 90-day average). No band, no tone colour. |
| 2 | Stress gauge band "comfortable 2–4", "lower is better" tone | `gaia-my-readings.js:374`, `:232`, `:220-221` | D | Same: **"Stress 3.40 · 3-scan average 3.30"**. |
| 3 | Same two bands in the saved image | `gaia-my-readings.js:157` | D | Image keeps the arcs and values with no bands. |
| 4 | "Most people sit between 40 and 70; higher is not always better." | `gaia-my-readings.js:300` (explainer) | D | "Bio-Well photographs the glow around your fingertips, and its software reports a figure it calls Energy. This card shows that figure and your own average." Method wording only; awaits Q-E1 (source requirements doc). |
| 5 | "Around 2–4 is comfortable; above 4 is worth a conversation with your practitioner." | `gaia-my-readings.js:301` | D | "A second figure Bio-Well's software reports from the same scan, shown on this card from 0 to 10, next to your own average." |
| 6 | "…each 0–10 for how active it is, and whether it sits centred or pulled to one side. Balance matters more than any single number." | `gaia-my-readings.js:302` | D | "Bio-Well's software gives a value for each of seven centres, root to crown. The bars show those values side by side." Plus: "What they mean for you is a question for your practitioner." |
| 7 | "In short" headline: "Energy above / below / around your recent average", "stress higher / lower than usual / about usual", decided by ±5 energy and ±0.5 stress | `staging-proxy/member-link.js:515-519` (on Home too, via `gaia-superapp.js:940`) | D (the step sizes and "usual") | **"Energy +4.0 · stress +0.90 vs your 90-day average"**: the signed difference, with no step size and no judgement word. |
| 8 | "Heart was your most active centre, Crown the quietest." | `member-link.js:538` | D ("quietest") | "Highest centre value: Heart. Lowest: Crown." |
| 9 | Centre of the week: quietest centre → an Energy tool plus a cue ("Slow, grounding breaths…") | `gaia-my-readings.js:85-105`, `:393` | D (a reading-to-action rule) | **Removed.** It returns only as an approved Path rule (R8), if approved. |
| 10 | Differences coloured green/red as better/worse (energy up = good, stress down = good) | `gaia-my-readings.js:66-71` (before/after list and compare picker) | D | Signed numbers, no colour. |
| 11 | "Most out of balance" with "%" | `gaia-my-readings.js:384`, `:340` | D (the label and the unit) | "Highest disbalance figures" plus "As the scan reports them". No "%" (unit unknown, Q-B1). |
| 12 | Scan "stale" after 30 days: "Your last reading", "A new scan would show where you are now." | `gaia-my-readings.js:58`, `:198`; `gaia-superapp.js:936`, `:941` | D | Gaia product policy, **60 days, server-configured** (`GAIA_SCAN_RECHECK_DAYS`): "Your latest scan was 60+ days ago. A new scan may give you a more current point of comparison." |
| 13 | Partner flags (`worsening`/`improving`, `high`/`elevated`) | `gaia-my-readings.js:339`, `:390`; `member-link.js:526-532` | **A** (labels passed through) | Kept, now attributed: "Flagged by your practitioner's scan platform; the labels are theirs." (Becomes "flagged by Bio-Well" only if Q-P1 confirms it.) |
| 14 | The figures: energy, stress, centre values, disbalance, dates, practitioner note, files | across the card | **A** | Unchanged. No raw information is removed. |
| 15 | 3-scan and 90-day averages, ranges, differences | `reading-history.js`, partner `trend.summary` | **A** (partner) / arithmetic | Unchanged. Arithmetic, labelled as averages of the member's own scans. |
| 16 | Ask-Gaia prompts that request interpretation of scans: "What does a low Sacral reading mean on Bio-Well?", "Summarize Heart chakra stability from my last scans", "How do I improve Solar Plexus balance…", "Explain Root chakra trends in Bio-Well scans", "Third Eye chakra and Bio-Well interpretation basics" | `gaia-chakra-data.js:20,36,52,68,100` (Chakra Match "Ask Gaia") | D. They also promise something Gaia cannot do: she never sees scans. | "What practices does the app have for the {centre} centre?" (all seven). |

## Not reading-based, but relevant to the Path

| # | Item | Location | Class | Status |
|---|---|---|---|---|
| 17 | Chakra → colour spray (shop search) | `gaia-store.js:406-415` | D (product mapping) | Unchanged in the Chakra Match tool (it follows a chosen or birth-date centre, not a reading). The Path must **not** use it until approved (rule 7, products). |
| 18 | Chakra practices, themes, journal prompts | `gaia-chakra-data.js`, `staging-proxy/wellness-router.js CHAKRA_PATHS` | D (developer-written, "real correspondences") | Not reading claims. Need Gaia content approval before any Path rule points to them. |
| 19 | 8-week Chakra Challenge | `staging-proxy/wellness-router.js:387-396` (commit 1d2fff3, 2026-07-05, developer) | D | See the data-quality section of `GAIA_PERSONAL_PATH.md`. |

## Practitioner-facing (proposed, not changed in #276)

| # | Item | Location | Class | Proposal |
|---|---|---|---|---|
| 20 | Disbalance bars scaled to max 50 | `gaia-practitioner.js:523` | D (display scale) | Keep as a display scale, but label the bar "relative" or show the number only, until Q-B1. |
| 21 | Alignment bar max 100 | `gaia-practitioner.js:560` | D (scale assumed) | Same, until Q-C2. |
| 22 | `worsening` coloured as elevated | `gaia-practitioner.js:572`, `:134-135` | A (label) with D (colour) | Keep the partner label; drop the extra colour or attribute it. |
| 23 | "Also moved": changes of 5 or more not flagged | `staging-proxy/assist-tools.js:487` | D (the threshold 5) | Show the top changes by size without a cut-off, or ask Q-E4/Q-S4. |

Practitioners are trained Bio-Well users, so these are lower risk. They are
listed so nothing is left unaccounted for.

## How it stays fixed

`tests/readings-guide.test.cjs` fails if the readings card or walk-through
reintroduces interpretive words ("normal", "healthy", "comfortable",
"concerning", "quietest", "most people", "where you are now", …), a gauge
band, the centre-cue table, better/worse colouring or an assumed "%". It also
fails if a chakra prompt asks Gaia about scans.
`staging-proxy/test/member-link.test.js` pins the neutral "In short" wording
and the configurable recheck window.
