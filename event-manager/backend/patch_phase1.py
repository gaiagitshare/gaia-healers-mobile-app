# -*- coding: utf-8 -*-
# PHASE 1 (backend): additive add-on entitlements + shared effective-access resolver.
# - TicketMapping.addon_code (EVENT_ADDON grants an add-on, never a tier)
# - _ent_record stores addon_code + day; _effective_access resolves base + add-ons
# - GET /attendees/{id} returns human-readable effective_access + entitlement_history
# - GET /events/{id}/ticket-counts: base counts vs add-on counts, separately
# - reconcile-attendee records an add-on (additive) when addon_code is supplied
import io, sqlite3, py_compile
BE="/root/event/backend"; MA=f"{BE}/main.py"; MO=f"{BE}/models.py"; SC=f"{BE}/schemas.py"; DB=f"{BE}/event.db"
def rd(p):
    with io.open(p,encoding="utf-8") as f: return f.read()
def wr(p,s):
    with io.open(p,"w",encoding="utf-8") as f: f.write(s)
def rep(s,old,new,tag,n=1):
    c=s.count(old); assert c==n,"ANCHOR %s found %d (expected %d)"%(tag,c,n); return s.replace(old,new)

# ---- DB: addon_code column ----
con=sqlite3.connect(DB)
cols=[r[1] for r in con.execute("PRAGMA table_info(ticket_mappings)")]
if "addon_code" not in cols:
    con.execute("ALTER TABLE ticket_mappings ADD COLUMN addon_code VARCHAR"); con.commit()
    print("DB: ticket_mappings.addon_code added")
else: print("DB: addon_code present")
con.close()

# ---- models.py ----
mo=rd(MO)
if "addon_code" not in mo:
    mo=rep(mo,
      '    entitlement_type = Column(String, default="EVENT_TICKET")\n    is_active = Column(Boolean, default=True)',
      '    entitlement_type = Column(String, default="EVENT_TICKET")\n'
      '    addon_code = Column(String, nullable=True)  # for EVENT_ADDON: the additive grant code (e.g. ONE_DAY_CONFERENCE)\n'
      '    is_active = Column(Boolean, default=True)',
      "models.addon_code")
    wr(MO,mo); print("models.py: addon_code added")
else: print("models.py: addon_code present")

# ---- schemas.py ----
sc=rd(SC)
if "addon_code" not in sc:
    sc=rep(sc,
      '    from_ticket_type_id: Optional[int] = None\n    entitlement_type: Optional[str] = None',
      '    from_ticket_type_id: Optional[int] = None\n    entitlement_type: Optional[str] = None\n    addon_code: Optional[str] = None',
      "schemas.map.addon_code")
    # ReconcileAttendee: addon_code + day
    sc=rep(sc,
      '    order_id: Optional[str] = None\n    is_upgrade: Optional[bool] = False',
      '    order_id: Optional[str] = None\n    is_upgrade: Optional[bool] = False\n    addon_code: Optional[str] = None\n    day: Optional[str] = None',
      "schemas.reconcile.addon")
    # AttendeeDetail: effective_access + entitlement_history
    sc=rep(sc,
      'class AttendeeDetail(Attendee):\n    event: Optional[Event] = None',
      'class AttendeeDetail(Attendee):\n    event: Optional[Event] = None\n'
      '    effective_access: Optional[Dict[str, Any]] = None\n'
      '    entitlement_history: Optional[List[Dict[str, Any]]] = None',
      "schemas.attendeedetail")
    wr(SC,sc); print("schemas.py: addon_code + day + AttendeeDetail fields added")
else: print("schemas.py: addon fields present")

# ---- main.py ----
ma=rd(MA)

