# -*- coding: utf-8 -*-
# Entitlement-boundary hardening: A1 (legacy webhook), A2 (create_attendee authz),
# A3 (explicit entitlement_type). Idempotent, assertion-guarded, py_compile-checked.
import io, sqlite3, py_compile, sys
BE="/root/event/backend"
MA=f"{BE}/main.py"; MO=f"{BE}/models.py"; SC=f"{BE}/schemas.py"; DB=f"{BE}/event.db"
def rd(p):
    with io.open(p, encoding="utf-8") as f: return f.read()
def wr(p, s):
    with io.open(p, "w", encoding="utf-8") as f: f.write(s)
def rep(s, old, new, tag, n=1):
    c=s.count(old)
    assert c==n, "ANCHOR %s found %d (expected %d)"%(tag,c,n)
    return s.replace(old, new)

# ---------- A3.1  DB: additive column + backfill ----------
con=sqlite3.connect(DB)
cols=[r[1] for r in con.execute("PRAGMA table_info(ticket_mappings)")]
if "entitlement_type" not in cols:
    con.execute("ALTER TABLE ticket_mappings ADD COLUMN entitlement_type VARCHAR DEFAULT 'EVENT_TICKET'")
    con.execute("UPDATE ticket_mappings SET entitlement_type = CASE WHEN is_upgrade=1 THEN 'EVENT_UPGRADE' ELSE 'EVENT_TICKET' END")
    con.commit()
    print("DB: entitlement_type column added + backfilled")
else:
    print("DB: entitlement_type already present")
print("DB mapping types:", dict(con.execute("SELECT entitlement_type,count(*) FROM ticket_mappings GROUP BY entitlement_type").fetchall()))
con.close()

# ---------- A3.2  models.py ----------
mo=rd(MO)
if "entitlement_type" not in mo:
    mo=rep(mo,
      '    from_ticket_type_id = Column(Integer, nullable=True)  # per-source upgrade pricing: show only to this current tier\n    is_active = Column(Boolean, default=True)',
      '    from_ticket_type_id = Column(Integer, nullable=True)  # per-source upgrade pricing: show only to this current tier\n'
      '    # Explicit destination discriminator so separation is DECLARED, not implicit.\n'
      '    # EVENT_TICKET | EVENT_UPGRADE (only event types are honored by the ticket path).\n'
      '    entitlement_type = Column(String, default="EVENT_TICKET")\n'
      '    is_active = Column(Boolean, default=True)',
      "models.entitlement_type")
    wr(MO, mo); print("models.py: entitlement_type column added")
else:
    print("models.py: already has entitlement_type")

# ---------- A3.3  schemas.py ----------
sc=rd(SC)
if "entitlement_type" not in sc:
    sc=rep(sc,
      '    is_active: Optional[bool] = True\n    checkout_url: Optional[str] = None\n    from_ticket_type_id: Optional[int] = None',
      '    is_active: Optional[bool] = True\n    checkout_url: Optional[str] = None\n    from_ticket_type_id: Optional[int] = None\n    entitlement_type: Optional[str] = None',
      "schemas.base.entitlement_type")
    wr(SC, sc); print("schemas.py: entitlement_type added to TicketMappingBase")
else:
    print("schemas.py: already has entitlement_type")

# ---------- main.py ----------
ma=rd(MA)

# A1: log helper (insert before the webhook decorator)
if "_log_webhook_noop" not in ma:
    ma=rep(ma,
      '@app.post("/webhooks/registration")\nasync def registration_webhook(',
      'def _log_webhook_noop(reason, email, payload, product_id=None):\n'
      '    """A registration webhook that resolves to NO entitlement must be loud and\n'
      '    safe: log why and create nothing. Never a name/price/next-event guess."""\n'
      '    try:\n'
      '        print(f"[registration_webhook] NO-OP reason={reason} product_id={product_id} "\n'
      '              f"email={email} source={(payload or {}).get(\'source\')}", flush=True)\n'
      '    except Exception:\n'
      '        pass\n\n\n'
      '@app.post("/webhooks/registration")\nasync def registration_webhook(',
      "main.log_helper")

# A1: harden the resolution gate (require exact EVENT-typed mapping; else safe no-op)
_old_gate='''    # Prefer a mapped GHL product id — stable, whitelist-only. No name/price
    # guessing and NO next-active-event fallback: an unmapped product is refused
    # so a membership/device/other-event purchase can never mint an event ticket.
    _product_id = payload.get("ghl_product_id") or payload.get("product_id")
    _forced_tt = None
    if _product_id:
        _mapping = db.query(models.TicketMapping).filter(
            models.TicketMapping.external_product_id == str(_product_id).strip(),
            models.TicketMapping.is_active == True,  # noqa: E712
        ).first()
        if not _mapping:
            raise HTTPException(status_code=422, detail="Unmapped product; not a recognised event ticket")
        event = db.query(models.Event).filter(models.Event.id == _mapping.event_id).first()
        _forced_tt = _mapping.ticket_type_id
    else:
        event = _resolve_registration_event(payload, db)
    if not event:
        raise HTTPException(status_code=404, detail="No active event to register against")'''
