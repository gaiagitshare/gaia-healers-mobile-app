"""BADGE ROLES AND SPEAKER BADGES -- 13 Nov 2026.

The word above a person's name on their badge (SPEAKER, VIP, EXHIBITOR,
VOLUNTEER, STAFF), the same role on the online card (never the pass), and
programme speakers getting a badge of their own or a link to the ticket they
already hold. Runs on a throwaway copy of the live database; nothing is sent.

Run:  python3 test_badge_roles.py
"""
import io, os, shutil, sqlite3, subprocess, sys, tempfile, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
WORK = tempfile.mkdtemp(prefix="roles-test-")
DBF = os.path.join(WORK, "event.db")
shutil.copy(os.path.join(HERE, "event.db"), DBF)
os.environ["DATABASE_URL"] = "sqlite:///" + DBF
os.environ["TICKET_DELIVERY_DB"] = os.path.join(WORK, "ticket-delivery.db")

import main as M                                              # noqa: E402
import database, models, badge_card as B                      # noqa: E402
from PIL import Image                                          # noqa: E402
from sqlalchemy.orm.attributes import flag_modified          # noqa: E402

fails = []
def check(ok, label, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else "\n          %r" % (detail,)))
    if not ok:
        fails.append(label)

db = database.SessionLocal()
EV = 1
TAG = uuid.uuid4().hex[:6]
types = {t.code: t for t in db.query(models.TicketType).filter(models.TicketType.event_id == EV).all()}
GA = next(t for t in types.values() if t.name == "General Admission")
VIPT = next(t for t in types.values() if t.is_vip)

def person(first, kind="paid", tt=GA, note=None, status="registered"):
    cd = {"source": "test"}
    if note:
        cd["note"] = note
    a = models.Attendee(event_id=EV, email="zz-%s-%s@example.invalid" % (first.lower(), TAG), first_name=first,
                        last_name="Zz" + TAG, ticket_type_id=tt.id, registration_status=status, attendance_type=kind,
                        registration_source="admin", qr_code="ATT-ZZ%s" % uuid.uuid4().hex[:10].upper(), custom_data=cd)
    db.add(a); db.flush()
    M.attach_member_identity(db, a)
    db.commit()
    return a

print("\n== Who gets which word")
ga = person("Alpha")
vip = person("Bravo", tt=VIPT)
vol = person("Charlie", kind="staff", tt=types.get("STAFF") or GA, note="From the planning sheet: Volunteer — Event Staff")
crew = person("Delta", kind="staff", note="AV contractor")
exh = person("Echo", kind="exhibitor")
gone = person("Foxtrot", tt=VIPT, status="cancelled")
check(M.badge_role(db, ga) is None, "General ticket: no word")
check(M.badge_role(db, vip) == "VIP", "VIP pass: VIP")
check(M.badge_role(db, vol) == "VOLUNTEER", "Volunteer crew: VOLUNTEER")
check(M.badge_role(db, crew) == "STAFF", "Other crew: STAFF")
check(M.badge_role(db, exh) == "EXHIBITOR", "Stand staff: EXHIBITOR")
check(M.badge_role(db, gone) is None, "Cancelled ticket: no word, not even VIP")

print("\n== Speakers: a badge of their own, or a link to the ticket they hold")
sp1 = models.Speaker(event_id=EV, name="Dr. Zed Zz%s, PhD" % TAG, is_published=True)
sp2 = models.Speaker(event_id=EV, name="Yara Zz%s" % TAG, is_published=True)
sp3 = models.Speaker(event_id=EV, name="Hidden Zz%s" % TAG, is_published=False)
db.add_all([sp1, sp2, sp3]); db.commit()
holder = person("Golf")                                      # sp2 already bought a GA ticket
before_conf = M._conference_grant(M._held_tiers(db, holder), [], "")["allowed"]
env = dict(os.environ)
def tool(*args):
    r = subprocess.run([sys.executable, os.path.join(HERE, "tools", "speaker_badges.py")] + list(args),
                       cwd=HERE, env=env, capture_output=True, text=True, timeout=300)
    return r.returncode, r.stdout + r.stderr
n0 = db.query(models.Attendee).count()
rc, out = tool("--dry-run", "--link", "%d:%d" % (sp2.id, holder.id))
db.expire_all()
check(rc == 0 and db.query(models.Attendee).count() == n0 and "dry run" in out, "Dry run writes nothing", out[-300:])
rc, out = tool("--link", "%d:%d" % (sp2.id, holder.id))
check(rc == 0, "Tool runs", out[-300:])
db.expire_all()
spt = db.query(models.TicketType).filter(models.TicketType.event_id == EV, models.TicketType.code == "SPEAKER").first()
check(spt is not None and spt.grants_conference and spt.grants_workshops and not spt.is_vip, "Speaker pass: conference + workshops, not VIP")
new = [a for a in db.query(models.Attendee).filter(models.Attendee.event_id == EV).all()
       if (a.custom_data or {}).get("speaker_id") == sp1.id]
