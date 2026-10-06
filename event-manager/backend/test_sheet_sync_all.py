# -*- coding: utf-8 -*-
"""SHEET SYNC RUNNER — one mirror failing never stops the others, and is seen.

Proves, with stand-in mirrors in a temp folder (no sheet, no database):
  1. every mirror runs even when an earlier one fails
  2. the runner exits non-zero when any failed, zero when all worked
  3. a mirror that hangs is stopped at its time limit and reported
  4. the status file records each one's result, and last_success survives a failure
  5. --apply is passed through; a dry run passes nothing
Then runs the real four in DRY RUN against a copy of the live database.

Run:  python3 /root/event/backend/test_sheet_sync_all.py
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = "/root/event/backend"
RUNNER = os.path.join(HERE, "tools", "sheet_sync_all.py")
fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra))))
    if not cond: fails += 1

print("SHEET SYNC RUNNER")
work = tempfile.mkdtemp(prefix="sheetsync-")
try:
    tools, data = os.path.join(work, "tools"), os.path.join(work, "data")
    os.makedirs(tools)
    def stand_in(name, body):
        open(os.path.join(tools, name + ".py"), "w").write(
            "import sys, os\nopen(os.path.join(%r, %r), 'a').write(' '.join(sys.argv[1:]) + '\\n')\n%s\n" % (work, name + ".ran", body))
    stand_in("a_ok", "print('fine')")
    stand_in("b_boom", "raise SystemExit('sheet layout changed')")
    stand_in("c_hang", "import time; time.sleep(30)")
    stand_in("d_ok", "print('fine too')")
    env = dict(os.environ, SHEET_SYNC_TOOLS_DIR=tools, VENDOR_SYNC_DATA=data,
               SHEET_SYNC_MIRRORS="a_ok,b_boom,c_hang,d_ok", SHEET_SYNC_TOOL_TIMEOUT="3")
    r = subprocess.run([sys.executable, RUNNER, "--apply"], env=env, capture_output=True, text=True, timeout=60)
    ran = {n: os.path.exists(os.path.join(work, n + ".ran")) for n in ("a_ok", "b_boom", "c_hang", "d_ok")}
    check(all(ran.values()), "every mirror ran, including the ones after a failure", ran)
    check(r.returncode == 1 and "FAILED: b_boom, c_hang" in r.stdout, "the runner exits 1 and names what failed", r.stdout[-400:])
    st = json.load(open(os.path.join(data, "sheet-sync-status.json")))
    check(st["a_ok"]["ok"] and st["d_ok"]["ok"] and not st["b_boom"]["ok"], "each result is recorded", st)
    check(st["c_hang"]["exit"] == 124 and "timed out" in st["c_hang"]["tail"], "a hung mirror is stopped and reported", st["c_hang"])
    check("sheet layout changed" in st["b_boom"]["tail"], "the failure says why", st["b_boom"]["tail"])
    check(open(os.path.join(work, "a_ok.ran")).read().strip() == "--apply", "--apply is passed through")
    first_success = st["a_ok"]["last_success"]
    stand_in("a_ok", "raise SystemExit(2)")
    env2 = dict(env, SHEET_SYNC_MIRRORS="a_ok,d_ok")
    r2 = subprocess.run([sys.executable, RUNNER], env=env2, capture_output=True, text=True, timeout=60)
    st2 = json.load(open(os.path.join(data, "sheet-sync-status.json")))
    check(r2.returncode == 1 and not st2["a_ok"]["ok"] and st2["a_ok"]["last_success"] == first_success,
          "last_success survives a later failure", st2["a_ok"])
    check(open(os.path.join(work, "d_ok.ran")).read() == "--apply\n\n", "a dry run passes no --apply (first run applied, second did not)", repr(open(os.path.join(work, "d_ok.ran")).read()))
    ok = subprocess.run([sys.executable, RUNNER], env=dict(env, SHEET_SYNC_MIRRORS="d_ok"), capture_output=True, text=True, timeout=60)
    check(ok.returncode == 0, "all working means exit 0", ok.stdout)

    # The real four, dry run, against a copy of the live database.
    db = os.path.join(work, "event.db"); shutil.copy(os.path.join(HERE, "event.db"), db)
    real = subprocess.run([sys.executable, RUNNER], env=dict(os.environ, DATABASE_URL="sqlite:///" + db, VENDOR_SYNC_DATA=os.path.join(work, "real")),
                          capture_output=True, text=True, timeout=900)
    check(real.returncode == 0 and real.stdout.count(" ok (exit 0") == 4, "the real four run clean as a dry run on a copy", real.stdout[-800:])
finally:
    shutil.rmtree(work, ignore_errors=True)

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
