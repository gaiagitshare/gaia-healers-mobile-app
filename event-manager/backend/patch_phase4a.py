# -*- coding: utf-8 -*-
# PHASE 4a — scanner as a backend access-control decision engine.
#  - TicketType.grants_conference; add-on entitlement carries day_date (ISO)
#  - scan_logs table (additive; never replaces is_checked_in)
#  - _authorize_decision(): zone-aware, day-aware (event-local), GRANTED/LIMITED/DENIED
#  - POST /events/{id}/authorize  (check-in ONLY on EVENT_ENTRY grants)
#  - POST /attendees/{id}/addon-day  (admin day selection, lifecycle-logged)
import io, sqlite3, py_compile
BE = "/root/event/backend"; MA = f"{BE}/main.py"; MO = f"{BE}/models.py"; SC = f"{BE}/schemas.py"; DB = f"{BE}/event.db"
def rd(p):
    with io.open(p, encoding="utf-8") as f: return f.read()
def wr(p, s):
    with io.open(p, "w", encoding="utf-8") as f: f.write(s)
def rep(s, old, new, tag, n=1):
    c = s.count(old); assert c == n, "ANCHOR %s found %d (expected %d)" % (tag, c, n); return s.replace(old, new)

# ---------- DB ----------
con = sqlite3.connect(DB)
cols = [r[1] for r in con.execute("PRAGMA table_info(ticket_types)")]
if "grants_conference" not in cols:
    con.execute("ALTER TABLE ticket_types ADD COLUMN grants_conference BOOLEAN DEFAULT 0")
    # ELEVATE: GA-CONF(7), 3DAY(5), VIP(4) include conference; GA(8), WS(6) do not.
    con.execute("UPDATE ticket_types SET grants_conference=1 WHERE id IN (7,5,4)")
    # DEMO: VIP-DEMO(2) includes everything.
    con.execute("UPDATE ticket_types SET grants_conference=1 WHERE id=2")
    con.commit(); print("DB: ticket_types.grants_conference added + set")
else:
    print("DB: grants_conference present")
con.execute("""CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER, attendee_id INTEGER, qr_code VARCHAR,
    access_type VARCHAR, result VARCHAR, reason VARCHAR,
    staff_user_id INTEGER, session_id INTEGER, created_at DATETIME)""")
con.commit(); print("DB: scan_logs ready")
con.close()

# ---------- models.py ----------
mo = rd(MO)
if "grants_conference" not in mo:
    mo = rep(mo,
        "    is_vip = Column(Boolean, default=False)\n    grants_workshops = Column(Boolean, default=False)",
        "    is_vip = Column(Boolean, default=False)\n    grants_workshops = Column(Boolean, default=False)\n"
        "    grants_conference = Column(Boolean, default=False)  # conference/speaker sessions",
        "p4.model.grants_conf")
if "class ScanLog(Base)" not in mo:
    mo = mo.rstrip() + '''


class ScanLog(Base):
    """Additive access-control audit — every zone scan, granted or not. It never
    replaces attendee.is_checked_in; it records what happened alongside it."""
    __tablename__ = "scan_logs"
    id = Column(Integer, primary_key=True, index=True)
    event_id = Column(Integer, ForeignKey("events.id"), index=True)
    attendee_id = Column(Integer, ForeignKey("attendees.id"), nullable=True, index=True)
    qr_code = Column(String, index=True)
    access_type = Column(String)      # EVENT_ENTRY | EXHIBIT | CONFERENCE | WORKSHOP | VIP | SESSION
    result = Column(String)           # GRANTED | LIMITED | DENIED
    reason = Column(String)
    staff_user_id = Column(Integer, nullable=True)
    session_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
'''
    wr(MO, mo); print("models.py: grants_conference + ScanLog")
else:
    print("models.py: already patched")

