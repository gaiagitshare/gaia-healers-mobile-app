"""Test-only helper: answer a held correction like a second admin would.

Since 10 Nov 2026 a sensitive correction made by an organiser or admin is not
applied: it is filed as a proposal (409, "needs a second admin's approval ...
proposal #N"). The suites written before that exercise the corrections
themselves, so for them this helper plays the second admin: it approves the
proposal through the real Approvals endpoint, with a separate admin account,
and hands the suite the response the original endpoint gives once approved.

Nothing here is imported by the server. Suites that test the approval rule
itself (test_four_eyes.py, test_email_center_fix.py) do not install it.
"""
import io
import json
import re
import sqlite3
import urllib.error
import urllib.request

_installed = {}
_HELD = re.compile(r"second admin's approval.*?proposal #(\d+)", re.S)


class _Resp(object):
    def __init__(self, status, body):
        self.status = status
        self._b = body
        self.headers = {"Content-Type": "application/json"}

    def read(self, *a):
        b, self._b = self._b, b""
        return b

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _approver(db_path, main_mod):
    if "approver" in _installed:
        return _installed["approver"]
    c = sqlite3.connect(db_path, timeout=60)
    row = c.execute("select id from users where email='zz-second-admin@example.invalid'").fetchone()
    uid = row[0] if row else c.execute(
        "insert into users(email,hashed_password,full_name,is_admin,created_at) values(?,?,?,?,datetime('now'))",
        ("zz-second-admin@example.invalid", "x", "ZZ Second Admin", 1)).lastrowid
    c.commit()
    c.close()
    tok = main_mod.create_access_token({"sub": str(uid)})
    _installed["approver"] = tok
    return tok


def install(base, db_path):
    if _installed.get("on"):
        _installed["targets"].append((base, db_path))
        return
    orig = urllib.request.urlopen
    _installed.update(on=True, targets=[(base, db_path)], orig=orig)

    def urlopen(req, *a, **kw):
        try:
            return orig(req, *a, **kw)
        except urllib.error.HTTPError as e:
            if e.code != 409:
                raise
            body = e.read()
            m = _HELD.search(body.decode("utf-8", "replace"))
            url = req.full_url if hasattr(req, "full_url") else str(req)
            tgt = next(((b, d) for b, d in _installed["targets"] if url.startswith(b)), None)
            if not m or tgt is None:
                raise urllib.error.HTTPError(e.url, e.code, e.msg, e.hdrs, io.BytesIO(body))
            pid = int(m.group(1))
            base_, db_ = tgt
            import main as main_mod
            c = sqlite3.connect(db_, timeout=60)
            ev = c.execute("select event_id from recon_proposals where id=?", (pid,)).fetchone()[0]
            c.close()
            dreq = urllib.request.Request(base_ + "/events/%d/email-center/proposals/%d/decide" % (ev, pid),
                                          data=json.dumps({"decision": "approve", "note": "second admin (test)"}).encode(),
                                          method="POST", headers={"Content-Type": "application/json",
                                                                  "Authorization": "Bearer " + _approver(db_, main_mod)})
            try:
                with orig(dreq, timeout=300) as r:
                    out = json.loads(r.read().decode() or "{}")
            except urllib.error.HTTPError as e2:
                if e2.code == 409:      # already applied by an earlier identical call
                    raise urllib.error.HTTPError(e.url, 409, e.msg, e.hdrs, io.BytesIO(body))
                raise
            res = (out.get("results") or [{}])[-1]
            if res.get("state") == "failed":
                det = res.get("error")
                raise urllib.error.HTTPError(e.url, int(res.get("status") or 409), "held", e.hdrs,
                                             io.BytesIO(json.dumps({"detail": det}).encode()))
            return _Resp(200, json.dumps(res.get("response", {"ok": True})).encode())

    urllib.request.urlopen = urlopen
