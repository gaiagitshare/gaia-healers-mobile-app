# Ticket audit — Elevate 2026
**1 October 2026.** Every product on sale, put through the real door decision.

Method: the live database is copied, a fresh buyer of each product is reconciled
through the same code path a real checkout uses, and the resulting badge is
scanned at the door for each of the three event days. Nothing below is inferred
from a price or a product name.

---

## 1. What a fresh buyer of each product actually gets

| Product | Entry Fri / Sat / Sun | Conference | Tier |
|---|---|---|---|
| VIP PASS ($999) | Y / Y / Y | all three days | VIP |
| THREE DAY EVENT PASS ($650) | Y / Y / Y | all three days | 3DAY |
| WORKSHOP ACCESS ($449) | Y / Y / Y | — | WORKSHOP |
| GENERAL ADMISSION (exhibit hall only) | Y / Y / Y | — | GA |
| Orlando funnel — GA Exhibit Pass ($99) | Y / Y / Y | — | GA |
| Orlando funnel — Full Speaker Access ($297) | Y / Y / Y | all three days | GA-CONF |
| Elevate Exhibit Hall Only ($99) | Y / Y / Y | — | GA |
| Elevate Friday Pass ($97) | **Y / — / —** | — | FRI-EXH |
| Elevate Saturday Pass ($197) | **— / Y / —** | — | SAT-EXH |
| Elevate Sunday Pass ($97) | **— / — / Y** | — | SUN-EXH |
| GENERAL ADMISSION + CONFERENCE (name variant) | Y / Y / Y | all three days | GA-CONF |
| **Orlando funnel — One Day Speaker Upgrade ($97)** | **— / — / —** | **—** | **none** |

Single-day passes correctly admit on their own day and no other. Every upgrade
product grants its tier without creating a second badge.

### The one that does not stand alone
The **$97 One Day Speaker Upgrade** is an add-on, not a ticket. Bought on its own
it produces no badge and no access at all. In the funnel it is only ever sold
after the $99 GA pass, so real buyers hold GA plus the add-on and get in — but
the product itself cannot carry a buyer, and nothing stops it being bought alone.

All 28 people currently holding it were given all three days complimentary, so
nobody is affected today. **Decision needed:** retire it from sale, or give it a
base-ticket grant so a standalone buyer still gets exhibit-hall entry.

---

## 2. Two upgrades were charging people to lose access — fixed

The passes are ranked, and the door resolved an attendee to the single
highest-ranked tier they had paid for. That works for a ladder. These are not a
ladder:

- **Workshop Access** — workshops, no conference (rank 3)
- **GA + Conference** — conference, no workshops (rank 2)

Two upgrades on sale cross between them:

| Upgrade | Before | After (was) | After (now) |
|---|---|---|---|
| GA-CONF → Workshop | conference | **conference lost** | conference + workshops |
| Workshop → Three-Day | workshops | **workshops lost** | workshops + conference |

Neither had sold, which is the only reason this never hit a real attendee.
Access is now the **union** of every tier a person paid for; the ranks still name
the tier, which is all they were ever fit for. A refund still closes its zone.

---

## 3. Duplicate payments versus extra tickets

Two settled charges on one account for the same product look identical whether
they are two people or one payment taken twice. One rule now decides, used both
by the money report and by the door so they can never disagree:

| Shape | Reading | Badge? |
|---|---|---|
| Same amount, within 15 minutes | payment that looked like it failed and was retried | **No** — flagged for review |
| A day or more later | a separate decision to buy | **Yes**, flagged "confirm this name" |
| Anything between, or undated | cannot be told apart | **No** — flagged for review |
| Quantity on one order | the buyer said how many seats they want | **Yes**, named at the desk |
| Any upgrade | never a person | **No** |
| Settles late, while an unsettled charge of the same amount sits on the account | the stuck charge finally going through | **No** — flagged for review |
| A second day (Sat then Sun) | one person collecting days | **No** — adds the day |

A duplicate is still reported even though no badge is made, so the refund stays
somebody's job rather than disappearing.

