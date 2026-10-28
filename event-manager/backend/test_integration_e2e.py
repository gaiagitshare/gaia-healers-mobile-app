# -*- coding: utf-8 -*-
"""INTEGRATIONS, END TO END — every source reaches the Event Manager and the public pages.

Proves the CONNECTIONS (not the data) with controlled test records, on staging
only: a throwaway copy of the Event Manager, the real staging proxy (webhooks,
API), the real sync scripts, and fake GHL / Shopify servers holding test orders.
Nothing real is called: no GHL, no Shopify, no Google, no production service.

Flows:
  F1  GHL purchase  -> webhook (proxy)       -> Event Manager            real time
  F2  GHL purchase  -> 15-min recovery pass  -> Event Manager            webhook never sent
  F3  GHL outage    -> recovery pass fails loudly; recovers next run
  F4  Shopify order -> signed webhook (proxy) -> Event Manager           real time
  F5  Shopify order -> 15-min backstop        -> Event Manager
  F6  Planning sheet: new exhibitor + changed booth -> Event Manager -> public directory + website embed
  F7  Planning sheet: new speaker -> Event Manager
  F8  Agenda page   -> Event Manager -> public agenda + website embed; an edit propagates
  F9  Event Manager -> app feed (proxy /api/events)
  F10 Monitoring: last-success status written; failures and webhook gaps raise alerts

Run:  python3 /root/event/backend/test_integration_e2e.py
"""
import base64, csv, hashlib, hmac, io, json, os, shutil, socket, sqlite3, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY = os.environ.get("PROXY_DIR", "/root/gaia-healers-mobile-app-1/staging-proxy")
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "tools"))
env = {}
for line in open(os.path.join(HERE, ".env")):
    s = line.strip()
    if "=" in s and not s.startswith("#"):
        k, v = s.split("=", 1); env[k] = v.strip().strip('"').strip("'")
from jose import jwt
ADMIN = jwt.encode({"sub": "1"}, env["SECRET_KEY"], algorithm="HS256")
SVC = env["IDENTITY_SERVICE_TOKEN"]
import testbed
import vendor_sheet as vs
BASE, DB = testbed.start()
WORK = tempfile.mkdtemp(prefix="e2e-")