# (1) _ent_record: support addon_code + day (backward compatible)
_old_entrec='''def _ent_record(cd, order_id, tx, tt_id, is_upgrade):
    if not order_id or not tt_id:
        return
    ents = list(cd.get("entitlements") or [])
    for e in ents:
        if e.get("order_id") == order_id:
            if e.get("status") == "refunded":
                cd["entitlements"] = ents
                return  # sticky: a re-seen completed order does not un-refund it
            e["ticket_type_id"] = tt_id
            e["is_upgrade"] = bool(is_upgrade)
            if tx:
                e["transaction_id"] = tx
            cd["entitlements"] = ents
            return
    ents.append({"order_id": order_id, "transaction_id": tx, "ticket_type_id": tt_id,
                 "is_upgrade": bool(is_upgrade), "status": "paid",
                 "ts": datetime.utcnow().isoformat()})
    cd["entitlements"] = ents'''
_new_entrec='''def _ent_record(cd, order_id, tx, tt_id, is_upgrade, addon_code=None, day=None):
    """Ledger one paid order. A base/upgrade carries a ticket_type_id; an ADD-ON
    carries an addon_code (and optional day) and never a tier. Keyed on
    (order_id, addon_code) so a base and an add-on from one order don't collide."""
    if not order_id:
        return
    if not tt_id and not addon_code:
        return
    ents = list(cd.get("entitlements") or [])
    for e in ents:
        if e.get("order_id") == order_id and e.get("addon_code") == addon_code:
            if e.get("status") == "refunded":
                cd["entitlements"] = ents
                return  # sticky: a re-seen completed order does not un-refund it
            if tt_id:
                e["ticket_type_id"] = tt_id
            e["is_upgrade"] = bool(is_upgrade)
            if addon_code:
                e["addon_code"] = addon_code
            if day is not None:
                e["day"] = day
            if tx:
                e["transaction_id"] = tx
            cd["entitlements"] = ents
            return
    entry = {"order_id": order_id, "transaction_id": tx, "ticket_type_id": tt_id,
             "is_upgrade": bool(is_upgrade), "status": "paid",
             "ts": datetime.utcnow().isoformat()}
    if addon_code:
        entry["addon_code"] = addon_code
    if day is not None:
        entry["day"] = day
    ents.append(entry)
    cd["entitlements"] = ents'''
if "addon_code=None, day=None" not in ma:
    ma=rep(ma,_old_entrec,_new_entrec,"main._ent_record")

# (2) resolver: _addon_label + _effective_access (inserted after _ent_effective)
_anchor_effend='''    best = max(paid, key=lambda e: _tt_rank(db, e.get("ticket_type_id")))
    has_base = any((not e.get("is_upgrade")) for e in paid)
    return (best.get("ticket_type_id"), has_base)'''