_new_gate='''    # HARDENED: an event ticket is minted ONLY from an exact, enabled, EVENT-typed
    # product mapping. No product id, no mapping, or a non-event entitlement type is
    # a logged SAFE NO-OP — never a name/price/next-active-event guess. This closes
    # the one path by which a membership/course/device/other-event payment could
    # otherwise have become an event attendee.
    _EVENT_TYPES = ("EVENT_TICKET", "EVENT_UPGRADE")
    _product_id = payload.get("ghl_product_id") or payload.get("product_id")
    if not _product_id:
        _log_webhook_noop("no_product_id", email, payload)
        return {"ok": True, "created": False, "no_op": True, "reason": "no_product_id",
                "detail": "No authoritative product id; refusing to infer an event ticket."}
    _mapping = db.query(models.TicketMapping).filter(
        models.TicketMapping.external_product_id == str(_product_id).strip(),
        models.TicketMapping.is_active == True,  # noqa: E712
    ).first()
    if not _mapping or (getattr(_mapping, "entitlement_type", "EVENT_TICKET") or "EVENT_TICKET") not in _EVENT_TYPES:
        _log_webhook_noop("unmapped_or_non_event_product", email, payload, product_id=_product_id)
        return {"ok": True, "created": False, "no_op": True, "reason": "unmapped_or_non_event_product",
                "detail": "No enabled event-ticket mapping for this product; nothing granted."}
    event = db.query(models.Event).filter(models.Event.id == _mapping.event_id).first()
    _forced_tt = _mapping.ticket_type_id
    if not event:
        _log_webhook_noop("mapping_event_missing", email, payload, product_id=_product_id)
        return {"ok": True, "created": False, "no_op": True, "reason": "mapping_event_missing",
                "detail": "Mapping points to a missing event; nothing granted."}'''
if "_EVENT_TYPES = (" not in ma:
    ma=rep(ma, _old_gate, _new_gate, "main.webhook_gate")

# A1: existing-branch — tier from mapping only (drop name match)
if "matched = _match_ticket_type(db, event.id, custom.get(\"pass_type\"))\n        new_tt" in ma:
    ma=rep(ma,
      '        old_tt = existing.ticket_type_id\n'
      '        matched = _match_ticket_type(db, event.id, custom.get("pass_type"))\n'
      '        new_tt = _forced_tt if _forced_tt else (matched.id if matched else None)\n'
      '        if new_tt:',
      '        old_tt = existing.ticket_type_id\n'
      '        # HARDENED: tier comes only from the explicit mapping, never a name match.\n'
      '        new_tt = _forced_tt\n'
      '        if new_tt:',
      "main.webhook_existing")

# A1: create-branch — tier from mapping only (drop name match)
_old_create='''    matched = _match_ticket_type(db, event.id, custom.get("pass_type"))
    attendee = models.Attendee(
        event_id=event.id,
        email=email,
        first_name=_pick(payload, "first_name") or "",
        last_name=_pick(payload, "last_name") or "",
        phone=_pick(payload, "phone"),
        company=_pick(payload, "company"),
        job_title=_pick(payload, "job_title"),
        custom_data=custom,
        ticket_type_id=(_forced_tt if _forced_tt else (matched.id if matched else None)),
        qr_code=f"ATT-{uuid.uuid4().hex[:12].upper()}",
    )'''
_new_create='''    attendee = models.Attendee(
        event_id=event.id,
        email=email,
        first_name=_pick(payload, "first_name") or "",
        last_name=_pick(payload, "last_name") or "",
        phone=_pick(payload, "phone"),
        company=_pick(payload, "company"),
        job_title=_pick(payload, "job_title"),
        custom_data=custom,
        ticket_type_id=_forced_tt,
        qr_code=f"ATT-{uuid.uuid4().hex[:12].upper()}",
    )'''
if _old_create in ma:
    ma=rep(ma, _old_create, _new_create, "main.webhook_create")

# A2: create_attendee authorization
_old_ca='''def create_attendee(
    attendee: schemas.AttendeeCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    # Generate unique QR code
    qr_code = f"ATT-{uuid.uuid4().hex[:12].upper()}"'''
_new_ca='''def create_attendee(
    attendee: schemas.AttendeeCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    # AUTHZ: manual attendee creation is an organizer action. A signed-in member
    # must never be able to add themselves (or anyone) to an arbitrary event.
    event = db.query(models.Event).filter(models.Event.id == attendee.event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    authz.require_cap(db, current_user, event.id, "attendee.write")
    # Generate unique QR code
    qr_code = f"ATT-{uuid.uuid4().hex[:12].upper()}"'''
if "AUTHZ: manual attendee creation" not in ma:
    ma=rep(ma, _old_ca, _new_ca, "main.create_attendee_authz")

# A3: expose entitlement_type to reconciler/proxy
_old_map='''             "ticket_type_id": r.ticket_type_id, "is_upgrade": bool(r.is_upgrade),
             "label": r.label, "checkout_url": r.checkout_url} for r in rows]'''
_new_map='''             "ticket_type_id": r.ticket_type_id, "is_upgrade": bool(r.is_upgrade),
             "entitlement_type": getattr(r, "entitlement_type", None) or "EVENT_TICKET",
             "label": r.label, "checkout_url": r.checkout_url} for r in rows]'''
if '"entitlement_type": getattr(r' not in ma:
    ma=rep(ma, _old_map, _new_map, "main.identity_mappings_out")

# A3: create_ticket_mapping sets entitlement_type
_old_cm='''                              from_ticket_type_id=(payload.from_ticket_type_id or None),
                              is_active=True if payload.is_active is None else bool(payload.is_active))'''
_new_cm='''                              from_ticket_type_id=(payload.from_ticket_type_id or None),
                              entitlement_type=(getattr(payload, "entitlement_type", None)
                                                or ("EVENT_UPGRADE" if payload.is_upgrade else "EVENT_TICKET")),
                              is_active=True if payload.is_active is None else bool(payload.is_active))'''
if "entitlement_type=(getattr(payload" not in ma:
    ma=rep(ma, _old_cm, _new_cm, "main.create_mapping")

wr(MA, ma)
for p in (MO, SC, MA):
    py_compile.compile(p, doraise=True)
print("py_compile OK for models.py, schemas.py, main.py")
print("DONE")