# ---------- schemas.py ----------
sc = rd(SC)
if "class AuthorizeRequest" not in sc:
    sc = rep(sc, "class CheckInRequest(BaseModel):\n    qr_code: str",
        "class CheckInRequest(BaseModel):\n    qr_code: str\n\n"
        "class AuthorizeRequest(BaseModel):\n"
        "    qr_code: str\n"
        "    access_type: str = 'EVENT_ENTRY'   # EVENT_ENTRY|EXHIBIT|CONFERENCE|WORKSHOP|VIP|SESSION\n"
        "    at: Optional[str] = None            # ISO date override for testing (else event-local today)\n"
        "    session_id: Optional[int] = None\n\n"
        "class AddonDay(BaseModel):\n"
        "    addon_code: str = 'ONE_DAY_CONFERENCE'\n"
        "    day_label: str                      # human, e.g. 'Saturday, Nov 21'\n"
        "    day_date: str                       # ISO, e.g. '2026-11-21'\n"
        "    reason: Optional[str] = None",
        "p4.schema.authorize")
if "day_date: Optional[str] = None" not in sc:
    sc = rep(sc, "    addon_code: Optional[str] = None\n    day: Optional[str] = None",
                 "    addon_code: Optional[str] = None\n    day: Optional[str] = None\n    day_date: Optional[str] = None",
                 "p4.schema.reconcile.daydate")
wr(SC, sc); print("schemas.py: AuthorizeRequest + AddonDay + reconcile.day_date")

# ---------- main.py ----------
ma = rd(MA)

# _ent_record: day_date
if "def _ent_record(cd, order_id, tx, tt_id, is_upgrade, addon_code=None, day=None, day_date=None)" not in ma:
    ma = rep(ma, "def _ent_record(cd, order_id, tx, tt_id, is_upgrade, addon_code=None, day=None):",
                 "def _ent_record(cd, order_id, tx, tt_id, is_upgrade, addon_code=None, day=None, day_date=None):",
                 "p4.entrec.sig")
    ma = rep(ma, '            if day is not None:\n                e["day"] = day\n            if tx:',
                 '            if day is not None:\n                e["day"] = day\n            if day_date is not None:\n                e["day_date"] = day_date\n            if tx:',
                 "p4.entrec.upd")
    ma = rep(ma, '    if day is not None:\n        entry["day"] = day\n    ents.append(entry)',
                 '    if day is not None:\n        entry["day"] = day\n    if day_date is not None:\n        entry["day_date"] = day_date\n    ents.append(entry)',
                 "p4.entrec.new")

# resolver addons: carry day_date
if '"day_date": e.get("day_date")' not in ma:
    ma = rep(ma,
        '        addons.append({"code": code, "label": _addon_label(code), "day": e.get("day"),\n'
        '                       "status": "paid", "order_id": e.get("order_id")})',
        '        addons.append({"code": code, "label": _addon_label(code), "day": e.get("day"),\n'
        '                       "day_date": e.get("day_date"),\n'
        '                       "status": "paid", "order_id": e.get("order_id")})',
        "p4.resolver.daydate")

# reconcile add-on branch: pass day_date
if "day=payload.day, day_date=payload.day_date" not in ma:
    ma = rep(ma, "_ent_record(cd, payload.order_id, None, None, False, addon_code=payload.addon_code, day=payload.day)",
                 "_ent_record(cd, payload.order_id, None, None, False, addon_code=payload.addon_code, day=payload.day, day_date=payload.day_date)",
                 "p4.reconcile.daydate")