_resolver='''    best = max(paid, key=lambda e: _tt_rank(db, e.get("ticket_type_id")))
    has_base = any((not e.get("is_upgrade")) for e in paid)
    return (best.get("ticket_type_id"), has_base)


# --- Additive effective-access: ONE source of truth for admin, scanner and app ---
ADDON_LABELS = {"ONE_DAY_CONFERENCE": "One-Day Speaker Access"}

def _addon_label(code):
    if not code:
        return code
    return ADDON_LABELS.get(code) or code.replace("_", " ").title()

def _effective_access(db, attendee):
    """Resolve an attendee into a human-readable access picture: a base ticket PLUS
    additive add-ons (each with an optional day). Everyone — roster, detail view,
    scanner, member app — renders THIS, so they never disagree."""
    cd = attendee.custom_data or {}
    ents = list(cd.get("entitlements") or [])
    paid = [e for e in ents if e.get("status") == "paid"]
    # base tier = highest-rank paid entitlement that is NOT an add-on
    base_ents = [e for e in paid if not e.get("addon_code") and e.get("ticket_type_id")]
    base_tt = None
    if base_ents:
        base_tt = max(base_ents, key=lambda e: _tt_rank(db, e.get("ticket_type_id"))).get("ticket_type_id")
    if cd.get("admin_tier"):
        base_tt = cd.get("admin_tier")
    if base_tt is None:
        base_tt = attendee.ticket_type_id
    base = db.query(models.TicketType).filter(models.TicketType.id == base_tt).first() if base_tt else None
    # add-ons (dedup by code, keep the first paid one)
    addons = []
    seen = set()
    for e in paid:
        code = e.get("addon_code")
        if not code or code in seen:
            continue
        seen.add(code)
        addons.append({"code": code, "label": _addon_label(code), "day": e.get("day"),
                       "status": "paid", "order_id": e.get("order_id")})
    active = _ticket_active(attendee)
    parts = []
    if base:
        parts.append(base.name or base.code)
    for a in addons:
        parts.append("%s (%s)" % (a["label"], a["day"] or "day not selected"))
    eff = " + ".join(parts) if parts else "No active ticket"
    if not active:
        eff = "%s \\u2014 %s" % (eff, _ticket_status(attendee).upper())
    # human-readable entitlement history (the "why")
    hist = []
    for e in ents:
        if e.get("addon_code"):
            lbl = _addon_label(e.get("addon_code")); kind = "add-on"
        else:
            tt = db.query(models.TicketType).filter(models.TicketType.id == e.get("ticket_type_id")).first()
            lbl = (tt.name if tt else "Ticket"); kind = ("upgrade" if e.get("is_upgrade") else "base ticket")
        hist.append({"label": lbl, "kind": kind, "status": e.get("status") or "paid",
                     "order_id": e.get("order_id"), "day": e.get("day"), "ts": e.get("ts")})
    return {
        "base_ticket": ({"id": base.id, "code": base.code, "name": base.name} if base else None),
        "status": _ticket_status(attendee),
        "active": active,
        "addons": addons,
        "effective_label": eff,
        "entitlement_history": hist,
    }'''
if "_effective_access" not in ma:
    ma=rep(ma,_anchor_effend,_resolver,"main.resolver")

# (3) reconcile-attendee: additive add-on branch (before the `if existing:` block)
_anchor_recon='''    existing = db.query(models.Attendee).filter(
        models.Attendee.event_id == event.id,
        func.lower(models.Attendee.email) == email).first()
    if existing:'''
_addon_branch='''    existing = db.query(models.Attendee).filter(
        models.Attendee.event_id == event.id,
        func.lower(models.Attendee.email) == email).first()
    # ADD-ON: additive event entitlement (e.g. one-day speaker). Never sets or
    # raises the base tier; idempotent per (order, addon). Creates a base-less
    # attendee if the buyer has no base ticket yet.
    if payload.addon_code:
        att = existing
        created = False
        if att is None:
            att = models.Attendee(event_id=event.id, email=email,
                first_name=payload.first_name or "", last_name=payload.last_name or "",
                phone=payload.phone, ticket_type_id=None,
                custom_data={"contact_id": payload.contact_id, "order_id": payload.order_id, "source": "ghl_reconcile"},
                qr_code=f"ATT-{uuid.uuid4().hex[:12].upper()}")
            db.add(att); db.flush(); created = True
        cd = dict(att.custom_data or {})
        already = any(e.get("order_id") == payload.order_id and e.get("addon_code") == payload.addon_code
                      for e in (cd.get("entitlements") or []))
        _ent_record(cd, payload.order_id, None, None, False, addon_code=payload.addon_code, day=payload.day)
        if not already:
            _ll = list(cd.get("lifecycle") or [])
            _ll.append({"ts": datetime.utcnow().isoformat(), "action": "addon_added", "actor": "reconcile",
                        "addon_code": payload.addon_code, "day": payload.day, "order_id": payload.order_id})
            cd["lifecycle"] = _ll
        if payload.contact_id:
            cd["contact_id"] = payload.contact_id
        att.custom_data = cd
        db.commit(); db.refresh(att)
        return {"ok": True, "created": created, "addon": payload.addon_code,
                "attendee_id": att.id, "qr_code": att.qr_code}
    if existing:'''
if "ADD-ON: additive event entitlement" not in ma:
    ma=rep(ma,_anchor_recon,_addon_branch,"main.reconcile_addon")

