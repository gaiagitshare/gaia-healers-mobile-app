# -*- coding: utf-8 -*-
"""THE EVENT MANAGER NEVER SIGNS WITH A PUBLISHED KEY

This repository is public, so the old SECRET_KEY fallback string is known to
everyone. If .env failed to load, tokens signed with it could be forged. Now a
missing, short or known-default key is replaced by a random per-process key;
a proper key from the environment is used unchanged.

Imports the real app in a subprocess against a fresh temporary database with
fictional values only. Run:  python3 test_secret_key_guard.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLISHED = "your-secret-key-change-in-production"
GOOD = "fictional-test-signing-key-" + "k" * 40
fails = []


def key_for(value):
    work = tempfile.mkdtemp(prefix="keyguard-")
    try:
        env = {k: v for k, v in os.environ.items() if k != "SECRET_KEY"}
        env["DATABASE_URL"] = "sqlite:///" + os.path.join(work, "event.db")
        if value is not None:
            env["SECRET_KEY"] = value
        # dotenv must not supply the live key: run from a copy without .env
        code = "import os, sys; sys.path.insert(0, %r); os.chdir(%r); import main; print('KEY=' + main.SECRET_KEY)" % (HERE, work)
        out = subprocess.run([sys.executable, "-c", code], cwd=work, env=env, capture_output=True, text=True, timeout=120)
        line = [l for l in out.stdout.splitlines() if l.startswith("KEY=")]
        return (line[0][4:] if line else None), out.stdout + out.stderr
    finally:
        shutil.rmtree(work, ignore_errors=True)


def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail[-300:],)))
    if not ok:
        fails.append(label)


k, log = key_for(GOOD)
check(k == GOOD, "a proper key from the environment is used unchanged", log)
for label, value in (("missing", None), ("published default", PUBLISHED), ("too short", "short-key")):
    k, log = key_for(value)
    check(k is not None and k not in (PUBLISHED, "short-key", "") and len(k) >= 32, label + " -> random key, never the published one", log)
    check("SECURITY: SECRET_KEY" in log, label + " -> logged loudly", log)
a, _ = key_for(None)
b, _ = key_for(None)
check(a != b, "the random key differs per process (not a new fixed default)")

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % len(fails)))
sys.exit(1 if fails else 0)