# decision helpers — inserted after _effective_access's return block
if "_authorize_decision" not in ma:
    anchor = ('        "addons": addons,\n'
              '        "effective_label": eff,\n'
              '        "entitlement_history": hist,\n'
              '    }')
    helpers = anchor + '''


def _event_local_today(event, at=None):
    """The event's current calendar date (event timezone), or an explicit ISO test
    override. Day rules are judged here, never in UTC or the browser's zone."""
    if at:
        return str(at)[:10]
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(event.timezone or "UTC")).date().isoformat()
    except Exception:
        return datetime.utcnow().date().isoformat()


def _conference_grant(tt, addons, today):
    """Decide conference/speaker access. A conference-granting base tier is always
    in; otherwise a ONE_DAY_CONFERENCE add-on grants it only on its selected day."""
    if tt is not None and getattr(tt, "grants_conference", False):
        return {"allowed": True, "reason": (tt.name or "Pass") + " includes conference access"}
    addon = next((a for a in (addons or []) if a.get("code") == "ONE_DAY_CONFERENCE"), None)
    if addon:
        dd = addon.get("day_date")
        if not dd:
            return {"allowed": False, "reason": "One-Day Speaker Access purchased \\u2014 day not selected"}
        if str(dd)[:10] == today:
            return {"allowed": True, "reason": "One-Day Speaker Access \\u2014 " + (addon.get("day") or dd)}
        return {"allowed": False, "reason": "Conference access valid " + (addon.get("day") or dd) + " only"}
    return {"allowed": False, "reason": "Pass does not include conference access"}


def _authorize_decision(db, attendee, event, access_type, at=None):
    """The backend authorization decision. Reads the ONE effective-access resolver,
    then answers a specific access zone with GRANTED / LIMITED / DENIED + reason."""
    eff = _effective_access(db, attendee)
    name = ("%s %s" % (attendee.first_name or "", attendee.last_name or "")).strip() or attendee.email
    base = eff.get("base_ticket")
    addons = eff.get("addons") or []
    tt = db.query(models.TicketType).filter(models.TicketType.id == base["id"]).first() if base else None
    today = _event_local_today(event, at)
    az = (access_type or "EVENT_ENTRY").upper()
    out = {"name": name, "qr_code": attendee.qr_code, "attendee_id": attendee.id,
           "access_type": az, "event_local_date": today,
           "effective_label": eff.get("effective_label"), "base_ticket": base,
           "addons": addons, "status": eff.get("status"),
           "checked_in": bool(attendee.is_checked_in),
           "checked_in_at": attendee.checked_in_at}
    # Lifecycle gate first — refunded/revoked/cancelled is never valid anywhere.
    if not eff.get("active"):
        st = (eff.get("status") or "invalid").upper()
        out.update({"result": "DENIED", "granted": False, "reason": "Ticket " + st + " \\u2014 not valid for entry"})
        return out
    has_base = base is not None
    conf = _conference_grant(tt, addons, today)
    zones = {
        "exhibit": has_base,
        "conference": conf,
        "workshop": bool(tt and getattr(tt, "grants_workshops", False)),
        "vip": bool(tt and getattr(tt, "is_vip", False)),
    }
    out["zones"] = zones
    if az in ("EVENT_ENTRY", "EXHIBIT"):
        if has_base:
            out.update({"result": "GRANTED", "granted": True, "reason": (base["name"] + " \\u2014 admitted")})
        else:
            out.update({"result": "DENIED", "granted": False, "reason": "Add-on found, but no valid base event admission"})
    elif az in ("CONFERENCE", "SPEAKER"):
        if conf["allowed"]:
            out.update({"result": "GRANTED", "granted": True, "reason": conf["reason"]})
        elif has_base:
            out.update({"result": "LIMITED", "granted": False, "reason": (base["name"] + " valid; " + conf["reason"])})
        else:
            out.update({"result": "DENIED", "granted": False, "reason": "No valid base admission"})
    elif az == "WORKSHOP":
        if zones["workshop"]:
            out.update({"result": "GRANTED", "granted": True, "reason": "Workshop access"})
        elif has_base:
            out.update({"result": "LIMITED", "granted": False, "reason": (base["name"] + " does not include workshops")})
        else:
            out.update({"result": "DENIED", "granted": False, "reason": "No valid base admission"})
    elif az == "VIP":
        if zones["vip"]:
            out.update({"result": "GRANTED", "granted": True, "reason": "VIP access"})
        elif has_base:
            out.update({"result": "LIMITED", "granted": False, "reason": (base["name"] + " is not a VIP pass")})
        else:
            out.update({"result": "DENIED", "granted": False, "reason": "No valid base admission"})
    else:
        out.update({"result": "DENIED", "granted": False, "reason": "Unknown access zone"})
    return out'''
    ma = rep(ma, anchor, helpers, "p4.helpers")

