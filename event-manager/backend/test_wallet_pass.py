# -*- coding: utf-8 -*-
"""WALLET PASSES — the ticket on the lock screen.

A badge QR on a web page needs the app to open, the session to hold and the
signal to reach. A wallet pass needs none of those, which is why it exists.

Both stores need credentials only the organiser can obtain, so what is proved
here is everything up to them: the feature is INERT and says so while they are
missing, a .pkpass really is a signed PassKit bundle (built here against a
throwaway certificate, never a real one), the barcode carries the SAME value
the door scanner reads off a printed badge, and the Google link is a signed
save-to-wallet JWT with the class and the object inside it.

No event or attendee is created; nothing is written.
Run:  python3 /root/event/backend/test_wallet_pass.py
"""
import hashlib, importlib, io, json, os, subprocess, sys, tempfile, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wallet

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "   %r" % (detail,)))
    if not ok:
        fails.append(label)

class Ev:
    id = 1; name = "Gaia Healers Elevate Conference 2026"
    start_date = "2026-11-20T09:00:00"; end_date = "2026-11-22T18:00:00"
    location = "Rosen Shingle Creek, Orlando, FL"
    hero_image_url = "https://gaiahealers.app/assets/gaia-elevate-poster.jpg"

class At:
    id = 42; first_name = "Jane"; last_name = "Oelke"
    email = "jane@example.invalid"; qr_code = "ATT-2E8F766C178B"

print("WALLET PASSES")

# ── 1. inert until the organiser has set a store up ────────────────────────
for var in ("APPLE_PASS_TYPE_ID", "APPLE_TEAM_ID", "APPLE_PASS_CERT_PEM", "APPLE_PASS_KEY_PEM",
            "APPLE_WWDR_CERT_PEM", "GOOGLE_WALLET_ISSUER_ID", "GOOGLE_WALLET_SA_JSON"):
    os.environ.pop(var, None)
importlib.reload(wallet)
check(wallet.status() == {"apple": False, "google": False},
      "with no credentials both stores report themselves unavailable", wallet.status())
for fn, label in ((lambda: wallet.apple_pkpass(At, Ev, "VIP Pass", Ev.location), "apple"),
                  (lambda: wallet.google_save_url(At, Ev, "VIP Pass", Ev.location), "google")):
    try:
        fn(); ok = False
    except RuntimeError:
        ok = True
    check(ok, "and %s refuses to invent one rather than issuing something broken" % label)

# ── 2. a real, signed PassKit bundle (throwaway certificate) ───────────────
tmp = tempfile.mkdtemp()
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                "-keyout", tmp + "/key.pem", "-out", tmp + "/cert.pem",
                "-subj", "/CN=zz-pass-test"], capture_output=True, check=True)
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                "-keyout", tmp + "/wkey.pem", "-out", tmp + "/wwdr.pem",
                "-subj", "/CN=zz-wwdr-test"], capture_output=True, check=True)
os.environ.update({
    "APPLE_PASS_TYPE_ID": "pass.app.gaiahealers.zztest", "APPLE_TEAM_ID": "ZZTEAM1234",
    "APPLE_PASS_CERT_PEM": tmp + "/cert.pem", "APPLE_PASS_KEY_PEM": tmp + "/key.pem",
    "APPLE_WWDR_CERT_PEM": tmp + "/wwdr.pem",
})
importlib.reload(wallet)
check(wallet.status()["apple"] is True, "with a certificate in place Apple reports itself ready")
blob = wallet.apple_pkpass(At, Ev, "VIP Pass", Ev.location)
zf = zipfile.ZipFile(io.BytesIO(blob))
names = set(zf.namelist())
check({"pass.json", "manifest.json", "signature", "icon.png", "icon@2x.png", "logo.png"} <= names,
      "the .pkpass carries pass.json, the images, a manifest and a signature", sorted(names))
manifest = json.loads(zf.read("manifest.json"))
bad = [n for n, digest in manifest.items() if hashlib.sha1(zf.read(n)).hexdigest() != digest]
check(not bad, "every file in it hashes to what the manifest says", bad)
check(set(manifest) == names - {"manifest.json", "signature"},
      "and the manifest covers every file except itself and the signature", sorted(set(manifest) ^ (names - {"manifest.json", "signature"})))
