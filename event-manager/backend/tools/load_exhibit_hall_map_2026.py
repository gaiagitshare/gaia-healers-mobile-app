# -*- coding: utf-8 -*-
"""Load the ELEVATE 2026 exhibit-hall map: the plan image and one place per table.

    python3 tools/load_exhibit_hall_map_2026.py            # dry run
    python3 tools/load_exhibit_hall_map_2026.py --apply

Through the normal organiser API (audited like any admin edit). Idempotent: a
table that already has a "Booth N" place is left alone. Pins carry NO exhibitor:
the Event Manager links each one to whoever the planning sheet puts on that
booth, at read time, so the map follows the sheet.

Positions come from the venue's floor plan (Sandlake Exhibits, 33 tables),
measured on the rendered PDF -- percent of the published image.
"""
import json, os, sqlite3, sys, urllib.request
from datetime import datetime, timedelta, timezone
from dotenv import dotenv_values
from jose import jwt

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENT = 1
IMAGE = "https://gaiahealers.app/assets/events/elevate-2026-exhibit-hall-map.png"
TABLES = {1: (31, 83), 2: (7, 58), 3: (7, 47), 4: (7, 36), 5: (14, 23), 6: (23, 15), 7: (36, 9), 8: (48, 9), 9: (61, 9), 10: (74, 16), 11: (82, 24), 12: (87, 36), 13: (87, 47), 14: (87, 58), 15: (65, 83), 16: (70, 69), 17: (70, 58), 18: (70, 47), 19: (70, 36), 20: (57, 24), 21: (57, 36), 22: (57, 47), 23: (57, 58), 24: (57, 69), 25: (39, 69), 26: (39, 58), 27: (39, 47), 28: (39, 36), 29: (39, 24), 30: (25, 36), 31: (25, 47), 32: (25, 58), 33: (25, 69)}

APPLY = "--apply" in sys.argv
key = dotenv_values(os.path.join(HERE, ".env"))["SECRET_KEY"]
admin = sqlite3.connect("file:%s?mode=ro" % os.path.join(HERE, "event.db"), uri=True).execute(
    "select id from users where is_admin=1 order by id limit 1").fetchone()[0]
TOKEN = jwt.encode({"sub": str(admin), "exp": datetime.now(timezone.utc) + timedelta(minutes=15)}, key, algorithm="HS256")


def call(method, path, body=None):
    req = urllib.request.Request("http://127.0.0.1:8002" + path, data=json.dumps(body).encode() if body is not None else None,
                                 method=method, headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "null")


have = {p["name"] for p in call("GET", "/events/%d/places" % EVENT)}
todo = [n for n in sorted(TABLES) if "Booth %d" % n not in have]
event = call("GET", "/events/%d" % EVENT)
print("map image now:", event.get("map_image_url") or "(none)", "-> wanted:", IMAGE)
print("tables to add:", len(todo), "of", len(TABLES))
if not APPLY:
    print("DRY RUN: nothing written. Re-run with --apply.")
    sys.exit(0)
if event.get("map_image_url") != IMAGE:
    call("PUT", "/events/%d" % EVENT, {"map_image_url": IMAGE})
for n in todo:
    x, y = TABLES[n]
    call("POST", "/events/%d/places" % EVENT, {"kind": "booth", "name": "Booth %d" % n, "x": x, "y": y, "sort_order": n, "is_published": True})
print("done")
