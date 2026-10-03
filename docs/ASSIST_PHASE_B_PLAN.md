# Gaia Assist — Phase B decision report

3 October 2026. Prepared after Phase 1 (#201) and the hardening pass (#202–#205).

**Status:** architecture **A** (items 2, 3, 5) was approved by the owner on
3 October and implemented the same day (branch `assist/phase-b-a`). Measured
after A, same offline method: visitor 5,201 → **5,099**, member 6,238 →
**6,176**, onboarding 7,488 → **7,386**, practitioner 8,207 → **8,144**; the
prefix two different members share went from 3,522 (80%) to **3,748 (87%)**,
and a member's own block is now facts only (907 → 557 tokens). Item 6 was decided by the owner the same day (40 names, no email) and shipped:
`practitioner_list_clients` now returns at most 40 clients without email, the
true count, and a pointer to `practitioner_find_client` — worst case 5,451 →
~700 tokens. Item 4 was measured with one owner-approved live call and then **set and
verified with a second** (see §1a): text chat now thinks `minimal`
(`GEMINI_TEXT_THINKING_LEVEL`, default `minimal`; `default` reverts). Items 7–12 remain **not implemented**; they wait on real
usage data and the decisions in §5.
Every number below is from the offline reconstruction in
`staging-proxy/tools/assist-context-audit.mjs` (same method as the Phase 1
baseline, ±10%), unless marked **REAL**. No paid model was called to produce it.

The rule this plan is written under (AGENTS.md): cost optimisation must never
silently weaken safety, tool reliability, memory or user experience. Where a
saving carries that risk it is said so, and the saving is not the reason.

---

## 1. Where Phase 1 left the architecture

Tokens per **voice** reply, re-processed on every reply, before history and audio:

| | visitor | member | onboarding | practitioner |
|---|---|---|---|---|
| fixed instructions (shared by every role) | 3,315 | 3,315 | 3,315 | 3,315 |
| role/state instructions (policy, memory, survey) | 80 | 159 | 1,788 | 409 |
| action / tool schemas | 1,632 | 1,718 | 2,046 | 3,376 |
| member + screen context | 47 | 907 | 188 | 916 |
| **total static per reply** | **5,201** | **6,238** | **7,488** | **8,207** |
| history at turn 1 / 5 / 20 (modelled, text + ~100 audio tokens per utterance) | 0 / 505 / 2,347 | same | same | same |
| **total context at turn 5** | 5,706 | 6,743 | 7,993 | 8,712 |
| **total context at turn 20** | 7,548 | 8,585 | 9,835 | 10,554 |

Phase 1 reference (kept for comparison): visitor 5,755 → 5,201 · member 6,706 →
6,238 · onboarding 7,623 → 7,488 · practitioner 8,674 → 8,207. These are
unchanged by the hardening pass; nothing in #202–#205 touches a prompt.

Text chat (Gemini) system prompt: visitor 3,104 · member 4,046 · onboarding
4,975 · practitioner 4,305, plus a ~120–350-token user prompt with up to
1,739 tokens of history.

### 1a. REAL — one approved Gemini sample (3 Oct 2026, 18:3x CEST)

One `generateContent` call to `gemini-3.6-flash` (the live text model), the
real member system prompt, one realistic question ("I keep waking up at 3am —
which of my courses or energy tools should I start with tonight?"), the live
`generationConfig` (no `thinkingConfig`). Guarded to exactly one call.

| | tokens | at the price book | share of this reply's cost |
|---|---|---|---|
| prompt (system + user) | 2,828 | $0.0021 | 39% |
| **thinking** (`thoughtsTokenCount`) | **806** | **$0.0030** | **56%** |
| reply (`candidatesTokenCount`) | 70 | $0.0003 | 5% |
| total | 3,704 | **$0.0054** | 5.6 s latency |

Two things this settles:

1. **Thinking is the largest line of a text reply** — 11.5× the reply itself,
   and more than the whole prompt. Item 4 (a thinking budget / low thinking
   level for text chat, where a reply is two or three sentences of
   navigation) is the single biggest lever for text chat: at this ratio it
   could remove up to ~half of a text reply's cost and most of its latency.
   It is **not set yet**; setting it changes model behaviour and needs one
   more approved call to confirm the reply quality holds.
2. **The offline tokenizer overestimates Gemini by ~24%**: 12,822 system
   chars came to ~2,600 Gemini tokens, not the ~3,700 the 3.45-chars/token
   rule gives. Every Phase 1 / Phase B number in this document is therefore a
   ceiling for Gemini; the relative savings hold. (Qwen's tokenizer is still
   unmeasured.)

`cachedContentTokenCount` was absent, so no implicit cache hit on a first
request — expected; only repeated traffic can show caching.

**Verification (REAL, second approved call, same prompt, `thinkingLevel: "low"`):**

| | default thinking | `low` | change |
|---|---|---|---|
| thinking tokens | 806 | **320** | −60% |
| reply tokens | 70 | 57 | same two sentences, slightly more concrete navigation |
| cost per reply | $0.0054 | **$0.0035** | **−35%** |
| latency | 5.6 s | **3.1 s** | −45% |

**Third approved call, `thinkingLevel: "minimal"`:** thinking **0** (field
absent), reply 78 tokens — the same two recommendations and the same
navigation — **1.8 s, $0.0024**. `minimal` is now the live default for both
Gemini text calls (one-shot and stream); against the original reply that is
**−55% cost and −67% latency**. Voice (Qwen) is untouched.

### Cache friendliness, measured

Identical leading tokens between two prompts (what a prefix cache could reuse)
and the first block that differs:

| pair | identical | first difference |
|---|---|---|
| same member, next turn | 100% | — |
| same member, different screen | 4,312 (98%) | `CURRENT NAVIGATION` |
| two different members | 3,522 (80%) | `You are speaking with …` |
| member vs practitioner | 3,315 (71%) | the state policy line |
| visitor vs member / onboarding | 3,315 (63–76%) | the state policy line |

Text chat: 3,060–3,269 identical tokens across the same pairs.

So the structure is now cache-friendly: 3,315 tokens are identical for everyone,
and a member's own prompt is identical turn to turn. **Whether any provider
actually reuses it is unknown.** Gemini's implicit cache needs ≥2,048 tokens on
2.5 Flash but ≥4,096 on the newer Flash models — our shared prefix is below the
latter, so a visitor→member switch would not hit; the same member's second turn
(≥4,000) might. Qwen realtime is undocumented. The usage log now records
`cachedInput`; **this question is answered by real traffic, not by this report.**

### Tool results, measured (voice: re-processed on every later reply)

| result | tokens |
|---|---|
| `gaia_lookup`, worst case (6 products, 6 practitioners, 8 courses, event) | 354 |
| practitioner scan card (`latest` / `trend` / `compare`) | ~160 |
| `navigate` and other client-side confirmations | ~60 |
| **`practitioner_list_clients`, worst case (200 clients)** | **5,451** |

The last row is the one pathological case: a practitioner with a full list who
says "show me my clients" puts 5,451 tokens into the session, and every later
reply re-processes them. The model needs the names and ids to resolve "him" /
"Arman" later; it does not need 200 emails. Not changed here because the exact
cap is a product decision (see §3, item 6).

---

## 2. Duplication map (for the rewrite, not done yet)

Each row is one rule said in more than one place in **every** prompt. Tokens are
for the voice prompt; the text prompt carries the same blocks.

| rule | where it is said | tokens repeated (approx.) | consolidation | risk |
|---|---|---|---|---|
| "not a medical device / not clinical / do not diagnose" | `SAFETY FIRST` ¶3 (assist-safety.js), `HEALTH` (policy), `ENERGY TOOLS` twice, `DEVICES & STORE` | ~60 | keep the SAFETY FIRST sentence, drop the four echoes | **HIGH** — safety wording; needs the safety suite extended to pin meaning first |
| medication → prescriber / pharmacist | `SAFETY FIRST` ¶3, `HEALTH` | ~40 | keep one | **HIGH** — same reason |
| prices / stock / availability only from live data | `PERSONALIZATION`, `DEVICES & STORE`, `EVENTS`, `ACT WITH YOUR TOOLS`, `gaia_lookup` description | ~90 | one sentence in `ACT WITH YOUR TOOLS`; keep the tool description | MEDIUM — the behaviour-contract test pins it, so a drop is caught |
| how to navigate | `CURRENT APP` (404), `ENERGY TOOLS` tab/tool names, `ENERGY ROUTING` (43; a URL format voice cannot use), `navigate` schema enums (424), `ACT WITH YOUR TOOLS` | ~150 redundant | drop `ENERGY ROUTING`; keep `CURRENT APP` and the enums | LOW for `ENERGY ROUTING`; MEDIUM for anything touching the enums (tool accuracy) |
| what each action does | each tool's description **and** `ACT WITH YOUR TOOLS` (235) | ~150 | shorten `ACT` to the rules only (act, don't describe; say what is on screen; never claim) | MEDIUM — tool accuracy; measure with the harness **only with approval** |
| "use saved preferences lightly" | `PERSONALIZATION`, member `Use these saved choices…`, `MEMORY (only for…)` | ~70 | keep `PERSONALIZATION` | LOW |
| member boilerplate (`WHAT YOU CAN SEE`, `CANNOT SEE`, `Privacy`, `Use these saved choices`, header) | inside the per-member block, 357 tokens of fixed text | 0 duplicated, but **uncacheable where it sits** | move the fixed sentences into the static block; leave only the member's facts in the dynamic part | LOW — wording unchanged, position only |
| crisis numbers (988, Iran 1480/123/115, 911) | `SAFETY FIRST` only | 0 | **keep exactly** | — |

Two blocks are **not** duplication and should stay as they are: `CURRENT APP`
(the screen map the model uses constantly) and the `navigate` enums (what keeps
tool selection reliable).

---

## 3. Remaining opportunities, ranked by risk-adjusted value

Scored on a member voice reply (6,238 static). "Measure" means: with real usage
data first, then at most the 3–5 requests the paid-API rule allows without
approval, or an approved larger run.

| # | opportunity | now | expected saving | quality | safety | tool accuracy | memory | latency | complexity | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Read the usage log** (cache hits, Gemini thinking, audio/text split) | — | decides #2, #7, #9 | none | none | none | none | none | none | **first; wait for data** |
| 2 | Move member boilerplate (357) into the static block | 6,238 | 0 now; +357 cacheable | none | none | none | none | none | small | do, if #1 shows caching |
| 3 | Drop `ENERGY ROUTING` (43) | 6,238 | −43 (−0.7%) | none | none | none | none | none | trivial | do |
| 4 | Gemini thinking level `minimal` (text only) | **806 → 0 thinking tokens (REAL)** | **−55% cost, −67% latency per text reply (REAL)** | none seen in two checks | low | none | none | **better** | trivial | **shipped** |
| 5 | Consolidate the live-price rule (5 → 1) | 6,238 | −90 (−1.4%) | none | none | low | none | none | small | do, contract test covers it |
| 6 | Cap `practitioner_list_clients` sent to the model (e.g. 40 names+ids, email omitted, count kept) | 5,451 worst | −4,000+ on that session | low (names still there) | none | low | none | none | small | **product decision** — ask |
| 7 | Replace old user **audio** in voice history with its transcript | ~48% of a 50-reply session | −30–50% on long sessions | none expected | none | none | none | none | medium; undocumented Qwen behaviour | after #1 shows the audio share; approved sample |
| 8 | Shorten `ACT WITH YOUR TOOLS` + tool prose | 6,238 | −200 to −300 (−4%) | low | none | **medium** | none | none | medium | needs an approved harness run; not before |
| 9 | Consolidate safety echoes (4 sentences) | 6,238 | −100 (−1.6%) | none if exact | **medium** | none | none | none | medium | only after the safety suite pins every rule by meaning |
| 10 | Rolling summary + server-written facts + open tasks | — | enables a 4-turn window later | **better** | none | none | **better** | none | large | design first; separate PR |
| 11 | Intent-scoped practitioner tools | 8,207 | −1,657 on non-client turns | none if right | none | **high** | none | none | large | not recommended until #8's harness evidence exists |
| 12 | Knowledge behind retrieval | 6,238 | −670 | low | none | none | none | **worse** (silence in voice) | medium | **not recommended** |

Ranking rationale: items 1–5 cost nothing in quality and most are reversible by
revert; 6 is cheap but changes what a practitioner's model can "see"; 7 is the
biggest real saving and the least understood; 8, 9, 11 touch the two things
the rule protects most (safety wording, tool choice) and need measurement that
itself costs money, so they wait for approval; 12 trades tokens for audible
silence.

---

## 4. Three architectures (updated)

### A — Safe / minimal (items 2, 3, 5)
- member 6,238 → **~6,105** static (−2%); practitioner 8,207 → ~8,074
- cost: −2% now; up to −75% on the static part **if** #1 shows a prefix cache applies
- work: a day, mostly tests · risk: very low; wording changes limited to one merged price sentence

### B — Balanced (A + 4, 6, 8, 9, and the facts/summary half of 10)
- member → **~5,500** (−12%); practitioner → ~7,300; the client-list session −4,000
- text chat: depends entirely on what #1 shows thinking costs (could dominate)
- work: ~1 week · risk: medium, concentrated in safety wording (#9) and tool prose (#8); both need the safety suite extended and **one approved harness run each**

### C — Maximum efficiency (B + 7, 11, full 10)
- member → ~4,100 (−34%) static; long voice sessions −30–50% from #7
- work: 2–3 weeks · risk: real — #11 is the failure #193 fixed; #7 depends on undocumented behaviour
- not recommended as a package; take #7 on its own evidence first

**Recommendation:** A now; read a week of the usage log; decide B from the
numbers it shows (cache hits, thinking tokens, audio share), not from this
report.

---

## 5. What the owner is asked to decide

1. Approve A as the next implementation PR (items 2, 3, 5), or amend.
2. The `practitioner_list_clients` cap (item 6): how many names should a spoken
   session carry — and may email be omitted from what the model sees?
3. Whether a single approved live sample (count, tokens and minimum cost will be
   stated first) may be used to read Gemini's thinking share before item 4.
