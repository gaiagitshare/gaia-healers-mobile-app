# The Practitioner area — design, before any code

**2 October 2026. Nothing implemented. Every number below was measured against their
staging server today with a connected practitioner, not taken from documentation.**

---

## What the data actually supports

This is the part that should shape the design, because it contradicts the obvious plan.

| Tool | Time | On the test account |
|---|---|---|
| `list_customers` | 475 ms | **1 client, real** |
| `search_customers` | 469 ms | **works** |
| `get_customer` | 473 ms | **full profile** |
| `search_customers_by_scan` | 1.6 s | **works** — matched "liver, worsened" |
| `list_flagged_customers` | 742 ms | **1 client, 7 concerns** |
| `suggest_follow_ups` | 823 ms | **works, with a date window** |
| `list_services` | 566 ms | **2 services, and see below** |
| `get_dashboard_summary` | 856 ms | counts, mostly zero |
| `get_customer_scan` | **11.0 s** | **100 scans, 1.6 MB** |
| `get_scan_trend` | **9.6 s** | **39 trends, 7 flagged** |
| `compare_protocol_before_after` | **9.5 s** | **3 comparisons** |
| `get_client_summary` | **11.9 s** | profile + latest scan |
| `get_customer_files` | 1.2 s | **`count: 0` — empty** |
| `get_customer_recommendations` | 969 ms | **`count: 0` — empty** |
| `get_customer_reviews` | 500 ms | **`count: 0` — empty** |
| `get_research_results` | 501 ms | **`count: 0` — empty** |
| `get_practice_research_analytics` | 513 ms | **`count: 0` — empty** |
| `get_practice_performance` | 650 ms | **all zeros** |
| `list_appointments` / `list_orders` | 500 ms | **`count: 0` — empty** |

**Seven of the sections you listed have no data to show.** Files in particular: you
asked for a files section, and `get_customer_files` returns `{"count":0,"files":[]}`.
Their developer said file access waits on a contract, so this is not a staging gap we
can design around — it is a section that cannot be built or tested yet.

I am not proposing UI for data I cannot see. Those sections appear in the design as
**empty states that are correct today and become real when data arrives**, not as
screens built on guesses about a shape nobody has returned.

### The thing worth building that you did not ask for

`list_services` returns each service with an `attributes` string, and those attributes
are **the same vocabulary as the scan readings**:

```
Serenity Flow Wellness Session →  Respiratory system, Sahasrara, Yin of Lungs,
                                  Nervous system, Mammary glands, Urogenital system…
Massage                        →  Cerebral zone (cortex), Hypothalamus,
                                  Musculoskeletal system, Sacrum, Spine…
```

The client's flagged areas are `Nervous system, Pancreas, Spleen, Liver, Yin of Liver,
Eyes, Yang of Large intestine`. I matched them: **"Nervous system" is covered by the
Serenity Flow session, and the Massage covers none of them.**

So the app can say *"Nima's nervous system is worsening — your Serenity Flow session
addresses that"*, built entirely from two read-only calls, with nothing new needed from
their team. That is a better answer than any client list, and it is the one thing here
that is genuinely theirs rather than a view onto somebody else's database.

---

## 1. Screens and navigation

Mobile-first, three screens, consistent with the existing `home.html?view=` pattern.

```
home.html?view=practice                     ← new tab, practitioners only
│
├── Practice                                the landing screen
│   ├── Needs attention      list_flagged_customers      742 ms
│   ├── Due a follow-up      suggest_follow_ups          823 ms
│   └── Your clients         list_customers              475 ms
│                            search_customers       (as typed)
│
└── home.html?view=practice&client=474      ← client detail
    │
    ├── header               get_customer                473 ms   instant
    ├── [ Latest reading ]   get_customer_scan            11 s    on tap
    ├── [ Trend ]            get_scan_trend              9.6 s    on tap
    ├── [ Before / after ]   compare_protocol_before_after 9.5 s   on tap
    ├── Suggested from your services  list_services       566 ms  instant
    └── Files                get_customer_files           — empty today
