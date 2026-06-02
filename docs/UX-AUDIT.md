# Gaia Healers Mobile Prototype — Senior UX Audit

**Date:** June 2026  
**Scope:** Home, Bio-Well, Academy, Community, Profile (+ splash `index.html`)  
**Benchmarks:** Apple Health, Oura, WHOOP, Headspace, Calm  

---

## 1. Executive summary

The v1 prototype establishes credible structure, emerald branding, and tab navigation. It reads as a **polished marketing mock** more than a **daily-use wellness product**. Gaps versus benchmarks cluster around: **no temporal context** (trends, history), **weak primary-action hierarchy**, **non-functional engagement patterns** (tabs, filters, emoji UI), and **thin onboarding** that does not teach the Bio-Well → Academy → Community loop.

**Overall score (heuristic):** 6.5/10 for visual direction · 4.5/10 for retention-ready UX.

---

## 2. Screen-by-screen findings

### Home

| Issue | Severity | Benchmark reference |
|-------|----------|---------------------|
| No single “Today” summary row (readiness + next action) | High | Apple Health Summary, Oura Home |
| Course cards use placeholder icons — feels empty vs photography/art | Medium | Headspace course tiles |
| Streak/CE stats lack context (no goal line, no “why it matters”) | Medium | WHOOP streak + strain narrative |
| Notification bell is inert | Low | Apple Health actionable alerts |
| Welcome block is text-heavy; no scannable metric hero | Medium | Oura Readiness ring |
| Community preview duplicates Community tab without clear CTA | Low | — |

**Weak layouts:** Vertical stack of similar-weight cards; Bio-Well CTA competes with welcome instead of owning the fold.  
**Empty areas:** Large gradient placeholders in course carousel.

---

### Bio-Well

| Issue | Severity | Benchmark reference |
|-------|----------|---------------------|
| No trend/history (7D/30D) — score feels static | Critical | Oura trends, WHOOP charts |
| Chakra list is spreadsheet-like, not embodied | High | Apple Health body maps |
| Aura viz is decorative, not tied to measurable deltas | Medium | Oura “actionable insight” |
| No scan cadence / last-next scan scheduling UX | High | WHOOP recovery timeline |
| Recommendations don’t link to Academy/Headspace-style sessions | Medium | Calm “Daily Calm” bridge |
| Duplicate score on Home CTA vs detail — good, but no “since last scan” story on Home | Medium | — |

**Missing premium:** Comparative baseline, export/share report, clinician note slot.  
**Missing wellness:** HRV/coherence tie-in, sleep/stress correlation copy.

---

### Academy

| Issue | Severity | Benchmark reference |
|-------|----------|---------------------|
| Filter chips are non-functional — trust erosion | High | — |
| No pinned “Resume” hero above the fold | High | Headspace “continue course” |
| Certification path lacks stepper/milestone moment | High | Duolingo/WHOOP milestones |
| Progress 68% without “next unlock” urgency | Medium | WHOOP “level up” |
| Catalog teaser is dead-end button | Low | — |

**Missing engagement:** Daily learning goal, quiz streak, faculty live session badge.

---

### Community

| Issue | Severity | Benchmark reference |
|-------|----------|---------------------|
| Feed/Groups/Events tabs don’t switch content — major inconsistency | Critical | Apple Health tab behavior |
| Emoji reactions (♥ 💬) feel social-app cheap vs premium | Medium | LinkedIn / Apple tone |
| Member highlights lack role/specialty | Medium | Practitioner credibility |
| No daily prompt or ritual (empty feed anxiety) | High | Headspace Today |
| Events duplicated from Home without personalization | Low | — |

**Missing retention:** Weekly circle RSVP, mentor match, CE credit for participation.

---

### Profile

| Issue | Severity | Benchmark reference |
|-------|----------|---------------------|
| “Upgrade” on Pro plan is confusing (already Pro) | High | Apple subscription clarity |
| Stats not tappable / no drill-down | Medium | Apple Health profile metrics |
| No weekly goal or retention loop | High | WHOOP weekly recap |
| Settings header disconnected from list below | Low | iOS Settings grouping |
| Sign out resets to splash but onboarding skip persists | Low | — |

---

## 3. Cross-cutting issues

