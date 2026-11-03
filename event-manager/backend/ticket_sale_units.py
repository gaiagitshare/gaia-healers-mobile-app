"""Read-only purchase-unit planning. Never creates tickets or sends email.

A source line and its quantity define ticket units; payment attempts and buyer
identity do not. Refund allocation remains explicit rather than inferred from
an amount. This planner is not wired into production issuance yet.
"""
from dataclasses import dataclass

@dataclass(frozen=True)
class TicketUnit:
    source: str
    order_id: str
    line_id: str
    ordinal: int
    event_id: int
    ticket_type_id: int


def plan_paid_units(order, lines, transactions):
    """Return stable candidate unit keys and holds from normalized source data.

    lines require immutable line_id, integer quantity, mapped event/category
    and role BASE/UPGRADE/ADDON. Refunds never silently subtract ticket units.
    The caller must reconcile these candidates to existing issuance first.
    """
    holds=[]
    if order.get("status") != "completed" or order.get("payment_status") != "paid" or order.get("live_mode") is not True:
        return {"units": [], "holds": ["order_not_confirmed_paid_live"]}
    ref=order.get("id");source=order.get("source")
    if not ref or not source:return {"units": [], "holds": ["missing_source_order_identity"]}
    # A repeated notification of one transaction is still the same transaction.
    unique={}
    for tx in transactions:
        if tx.get("order_id")==ref and tx.get("id"):
            key=tx["id"]
            if key in unique and unique[key]!=tx:
                holds.append("conflicting_transaction_snapshot")
            else:unique[key]=tx
    paid=[tx for tx in unique.values() if tx.get("status")=="succeeded"]
    if not paid:holds.append("no_successful_payment_confirmation")
    if len(paid)>1:holds.append("multiple_successful_charges_one_order_review")
    if any(tx.get("status") in {"refunded","partially_refunded"} or tx.get("amount_refunded",0) for tx in unique.values()):
        holds.append("refund_ticket_allocation_requires_documented_rule")
    units=[];seen={}
    for line in lines:
        lid=line.get("id")
        if not lid:holds.append("missing_order_line_identity");continue
        if lid in seen:
            if seen[lid]!=line:holds.append("conflicting_order_line_snapshot")
            continue
        seen[lid]=line
        if line.get("role") in {"UPGRADE","ADDON"}:continue
        if line.get("role")!="BASE":holds.append("unmapped_line_role");continue
        qty=line.get("quantity")
        if type(qty) is not int or qty<1:
            holds.append("invalid_or_missing_line_quantity");continue
        event=line.get("event_id");category=line.get("ticket_type_id")
        if not event or not category:holds.append("unmapped_event_or_category");continue
        units.extend(TicketUnit(source,ref,lid,n,event,category) for n in range(1,qty+1))
    # Candidates may be counted while on HOLD; they are never send permission.
    return {"units":units,"holds":sorted(set(holds))}