fails = 0
def check(cond, label, extra=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else ("   " + str(extra)[:600])))
    if not cond: fails += 1

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def http(method, url, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items(): req.add_header(k, v)
    if data is not None and "Content-Type" not in (headers or {}): req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()

def roll(email):
    c = sqlite3.connect(DB)
    return c.execute("SELECT id, ticket_type_id FROM attendees WHERE event_id=1 AND lower(email)=?", (email,)).fetchall()

NOW = datetime.now(timezone.utc).replace(microsecond=0)
ISO = NOW.isoformat().replace("+00:00", "Z")
VIP, GA = "69b461f512895312b36276de", "68755fe707a26368c72395d6"

# ── fake GHL ────────────────────────────────────────────────────────────────
def ghl_order(oid, email, pid, name, price):
    return {"_id": oid, "status": "completed", "createdAt": ISO, "contactEmail": email, "contactName": "Zz E2e",
            "contactId": "c-" + oid, "amount": price,
            "items": [{"product": {"_id": pid, "name": name}, "qty": 1, "price": {"amount": price}}],
            "contactSnapshot": {"email": email, "firstName": "Zz", "lastName": "E2e"}}
GHL = {"down": False,
       "orders": {"e2e-ord-A": ghl_order("e2e-ord-A", "zz-e2e-ghl-webhook@example.invalid", VIP, "VIP PASS", 1058.94),
                  "e2e-ord-B": ghl_order("e2e-ord-B", "zz-e2e-ghl-recovery@example.invalid", GA, "GA", 104.94)}}
def ghl_tx(oid):
    o = GHL["orders"][oid]
    return {"_id": "tx-" + oid, "status": "succeeded", "entityType": "order", "entityId": oid, "contactId": o["contactId"],
            "contactEmail": o["contactEmail"], "contactName": o["contactName"], "amount": o["amount"],
            "createdAt": ISO, "updatedAt": ISO, "paymentProviderType": "stripe", "liveMode": True, "currency": "USD"}

class FakeGhl(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if GHL["down"]:
            self.send_response(503); self.end_headers(); return
        path = self.path.split("?")[0]
        if path.startswith("/payments/orders/"):
            o = GHL["orders"].get(path.rsplit("/", 1)[1]); body = o or {}
        elif path == "/payments/orders":
            body = {"data": [{k: v for k, v in o.items() if k != "items"} for o in GHL["orders"].values()]}
        elif path == "/payments/transactions":
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            off = int((q.get("offset") or ["0"])[0])
            txs = [ghl_tx(k) for k in GHL["orders"]]
            if q.get("contactId"): txs = [t for t in txs if t["contactId"] == q["contactId"][0]]
            body = {"data": txs if off == 0 else []}
        elif path.startswith("/invoices"):
            body = {"invoices": []}
        elif path.startswith("/contacts/"):
            body = {"contact": {"id": path.rsplit("/", 1)[1], "email": ""}}
        else:
            body = {}
        out = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(out)

# ── fake Shopify ────────────────────────────────────────────────────────────
SHOP = {"orders": []}
def shop_order(oid, email, pid, price):
    return {"id": oid, "email": email, "financial_status": "paid", "processed_at": ISO, "total_price": str(price),
            "customer": {"first_name": "Zz", "last_name": "Shop"},
            "line_items": [{"product_id": pid, "title": "Elevate", "price": str(price), "quantity": 1, "tax_lines": [], "discount_allocations": []}]}
class FakeShopify(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        out = json.dumps({"orders": SHOP["orders"]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(out)

import urllib.parse
gp, sp, pp = free_port(), free_port(), free_port()
for port, handler in ((gp, FakeGhl), (sp, FakeShopify)):
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
GHL_BASE, SHOP_BASE, PROXY_BASE = "http://127.0.0.1:%d" % gp, "http://127.0.0.1:%d/admin/api/2024-10" % sp, "http://127.0.0.1:%d" % pp
WEBHOOK_SECRET, SHOP_SECRET = "e2e-ghl-secret", "e2e-shop-secret"

# ── staging proxy ───────────────────────────────────────────────────────────
pdata = os.path.join(WORK, "proxy"); os.makedirs(os.path.join(pdata, "data"))
penv = {"PATH": os.environ["PATH"], "HOME": WORK, "PORT": str(pp), "HOST": "127.0.0.1", "NODE_ENV": "test",
        "MEMBER_ENTITLEMENTS_FILE": os.path.join(pdata, "data", "tmp-member-entitlements.json"),
        "GHL_API_BASE_URL": GHL_BASE, "GHL_API_TOKEN": "e2e", "GHL_LOCATION_ID": "LOC-E2E",
        "EVENT_MANAGER_BASE_URL": BASE, "IDENTITY_SERVICE_TOKEN": SVC, "REGISTRATION_WEBHOOK_SECRET": WEBHOOK_SECRET,
        "SHOPIFY_WEBHOOK_SECRET": SHOP_SECRET, "STORE_SYNC_ENABLED": "false", "CONTACT_MERGE_SCAN": "false",
        "SESSION_SECRET": "e2e-session-secret-0123456789abcdef", "GAIA_ADMIN_PASSWORD": "e2e",
        # throwaway values; the proxy refuses to boot without them
        "AUTH_SESSION_SECRET": "e2e-auth-session-secret-0123456789abcdef",
        "COURSES_SYNC_SECRET": "e2e-courses-sync-secret-0123456789abcdef",
        "GHL_BACKFILL_SECRET": "e2e-ghl-backfill-secret-0123456789abcdef"}
plog = open(os.path.join(WORK, "proxy.log"), "w")
proxy = subprocess.Popen(["node", os.path.join(PROXY, "server.js")], cwd=pdata, env=penv, stdout=plog, stderr=subprocess.STDOUT)
for _ in range(60):
    try:
        if http("GET", PROXY_BASE + "/api/events")[0] in (200, 502, 503): break
    except Exception: pass
    time.sleep(0.5)

mirror_env_file = os.path.join(WORK, "mirror.env")
open(mirror_env_file, "w").write("GHL_LOCATION_ID=LOC-E2E\nGHL_API_TOKEN=e2e\nEVENT_MANAGER_BASE_URL=%s\nIDENTITY_SERVICE_TOKEN=%s\n" % (BASE, SVC))
MIRROR_STATUS = os.path.join(WORK, "proxy-data", "event-mirror-status.json"); os.makedirs(os.path.dirname(MIRROR_STATUS))
def run_mirror(**extra):
    e = dict(os.environ, EVENT_MIRROR_ENV_FILE=mirror_env_file, EVENT_MIRROR_GHL_BASE=GHL_BASE,
             EVENT_MIRROR_STATUS_FILE=MIRROR_STATUS, **extra)
    return subprocess.run(["node", os.path.join(PROXY, "event-mirror.mjs")], env=e, capture_output=True, text=True, timeout=300)

try:
    print("INTEGRATIONS, END TO END")
    if proxy.poll() is not None:
        plog.flush(); print(open(os.path.join(WORK, "proxy.log")).read()[-1500:]); raise SystemExit(1)
    st, _ = http("GET", PROXY_BASE + "/api/events")
    check(st == 200, "the staging proxy is up and talks to the Event Manager copy", st)

    print("\n== F1  GHL purchase -> webhook -> Event Manager (real time) ==")
    st, body = http("POST", PROXY_BASE + "/api/webhooks/ghl-payment", {"transaction_id": "tx-e2e-ord-A", "contact_id": "c-e2e-ord-A"},
                    headers={"x-gaia-secret": WEBHOOK_SECRET})
    got = roll("zz-e2e-ghl-webhook@example.invalid")
    check(st == 200 and len(got) == 1 and got[0][1] == 4,
          "the order became a VIP attendee within the request", (st, body[:300], got))
    st, _ = http("POST", PROXY_BASE + "/api/webhooks/ghl-payment", {"transaction_id": "tx-e2e-ord-A"}, headers={"x-gaia-secret": "wrong"})
    check(st == 403, "a webhook without the shared secret is refused", st)

    print("\n== F2  GHL purchase the webhook never delivered -> recovery pass ==")
    r = run_mirror()
    check(r.returncode == 0 and len(roll("zz-e2e-ghl-recovery@example.invalid")) == 1,
          "the 15-minute pass recorded it", (r.returncode, r.stdout[-400:], r.stderr[-300:]))
    status = json.load(open(MIRROR_STATUS))
    check(status.get("reconciled", 0) >= 1 and status.get("at"), "and wrote its last-success status (with the miss counted)", status)

    print("\n== F3  GHL outage -> fails loudly, then recovers ==")
    GHL["down"] = True
    r = run_mirror()
    check(r.returncode != 0 and '"phase":"error"' in r.stdout.replace(" ", ""), "the pass exits non-zero (the unit is marked failed)", (r.returncode, r.stdout[-300:]))
    GHL["down"] = False
    GHL["orders"]["e2e-ord-C"] = ghl_order("e2e-ord-C", "zz-e2e-ghl-after-outage@example.invalid", GA, "GA", 104.94)
    r = run_mirror()
    check(r.returncode == 0 and len(roll("zz-e2e-ghl-after-outage@example.invalid")) == 1, "the next pass catches up on the sale made during the outage",
          (r.returncode, r.stderr[-300:]))

    print("\n== F4  Shopify order -> signed webhook -> Event Manager (real time) ==")
    st, body = http("POST", BASE + "/events/1/ticket-mappings", {"provider": "shopify", "external_product_id": "8800001", "ticket_type_id": 4,
                    "is_upgrade": False, "label": "E2E Shopify VIP", "entitlement_type": "EVENT_TICKET"},
                    headers={"Authorization": "Bearer " + ADMIN})
    check(st in (200, 201), "a Shopify product is mapped to a ticket (provider = shopify)", (st, body[:300]))
    order = shop_order(5550001, "zz-e2e-shop-webhook@example.invalid", 8800001, 999)
    raw = json.dumps(order).encode()
    sig = base64.b64encode(hmac.new(SHOP_SECRET.encode(), raw, hashlib.sha256).digest()).decode()
    st, body = http("POST", PROXY_BASE + "/api/webhooks/shopify-order", raw=raw,
                    headers={"Content-Type": "application/json", "X-Shopify-Hmac-Sha256": sig, "X-Shopify-Topic": "orders/paid"})
    check(st == 200 and len(roll("zz-e2e-shop-webhook@example.invalid")) == 1, "the Shopify buyer is an attendee within the request", (st, body[:300]))
    st, _ = http("POST", PROXY_BASE + "/api/webhooks/shopify-order", raw=raw,
                 headers={"Content-Type": "application/json", "X-Shopify-Hmac-Sha256": "bad"})
    check(st == 401, "an unsigned Shopify webhook is refused", st)

    print("\n== F5  Shopify order -> 15-minute backstop ==")
    SHOP["orders"] = [shop_order(5550002, "zz-e2e-shop-backstop@example.invalid", 8800001, 999)]
    r = run_mirror(SHOPIFY_STORE_DOMAIN="e2e.myshopify.com", SHOPIFY_ADMIN_TOKEN="e2e", SHOPIFY_API_BASE=SHOP_BASE)
    check(r.returncode == 0 and len(roll("zz-e2e-shop-backstop@example.invalid")) == 1, "the backstop recorded the Shopify order",
          (r.returncode, r.stdout[-400:], r.stderr[-300:]))

    print("\n== F6  Planning sheet -> exhibitors -> directory + website ==")
    rows = list(csv.reader(io.StringIO(vs.fetch_csv())))
    hi = next(i for i, r in enumerate(rows) if "Company Name" in [c.strip() for c in r])
    hdr = [c.strip() for c in rows[hi]]
    ci, bi = hdr.index("Company Name"), hdr.index("Booth #")
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    pub = c.execute("SELECT id, company_name FROM exhibitors WHERE event_id=1 AND is_published=1 AND stage='confirmed' ORDER BY id LIMIT 1").fetchone()
    pi = next(i for i, r in enumerate(rows) if i > hi and len(r) > ci and vs.norm_name(r[ci]) == vs.norm_name(pub["company_name"]))
    rows[pi][bi] = "#77"
    new = list(rows[pi]); new[ci] = "ZZ E2E Stand"; new[bi] = "#78"
    rows.insert(pi + 1, new)
    sheet_csv = os.path.join(WORK, "sheet.csv")
    with open(sheet_csv, "w", newline="") as f: csv.writer(f).writerows(rows)
    r = subprocess.run([sys.executable, os.path.join(HERE, "tools", "vendor_sync.py"), "--apply", sheet_csv],
                       env=dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=WORK), capture_output=True, text=True, timeout=180)
    c = sqlite3.connect(DB)
    check(r.returncode in (0, 3) and c.execute("SELECT count(*) FROM exhibitors WHERE company_name='ZZ E2E Stand'").fetchone()[0] == 1,
          "a new sheet row is a new exhibitor (unpublished until set up)", (r.returncode, r.stderr[-300:]))
    st, body = http("GET", BASE + "/public/events/1/exhibitors")
    mine = [x for x in json.loads(body) if x["id"] == pub["id"]]
    check(mine and mine[0].get("booth_number") == "77", "a changed booth reaches the public directory", mine)
    st, html = http("GET", BASE + "/public/events/1/embed/exhibitors")
    check(st == 200 and "Booth 77" in html, "and the website embed", st)

    print("\n== F7  Planning sheet -> speakers ==")
    import speaker_sheet as ss
    srows = list(csv.reader(io.StringIO(ss.fetch())))
    shi = next(i for i, r in enumerate(srows) if ss.HEADERS["name"] in [h.strip() for h in r])
    nci = [h.strip() for h in srows[shi]].index(ss.HEADERS["name"])
    add = list(srows[shi + 1]); add[nci] = "Zz E2e Speaker"
    srows.insert(shi + 1, add)
    scsv = os.path.join(WORK, "speakers.csv")
    with open(scsv, "w", newline="") as f: csv.writer(f).writerows(srows)
    r = subprocess.run([sys.executable, os.path.join(HERE, "tools", "speaker_sync.py"), "--apply", scsv],
                       env=dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=WORK), capture_output=True, text=True, timeout=180)
    check(r.returncode == 0 and c.execute("SELECT count(*) FROM speakers WHERE name='Zz E2e Speaker'").fetchone()[0] == 1,
          "a new sheet speaker reaches the Event Manager", (r.returncode, r.stdout[-300:], r.stderr[-300:]))

    print("\n== F7b Speaker page -> Event Manager -> public speakers + website ==")
    epage = os.path.join(HERE, "fixtures", "event-page-2026-10-28.html")
    senv = dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=WORK, SPEAKER_PAGE_PUBLISH="1")
    r = subprocess.run([sys.executable, os.path.join(HERE, "tools", "speaker_page_sync.py"), "--apply", epage], env=senv, capture_output=True, text=True)
    st, body = http("GET", BASE + "/public/events/1/speakers")
    names = [x["name"] for x in json.loads(body)] if st == 200 else []
    check(r.returncode == 0 and "Martha Carlin" in names and "Dr. Davis" in names, "speakers on the page are published to the public API", (r.returncode, names))
    html = open(epage, encoding="utf-8").read().replace("Preventive Cardiology", "Preventive Cardiology (E2E)")
    i = html.find('<div class="spk-card">')
    html = html[:i] + ('<div class="spk-card"><div class="spk-img"><img src="https://example.invalid/e2e.png" alt=""></div>'
                       '<div class="spk-info"><div class="spk-name">Zz E2e Keynote</div><div class="spk-topic">Flows</div>'
                       '<p class="spk-bio">Added.</p></div></div>') + html[i:]
    ep2 = os.path.join(WORK, "event2.html"); open(ep2, "w", encoding="utf-8").write(html)
    subprocess.run([sys.executable, os.path.join(HERE, "tools", "speaker_page_sync.py"), "--apply", ep2], env=senv, capture_output=True, text=True)
    st, emb = http("GET", BASE + "/public/events/1/embed/speakers")
    check(st == 200 and "Zz E2e Keynote" in emb, "a speaker added to the page reaches the website embed", st)

    print("\n== F8  Agenda page -> Event Manager -> public agenda + website ==")
    page = os.path.join(HERE, "fixtures", "agenda-page-2026-10-28.html")
    aenv = dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=WORK, AGENDA_PAGE_PUBLISH="1")
    r = subprocess.run([sys.executable, os.path.join(HERE, "tools", "agenda_page_sync.py"), "--apply", page], env=aenv, capture_output=True, text=True)
    st, body = http("GET", BASE + "/public/events/1/agenda")
    days = json.loads(body).get("days") if st == 200 else None
    check(r.returncode == 0 and days and len(days) == 3, "the agenda reaches the public agenda (3 days)", (r.returncode, st, body[:200]))
    c = sqlite3.connect(DB)
    leaders = [n for (n,) in c.execute("SELECT name FROM speakers WHERE name IN ('Master Masaji','Tiffany Cagwin','Jai Karter')")]
    check(len(leaders) == 3, "workshop leaders named only on the agenda become speakers", leaders)
    edited = open(page, encoding="utf-8").read().replace("Sonic Frequency Therapy", "Sonic Frequency Therapy (E2E edit)")
    page2 = os.path.join(WORK, "page2.html"); open(page2, "w", encoding="utf-8").write(edited)
    subprocess.run([sys.executable, os.path.join(HERE, "tools", "agenda_page_sync.py"), "--apply", page2], env=aenv, capture_output=True, text=True)
    st, html = http("GET", BASE + "/public/events/1/embed/agenda")
    check(st == 200 and "Sonic Frequency Therapy (E2E edit)" in html, "an edit on the page reaches the website embed", st)

    print("\n== F8b Event website (tickets, packages, FAQ, hotel) + exhibitor block -> Event Manager -> app ==")
    pkgpage = os.path.join(HERE, "fixtures", "exhibitors-and-speakers-page-2026-10-28.html")
    wenv = dict(os.environ, DATABASE_URL="sqlite:///" + DB, VENDOR_SYNC_DATA=WORK, EXHIBITOR_PAGE_PUBLISH="1")
    r = subprocess.run([sys.executable, os.path.join(HERE, "tools", "event_site_sync.py"), "--apply", epage, pkgpage],
                       env=wenv, capture_output=True, text=True)
    st, body = http("GET", BASE + "/public/events/1/site")
    site0 = json.loads(body) if st == 200 else {}
    check(r.returncode == 0 and len(site0.get("tickets", [])) == 4 and len(site0.get("packages", [])) == 4
          and len(site0.get("faq", [])) == 12 and len(site0.get("hotel", [])) == 1,
          "tickets, packages, FAQ and hotel reach the Event Manager", (r.returncode, {k: len(v) for k, v in site0.items() if isinstance(v, list)}))
    edited = open(pkgpage, encoding="utf-8").read().replace('<span class="ph-pkg-price">$3,500</span>', '<span class="ph-pkg-price">$3,700</span>', 1)
    pk2 = os.path.join(WORK, "packages2.html"); open(pk2, "w", encoding="utf-8").write(edited)
    subprocess.run([sys.executable, os.path.join(HERE, "tools", "event_site_sync.py"), "--apply", epage, pk2], env=wenv, capture_output=True, text=True)
    r = subprocess.run([sys.executable, os.path.join(HERE, "tools", "exhibitor_page_sync.py"), "--apply", epage], env=wenv, capture_output=True, text=True)
    st, body = http("GET", PROXY_BASE + "/api/events/1")
    app = json.loads(body) if st == 200 else {}
    pk = {p["title"]: p for p in (app.get("site") or {}).get("packages", [])}
    check(st == 200 and pk.get("The Ambassador", {}).get("price") == "$3,700", "a price changed on the website reaches the app feed", (st, pk.get("The Ambassador")))
    tk = (app.get("site") or {}).get("tickets", [])
    check(len(tk) == 4 and all(t.get("url", "").startswith("https://") and "gaiahealers.com" in t["url"] for t in tk),
          "the app's ticket buttons carry an official GHL checkout link", [t.get("url") for t in tk])
    cats = {sp.get("name"): sp.get("category") for sp in app.get("sponsors", [])}
    check(r.returncode == 0 and cats.get("LifeWave") == "Premium Sponsor" and cats.get("Manta Sleep") == "Gifted to You By",
          "sponsors from the website's exhibitor block reach the app with their website category", cats)
    names = {e.get("company_name") for e in app.get("exhibitors", [])}
    check("Rapid Release" in names, "the app shows exhibitors under the website's names", sorted(names)[:6])

    print("\n== F9  Event Manager -> app feed ==")
    st, body = http("GET", PROXY_BASE + "/api/events")
    check(st == 200 and "Elevate" in body, "the app's events feed serves the event from the Event Manager", (st, body[:200]))

    print("\n== F10 Monitoring ==")
    n = subprocess.run(["node", "--input-type=module", "-e",
        "import {alertExtras} from '%s/admin-router.js'; import {detect} from '%s/alerts.js';"
        "const x = await alertExtras({eventDataDir:'%s', proxyDataDir:'%s', loadLedger:()=>({contacts:{}}), ghlGet:async()=>null, ghlConfig:()=>({enabled:false})});"
        "console.log(JSON.stringify(detect({components:[]}, x).map(d=>d.key).filter(k=>k.startsWith('event-source:'))));"
        % (PROXY, PROXY, WORK, os.path.dirname(MIRROR_STATUS))], capture_output=True, text=True, timeout=60)
    keys = json.loads((n.stdout.strip().splitlines() or ["[]"])[-1]) if n.returncode == 0 else None
    check(keys is not None and "event-source:webhook-missed" in keys, "the webhook gap seen in F2/F3 raises an alert", (n.returncode, n.stdout[-300:], n.stderr[-300:]))
finally:
    proxy.terminate()
    try: proxy.wait(timeout=10)
    except Exception: proxy.kill()
    plog.close()
    if fails:
        print("\n(proxy log tail)\n" + open(os.path.join(WORK, "proxy.log")).read()[-1500:])
    shutil.rmtree(WORK, ignore_errors=True)

print("\n%s" % ("ALL PASS" if not fails else "FAILED: %d" % fails))
sys.exit(1 if fails else 0)
