# Assist → practitioner tools: making the calls reliable

October 2026.

The practitioner tools worked. They did not work *every time*, and a tool that
answers two questions out of three is worse than one that is simply missing,
because the practitioner has no way to tell which kind of answer they just got.
The acceptance test caught one instance — *"Compare his last two scans."*
answered with *"His latest scan is now on your screen."*, no tool called — and
one instance is not a measurement. This is the audit, the change, and the
before/after numbers.

## How it was measured

`gaia-staging-proxy/tools/determinism-harness.mjs`.

It drives the production decision path: the same realtime model the orb talks
to (`qwen3.8-omni-flash-realtime`), the instruction string from the real
`buildGaiaLiveInstructions()`, and the declarations from the real
`toolDeclarationsFor()`. Two things differ, both on purpose:

- **Turns are typed, not spoken.** This model accepts typed turns and the orb
  sends them too, for the text box. It takes the audio encoder out of the
  measurement; transcription noise is not what was being tuned.
- **Tool results are replayed, not fetched.** A real scan is a ten-second call
  to someone else's server and 1.6 MB on the wire. The stubs are the exact
  shape the real handlers return, so the model sees what it would really see.

Every intent is asked several times in several phrasings, because a single pass
cannot tell a reliable prompt from a lucky one. Three groups:

- **follow-ups** — the six conversational follow-ups from the brief, asked in
  order, in one session, each turn scored on its own. This is how they were
  asked and how they failed.
- **intent/\*** — the same intents one at a time, in 2–4 natural phrasings, with
  the client established first so pronouns resolve.
- **controls** — ordinary conversation that must call *nothing*, plus two member
  sessions. A stricter prompt that starts firing tools at *"thanks, that's
  helpful"* has made things worse, so these are scored as hard failures.

## The audit: four causes

**1. `navigate` was told to beat the data tools, and it returns no data.**
Its practitioner clause read *"Prefer this over describing readings aloud — open
the card, then say one short sentence about what it shows."* So a reading
request had two valid answers and the prompt preferred the one that fetches
nothing; the model was then left with nothing to say but *"it is on your
screen."* Written when navigation was the only way to show a card — and since
PR #192 every practitioner tool opens its own card, so the preference bought
nothing and cost the answer.

**2. Nothing said a practitioner's own clients are theirs to ask about.**
`MEMBER CONTEXT` says *"never reference data belonging to other members"*, and
a client's Bio-Well reading looks exactly like that. Runs refused outright — *"I
can't track Nima's personal progress"*, with a line about consent. A refusal is
a worse failure than a missing call.

