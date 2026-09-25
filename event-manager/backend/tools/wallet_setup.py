# -*- coding: utf-8 -*-
"""Turn Google Wallet (or Apple Wallet) on, and prove it works.

    python3 tools/wallet_setup.py google --issuer 3388000000000000000 \
        --key /root/gaia-wallet-sa.json [--email someone@example.com] [--apply]

Without --apply it only checks: is the key readable, is it a service account,
does the issuer id look right, and what would the save link contain. With
--apply it writes the two entries into backend/.env, restarts the service, and
prints a REAL save link for one attendee so the whole path can be tested on a
phone before anyone else sees a button.

Nothing here talks to Google. A save link is signed locally; Google creates
the class and the object the first time somebody saves one.
"""
import argparse, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
ENV = os.path.join(HERE, ".env")


def env_set(pairs):
    """Write or replace keys in backend/.env, leaving everything else alone."""
    lines = open(ENV).read().splitlines() if os.path.isfile(ENV) else []
    for key, value in pairs.items():
        line = "%s=%s" % (key, value)
        for i, existing in enumerate(lines):
            if existing.split("=", 1)[0].strip() == key:
                lines[i] = line
                break
        else:
            lines.append(line)
    with open(ENV, "w") as fh:
        fh.write("\n".join(lines).rstrip() + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("store", choices=["google", "apple"])
    ap.add_argument("--issuer", help="Google Wallet issuer id (19 digits)")
    ap.add_argument("--key", help="service-account JSON (Google) or a directory of PEMs (Apple)")
    ap.add_argument("--pass-type-id"); ap.add_argument("--team-id")
    ap.add_argument("--email", help="whose ticket to issue as the test pass")
    ap.add_argument("--event", type=int, default=int(os.environ.get("VENDOR_SHEET_EVENT", "1")))
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    pairs = {}
    if args.store == "google":
        if not args.issuer or not args.key:
            raise SystemExit("need --issuer and --key")
        if not re.fullmatch(r"\d{15,25}", args.issuer.strip()):
            raise SystemExit("that issuer id is not a plain number — copy it from the Wallet console")
        if not os.path.isfile(args.key):
            raise SystemExit("no service-account file at %s" % args.key)
        sa = json.load(open(args.key))
        for field in ("client_email", "private_key", "type"):
            if not sa.get(field):
                raise SystemExit("%s is missing %r — is this the service-account key?" % (args.key, field))
        if sa.get("type") != "service_account":
            raise SystemExit("that key is a %r, not a service account" % sa.get("type"))
        print("service account : %s" % sa["client_email"])
        print("issuer id       : %s" % args.issuer.strip())
        print("→ that service account must be listed in the Google Wallet console for this issuer.")
        pairs = {"GOOGLE_WALLET_ISSUER_ID": args.issuer.strip(), "GOOGLE_WALLET_SA_JSON": args.key}
    else:
        need = {"APPLE_PASS_TYPE_ID": args.pass_type_id, "APPLE_TEAM_ID": args.team_id}
        if not all(need.values()) or not args.key:
            raise SystemExit("need --pass-type-id, --team-id and --key <dir with pass-cert.pem, pass-key.pem, wwdr.pem>")
        files = {"APPLE_PASS_CERT_PEM": "pass-cert.pem", "APPLE_PASS_KEY_PEM": "pass-key.pem",
                 "APPLE_WWDR_CERT_PEM": "wwdr.pem"}
        for var, name in files.items():
            path = os.path.join(args.key, name)
            if not os.path.isfile(path):
                raise SystemExit("missing %s" % path)
            need[var] = path
        pairs = need

    if not args.apply:
        print("\nDry run. Nothing was written. Re-run with --apply to switch it on.")
        return

    env_set(pairs)
    os.environ.update(pairs)
    subprocess.run(["systemctl", "restart", "gaia-event-manager"], check=False)
    print("\nWrote %s to backend/.env and restarted the service." % ", ".join(sorted(pairs)))

    import importlib, sqlite3
    import wallet
    importlib.reload(wallet)
    print("status now      : %s" % wallet.status())
    if not wallet.status()[args.store]:
        raise SystemExit("still not ready — check the values above")

    db = sqlite3.connect(os.path.join(HERE, "event.db")); db.row_factory = sqlite3.Row
    row = db.execute(
        "SELECT * FROM attendees WHERE event_id=? AND (?='' OR lower(email)=?) AND qr_code IS NOT NULL LIMIT 1",
        (args.event, (args.email or "").lower(), (args.email or "").lower())).fetchone()
    event = db.execute("SELECT * FROM events WHERE id=?", (args.event,)).fetchone()
    if not row or not event:
        print("No attendee to test with — pass --email of somebody on the list.")
        return

    class Obj:
        def __init__(self, r): self.__dict__.update({k: r[k] for k in r.keys()})
    att, ev = Obj(row), Obj(event)
    tt = db.execute("SELECT name FROM ticket_types WHERE id=?", (row["ticket_type_id"],)).fetchone()
    pass_name = tt["name"] if tt else "Ticket"
    print("\nTest pass for %s %s (%s)" % (row["first_name"], row["last_name"] or "", row["qr_code"]))
    if args.store == "google":
        print("\nOpen this on a phone and save it:\n\n%s\n"
              % wallet.google_save_url(att, ev, pass_name, event["location"] or ""))
    else:
        out = "/tmp/gaia-test-ticket.pkpass"
        with open(out, "wb") as fh:
            fh.write(wallet.apple_pkpass(att, ev, pass_name, event["location"] or ""))
        print("\nWrote %s — AirDrop or e-mail it to an iPhone to test.\n" % out)


if __name__ == "__main__":
    main()
