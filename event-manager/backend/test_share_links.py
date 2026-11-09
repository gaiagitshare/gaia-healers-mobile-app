# -*- coding: utf-8 -*-
"""SHARE LINKS & QR CODES (9 Nov 2026).

On a testbed copy of the live database: organisers list the event's public
pages and published stands with their links; the QR image is public, points
only at public pages, and refuses a stand that is not in the directory.
Run:  python3 /root/event/backend/test_share_links.py
"""
import json, sqlite3, sys, urllib.error, urllib.request

HERE = "/root/event/backend"
sys.path.insert(0, HERE)
import testbed
BASE, DB = testbed.start()
import main                                                    # noqa: E402

ADMIN = {"Authorization": "Bearer " + main.create_access_token({"sub": "3", "adm": True})}
fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

def get(path, headers=ADMIN, raw=False):
    req = urllib.request.Request(BASE + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            b = r.read()
            return r.status, (b if raw else json.loads(b.decode() or "null")), r.headers.get("content-type")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), None

db = sqlite3.connect(DB, timeout=30)
EV = 1
door = db.execute("select u.id from users u join event_roles r on r.user_id=u.id where r.role='checkin_staff' limit 1").fetchone()
DOOR = {"Authorization": "Bearer " + main.create_access_token({"sub": str(door[0])})} if door else None

print("\n== organisers get every public page and published stand ==")
st, d, _ = get("/events/%d/share-links" % EV)
check(st == 200, "the list loads", st)
keys = [p["key"] for p in d["pages"]]
check({"exhibitors", "map", "agenda"} <= set(keys), "directory, map and agenda are offered", keys)
ex = next(p for p in d["pages"] if p["key"] == "exhibitors")
check(ex["url"] == "https://gaiahealers.app/home.html?view=events&event=1&tab=exhibitors", "the directory link is the app's own deep link", ex["url"])
pub = db.execute("select count(*) from exhibitors where event_id=? and is_published=1", (EV,)).fetchone()[0]
check(len(d["stands"]) == pub, "every published stand is offered (%d)" % pub, len(d["stands"]))
check(all("&stand=%d" % s["id"] in s["url"] for s in d["stands"]), "a stand link opens the map on that stand", d["stands"][:1])
st, _, _ = get("/events/%d/share-links" % EV, headers={})
check(st == 401, "nobody without a login", st)
if DOOR:
    st, _, _ = get("/events/%d/share-links" % EV, headers=DOOR)
    check(st == 403, "door staff do not manage sharing", st)

print("\n== the QR image ==")
for q in ("page=exhibitors", "page=map", "page=map&sign=1", "stand=%d" % d["stands"][0]["id"], "stand=%d&sign=1" % d["stands"][0]["id"]):
    st, png, ct = get("/events/%d/share-qr.png?%s" % (EV, q), headers={}, raw=True)
    check(st == 200 and ct == "image/png" and png[:8] == b"\x89PNG\r\n\x1a\n", "a QR image without signing in: " + q, (st, ct))
hidden = db.execute("select id from exhibitors where event_id=? and coalesce(is_published,0)=0 limit 1", (EV,)).fetchone()
if hidden:
    st, _, _ = get("/events/%d/share-qr.png?stand=%d" % (EV, hidden[0]), headers={}, raw=True)
    check(st == 404, "a stand that is not in the directory gets no code", st)
st, _, _ = get("/events/%d/share-qr.png?page=volunteer-team" % EV, headers={}, raw=True)
check(st == 404, "only the listed public pages: anything else is refused", st)
other = db.execute("select id from exhibitors where event_id<>? and is_published=1 limit 1", (EV,)).fetchone()
if other:
    st, _, _ = get("/events/%d/share-qr.png?stand=%d" % (EV, other[0]), headers={}, raw=True)
    check(st == 404, "another event's stand is refused", st)

try:
    from PIL import Image
    import io
    st, png, _ = get("/events/%d/share-qr.png?page=map&sign=1" % EV, headers={}, raw=True)
    im = Image.open(io.BytesIO(png))
    check(im.width >= 600 and im.height > im.width, "the sign is big enough to print, with room for its title", im.size)
except ImportError:
    pass

print("\n" + ("ALL CHECKS PASSED" if not fails else "%d FAILED: %s" % (len(fails), "; ".join(fails))))
sys.exit(1 if fails else 0)
