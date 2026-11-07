# -*- coding: utf-8 -*-
"""THREE REGRESSIONS CODEX FOUND IN PHASES 1-4 (7 Nov 2026), AND THEIR FIXES.

  1. Door retry: after a lost first request the door turned the backend's
     "already checked in" into "admitted" whenever the check-in was under a
     minute old -- which is also what a second device or a copied QR gives.
     Now every scan carries a device scan id, a retry is answered with the
     decision the backend recorded for THAT id, and the door shows success
     only from that.
  2. Badge identity: a second ticket for the same person (comp, admin add,
     returning visitor) copied the member card's token, so both printed
     badges opened the same ticket at the door.
  3. Transfer consent: the previous holder's yes to sharing email/phone with
     stands stayed on the ticket and disclosed the NEW holder's details.

Synthetic attendees on a testbed copy only (example.invalid); no production row
is read through the API or written.
Run:  python3 /root/event/backend/test_door_retry_badge_consent.py
"""
import json, os, secrets, shutil, sqlite3, subprocess, sys, tempfile, threading, urllib.error, urllib.request

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402

ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "1", "adm": True})}
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def call(method, path, body=None, headers=ADMIN):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try: return e.code, json.loads(b or "null")
        except Exception: return e.code, b

db = sqlite3.connect(DB, timeout=30)
EV = 1
TAG = secrets.token_hex(3)
DEAD = "('refunded','cancelled','canceled','revoked','void','withdrawn')"
existing = dict(db.execute("select id, coalesce(qr_code,'')||'|'||coalesce(public_token,'') from attendees").fetchall())

def ticket(who, **extra):
    body = dict({"event_id": EV, "email": "zz-%s-%s@example.invalid" % (who, TAG), "first_name": "Zz",
                 "last_name": who, "ticket_type_id": 7}, **extra)
    st, a = call("POST", "/attendees", body)
    assert st == 200, (st, a)
    return a

def sid():
    return secrets.token_hex(16)

def scan(qr, scan_id=None):
    body = {"qr_code": qr, "access_type": "EVENT_ENTRY"}
    if scan_id:
        body["scan_id"] = scan_id
    return call("POST", "/events/%d/authorize" % EV, body)

def rows_for(scan_id):
    return db.execute("select count(*) from scan_logs where request_id=?", (scan_id,)).fetchone()[0]

# The copy carries production's rehearsal switch; force it on so a scan today admits.
call("POST", "/events/%d/door-test-mode" % EV, {"enabled": True})

print("\n== 1. a retried scan is answered with that scan's own decision ==")
a = ticket("door-a")
s1 = sid()
st, d1 = scan(a["qr_code"], s1)
check(st == 200 and d1.get("result") == "GRANTED" and d1.get("checked_in_now") and d1.get("replayed") is False,
      "first attempt admits and says it is fresh", (st, d1.get("result"), d1.get("replayed")))
st, r1 = scan(a["qr_code"], s1)
check(st == 200 and r1.get("result") == "GRANTED" and r1.get("replayed") is True and r1.get("checked_in_now") is True,
      "the retry with the same id replays GRANTED (the response was lost, the admission was not)", (st, r1))
check(rows_for(s1) == 1, "the retry writes no second scan row", rows_for(s1))
check(r1.get("door") is not None and r1.get("first_name") == "Zz", "a replay still carries the door card", list(r1)[:6])

s2 = sid()
st, d2 = scan(a["qr_code"], s2)
check(d2.get("result") == "LIMITED" and d2.get("replayed") is False and d2.get("granted") is False,
      "a DIFFERENT device scanning the same ticket a second later is LIMITED, not admitted", (d2.get("result"), d2.get("reason")))
st, r2 = scan(a["qr_code"], s2)
check(r2.get("result") == "LIMITED" and r2.get("replayed") is True and not r2.get("checked_in_now"),
      "that device's retry replays LIMITED, never GRANTED", (r2.get("result"), r2.get("checked_in_now")))

b = ticket("door-b")
call("POST", "/attendees/%d/revoke" % b["id"], {"reason": "synthetic revoke"})
s3 = sid()
st, d3 = scan(b["qr_code"], s3)
st, r3 = scan(b["qr_code"], s3)
check(d3.get("result") == "DENIED" and r3.get("result") == "DENIED" and r3.get("replayed") is True,
      "a rejected ticket stays rejected on the retry", (d3.get("result"), r3.get("result")))

st, d4 = scan(ticket("door-c")["qr_code"])
check(st == 200 and d4.get("result") == "GRANTED" and d4.get("replayed") is False,
      "a door build without scan ids still works as before", (st, d4.get("result")))
st, _ = scan(b["qr_code"], s1)
check(st == 409, "a scan id cannot be reused for a different ticket", st)
st, _ = scan(a["qr_code"], "bad id!")
check(st == 422, "a malformed scan id is refused", st)

