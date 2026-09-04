# -*- coding: utf-8 -*-
# PHASE 1 end-to-end test on DEMO (event 2). Creates base GA + one-day add-on for a
# throwaway email, verifies the effective-access resolver + counts, then cleans up.
import json, urllib.request, sqlite3
env={}
for l in open("/root/event/backend/.env"):
    m=l.strip()
    if "=" in m and not m.startswith("#"):
        k,v=m.split("=",1); env[k]=v.strip().strip('"').strip("'")
SECRET=env.get("SECRET_KEY"); SVC=env.get("IDENTITY_SERVICE_TOKEN")
from jose import jwt
ADMIN=jwt.encode({"sub":"1"}, SECRET, algorithm="HS256")
BASE="http://127.0.0.1:8002"
TEST="phase1-demo-test@example.invalid"
def call(method, path, body=None, token=None):
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request(BASE+path, data=data, method=method)
    req.add_header("Content-Type","application/json")
    if token: req.add_header("Authorization","Bearer "+token)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        return e.code, (e.read().decode()[:200])

print("== 1) reconcile BASE (GA-DEMO tier 1) ==")
s,b=call("POST","/identity/reconcile-attendee",
  {"event_id":2,"email":TEST,"ticket_type_id":1,"first_name":"Phase1","last_name":"Test","order_id":"P1-BASE-001"},SVC)
print("  ",s,b); aid=b.get("attendee_id")

print("== 2) reconcile ADD-ON (ONE_DAY_CONFERENCE, day=Saturday Nov 21) ==")
s,b=call("POST","/identity/reconcile-attendee",
  {"event_id":2,"email":TEST,"addon_code":"ONE_DAY_CONFERENCE","day":"Saturday, Nov 21","order_id":"P1-ADDON-001"},SVC)
print("  ",s,b)

print("== 3) GET /attendees/%s -> effective_access =="%aid)
s,b=call("GET","/attendees/%s"%aid,None,ADMIN)
if isinstance(b,dict):
    ea=b.get("effective_access") or {}
    print("   base_ticket:",ea.get("base_ticket"))
    print("   addons:",ea.get("addons"))
    print("   EFFECTIVE:",ea.get("effective_label"))
    print("   history:")
    for h in ea.get("entitlement_history") or []: print("     -",h.get("kind"),"|",h.get("label"),"| day=",h.get("day"),"| order=",h.get("order_id"),"|",h.get("status"))
else:
    print("  ",s,b)

print("== 4) idempotency: re-send the same add-on order ==")
s,b=call("POST","/identity/reconcile-attendee",
  {"event_id":2,"email":TEST,"addon_code":"ONE_DAY_CONFERENCE","day":"Saturday, Nov 21","order_id":"P1-ADDON-001"},SVC)
s2,b2=call("GET","/attendees/%s"%aid,None,ADMIN)
addons=(b2.get("effective_access") or {}).get("addons") if isinstance(b2,dict) else None
print("   add-on count after re-send (expect 1):", len(addons) if addons is not None else "?")

print("== 5) GET /events/2/ticket-counts (base vs add-on separate) ==")
s,b=call("GET","/events/2/ticket-counts",None,ADMIN)
print("  ",s,json.dumps(b) if isinstance(b,dict) else b)

print("== 6) cleanup test attendee ==")
c=sqlite3.connect("/root/event/backend/event.db")
c.execute("delete from attendees where email=?",(TEST,)); c.commit()
print("   deleted rows for",TEST,"-> remaining:",c.execute("select count(*) from attendees where email=?",(TEST,)).fetchone()[0])
c.close()