```

**Navigation rules**

- The Practice tab appears only when the server says the member is a practitioner —
  the same GHL-tag check the tools already use. It is not a client-side role guess.
- `?client=` makes a client deep-linkable, which is what lets Gaia open one (§4).
- Nothing deeper than two levels. A practitioner on a phone between sessions is the
  user; a third level is a level they will not find their way back from.

**Why "Needs attention" is the landing screen and not the client list.** A client list
answers a question nobody asks — they know who their clients are. "Who should I look
at" and "who should I book back in" are the questions, both are sub-second, and both
are already answerable.

---

## 2. What powers each section

| Section | Tool | Time | Loads |
|---|---|---|---|
| Needs attention | `list_flagged_customers` | 742 ms | with the screen |
| Due a follow-up | `suggest_follow_ups` | 823 ms | with the screen |
| Your clients | `list_customers` | 475 ms | with the screen |
| Client search | `search_customers` | 469 ms | as typed, debounced |
| Find by reading | `search_customers_by_scan` | 1.6 s | on submit |
| Client header | `get_customer` | 473 ms | with the screen |
| Latest reading | `get_customer_scan` | **11 s** | **on tap only** |
| Trend | `get_scan_trend` | **9.6 s** | **on tap only** |
| Before / after | `compare_protocol_before_after` | **9.5 s** | **on tap only** |
| Suggested services | `list_services` + the flags already held | 566 ms | with the screen |
| Files | `get_customer_files` | 1.2 s | empty state today |

**Three calls are never made automatically.** Opening a client must not cost eleven
seconds, and opening a client who is then not asked about must not cost anything. Each
scan section is a card with a label, a one-line description and a button — the
practitioner chooses to spend the wait.

`get_client_summary` is deliberately unused: it costs 11.9 s because it bundles the
latest scan, and the two things it bundles are already available separately — one of
them instantly.

---

## 3. The shaped scan schema

The raw response is **1.6 MB**: a hundred scans at about 16 KB each. Per scan:

```
exp_id, backup_type, scanned_at, synced_at,
data    { jsonrpc, result, id }        ← 9.5 KB of JSON-RPC envelope, meaningless
labeled { stress, energy,
          chakras[7]   { index, name, value, align, asymmetry }
          organs[31]   { index, name, left, right, disbalance }
          meridians[12]{ index, name, left, right, disbalance }
          systems[8]   { index, name, left, right, disbalance } }
```

`data` is the entire envelope of their own upstream call. It is 60% of the payload and
carries nothing. It must never leave the server.

### What the server returns

```jsonc
{
  "client":        { "id": "474", "name": "Nima Farshid" },
  "scans_on_file": 100,
  "scanned_at":    "2026-08-12",
  "stress":        2.17,          // 0–10, lower is calmer
  "energy":        50.9,          // joules ×100
  "chakras": [                     // all 7 — it is a fixed, small, meaningful set
    { "name": "Muladhara", "value": 5.5, "alignment": 95.7 }
  ],
  "most_out_of_balance": [         // top 6 of 51, ranked, across all three groups
    { "area": "organ", "name": "Pancreas", "disbalance": 30.2 }
  ],
  "suggested_services": [          // computed here, from list_services attributes
    { "id": 24, "name": "Serenity Flow Wellness Session", "covers": ["Nervous system"] }
  ]
}
```

**≈850 characters.** Measured, not estimated — the handler exists and returns this today.

Three decisions worth stating:

- **All seven chakras, only six of fifty-one disbalances.** The chakras are a fixed set
  a practitioner reads as a whole; the organ/meridian/system readings are a long tail
  where only the extremes carry a decision.
- **One ranked list, not three.** Organs, meridians and systems are separate in the raw
  data and irrelevant as separate lists to someone asking "what is worst". The `area`
  field keeps the distinction without imposing three sections.
- **Numbers are rounded at the server.** `2.167376046606188` is false precision and
  costs tokens; `2.17` is what anybody reads.

The same shaping applies to the trend (39 trends → flagged plus movers over 5 points)
and the comparison (full before/after objects → dates, two deltas, top six changes).

**This layer is already written and in production** — `assist-tools.js`, merged in #188.
The UI consumes the same shaped output as the model, from the same handler, so the two
cannot drift.

---

## 4. How Gaia Assist opens a result

Today the model narrates JSON. The change is one tool and one screen registration.

**Registration.** `staging-proxy/assist-guide.js` holds the shared `screens` map that
feeds both app navigation and the `navigate` tool. Adding one line registers the screen
for both:

```js
practice: 'Practice: your clients, their Bio-Well readings and who needs attention.
          Practitioners only.'
```

**The tool.** `navigate` gains a `client` parameter, so the model can open a specific
person rather than a screen:

```
practitioner: "how has Nima been lately?"
  → practitioner_find_client { query: "Nima" }        470 ms   resolves to 474
  → navigate { screen: "practice", client: "474", open: "trend" }
  → the app opens Nima, expands the Trend card, shows the loading state
  → practitioner_client_trend { clientId: "474" }     9.6 s
  → the card fills; Gaia says what it shows