c = ticket("door-race")
same = sid()
res = []
def go(scan_id):
    res.append(scan(c["qr_code"], scan_id)[1])
ts = [threading.Thread(target=go, args=(same,)) for _ in range(8)]
[t.start() for t in ts]; [t.join() for t in ts]
check(all(x.get("result") == "GRANTED" for x in res) and sum(1 for x in res if not x.get("replayed")) <= 1,
      "8 overlapping attempts of ONE scan (slow original + retries): all GRANTED, at most one fresh", [(x.get("result"), x.get("replayed")) for x in res])
check(rows_for(same) == 1, "and exactly one scan row for it", rows_for(same))
d = ticket("door-race2")
res = []
ts = [threading.Thread(target=go, args=(sid(),)) for _ in range(8)]
c = d
[t.start() for t in ts]; [t.join() for t in ts]
check(sum(1 for x in res if x.get("result") == "GRANTED") == 1 and sum(1 for x in res if x.get("result") == "LIMITED") == 7,
      "8 devices scanning one ticket at once: one admission, seven LIMITED", sorted(x.get("result") for x in res))

# The door's own retry helper, extracted from the shipped CheckIn.js and fed
# REAL backend decisions from above.
src_path = os.environ.get("CHECKIN_JS") or os.path.join(os.path.dirname(HERE), "frontend", "src", "components", "CheckIn.js")
node = shutil.which("node")
if node and os.path.exists(src_path):
    work = tempfile.mkdtemp(prefix="retry-")
    fx = os.path.join(work, "fx.json")
    json.dump({"other_device_limited": d2, "replay_granted": r1, "replay_denied": r3, "fresh_granted": d1}, open(fx, "w"), default=str)
    js = r"""
const fs=require('fs');const src=fs.readFileSync(process.argv[2],'utf8');
const a=src.indexOf('    const SCAN_TIMEOUT_MS =');const b=src.indexOf('    const runScan =',a);
const fx=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
global.window={crypto:require('crypto').webcrypto};
const net=()=>{const e=new Error('Network Error');return e;};
async function run(second, firstFails=true){const ids=[];let n=0;
  const mock=async(ev,body)=>{ids.push(body.scan_id);n++;if(firstFails&&n===1)throw net();
    if(second==='fail')throw net();return {data:{...fx[second],scan_id:fx[second].replayed?body.scan_id:fx[second].scan_id}};};
  const h=new Function('authorizeScan','eventId','window',src.slice(a,b)+'\nreturn authorizeWithRetry;')(mock,1,global.window);
  const realT=setTimeout;global.setTimeout=(f)=>realT(f,0);
  try{const r=await h({qr_code:'x',access_type:'EVENT_ENTRY'});return {result:r.data.result,fresh:!!r.data.checked_in_now,same_id:ids.length===2&&ids[0]===ids[1]&&!!ids[0]};}
  catch(e){return {error:true};} finally{global.setTimeout=realT;}}
(async()=>{const o={};for(const k of ['other_device_limited','replay_granted','replay_denied','fresh_granted','fail'])o[k]=await run(k);
console.log(JSON.stringify(o));})();
"""
    open(os.path.join(work, "t.js"), "w").write(js)
    out = subprocess.run([node, os.path.join(work, "t.js"), src_path, fx], capture_output=True, text=True, timeout=60)
    shutil.rmtree(work, ignore_errors=True)
    try:
        o = json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:
        o = {}
        check(False, "door helper ran", (out.stdout[-300:], out.stderr[-300:]))
    if o:
        check(o["other_device_limited"]["result"] == "LIMITED" and not o["other_device_limited"]["fresh"],
              "DOOR: lost first request + another device's admission -> shows LIMITED, not success", o["other_device_limited"])
        check(o["replay_granted"]["result"] == "GRANTED" and o["replay_granted"]["same_id"],
              "DOOR: lost response of its own admission -> success, same scan id both times", o["replay_granted"])
        check(o["replay_denied"]["result"] == "DENIED", "DOOR: rejected ticket after a retry -> rejected", o["replay_denied"])
        check(o["fail"].get("error"), "DOOR: both attempts lost -> an error, never success", o["fail"])
else:
    print("  SKIP  node or CheckIn.js not available")

print("\n== 2. every live ticket keeps its own badge identity ==")
p1 = ticket("badge")
p2 = ticket("badge", attendance_type="complimentary")
check(p1["public_token"] and p2["public_token"] and p1["public_token"] != p2["public_token"],
      "a second (complimentary) ticket for the same person gets its own badge token", (p1["public_token"], p2["public_token"]))