**3. The one practitioner-only line in the prompt asked for conversation.**
`statePolicy.practitioner` said *"give practice-oriented platform and education
guidance"*. The only paragraph that makes tool use mandatory, `ACT WITH YOUR
TOOLS`, enumerates the member tools and then `gaia_lookup` for "prices, stock,
practitioner availability, event details or course access" — a closed list that
client readings fall outside. Client data was in no must-call category at all.

**4. Three tool descriptions described the failure.** *"SLOW — takes about ten
seconds, so tell the practitioner you are fetching it before you call it."* In
this model the turn ends at the tool call (a tool-call turn emits zero audio
deltas), so the preamble never plays first anyway — it only licensed a turn that
spoke *instead* of calling. That is the dead-end turn, verbatim.

### One thing that was not a bug

`sessionState()` requires a line matching `^MEMBER CONTEXT:` and the real
context header is `MEMBER CONTEXT (private — …)`, which looks like it would make
every signed-in session a visitor. It does not: production emits
`GAIA SESSION STATE: practitioner` as the first line and the explicit branch
catches it. The first harness fixture was wrong, not the product. The harness
now asserts it is measuring a practitioner session and exits if it is not.

## The change

Three edits, all inside the practitioner branch so no member session is
affected:

- `assist-guide.js` — `statePolicy.practitioner` gains two clauses: their own
  clients are theirs to ask about, and client facts come from a tool in the same
  turn, every time, including follow-ups and including questions a scan already
  in the conversation looks like it answers.
- `assist-tools.js` — `navigate`'s practitioner clause now says it returns no
  data and cannot answer a question, and points at the tools.
- `assist-tools.js` — the three slow descriptions ask the model to call rather
  than announce.

Pinned by six tests in `test/practice-navigation.test.js`, including one that
asserts the other four roles are untouched.

## How the measurement had to be fixed first

Three attempts produced three different answers for the same code, and the
reasons matter more than the first numbers did:

**Eight repetitions is not a measurement.** A run of the changed code scored
86%; a later run of *identical* code scored 71%. Anything inferred from one run
per configuration was noise.

**An upstream failure is not a model decision.** That 71% run carried 35
`InternalError.Algo.ModelServingError` responses and 27 turns that returned
nothing at all — the Qwen endpoint was degraded for the duration. Those turns
were being scored as the model declining to call a tool. The harness now tags
them `invalid` and the rates exclude them.

**Configurations have to be measured in the same window.** Because the upstream
has weather, two runs an hour apart are not comparable. The harness takes
`--variant both`, rewrites the prompt and the tool descriptions back to their
pre-change wording in memory, and interleaves both variants in one process, so
each pair of observations shares the same queue and the same minute.

**Two harness bugs of my own, fixed rather than reported as findings:**

- The first client fixture was named "Nima", which collides with Dr. Nima
  Farshid, the founder named in the prompt's ABOUT line. The model kept
  answering, correctly, that he is not one of their clients — so the run
  measured a name collision. Every fixture name is now checked against the
  prompt.
- Every socket wait was unbounded, so one quiet connection wedged six workers
  and a whole run stalled at 173 of 232 jobs. Every wait now has a deadline, and
  records are appended to a `.jsonl` as they land, so a run that is cut short is
  still worth something (`tools/determinism-rollup.mjs`).

## Results

Both variants interleaved, upstream failures excluded, pooled across runs.
`before` is the old wording restored in memory; `after` is what is on disk.

| group | before | after |
|---|---|---|
| **practitioner data, all** | **72%** (134/185) | **81%** (107/132) |
| intent/compare | 85% (28/33) | **100%** (24/24) * |
| intent/latest | 53% (16/30) | **81%** (13/16) |
| intent/follow-ups | 73% (8/11) | **94%** (15/16) |
| intent/trend | 88% (23/26) | 90% (18/20) |
| intent/flagged | 100% (12/12) | 100% (11/11) |
| intent/services | 100% (9/9) | 100% (5/5) |
| follow-up conversation | 59% (38/64) | 53% (21/40) |
| **controls — must stay 100%** | **100%** (51/51) | **100%** (35/35) |

\* p<0.05, two-proportion z. The overall +9 points is z = 1.79, p ≈ 0.07:
directionally consistent in every run but short of conventional significance.

**The robust result is the shape of the misses, not the headline rate.**
`navigate` called instead of a data tool fell from 24 misses in 185 turns (13%)
to 8 in 132 (6%) — halved, and consistent across every post-change run. That was
the largest single cause of a practitioner question that fetched nothing, and it
is the one the acceptance test caught.

**Ordinary conversation was not disturbed.** 86 control turns across both
variants, 100% in every run: greetings, thanks, "keep it short", "do you think
I'm taking on too many clients", general Bio-Well education, and two member
sessions. The stricter wording did not produce a single spurious call.

### What a clause that backfired looks like

A fourth change was tried and reverted. Adding *"Never promise a fetch as a
whole turn — 'I will pull that up', 'let me check' and 'I am looking it up' are
only ever said in the same turn as the call itself"* made the behaviour it
forbids **more** common: dead-end turns went from 14 to 20, and the overall rate
fell from 86% to 75%. Quoting the phrases to avoid appears to have primed them.
It is recorded here because the wording reads like an obvious improvement.

### The follow-up conversation, turn by turn

Two of its eight turns fail deterministically, in both variants, and neither is
a determinism problem:

- **"What about the previous one?" — 0/13.** Nothing can answer it. No tool
  returns an arbitrary earlier scan: `practitioner_client_latest_scan` keeps
  only the newest of the ~100 scans their server sends, and
  `practitioner_compare_sessions` returns deltas, not the earlier reading's own
  values. A **capability gap**, not a missed call. The model's answer — offering
  to pull the history instead — is the honest one.
- **"Has he improved?" — 0/13.** The model answers from the comparison it
  fetched the turn before, with the correct numbers. That is good behaviour;
  forcing a second ten-second call there would be worse for the practitioner.
  Across the whole group, **23 of 45 follow-up "misses" had the data fetched by
  the immediately preceding turn** — half of the failure count is correct reuse
  of fresh data. The harness records this as `freshData` so the two can be told
  apart.

That leaves one genuine residual: **"Show me my clients." still goes to
`navigate` about 4 times in 5.** It is not wrong — the list does appear — but
the model does not get it, so later pronouns rely on the next turn re-fetching
(which it does, 13/13). The smallest fix would be to drop `section` from
navigate's practitioner declaration, so the only way to show a list is the tool
that also returns it. Not done here: it changes the tool contract, and the
measurement window was too unreliable to verify another change honestly.

### Caveat on the measurement window

84% of all session attempts (2,138 of 2,541) failed upstream with
`InternalError.Algo.ModelServingError`. The endpoint flaps on a timescale of
minutes — four sequential single-turn probes succeeded 4/4 while the harness was
failing most of its sessions, and a `--jobs 1` probe produced 13 failures where
`--jobs 2` produced none. This is why the variants are interleaved and why the
valid samples are smaller than the number of attempts. It also means the +9
points should be re-measured in a calm window before anybody treats it as
settled; the halved `navigate` misses do not depend on it.