```

The model never passes an identity, only a client id it got from a listing — and their
server refuses any client that is not this practitioner's, which we verified by asking
for eight that were not.

**The division of labour**: Gaia resolves the name and opens the card; the card shows
the numbers; Gaia says the sentence about them. The practitioner can also tap the same
card without saying anything, and gets the same thing.

---

## 5. Loading, error and disconnected states

Four states, each with its own copy, because the right next action differs.

**Not connected** — no token for this contact.
> *Connect your Gaia Practitioners account to see your clients here.* → **Connect**

The Practice tab still appears (they are a practitioner); it explains itself rather
than being empty or hidden.

**Reconnect needed** — a refresh was refused. Distinct from never-connected, which is
why `connectionStatus` returns them as separate states.
> *Your connection to Gaia Practitioners expired. Reconnect to see your clients.*
> *Connected as dr@example.com* → **Reconnect**

Naming the account matters: if the wrong one was connected, this is where they notice.

**Loading a scan** — nine to twelve seconds, which is long enough that a spinner alone
reads as broken.
> Skeleton card, and under it: *Fetching from Bio-Well — this usually takes about ten
> seconds.* The elapsed count appears after five seconds.

Saying how long, before it is long, is the difference between waiting and giving up.
Gaia says the same thing aloud, which the tool descriptions already instruct.

**Failed** — distinguish what the practitioner can act on.

| Cause | Copy |
|---|---|
| Their server timed out | *Bio-Well did not answer. Try again.* → **Retry** |
| No scans on file | *No Bio-Well scans on file for this client yet.* |
| Fewer than two scans | *A comparison needs two scans; this client has one.* |
| Client not theirs | *That client is not on your list.* |

**Empty but correct** — files, recommendations, appointments. These are honestly empty
today, so they say so rather than being hidden, and become real without a redesign:
> *No files for this client yet.*

---

## 6. What is impossible, and will stay impossible

The scope is `mcp.read`. One scope, read-only, confirmed in their discovery document.

| | |
|---|---|
| **Writing anything** | No note, no tag, no appointment, no client edit. There is no write scope to request. |
| **Generating a report** | No tool exists. Their developer: *"we'll start on it once the contract is finalized."* |
| **Opening a file** | `get_customer_files` lists files including PDFs; nothing retrieves one, and it returns empty for this account anyway. |
| **Booking a follow-up** | `suggest_follow_ups` suggests a window. Acting on it is a write. |
| **A member seeing their own results** | MCP access is practitioner-only. Their developer described a future "connect my results" flow; it does not exist. |
| **Live notification** | No webhooks. Everything is pull, on open. |

**What this means for the design:** every screen is a reading surface. There is no save
button anywhere, and there should not be a place that looks like one. The practitioner
acts in Gaia Practitioners; they *look* in Gaia.

One honest consequence: **a report can still be produced, just not by them.** We hold
the shaped scan, the trend and the comparison. Rendering that as a printable summary is
work on our side using data we already have — it is the one way to give you the report
feature while their file access waits on a contract.

---

## Design system and mobile-first

Nothing new invented. The existing families carry this:

| Need | Existing component |
|---|---|
| Client cards, section tiles | `.gaia-bento__` |
| Stress, energy, scan count | `.gaia-metric__` |
| Energy/stress over time | `.gaia-chart__` |
| Scan history | `.gaia-timeline__` |
| No clients, no files, no scans | `.gaia-empty__` |
| Latest / Trend / Compare switch | `.gaia-segment__` |
| Disbalance bars | `.gaia-progress__` |

Screens are `home.html?view=practice`, matching every other screen. Tokens
(`--gaia-topbar-h`, `--gaia-tab-h`, `--gaia-fold`) are untouched, so the Practice tab
sits in the existing bottom bar at the existing height.

Mobile-first means: one column; the three scan cards collapsed by default, which is
also what keeps the slow calls off the critical path; and a client reachable in two
taps from opening the app.

---

## What I would build first

**Phase 1 — the landing screen.** Needs attention, follow-ups, client list, search.
Four tools, all sub-second, no loading states beyond a skeleton. It is useful on its
own, and it proves the tab, the role gate and the empty states.

**Phase 2 — client detail with the three scan cards**, the lazy-load pattern, and the
service matching. This is where the ten seconds has to feel handled.

**Phase 3 — Gaia navigation.** `navigate` learns `client` and `open`, so asking opens
the card. Deliberately last: it is the part that only makes sense once there is
something to open.

Nothing beyond that until their write scope or file access exists.

---

## What I need you to decide

1. **Practice as a fifth bottom-bar tab, or inside You/Profile?** A tab is one tap and
   right for someone who uses it daily; inside Profile keeps the bar as it is for the
   overwhelming majority of members who are not practitioners.
2. **Does the printable summary matter enough to build on our side**, given their
   report generation is blocked on a contract?
3. **Phase 1 alone, or Phases 1 and 2 together?** Phase 1 is genuinely useful and
   quick. Phase 2 is where the real work is.