check(len(new) == 1 and new[0].attendance_type == "speaker" and new[0].ticket_type_id == spt.id,
      "Speaker without a ticket gets one speaker badge", [(a.id, a.attendance_type) for a in new])
nb = new[0]
check((nb.first_name, nb.last_name) == ("Zed", "Zz" + TAG) and not nb.email and nb.public_token,
      "Name without title or credentials, no guessed email, has a badge token", (nb.first_name, nb.last_name, nb.email))
check(M.badge_role(db, nb) == "SPEAKER", "...and its badge says SPEAKER")
check(not any((a.custom_data or {}).get("speaker_id") == sp3.id for a in db.query(models.Attendee).all()),
      "Unpublished speaker gets nothing")
db.refresh(holder)
check((holder.custom_data or {}).get("speaker_id") == sp2.id and holder.ticket_type_id == GA.id,
      "Speaker who holds a ticket is linked and keeps it")
check(M.badge_role(db, holder) == "SPEAKER", "...badge says SPEAKER")
check(not before_conf and M._conference_grant(M._held_tiers(db, holder), [], "")["allowed"],
      "...and their GA now opens the conference room they speak in")
check(M._pass_display(db, holder) == "General Admission", "...while the pass they bought is still what the ticket says")
n1 = db.query(models.Attendee).count()
rc, out = tool("--link", "%d:%d" % (sp2.id, holder.id))
db.expire_all()
check(rc == 0 and db.query(models.Attendee).count() == n1 and out.count("has badge") >= 2, "Running again changes nothing", out[-300:])
other = db.query(models.Attendee).filter(models.Attendee.event_id != EV).first()
if other:
    sp4 = models.Speaker(event_id=EV, name="Xavi Zz%s" % TAG, is_published=True); db.add(sp4); db.commit()
    rc, out = tool("--dry-run", "--link", "%d:%d" % (sp4.id, other.id))
    check("REFUSED" in out, "A link to another event's attendee is refused", out[-300:])

print("\n== Printed badge")
for role in (None, "SPEAKER", "VOLUNTEER"):
    for dpi in (203, 300):
        png, meta = B.render_label("Tereza Cristina", "Ribeiro De Souza", "AB3K7QXZ", width_mm=50, height_mm=30,
                                   layout="vertical", view="card", dpi=dpi, role=role)
        im = Image.open(io.BytesIO(png)).convert("L")
        top_dark = sum(1 for x in range(im.width) if im.getpixel((x, 2)) < 128) / im.width
        if role:
            check(meta.get("role") == role and top_dark > 0.6, "%s @%d: black band across the top" % (role, dpi), top_dark)
            check(meta["content_mm"] <= 50 - B.ROLE_BAND_MM - 2.0, "%s @%d: name, QR and code still fit under it" % (role, dpi), meta["content_mm"])
        else:
            check("role" not in meta and top_dark < 0.05, "No role @%d: sticker unchanged, no band" % dpi, top_dark)
_, plain = B.render_label("Ada", "Lovelace", "AB3K7QXZ", width_mm=50, height_mm=30, layout="vertical", view="card")
_, banded = B.render_label("Ada", "Lovelace", "AB3K7QXZ", width_mm=50, height_mm=30, layout="vertical", view="card", role="VIP")
check(plain["qr_mm"] == banded["qr_mm"] and plain["payload"] == banded["payload"], "The QR is the same size and says the same with a band")
for size in ("40x60", "40x40", "40x30", "50x30"):
    w, h = B.LABEL_SIZES[size]
    png, meta = B.render_label("Ada", "Lovelace", "AB3K7QXZ", width_mm=w, height_mm=h, layout=B.LABEL_LAYOUT.get(size), role="SPEAKER")
    check(meta.get("role") == "SPEAKER", "Roll %s prints the band too" % size)

print("\n== Online card shows the role, never the pass")
class _Req:
    client = type("C", (), {"host": "127.0.0.1"})()
    headers = {}
db.expire_all()
for a, want in ((nb, "Speaker"), (vol, "Volunteer"), (exh, "Exhibitor"), (vip, "Participant"), (ga, "Participant")):
    a = db.query(models.Attendee).get(a.id)
    v = M._serve_card(a.public_token, _Req(), db, "json")
    check(v.get("event_role") == want, "%s: card role %s" % (a.first_name, want), v.get("event_role"))
    html = M._serve_card(a.public_token, _Req(), db, "html").body.decode()
    check("VIP" not in html, "%s: the page never says VIP" % a.first_name)
    if want != "Participant":
        check(("<b>%s</b> ·" % want) in html, "%s: the page names the role at the event" % a.first_name)

shutil.rmtree(WORK, ignore_errors=True)
print("\n%d failure(s)" % len(fails))
for f in fails:
    print("   - " + f)
sys.exit(1 if fails else 0)
