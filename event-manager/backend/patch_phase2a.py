# -*- coding: utf-8 -*-
# PHASE 2a backend: roster carries effective_access; list limit raised; search by
# phone + QR; export extended with base/add-ons/day/effective/source.
import io, py_compile
BE="/root/event/backend"; MA=f"{BE}/main.py"; SC=f"{BE}/schemas.py"
def rd(p):
    with io.open(p,encoding="utf-8") as f: return f.read()
def wr(p,s):
    with io.open(p,"w",encoding="utf-8") as f: f.write(s)
def rep(s,old,new,tag,n=1):
    c=s.count(old); assert c==n,"ANCHOR %s found %d (expected %d)"%(tag,c,n); return s.replace(old,new)

# schemas.Attendee: effective_access
sc=rd(SC)
if "class Attendee(AttendeeBase):" in sc and "effective_access: Optional[Dict[str, Any]] = None\n    created_at" not in sc:
    sc=rep(sc,
      '    # The canonical pass, so the admin editor can show and change it.\n    ticket_type_id: Optional[int] = None\n    created_at: datetime',
      '    # The canonical pass, so the admin editor can show and change it.\n    ticket_type_id: Optional[int] = None\n    effective_access: Optional[Dict[str, Any]] = None\n    created_at: datetime',
      "schemas.attendee.effective")
    wr(SC,sc); print("schemas.py: Attendee.effective_access added")
else:
    print("schemas.py: Attendee.effective_access present/na")

ma=rd(MA)

# list: raise limit + attach effective_access
if "    limit: int = 100,\n    db: Session = Depends(get_db),\n    current_user: models.User = Depends(get_current_user)\n):\n    attendees = db.query(models.Attendee).filter(" in ma:
    ma=rep(ma,
      '    limit: int = 100,\n    db: Session = Depends(get_db),\n    current_user: models.User = Depends(get_current_user)\n):\n    attendees = db.query(models.Attendee).filter(\n        models.Attendee.event_id == event_id\n    ).offset(skip).limit(limit).all()\n    authz.require_cap(db, current_user, event_id, "attendee.read")\n    return attendees',
      '    limit: int = 10000,\n    db: Session = Depends(get_db),\n    current_user: models.User = Depends(get_current_user)\n):\n    authz.require_cap(db, current_user, event_id, "attendee.read")\n    attendees = db.query(models.Attendee).filter(\n        models.Attendee.event_id == event_id\n    ).offset(skip).limit(limit).all()\n    for _a in attendees:\n        _a.effective_access = _effective_access(db, _a)\n    return attendees',
      "main.get_attendees")
    print("main.py: get_attendees limit+effective")
else:
    print("main.py: get_attendees already patched/na")

# search: phone + qr + attach
_old_search='''    return db.query(models.Attendee).filter(
        models.Attendee.event_id == event_id,
        func.lower(models.Attendee.first_name + " " + models.Attendee.last_name).like(term)
        | func.lower(models.Attendee.email).like(term)
        | func.lower(models.Attendee.company).like(term),
    ).order_by(models.Attendee.last_name.asc()).limit(25).all()'''
_new_search='''    _res = db.query(models.Attendee).filter(
        models.Attendee.event_id == event_id,
        func.lower(models.Attendee.first_name + " " + models.Attendee.last_name).like(term)
        | func.lower(models.Attendee.email).like(term)
        | func.lower(models.Attendee.company).like(term)
        | func.lower(func.coalesce(models.Attendee.phone, "")).like(term)
        | func.lower(models.Attendee.qr_code).like(term),
    ).order_by(models.Attendee.last_name.asc()).limit(50).all()
    for _a in _res:
        _a.effective_access = _effective_access(db, _a)
    return _res'''
if _old_search in ma:
    ma=rep(ma,_old_search,_new_search,"main.search"); print("main.py: search phone+qr+effective")
else:
    print("main.py: search already patched/na")

# export: richer columns
_old_exp='''    writer.writerow(["first_name", "last_name", "email", "phone", "company", "job_title",
                     "ticket_type", "registration_status", "checked_in", "checked_in_at", "qr_code"])
    for a in rows:
        writer.writerow([a.first_name, a.last_name, a.email, a.phone or "", a.company or "",
                         a.job_title or "", a.ticket_type.name if a.ticket_type else "",
                         a.registration_status, "yes" if a.is_checked_in else "no",
                         a.checked_in_at.isoformat() if a.checked_in_at else "", a.qr_code])'''
_new_exp='''    writer.writerow(["first_name", "last_name", "email", "phone", "company", "job_title",
                     "base_ticket", "add_ons", "add_on_day", "effective_access",
                     "registration_status", "checked_in", "checked_in_at",
                     "qr_code", "source", "order_ref"])
    for a in rows:
        _eff = _effective_access(db, a)
        _bt = _eff.get("base_ticket") or {}
        _addons = _eff.get("addons") or []
        _cd = a.custom_data or {}
        writer.writerow([a.first_name, a.last_name, a.email, a.phone or "", a.company or "",
                         a.job_title or "", (_bt.get("name") or ""),
                         "; ".join(x.get("label") or "" for x in _addons),
                         "; ".join((x.get("day") or "") for x in _addons),
                         _eff.get("effective_label") or "",
                         a.registration_status, "yes" if a.is_checked_in else "no",
                         a.checked_in_at.isoformat() if a.checked_in_at else "", a.qr_code,
                         _cd.get("source") or "", _cd.get("order_id") or ""])'''
if _old_exp in ma:
    ma=rep(ma,_old_exp,_new_exp,"main.export"); print("main.py: export extended")
else:
    print("main.py: export already patched/na")

wr(MA,ma)
for p in (SC,MA): py_compile.compile(p,doraise=True)
print("py_compile OK — PHASE2a DONE")