# (4) detail endpoint returns effective_access + history
_old_detail='''    authz.require_cap(db, current_user, attendee.event_id, "attendee.read")
    return attendee

@app.put("/attendees/{attendee_id}", response_model=schemas.Attendee)'''
_new_detail='''    authz.require_cap(db, current_user, attendee.event_id, "attendee.read")
    _eff = _effective_access(db, attendee)
    attendee.effective_access = _eff
    attendee.entitlement_history = _eff.get("entitlement_history")
    return attendee

@app.put("/attendees/{attendee_id}", response_model=schemas.Attendee)'''
if "attendee.effective_access = _eff" not in ma:
    ma=rep(ma,_old_detail,_new_detail,"main.detail_endpoint")

# (5) counts endpoint (base vs add-on, separate) — appended after detail's PUT block anchor
if "/events/{event_id}/ticket-counts" not in ma:
    _counts='''@app.get("/attendees/{attendee_id}", response_model=schemas.AttendeeDetail)'''
    _counts_new='''@app.get("/events/{event_id}/ticket-counts")
def event_ticket_counts(event_id: int, db: Session = Depends(get_db),
                        current_user: models.User = Depends(get_current_user)):
    """Operational counts for the event dashboard. Base-ticket counts and add-on
    counts are reported SEPARATELY so an additive add-on never inflates a tier."""
    _get_event_or_404(event_id, db)
    authz.require_cap(db, current_user, event_id, "attendee.read")
    atts = db.query(models.Attendee).filter(models.Attendee.event_id == event_id).all()
    from collections import Counter
    base = Counter(); addon = Counter(); status = Counter(); checked = 0
    for a in atts:
        status[_ticket_status(a)] += 1
        if a.is_checked_in:
            checked += 1
        eff = _effective_access(db, a)
        bt = eff.get("base_ticket")
        base[(bt["code"] if bt else "none")] += 1
        for ad in (eff.get("addons") or []):
            addon[ad["code"]] += 1
    return {"total": len(atts), "checked_in": checked, "not_checked_in": len(atts) - checked,
            "by_base_ticket": dict(base), "by_addon": dict(addon), "by_status": dict(status)}


@app.get("/attendees/{attendee_id}", response_model=schemas.AttendeeDetail)'''
    ma=rep(ma,_counts,_counts_new,"main.counts_endpoint")

# (6) expose addon_code in the reconciler-facing mappings list
_old_idmap='''             "entitlement_type": getattr(r, "entitlement_type", None) or "EVENT_TICKET",
             "label": r.label, "checkout_url": r.checkout_url} for r in rows]'''
_new_idmap='''             "entitlement_type": getattr(r, "entitlement_type", None) or "EVENT_TICKET",
             "addon_code": getattr(r, "addon_code", None),
             "label": r.label, "checkout_url": r.checkout_url} for r in rows]'''
if '"addon_code": getattr(r' not in ma:
    ma=rep(ma,_old_idmap,_new_idmap,"main.idmap_addon")

# (7) create_ticket_mapping passes addon_code
_old_cm2='''                              entitlement_type=(getattr(payload, "entitlement_type", None)
                                                or ("EVENT_UPGRADE" if payload.is_upgrade else "EVENT_TICKET")),
                              is_active=True if payload.is_active is None else bool(payload.is_active))'''
_new_cm2='''                              entitlement_type=(getattr(payload, "entitlement_type", None)
                                                or ("EVENT_UPGRADE" if payload.is_upgrade else "EVENT_TICKET")),
                              addon_code=(getattr(payload, "addon_code", None) or None),
                              is_active=True if payload.is_active is None else bool(payload.is_active))'''
if "addon_code=(getattr(payload" not in ma:
    ma=rep(ma,_old_cm2,_new_cm2,"main.create_mapping_addon")

wr(MA,ma)
for p in (MO,SC,MA):
    py_compile.compile(p,doraise=True)
print("py_compile OK")
print("PHASE1 DONE")
