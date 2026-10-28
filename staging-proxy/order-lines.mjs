/**
 * What each line of a GHL order or invoice actually cost.
 *
 * A checkout can carry several tickets: on 26 Oct 2026 one Stripe charge of
 * $1,747.94 bought a VIP pass ($999) and a Three Day pass ($650) plus 6% tax.
 * The sync and the webhook used to send the ORDER total with every ticket, so
 * that buyer was counted as $3,495.88. Each line now carries its own share:
 * price x quantity, plus the same proportion of whatever sits between the
 * lines' subtotal and what was actually charged (tax, discount, shipping).
 * Cents are reconciled on the largest line so the lines add up to the total.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Unit price of one line, whichever shape GHL used for it. */
export function unitPrice(item) {
  if (!item || typeof item !== 'object') return null;
  const p = item.price;
  if (p && typeof p === 'object') return num(p.amount);
  return num(p) ?? num(item.amount) ?? num(item.unitPrice);
}

export function lineQty(item) {
  const q = num(item && (item.qty != null ? item.qty : item.quantity));
  return Math.max(1, q == null ? 1 : Math.round(q));
}

export function lineProductId(item) {
  return String((item && ((item.product && item.product._id) || item.productId)) || '');
}

/**
 * Map of productId -> amount for this order. `total` is what was charged
 * (order.amount / invoice.amountPaid). Lines without a readable price share
 * whatever the priced lines leave; if nothing is priced the total goes to
 * the only line, or is left out (null) when it cannot be split honestly.
 */
export function lineAmounts(items, total) {
  const lines = (Array.isArray(items) ? items : [])
    .map((it) => ({ pid: lineProductId(it), base: (unitPrice(it) ?? 0) * lineQty(it), priced: unitPrice(it) != null }))
    .filter((l) => l.pid);
  const out = new Map();
  const t = num(total);
  if (!lines.length) return out;
  if (lines.length === 1) { out.set(lines[0].pid, t != null ? round2(t) : round2(lines[0].base)); return out; }
  const sub = lines.reduce((s, l) => s + l.base, 0);
  if (!(sub > 0)) {
    for (const l of lines) out.set(l.pid, null);   // cannot split an unpriced order honestly
    return out;
  }
  const factor = t != null ? t / sub : 1;
  let assigned = 0;
  for (const l of lines) {
    const amt = round2(l.base * factor);
    out.set(l.pid, (out.get(l.pid) || 0) + amt);
    assigned += amt;
  }
  if (t != null) {
    const drift = round2(t - assigned);
    if (drift !== 0) {
      const top = [...out.entries()].sort((a, b) => b[1] - a[1])[0][0];
      out.set(top, round2(out.get(top) + drift));
    }
  }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }
