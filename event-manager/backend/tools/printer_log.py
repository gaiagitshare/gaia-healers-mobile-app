#!/usr/bin/env python3
"""Read the door printers' reports (printer_logs) — read-only.

  python3 tools/printer_log.py              newest 20, one line each
  python3 tools/printer_log.py --failed     failures only
  python3 tools/printer_log.py --trace 5    newest 5 with the driver's trace
"""
import argparse, sqlite3

p = argparse.ArgumentParser()
p.add_argument("--failed", action="store_true")
p.add_argument("--trace", type=int, metavar="N", help="show N reports with their trace")
p.add_argument("--limit", type=int, default=20)
a = p.parse_args()
c = sqlite3.connect("file:/root/event/backend/event.db?mode=ro", uri=True)
limit = a.trace or a.limit
rows = c.execute(
    "SELECT l.id, l.created_at, u.email, l.station, l.stage, l.result, l.error, l.printer, l.device, l.user_agent, l.trace "
    "FROM printer_logs l LEFT JOIN users u ON u.id = l.staff_user_id "
    + ("WHERE l.result='failed' " if a.failed else "") + "ORDER BY l.id DESC LIMIT ?", (limit,)).fetchall()
if not rows:
    print("no printer reports yet")
for (i, at, by, st, stage, res, err, prn, devn, ua, trace) in rows:
    dev = "iPad" if ua and "iPad" in ua else "iPhone" if ua and "iPhone" in ua else "Android" if ua and "Android" in ua else "desktop" if ua else "?"
    if ua and "Bluefy" in ua: dev += "/Bluefy"
    print("#%d %s UTC  %-7s %-6s %-26s %-14s %-16s %s  %s%s" % (i, str(at)[:19], stage, res, by or "?", st or "-", devn or "-", dev,
          prn or "", ("  — " + err) if err else ""))
    if a.trace:
        for line in (trace or "").split("\n"):
            if line: print("      " + line)
        print()
