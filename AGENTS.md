# Project instructions — Gaia Healers

This file is for everyone working on this repository: human developers, Claude,
Codex, ChatGPT, or any other AI agent. Read it before running tests or scripts.
`CLAUDE.md` imports this file; this is the single source.

---

## RULE: PAID APIs AND MODELS — no large tests without explicit approval

**This is a permanent project rule.** It applies to every paid or metered API
and model this project uses or may use later — including but not limited to
Qwen / Alibaba Model Studio, Google Gemini, OpenAI, Groq, OpenRouter,
ElevenLabs, Anthropic, and any provider added in the future. It does not depend
on any person or assistant remembering it.

### Hard requirements

1. **Default maximum: 5 live paid requests or sessions per run**, unless the
   existing test is inherently smaller.
2. **No large batch, stress, repetition, consistency, reliability, or loop
   testing** against a paid API or model **without the account owner's explicit
   approval, given in advance.** A test being useful or technically necessary
   does **not** authorize significant spending.
3. **Before asking for approval**, state:
   - the number of planned requests / sessions,
   - the estimated tokens or usage,
   - the estimated **minimum** cost,
   - why the larger test is necessary.
4. **Every script that can call a paid API must have a hard programmatic cap.**
   Use `staging-proxy/tools/paid-call-guard.mjs` (below).
5. **Never silently bypass the cap, and never increase it automatically.** A run
   above the cap must refuse and exit — not trim itself and carry on. The cap is
   raised only by an explicit flag, for one run, after approval.
6. **Prefer, in this order:** `--dry-run`, mocks, recorded responses, local
   tests, staging, and only then a tiny live sample.
7. **If the cost cannot be estimated reliably, STOP and ask** before running
   anything beyond a tiny sample.
8. **Treat every estimate as a minimum.** Failed requests, retries, and audio
   output can still be billed.
9. **Never create an uncontrolled loop against a paid API** — in a script, a
   test, a cron job, a timer, or a retry path.

### Why this rule exists

On 2–3 October 2026 a tool-call consistency harness sent **~5,400 requests and
~90 million tokens** to the Qwen pay-as-you-go account. That was about **99% of
the month's bill**; every real member combined used ~1%. Nobody approved that
volume, because nothing asked and nothing counted. It must not happen again.

For scale: one Gaia voice turn re-sends ~8–12k input tokens (system prompt plus
tool declarations plus history). Real member usage is roughly **$0.002 per turn**.

### How the cap is enforced in code

`staging-proxy/tools/paid-call-guard.mjs` — `installPaidCallGuard({ label, planned, … })`

- **Provider-independent:** it counts **every outbound request to a non-local
  host**, so a provider added later is capped without updating any list.
- **Before sending:** the script states how many paid calls it plans. Above the
  cap it prints the plan and **refuses** (exit 2).
- **While running:** every outbound `fetch` is counted; the call that would
  exceed the cap **throws**, so a miscounted plan or a retry loop still cannot
  spend past it. Scripts that open a WebSocket call `guard.count(url)` first.
- Every guarded script accepts:
  - `--dry-run` — print the plan and estimate, send nothing.
  - `--max-requests N` — raise the cap **for this run only, after approval**.

`staging-proxy/test/paid-call-guard.test.js` fails CI if **any** script in
`tools/` or `scripts/` references a paid API host or a `*_API_KEY` variable
without installing the guard — including scripts written in the future.

### Guarded scripts (planned calls at default settings)

| script | default | how to stay small |
|---|---|---|
| `staging-proxy/tools/determinism-harness.mjs` | refuses (29 sessions) | `--only <case>`; cap flag is `--max-sessions`; default 1 repetition |
| `scripts/assist-quality-probe.mjs` | refuses (100 calls) | `--only <case-id,…>` |
| `scripts/assist-guidance-probe.mjs` | refuses (16 calls) | `--only <screen or words>` |
| `staging-proxy/scripts/voice-latency-probe.mjs` | 3 sessions | `--repeats` (default 1) |
| `staging-proxy/tools/assist-health.mjs` | refuses (6 calls) | one tiny call per configured provider |
| `staging-proxy/tools/assist-live-check.mjs` | 2 calls | — |
| `staging-proxy/tools/qwen-access-check.mjs` | 1 session (no audio, ~0 tokens) | `--dry-run`; `--account 2` for the second Qwen account; run only when the owner asks whether Qwen access has returned |
| `staging-proxy/tools/member-flow-check.mjs` | 0 (offline: loopback fake partner) | end-to-end member results path: code → redeem → readings → seen → prefs → practitioner view → unlink; also run by the test suite |

Runtime code (the proxy itself) is covered by rule 9: no timer or retry path may
call a paid model without a bound. As of 3 Oct 2026 the scheduled jobs
(cron and systemd timers) make **no** paid-model calls, and the only retry paths
are bounded (`QWEN_MAX_RETRIES = 3` in `qwen-voice-relay.js`; one MCP retry in
`practitioners-oauth.js`, which is not a paid model).

### Where the bills are

- Qwen: <https://home.qwencloud.com/billing/pay-as-you-go> — usage at
  `/analytics/pay-as-you-go/usage`. Set a **Spending Alert Limit** there.
- Each other provider has its own console; set a spend alert on each.

---

## RULE: TOKEN EFFICIENCY in prompts, context, history, retrieval and tools

When modifying AI prompts, context construction, conversation history,
retrieval, or tool schemas, developers and agents **must consider token
efficiency** and avoid unnecessarily resending static, duplicated, irrelevant,
or excessively verbose context.

**Cost optimization must never silently weaken safety, tool reliability,
memory, or user experience.** A change that saves tokens but makes Gaia less
safe, less able to pick the right tool, more forgetful, or worse to talk to is
not an optimization. If a reduction risks any of those, say so explicitly and
measure it before shipping — within the paid-API testing limits above.

Practical meaning:

- Know what each change adds to **every** turn. Something sent once per turn is
  multiplied by every reply of every conversation.
- Prefer loading context by **role, state, page and intent** over sending
  everything to everyone (a member does not need practitioner-only tools).
- Do not carry large tool results or stale context forward forever; keep the
  facts, not the raw payload.
- Keep static content stable and at the front where caching applies, so it is
  not re-billed at full price.