st, d = call("POST", "/events/%d/authorize" % EV, {"qr_code": p2["public_token"], "access_type": "EVENT_ENTRY"})
check(d.get("attendee_id") == p2["id"], "the second printed badge opens the SECOND ticket", (d.get("attendee_id"), p2["id"]))
st, cj = call("GET", "/c/%s.json" % p2["public_token"], headers={})
check(st == 200, "the second badge's card link still opens the person's card", st)
ret = db.execute("select a.email from attendees a join attendees b on a.public_token=b.public_token and b.event_id<>a.event_id "
                 "where a.event_id=? and lower(coalesce(a.registration_status,'registered')) not in %s limit 1" % DEAD, (EV,)).fetchone()
if ret:
    st, rx = call("POST", "/attendees", {"event_id": EV, "email": ret[0], "first_name": "Zz", "last_name": "Returning",
                                         "ticket_type_id": 7, "attendance_type": "complimentary"})
    held = {r[0] for r in db.execute("select public_token from attendees where event_id=? and id<>? and lower(email)=lower(?)",
                                      (EV, rx.get("id", -1), ret[0])).fetchall()}
    check(st == 200 and rx.get("public_token") not in held,
          "a returning visitor's extra 2026 ticket does not take last year's token again", st)
st, lk = call("POST", "/attendees", {"event_id": EV, "email": "zz-link-%s@example.invalid" % TAG, "first_name": "Zz", "last_name": "Link", "ticket_type_id": 7})
dup = db.execute("select count(*) from (select public_token from attendees where event_id=? and public_token is not null and "
                 "lower(coalesce(registration_status,'registered')) not in %s group by public_token having count(*)>1)" % DEAD, (EV,)).fetchone()[0]
check(dup == 0, "no two live tickets in the event share a badge token after all of the above", dup)

print("\n== 3. consent belongs to the current holder ==")
ex = db.execute("select access_token from exhibitors where event_id=? and can_scan_leads=1 and stage='confirmed' and access_token is not null limit 1", (EV,)).fetchone()
t = ticket("consent-old", phone="+10000000001")
call("POST", "/events/%d/attendees/%d/sharing" % (EV, t["id"]), {"share_email": True, "share_phone": True, "reason": "synthetic yes"})
st, l1 = call("POST", "/scan", {"qr_code": t["qr_code"], "access_token": ex[0]}, headers={})
check((l1.get("attendee") or {}).get("email", "").startswith("zz-consent-old"), "the holder who said yes is shared with the stand", st)
new_email = "zz-consent-new-%s@example.invalid" % TAG
st, tr = call("POST", "/attendees/%d/transfer" % t["id"], {"email": new_email, "first_name": "Zz", "last_name": "New",
                                                          "phone": "+10000000002", "reason": "synthetic transfer"})
check(st == 200, "transfer accepted", st)
row = db.execute("select consent_updated_at, share_email_with_exhibitors, share_phone_with_exhibitors, custom_data from attendees where id=?", (t["id"],)).fetchone()
check(row[0] is None, "the transfer returns the ticket to 'never asked'", row[:3])
reset = (json.loads(row[3] or "{}").get("transfers") or [{}])[-1].get("sharing_reset")
check(reset and reset.get("was_asked") is True, "the previous holder's choice is kept in the transfer record", reset)
st, l2 = call("POST", "/scan", {"qr_code": t["qr_code"], "access_token": ex[0]}, headers={})
at = l2.get("attendee") or {}
check(not at.get("email") and not at.get("phone"), "the NEW holder's email and phone are NOT disclosed", (at.get("email"), at.get("phone")))
st, lst = call("GET", "/scan/leads/%s?limit=500" % ex[0], headers={})
mine = [x for x in (lst if isinstance(lst, list) else []) if (x.get("attendee") or x).get("attendee_id") == t["id"]]
check(not any(new_email in json.dumps(x) or "+10000000002" in json.dumps(x) for x in mine),
      "the stand's lead list does not show the new holder's email or phone", len(mine))
call("POST", "/events/%d/attendees/%d/sharing" % (EV, t["id"]), {"share_email": True, "share_phone": False, "reason": "new holder yes"})
st, l3 = call("POST", "/scan", {"qr_code": t["qr_code"], "access_token": ex[0]}, headers={})
at = l3.get("attendee") or {}
check(at.get("email") == new_email and not at.get("phone"), "once the new holder says yes (email only), exactly that is shared", (bool(at.get("email")), at.get("phone")))

print("\n== nothing that existed before the suite changed ==")
after = dict(db.execute("select id, coalesce(qr_code,'')||'|'||coalesce(public_token,'') from attendees").fetchall())
changed = [i for i, v in existing.items() if after.get(i) != v]
check(not changed, "every pre-existing ticket keeps its QR code and badge token", changed[:5])

print("\n%d check(s) failed" % len(fails) if fails else "\nALL CHECKS PASSED")
sys.exit(1 if fails else 0)