### Why the last row matters here
The ledger holds **39 pending** and **43 failed** payments, and about a dozen
people carry both a failed and a paid one — the "it did not go through, so I paid
again" pattern. The gap rule on its own reads a charge that sat pending for a week
and then settled as a separate decision to buy, because by then it is more than a
day old. It would have handed one person a second badge for a ticket they bought
once. An unsettled charge for the same amount on the same account is now read as
the thing that is settling, the badge is not made, and the reason is written onto
the record for whoever checks the gateway.

---

## 4. Multi-seat bookings

A buyer who chooses several seats on one order produces **one** payment carrying
a quantity. The door read payments only, so such a booking showed no party at all
while the money report was already counting the extra seats. The door now reads
the quantity too: it shows how many seats were paid for, how many still have
nobody's name on them, and names them one at a time at the desk — with the real
name of whoever is standing there, not the buyer's.

There are no multi-quantity orders in the 2026 ledger yet, so this path had never
been exercised with real data. It is now covered by tests.

---

## 5. The roll, day by day

- **373** badges on the roll, **345** of them with paid money behind them
- **1** refused on every day: Kay Raymond #275 — a deliberately revoked duplicate
  of #274 (one GHL contact, two email addresses). Her live badge admits all three
  days. Correct.
- **14** admitted on one day only: single-day exhibit-hall buyers. Correct.
- **28** one-day conference holders: all admitted all three days, per the
  complimentary upgrade.

Nobody who has paid is refused.

---

## 6. Sales with no ticket mapping

15 event-like sales, $10,584, have no mapping. Checked one by one, none is an
Elevate attendee missing a ticket:

- **Biotiquest Elevate 2026 Community Package — $7,500.** Explicitly Elevate
  2026, buyer not on the roll. **Decision needed:** how many passes does this
  package include?
- "General Admission $47" ×2 and 16 calendar bookings — Nima Farshid's own
  events, run through the same CRM.
- "VIP Admission $97" — does not match Elevate VIP ($999); another event's.
- Manifestation Summit / "Taylor Swift" and a $1 webhook test — test data.
- Four $150 POS items, no email — in-person sales elsewhere.
- Two buyers (Isabel Sepulveda, Pati Clifford) are already on the roll as
  volunteers; these were other purchases.

## 7. Where this now lives: the review queue

Everything above that is waiting on a person is now one list in admin, under
**People → Review Queue**, built from the records themselves rather than a
separate queue table — so an item disappears when the fact changes (a name gets
confirmed, a payment settles) rather than when somebody remembers to tick it off.

As of today it holds 135 items:

| Section | Count | Money involved |
|---|---|---|
| Paid twice for the same thing | 18 | $1,863.94 |
| Sales with no ticket behind them | 15 | $10,584.00 |
| Seats needing a name confirmed | 14 | — |
| Seats paid for with no badge yet | 6 bookings / 7 seats | — |
| Payments that never settled | 82 | $12,884.18 |

The 18 possible double-charges are new information — nothing was surfacing them.
Each is two settled charges for the same product, close together in time; either
somebody is owed a refund or they meant to buy a second ticket and need a badge.

The money sections need the organiser role. A door lead opening the same page sees
only the 20 items that are desk work — which seats need a name — and no amounts.

Items that cannot resolve themselves are closed with a written reason, which is
appended to the record rather than deleting anything: an item closed silently is
indistinguishable from one nobody looked at.

### Two permission holes closed on the way
Building this surfaced two endpoints a door account could read:

- `ticket-metrics` returned gross and net revenue for the whole event behind
  `attendee.read`, which every door account holds — looking one person up is the
  job all weekend.
- `ticket-mapping-audit` read back the entire storefront (every product, its tier
  and its price label) behind `event.read`, held by door staff and exhibitor
  managers alike.

Both now require `analytics.read`, and the door-boundary test covers them.

---

## 8. Cosmetic, not a bug

Mappings #14 and #15 are flagged `is_upgrade` while typed `EVENT_TICKET`.
Behaviour follows `is_upgrade`, which is correct for an upsell, and every code
path accepts both types — so this is a labelling inconsistency only.