# endpoints — inserted before the ticket-counts endpoint
if '/events/{event_id}/authorize' not in ma:
    anchor2 = '@app.get("/events/{event_id}/ticket-counts")'
    endpoints = '''@app.post("/events/{event_id}/authorize")
def authorize_scan(event_id: int, payload: schemas.AuthorizeRequest,
                   db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """Access-control decision for one scan at one zone. The BACKEND decides;
    the scanner only shows the result. Only a successful EVENT_ENTRY marks global
    check-in; a denied conference/zone scan never corrupts attendance."""
    event = _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "checkin.perform")
    att = db.query(models.Attendee).filter(
        models.Attendee.qr_code == payload.qr_code,
        models.Attendee.event_id == event_id).first()
    if not att:
        db.add(models.ScanLog(event_id=event_id, attendee_id=None, qr_code=payload.qr_code,
                              access_type=(payload.access_type or "EVENT_ENTRY").upper(),
                              result="DENIED", reason="Badge not valid for this event",
                              staff_user_id=current_user.id, session_id=payload.session_id))
        db.commit()
        return {"result": "DENIED", "granted": False, "reason": "This badge is not valid for this event",
                "qr_code": payload.qr_code, "access_type": (payload.access_type or "EVENT_ENTRY").upper()}
    dec = _authorize_decision(db, att, event, payload.access_type, payload.at)
    checked_in_now = False
    if dec.get("granted") and dec.get("access_type") == "EVENT_ENTRY":
        if not att.is_checked_in:
            att.is_checked_in = True
            att.checked_in_at = datetime.utcnow()
            checked_in_now = True
    db.add(models.ScanLog(event_id=event_id, attendee_id=att.id, qr_code=att.qr_code,
                          access_type=dec.get("access_type"), result=dec.get("result"),
                          reason=dec.get("reason"), staff_user_id=current_user.id,
                          session_id=payload.session_id))
    db.commit()
    dec["checked_in"] = bool(att.is_checked_in)
    dec["checked_in_now"] = checked_in_now
    return dec


@app.post("/attendees/{attendee_id}/addon-day")
def set_addon_day(attendee_id: int, payload: schemas.AddonDay,
                  db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    """Authorized admin selection of a one-day add-on's day. Records a lifecycle
    event; the app and scanner reflect it immediately from the same resolver."""
    att = db.query(models.Attendee).filter(models.Attendee.id == attendee_id).first()
    if not att:
        raise HTTPException(status_code=404, detail="Attendee not found")
    authz.require_cap(db, current_user, att.event_id, "attendee.write")
    cd = dict(att.custom_data or {})
    ents = list(cd.get("entitlements") or [])
    prev = None; hit = False
    for e in ents:
        if e.get("addon_code") == payload.addon_code:
            prev = e.get("day")
            e["day"] = payload.day_label
            e["day_date"] = payload.day_date
            hit = True
    if not hit:
        raise HTTPException(status_code=404, detail="Attendee has no such add-on")
    cd["entitlements"] = ents
    att.custom_data = cd
    changed = bool(prev and prev != payload.day_label)
    _lifecycle_append(att, "day_changed" if changed else "day_selected",
                      actor=(current_user.email or "admin"),
                      addon_code=payload.addon_code, day=payload.day_label,
                      day_date=payload.day_date,
                      **({"from": prev, "reason": payload.reason} if changed else {}))
    db.commit(); db.refresh(att)
    return {"ok": True, "effective_access": _effective_access(db, att)}


'''
    ma = rep(ma, anchor2, endpoints + anchor2, "p4.endpoints")

wr(MA, ma)
for p in (MO, SC, MA): py_compile.compile(p, doraise=True)
print("py_compile OK — PHASE4a DONE")