### Navigation
- Five equal tabs — Bio-Well (core differentiator) should feel primary (Oura centers Readiness).
- No global “Today” or search; long scroll on Community/Academy.
- Splash auto-skips on return — good for speed, bad for brand ritual (Calm opening).

### UX inconsistencies
- Header patterns differ (Profile has no sticky bar; Bio-Well has date pill).
- Section title casing: mixed sentence case vs uppercase labels.
- Buttons: mix of `button` and `a` without consistent affordance.
- `ring-1` cards everywhere — visual monotony vs Apple’s grouped inset lists.

### Missing premium features (v1)
- Personalized insight sentence tied to data
- Trend charts and baselines
- Guided session launch from recommendations
- Certificate wallet with QR/verification
- Practitioner verification badge

### Missing engagement
- Daily intention, streaks with recovery, push-style reminders (UI only)
- Social proof on events (friends attending)
- Progress celebrations at milestones

### Missing wellness
- Correlation storytelling (scan → practice → outcome)
- Breathwork/meditation quick actions from Bio-Well
- Client session mode (practitioner use case)

---

## 4. Benchmark comparison matrix

| Capability | Apple Health | Oura | WHOOP | Headspace | Calm | Gaia v1 |
|------------|-------------|------|-------|-----------|------|---------|
| Hero metric + trend | ✓ | ✓ | ✓ | — | — | Partial |
| Actionable “today” | ✓ | ✓ | ✓ | ✓ | ✓ | Weak |
| Body/visual metaphor | ✓ | ✓ | ✓ | — | — | Weak |
| Learning continuity | — | — | — | ✓ | ✓ | Partial |
| Community ritual | — | — | ✓ | — | — | Weak |
| Premium visual calm | ✓ | ✓ | ✓ | ✓ | ✓ | Good |
| Scientific credibility | ✓ | ✓ | ✓ | Partial | Partial | Partial |

---

## 5. Priority improvements (implemented in v1.1)

### P0 — High impact, low complexity (done in prototype pass)
1. **Today strip on Home** — readiness, resume lesson, next event (Oura/Apple pattern).
2. **Bio-Well trends + chakra body map + scan history** — temporal credibility.
3. **Academy “Continue” hero + module stepper + next milestone** — Headspace/WHOOP progression.
4. **Community daily prompt + icon actions + group activity line** — practitioner ritual.
5. **Profile weekly goal + value-led membership + tappable stats** — retention.
6. **Onboarding value steps on splash** — teach product loop before skip.
7. **Shared visual system** (`gaia-shared.css`) — typography, section labels, tabular nums.
8. **First-visit coach mark on Home** — dismissible, sessionStorage.

### P1 — Next sprint (not in this pass)
- Functional Community segment control (show/hide sections).
- Academy filter state.
- Recommendation → linked mock session card.
- Photo/illustration system for courses.

### P2 — Defer
- Full chart library, messaging, client records, payments.

---

## 6. Version 2 roadmap

### Phase A — Credibility & daily habit (Q1)
- Real Bio-Well API integration with scan timeline
- Readiness algorithm copy + baseline personalization
- Push notification UI flows (scan reminder, streak, event)
- Apple Health / Oura import placeholders

### Phase B — Education & certification (Q2)
- Course player, quizzes, CE auto-logging
- Certificate wallet + public verify URL
- Learning path wizard at onboarding

### Phase C — Community & retention (Q3)
- Groups with threads, case study templates
- Mentor booking, live circles (calendar sync)
- Weekly recap email + in-app “Gaia Report”

### Phase D — Premium tier (Q4)
- Client session mode (multi-profile scans)
- White-label reports for practitioners
- Summit / events ticketing

### Design system (parallel)
- SF Pro / custom wordmark, photography art direction
- Dark mode for evening wellness (Calm)
- Haptic and motion spec (score reveal, streak celebrate)

---

## 7. Success metrics (for real users)

| Metric | Target | UX driver |
|--------|--------|-----------|
| D7 retention | >40% | Today strip + weekly goal |
| Scans/week (Pro) | ≥2 | Cadence UI + reminders |
| Lesson completion | +25% | Continue hero + stepper |
| Community posts/user/mo | ≥1 | Daily prompt |
| Pro renewal | >85% | Clear membership value |

---

*Audit completed against static prototype. v1.1 implements P0 items only.*
