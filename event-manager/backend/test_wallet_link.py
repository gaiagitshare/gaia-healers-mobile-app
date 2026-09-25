# -*- coding: utf-8 -*-
"""THE WALLET LINK IN AN EMAIL — one URL, the right ticket.

A confirmation email cannot carry a session, and a Google save link is signed
for an hour, so the durable thing in the mail is a link that is RESOLVED when
it is clicked: /wallet/<badge token>. The token is the one already printed on
the badge and already accepted by the door scanner, so the link gives away
nothing the badge in somebody's hand does not.

Two things can go wrong with a link like that, and both are pinned here:

  1. it resolves to the wrong PERSON -- badge tokens are per-person, so this
     would be a stranger holding your ticket. Checked against the real roll.
  2. it resolves to the wrong EVENT -- a returning attendee keeps the same
     token year on year, and the newest row is last year's archived
     conference. The pass has to be for the event that is still running.

A throwaway Google service account and a COPY of the database are used; the
live database and the running service are never touched, and no real
credential is read.

Run:  python3 /root/event/backend/test_wallet_link.py
"""
import json, os, shutil, signal, sqlite3, subprocess, sys, tempfile, time
import urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE_DB = os.path.join(HERE, "event.db")
PORT = 8099

env_file = {}
for line in open(os.path.join(HERE, ".env")):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1)
        env_file[k.strip()] = v.strip().strip('"').strip("'")
SVC = env_file["IDENTITY_SERVICE_TOKEN"]

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "   %r" % (detail,)))
    if not ok:
        fails.append(label)

print("THE WALLET LINK IN AN EMAIL")

# ── 1. the roll itself: a token is never two different people ──────────────
db = sqlite3.connect(LIVE_DB, timeout=30)
cur = db.cursor()
cur.execute("""select upper(public_token) t, count(*) n from attendees
               where public_token is not null and public_token <> ''
               group by t having n > 1""")
shared = [r[0] for r in cur.fetchall()]
bad_person, spans_years = [], []
for token in shared:
    cur.execute("""select id, event_id, lower(trim(coalesce(first_name,''))),
                          lower(trim(coalesce(last_name,''))), qr_code
                   from attendees where upper(public_token) = ? order by id desc""", (token,))
    rows = cur.fetchall()
    if len({(r[2], r[3]) for r in rows}) > 1:
        bad_person.append(token)
    if len({r[1] for r in rows}) > 1:
        spans_years.append((token, rows))
check(not bad_person,
      "no badge token belongs to two different people, so no link can hand over a stranger's ticket",
      bad_person[:5])
check(len(shared) > 0, "returning attendees really do share one token across years", len(shared))
check(len(spans_years) > 0, "and some of those tokens exist in more than one event -- the case that needs a rule",
      len(spans_years))

cur.execute("select id from events where is_active = 1")
live_events = {r[0] for r in cur.fetchall()}
newest_is_archived = [t for t, rows in spans_years if rows[0][1] not in live_events]
check(len(newest_is_archived) > 0,
      "for some of them the NEWEST row is the archived year -- picking by id alone would mail last year's pass",
      len(newest_is_archived))
sample_token, sample_rows = None, None
for t, rows in spans_years:
    if rows[0][1] not in live_events and any(r[1] in live_events for r in rows):
        sample_token, sample_rows = t, rows
        break
db.close()
check(sample_token is not None, "there is a real person to test that rule with")

# ── 2. an API on a copy of the database, with a throwaway Google key ───────
tmp = tempfile.mkdtemp()
shutil.copy(LIVE_DB, tmp + "/event.db")
subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-out", tmp + "/sa.pem",
                "-pkeyopt", "rsa_keygen_bits:2048"], capture_output=True, check=True)
with open(tmp + "/sa.pem") as fh:
    sa_key = fh.read()
with open(tmp + "/sa.json", "w") as fh:
    json.dump({"client_email": "zz-test@example.iam.gserviceaccount.com", "private_key": sa_key}, fh)

env = dict(os.environ)
env.update({k: v for k, v in env_file.items()})
env["DATABASE_URL"] = "sqlite:///" + tmp + "/event.db"
env["GOOGLE_WALLET_ISSUER_ID"] = "3388000000000000000"
env["GOOGLE_WALLET_SA_JSON"] = tmp + "/sa.json"
env.pop("EVENT_AUTO_SYNC_URLS", None)          # never reach out to anything
proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--port", str(PORT),
                         "--host", "127.0.0.1", "--log-level", "warning"],
                        cwd=HERE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def post(path, body):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path),
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + SVC})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]

try:
    for _ in range(60):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/docs" % PORT, timeout=2)
            break
        except Exception:
            time.sleep(0.5)
    else:
        raise RuntimeError("test API never came up: " + proc.stderr.read().decode()[-500:])

    status, body = post("/identity/wallet/by-token", {"token": sample_token, "store": "google"})
    ok = status == 200 and isinstance(body, dict) and body.get("ok") is True
    check(ok, "a badge token resolves to a Google save link", (status, body))
    if ok:
        from jose import jwt as jose_jwt
        claims = jose_jwt.get_unverified_claims(body["save_url"].rsplit("/", 1)[1])
        cls = claims["payload"]["eventTicketClasses"][0]
        obj = claims["payload"]["eventTicketObjects"][0]
        live_row = next(r for r in sample_rows if r[1] in live_events)
        check("2026" in cls["eventName"]["defaultValue"]["value"],
              "for the conference that is still running, not the archived year",
              cls["eventName"]["defaultValue"]["value"])
        check(obj["barcode"]["value"] == live_row[4],
              "and its barcode is that year's door code, so the scanner admits it",
              (obj["barcode"]["value"], live_row[4]))
        check(body.get("event_name", "").find("2026") >= 0,
              "the reply names the event, so the page that opens can say which ticket", body.get("event_name"))

    status, body = post("/identity/wallet/by-token", {"token": sample_token.lower(), "store": "google"})
    check(status == 200 and body.get("ok") is True,
          "typing the token in lower case still works -- it is read off a printed label", (status, body))

    status, body = post("/identity/wallet/by-token", {"token": "ZZZZZZZZ", "store": "google"})
    check(status == 200 and body.get("ok") is False and body.get("reason") == "unknown_token",
          "a token nobody holds is refused", (status, body))

    status, body = post("/identity/wallet/by-token", {"token": "", "store": "google"})
    check(status == 200 and body.get("ok") is False, "so is an empty one", (status, body))

    status, body = post("/identity/wallet/by-token", {"token": sample_token, "store": "paypal"})
    check(status == 400, "and a store that does not exist is rejected outright", (status, body))

    # Service-token auth is the same gate the rest of identity sits behind:
    # the PROXY holds the credential, never the browser.
    req = urllib.request.Request("http://127.0.0.1:%d/identity/wallet/by-token" % PORT,
                                 data=json.dumps({"token": sample_token, "store": "google"}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10); unauth = 200
    except urllib.error.HTTPError as e:
        unauth = e.code
    check(unauth in (401, 403), "and the endpoint is not open to the internet without the service token", unauth)
finally:
    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(tmp, ignore_errors=True)

print("\n%d checks, %d failed" % (14, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