sig = zf.read("signature")
check(len(sig) > 500 and sig[:1] == b"\x30", "the signature is DER PKCS#7, not an empty placeholder", len(sig))

body = json.loads(zf.read("pass.json"))
check(body["barcodes"][0]["message"] == At.qr_code,
      "the barcode carries the same code the door scanner reads off a printed badge", body["barcodes"][0])
check(body["passTypeIdentifier"] == "pass.app.gaiahealers.zztest" and body["teamIdentifier"] == "ZZTEAM1234",
      "the pass is issued under the organiser's own identifiers", (body["passTypeIdentifier"], body["teamIdentifier"]))
check(body["serialNumber"] == "gaia-1-42",
      "the serial is the person and the event, so re-issuing REPLACES rather than adds", body["serialNumber"])
check(body.get("relevantDate") == Ev.start_date and body.get("expirationDate") == Ev.end_date,
      "it surfaces on the lock screen for the event and expires with it", (body.get("relevantDate"), body.get("expirationDate")))
fields = body["eventTicket"]
check(any(f["value"] == "Jane Oelke" for f in fields["secondaryFields"])
      and any(f["value"] == "VIP Pass" for f in fields["headerFields"]),
      "and it names the holder and the pass they bought", fields)

# ── 3. Google: a signed save-to-wallet link ────────────────────────────────
subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-out", tmp + "/sa.pem",
                "-pkeyopt", "rsa_keygen_bits:2048"], capture_output=True, check=True)
with open(tmp + "/sa.pem") as fh:
    sa_key = fh.read()
with open(tmp + "/sa.json", "w") as fh:
    json.dump({"client_email": "zz-test@example.iam.gserviceaccount.com", "private_key": sa_key}, fh)
os.environ["GOOGLE_WALLET_ISSUER_ID"] = "3388000000000000000"
os.environ["GOOGLE_WALLET_SA_JSON"] = tmp + "/sa.json"
importlib.reload(wallet)
check(wallet.status()["google"] is True, "with an issuer and a key Google reports itself ready")
url = wallet.google_save_url(At, Ev, "VIP Pass", Ev.location)
check(url.startswith("https://pay.google.com/gp/v/save/"), "the link is a save-to-Google-Wallet URL", url[:60])
from jose import jwt as jose_jwt
claims = jose_jwt.get_unverified_claims(url.rsplit("/", 1)[1])
check(claims["typ"] == "savetowallet" and claims["aud"] == "google", "carrying a savetowallet JWT", claims.get("typ"))
obj = claims["payload"]["eventTicketObjects"][0]
cls = claims["payload"]["eventTicketClasses"][0]
check(obj["barcode"]["value"] == At.qr_code, "with the same door code in its barcode", obj["barcode"])
check(obj["ticketHolderName"] == "Jane Oelke" and cls["eventName"]["defaultValue"]["value"] == Ev.name,
      "the holder's name and the event on the class it creates", (obj["ticketHolderName"], cls["eventName"]))
check(obj["id"].startswith("3388000000000000000.") and cls["id"].startswith("3388000000000000000."),
      "both namespaced under the organiser's issuer id", (obj["id"], cls["id"]))
# A pass with no logo and no artwork is a grey rectangle in a wallet full of
# branded ones, and the save link fails quietly when the page it opens from is
# not declared as an origin.
check(cls.get("logo", {}).get("sourceUri", {}).get("uri", "").startswith("https://"),
      "the class carries the Gaia logo", cls.get("logo"))
check(cls.get("heroImage", {}).get("sourceUri", {}).get("uri", "") == Ev.hero_image_url,
      "and the event's own artwork", cls.get("heroImage"))
check(cls["venue"]["name"]["defaultValue"]["value"] == Ev.location
      and cls["dateTime"]["start"] == Ev.start_date,
      "with the venue and the dates on it", (cls.get("venue"), cls.get("dateTime")))
check("https://gaiahealers.app" in claims["origins"] and "https://www.gaiahealers.app" in claims["origins"],
      "and every origin the save link may be opened from", claims["origins"])

subprocess.run(["rm", "-rf", tmp])
print("\n%d checks, %d failed" % (21, len(fails)))
if fails:
    print("FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
