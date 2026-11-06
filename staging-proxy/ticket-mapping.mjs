/**
 * Which ticket does an order line buy?
 *
 * One GHL product can be sold under several names: 69b463a1… is both "GENERAL
 * ADMISSION (EXHIBIT HALL ONLY)" and "GENERAL ADMISSION + CONFERENCE", at the
 * same price, so neither the product id nor the amount can tell them apart. Only
 * the name on the order line can. A mapping may carry `product_name_match`; one
 * that matches the line beats the plain mapping for that product, and the plain
 * mapping is the answer for every other line. Same rule as the Event Manager's
 * _pick_mapping, which owns the sales windows.
 *
 * Keeping only one mapping per product gave all six plain buyers of 28 Sep to
 * 3 Nov 2026 the conference pass.
 */

/** Map of product id -> every accepted mapping for it. */
export function indexMappings(rows, accept = () => true) {
  const out = new Map();
  for (const m of rows || []) {
    if (!accept(m)) continue;
    const key = String(m.external_product_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(m);
  }
  return out;
}

/** The words the buyer saw on a line: its own name and its price's name. */
export function lineText(item) {
  return [item && item.name, item && item.price && item.price.name].filter(Boolean).join(' ');
}

/** The mapping for one line, or undefined if the product is not mapped. */
export function pickMapping(candidates, text) {
  if (!candidates || !candidates.length) return undefined;
  const name = String(text || '').toUpperCase();
  const pattern = (m) => String(m.product_name_match || '').trim().toUpperCase();
  const named = candidates.filter((m) => pattern(m) && name.includes(pattern(m)))
    .sort((a, b) => pattern(b).length - pattern(a).length);
  if (named.length) return named[0];
  const plain = candidates.filter((m) => !pattern(m));
  return plain[plain.length - 1];
}
