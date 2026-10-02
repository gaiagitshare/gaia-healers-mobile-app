# -*- coding: utf-8 -*-
"""Remove what the test suites left on the live database.

Three suites write against REAL rows on production rather than a copy, and
none of them tidied up completely:

  * badge prints recorded against whichever attendee happened to be first on
    the roll and not yet checked in -- Jane Oelke, then Bita ja. Thirty-seven
    rows saying a sticker came out that never did, which the new print report
    counts, and one of which switched Jane's card on months before she arrives.
  * member cards for throwaway attendees that were themselves deleted, leaving
    the card behind.

Four orphaned cards are NOT touched: michelle leckliter, jantale jones, leandro
eleotero and mark glenn are real people whose attendee rows are gone. Their
cards are supposed to keep working -- a badge outliving its event is the
design, not a leak.

Dry run by default. Nothing is written without --apply.
Run:  python3 /root/event/backend/tools/clear_test_litter.py [--apply]
"""
import os, sqlite3, sys

DB = "/root/event/backend/event.db"
APPLY = "--apply" in sys.argv

TEST_NAMES = ("Multi Day", "Eq Tester", "Zed Tester", "Zed NoProd", "Gen Adm", "Up Grade",
              "Zed Payer", "Zed Late", "Phase1 Test", "Pat Four", "No Day", "Repl Ay",
              "Ines Invoice", "Otto Order", "Uma Upgrade", "Iris Both", "Pia Partial",
              "Sam Sponsor")

c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row
marks = ",".join("?" * len(TEST_NAMES))

cards = [r["id"] for r in c.execute(
    "select id from member_cards where public_token not in "
    "(select coalesce(public_token,'') from attendees) and name in (%s)" % marks, TEST_NAMES)]
logs = [r["id"] for r in c.execute(
    "select id from badge_print_logs where attendee_id in "
    "(select id from attendees where coalesce(badge_print_count,0)=0)")]
woke = [r["id"] for r in c.execute(
    "select id from member_cards where activated_at is not null and public_token in "
    "(select public_token from attendees where event_id=1 and is_checked_in=0 "
    " and public_token is not null)")]
kept = [dict(r) for r in c.execute(
    "select name, public_token from member_cards where public_token not in "
    "(select coalesce(public_token,'') from attendees) and name not in (%s)" % marks, TEST_NAMES)]

print("test member cards to remove  : %d" % len(cards))
print("phantom print rows to remove : %d" % len(logs))
print("cards to put back to dormant : %d" % len(woke))
print("real orphaned cards KEPT     : %d" % len(kept))
for k in kept:
    print("    %-24s %s" % (k["name"], k["public_token"]))

if not APPLY:
    print("\nDRY RUN. Nothing written. Re-run with --apply.")
    sys.exit(0)

for cid in cards:
    c.execute("delete from member_cards where id=?", (cid,))
for lid in logs:
    c.execute("delete from badge_print_logs where id=?", (lid,))
for wid in woke:
    c.execute("update member_cards set activated_at=null where id=?", (wid,))
c.commit()

print("\nremoved %d card(s), %d print row(s), re-dormanted %d card(s)"
      % (len(cards), len(logs), len(woke)))
print("member cards now : %d" % c.execute("select count(*) from member_cards").fetchone()[0])
print("print logs now   : %d" % c.execute("select count(*) from badge_print_logs").fetchone()[0])
print("attendees        : %d  (untouched)" % c.execute("select count(*) from attendees").fetchone()[0])
