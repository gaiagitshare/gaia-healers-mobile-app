# -*- coding: utf-8 -*-
"""WHO THE CONTROL CENTER MAY TREAT AS AN ADMINISTRATOR (PR 1, audit S1)

The Gaia Control Center accepts an Event Manager login as single sign-on. It
used to treat ANY valid Event token as an administrator, so the door and
check-in staff logins were Control Center admins. The Control Center now asks
this service, server to server, before trusting a token:

    GET /identity/staff/{user_id}/control-center   (service token required)

Only User.is_admin (the platform owner flag) answers yes; a per-event role,
door staff included, never does. The answer carries no name, email or roles.

Runs the real app against a brand-new EMPTY database with fictional staff --
no copy of the live database, no network.
Run:  python3 test_control_center_access.py
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = "test-identity-service-token-" + "y" * 16
work = tempfile.mkdtemp(prefix="cc-access-")
DB = os.path.join(work, "event.db")
os.environ["DATABASE_URL"] = "sqlite:///" + DB
os.environ["IDENTITY_SERVICE_TOKEN"] = SVC
sys.path.insert(0, HERE)

s = socket.socket(); s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]; s.close()
BASE = "http://127.0.0.1:%d" % PORT
env = dict(os.environ, DATABASE_URL="sqlite:///" + DB, IDENTITY_SERVICE_TOKEN=SVC)
proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "warning"],
                        cwd=HERE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
fails = []
try:
    deadline = time.time() + 40
    while time.time() < deadline:
        try:
            urllib.request.urlopen(BASE + "/events", timeout=2); break
        except urllib.error.HTTPError:
            break
        except Exception:
            time.sleep(0.25)

    import models                                   # noqa: E402
    from database import SessionLocal               # noqa: E402
    db = SessionLocal()
    owner = models.User(email="owner@example.invalid", hashed_password="x", full_name="Owner Example", is_admin=True)
    door = models.User(email="door@example.invalid", hashed_password="x", full_name="Door Example", is_admin=False)
    db.add_all([owner, door]); db.commit()
    ids = {"owner": owner.id, "door": door.id}
    db.close()

    def check(ok, label, detail=""):
        print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
        if not ok:
            fails.append(label)

    def get(path, token=None):
        req = urllib.request.Request(BASE + path, headers={"Authorization": "Bearer " + token} if token else {})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, None

    st, body = get("/identity/staff/%d/control-center" % ids["owner"], SVC)
    check(st == 200 and body == {"user_id": ids["owner"], "control_center_admin": True}, "platform admin -> yes, and nothing else in the answer", (st, body))
    st, body = get("/identity/staff/%d/control-center" % ids["door"], SVC)
    check(st == 200 and body["control_center_admin"] is False, "door staff -> no", (st, body))
    st, body = get("/identity/staff/999999/control-center", SVC)
    check(st == 200 and body["control_center_admin"] is False, "unknown user -> no", (st, body))
    st, _ = get("/identity/staff/%d/control-center" % ids["owner"])
    check(st == 403, "no service token -> refused", st)
    st, _ = get("/identity/staff/%d/control-center" % ids["owner"], "wrong-token-" + "z" * 30)
    check(st == 403, "wrong service token -> refused", st)
    st, _ = get("/identity/staff/abc/control-center", SVC)
    check(st == 422, "non-numeric id -> rejected", st)
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    shutil.rmtree(work, ignore_errors=True)

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % len(fails)))
sys.exit(1 if fails else 0)
