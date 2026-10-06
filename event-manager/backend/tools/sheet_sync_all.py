# -*- coding: utf-8 -*-
"""Run every planning-sheet mirror, each on its own, and say how each went.

    python3 tools/sheet_sync_all.py            # dry run of all four
    python3 tools/sheet_sync_all.py --apply    # write (what the timer runs)

The four mirrors (exhibitors, speakers, schedule, volunteers) used to be four
ExecStart lines in one systemd unit. systemd stops at the first one that fails,
so a hiccup in the exhibitor sync silently skipped the other three -- and the
unit was then just "failed" with nothing saying which part, or that the rest
never ran.

Here each runs regardless of the others, with its own time limit, and the
outcome of every one is written to data/sheet-sync-status.json:

    {"vendor_sync": {"ok": true, "exit": 0, "seconds": 4.1,
                     "last_run": "...", "last_success": "...", "tail": "..."}, ...}

The process exits 1 if any of them failed, so the unit is marked failed and the
monitoring that reads it sees the problem; the ones that worked still wrote.
`last_success` survives a failure, so "when did speakers last really sync?" is
always answerable.
"""
import json, os, subprocess, sys, time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.environ.get("SHEET_SYNC_TOOLS_DIR") or os.path.join(HERE, "tools")   # a test points this at stand-ins
DATA = os.environ.get("VENDOR_SYNC_DATA") or os.path.join(HERE, "data")
STATUS = os.path.join(DATA, "sheet-sync-status.json")
MIRRORS = [m for m in os.environ.get("SHEET_SYNC_MIRRORS", "vendor_sync,speaker_sync,session_sync,people_sync").split(",") if m]
PER_TOOL_TIMEOUT = int(os.environ.get("SHEET_SYNC_TOOL_TIMEOUT", "240"))
APPLY = "--apply" in sys.argv


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")


def main():
    os.makedirs(DATA, exist_ok=True)
    try:
        status = json.load(open(STATUS))
    except Exception:
        status = {}
    failed = []
    for name in MIRRORS:
        cmd = [sys.executable, os.path.join(TOOLS, name + ".py")] + (["--apply"] if APPLY else [])
        started = time.time()
        try:
            run = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=PER_TOOL_TIMEOUT)
            code, out = run.returncode, (run.stdout + run.stderr)
        except subprocess.TimeoutExpired as e:
            code, out = 124, "timed out after %ds\n%s" % (PER_TOOL_TIMEOUT, (e.stdout or "") if isinstance(e.stdout, str) else "")
        except Exception as e:                       # noqa: BLE001 - a launcher problem is still a failure to report
            code, out = 127, "could not start: %s" % e
        rec = dict(status.get(name) or {})
        rec.update({"ok": code == 0, "exit": code, "seconds": round(time.time() - started, 1),
                    "last_run": now(), "applied": APPLY,
                    "tail": "\n".join(out.strip().splitlines()[-6:])[-1200:]})
        if code == 0:
            rec["last_success"] = rec["last_run"]
        else:
            failed.append(name)
        status[name] = rec
        print("%-14s %s (exit %d, %.1fs)" % (name, "ok" if code == 0 else "FAILED", code, rec["seconds"]))
        if code != 0:
            print("    " + rec["tail"].replace("\n", "\n    "))
    tmp = STATUS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(status, f, indent=1, sort_keys=True)
    os.replace(tmp, STATUS)
    if failed:
        print("FAILED: %s" % ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
