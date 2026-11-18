"""Tickets tab finds everyone (18 Nov 2026), on a copy.
Run: python3 test_ec_find_everyone.py"""
import json, os, sys, urllib.request, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["EMAIL_CENTER_CACHE_SECONDS"] = "0"
import testbed
BASE, DB = testbed.start()
import main                                                   # noqa: E402
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok: fails.append(label)
H = {"Authorization": "Bearer " + main.create_access_token({"sub": "1", "adm": True})}
def get(params):
    with urllib.request.urlopen(urllib.request.Request(BASE + "/events/1/email-center/bookings?" + urllib.parse.urlencode(params), headers=H), timeout=180) as x:
        return json.loads(x.read())
r = get({"q": "justaphasemassage@gmail.com"})
o = r.get("others") or []
check(r["count"] == 0 and len(o) == 1 and o[0]["name"] == "Lauren Nicole" and o[0]["kind"] == "Complimentary guest" and o[0]["pass"]
      and o[0]["ticket_url"], "a complimentary guest is found by email, with her pass and ticket link", o)
r = get({"q": "victoriamariellc@gmail.com"})
check(r["count"] == 1 and not r["others"], "a paid booking is still found as before", (r["count"], r["others"]))
r = get({"q": "Kelie"})
check(any(x["kind"] == "Speaker" for x in r["others"]), "speakers are found", [x["kind"] for x in r["others"]])
r = get({"q": "#902"})
check(any(x["id"] == 902 for x in r["others"]), "by ticket number", r["others"][:2])
r = get({"filter": "others"})
check(r["count"] == 0 and r["others_count"] >= 90, "the Other tickets filter lists all of them", (r["count"], r["others_count"]))
r = get({})
check(r["count"] >= 400 and not r["others"], "no search: the order list is unchanged", (r["count"], len(r["others"])))
print("\n%d failed" % len(fails) if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
