# -*- coding: utf-8 -*-
"""SHARED SECRETS ARE COMPARED IN CONSTANT TIME

The service token (proxy -> Event Manager) and the registration webhook secret
are checked with `_secret_equal`, which compares UTF-8 bytes with
`hmac.compare_digest`. Comparing bytes rather than str matters: for a str that
is not pure ASCII `compare_digest` raises TypeError, so a junk header used to
surface as a 500 instead of a clean 403.

This checks the helper, both guards (with fictional secrets and a fake request
object -- no server, no network) and a source tripwire that no `==`/`!=` is
used against those secrets.

Runs against its own empty temporary database; the live database is never
opened.
Run:  python3 event-manager/backend/test_constant_time_secrets.py
"""
import asyncio
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = tempfile.mkdtemp(prefix="gaia-ct-secrets-")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(WORK, "test.db")
# Fictional values, set before main is imported (it reads them at import).
SVC = "svc-" + "a1b2c3d4" * 5
HOOK = "hook-" + "z9y8x7w6" * 4
os.environ["IDENTITY_SERVICE_TOKEN"] = SVC
os.environ["REGISTRATION_WEBHOOK_SECRET"] = HOOK

sys.path.insert(0, HERE)
os.chdir(WORK)
import main                                                 # noqa: E402
from fastapi import HTTPException                           # noqa: E402

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)


class FakeRequest(object):
    def __init__(self, headers=None, query=None):
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}
        self.query_params = dict(query or {})

    async def body(self):  # only reached once auth has passed
        return b"{}"


def status_of(fn):
    try:
        fn()
        return 200
    except HTTPException as e:
        return e.status_code
    except Exception as e:  # noqa: BLE001
        return "raised %s" % type(e).__name__


try:
    eq = main._secret_equal
    print("helper")
    check(eq("abc", "abc") is True, "equal strings match")
    check(eq("abd", "abc") is False, "different strings do not match")
    check(eq("ab", "abc") is False, "a prefix does not match")
    check(eq("abcd", "abc") is False, "a longer value does not match")
    check(eq("", "") is False, "empty expected never matches (empty supplied)")
    check(eq("x", "") is False, "empty expected never matches")
    check(eq("x", None) is False, "missing expected never matches")
    check(eq(None, "abc") is False, "missing supplied does not match")
    check(eq("café", "café") is True, "non-ASCII equal values match")
    check(eq("ééé", "abc") is False, "non-ASCII supplied is a clean mismatch, not TypeError")
    check(eq(b"abc", "abc") is True, "bytes and str compare by UTF-8 bytes")

    print("service token guard")
    rst = main.require_service_token
    check(status_of(lambda: rst(FakeRequest({"Authorization": "Bearer " + SVC}))) == 200, "right bearer accepted")
    check(status_of(lambda: rst(FakeRequest({"Authorization": "bearer " + SVC}))) == 200, "bearer prefix stays case-insensitive")
    check(status_of(lambda: rst(FakeRequest({"Authorization": "Bearer " + SVC[:-1]}))) == 403, "wrong bearer refused")
    check(status_of(lambda: rst(FakeRequest({}))) == 403, "no header refused")
    check(status_of(lambda: rst(FakeRequest({"Authorization": "Bearer éé"}))) == 403, "non-ASCII bearer -> 403, not 500")
    saved = main.IDENTITY_SERVICE_TOKEN
    main.IDENTITY_SERVICE_TOKEN = ""
    check(status_of(lambda: rst(FakeRequest({"Authorization": "Bearer "}))) == 503, "unset token still fails closed (503)")
    main.IDENTITY_SERVICE_TOKEN = saved

    print("registration webhook guard")
    def hook(req):
        return asyncio.run(main.registration_webhook(req, db=None))
    check(status_of(lambda: hook(FakeRequest({"X-Gaia-Secret": HOOK[:-1]}))) == 403, "wrong header secret refused")
    check(status_of(lambda: hook(FakeRequest(query={"secret": "nope"}))) == 403, "wrong ?secret= refused")
    check(status_of(lambda: hook(FakeRequest())) == 403, "no secret refused")
    check(status_of(lambda: hook(FakeRequest({"X-Gaia-Secret": "é"}))) == 403, "non-ASCII secret -> 403, not 500")
    # The right secret gets PAST auth (it then fails later on the fake db/body,
    # which is fine: anything but 403/503 shows the secret was accepted).
    got = status_of(lambda: hook(FakeRequest({"X-Gaia-Secret": HOOK})))
    check(got not in (403, 503), "right header secret passes auth", got)
    got = status_of(lambda: hook(FakeRequest(query={"secret": HOOK})))
    check(got not in (403, 503), "right ?secret= still passes auth", got)

    print("source tripwire")
    src = open(os.path.join(HERE, "main.py"), encoding="utf-8").read()
    names = r"(IDENTITY_SERVICE_TOKEN|REGISTRATION_WEBHOOK_SECRET)"
    bad = re.findall(r"(?:==|!=)\s*" + names + r"\b|\b" + names + r"\s*(?:==|!=)", src)
    check(not bad, "no ==/!= against the service secrets in main.py", bad)
    check("compare_digest(supplied, " not in src, "guards go through _secret_equal", "")
finally:
    shutil.rmtree(WORK, ignore_errors=True)

print("\n%d failure(s)" % len(fails) if fails else "\nall passed")
sys.exit(1 if fails else 0)
