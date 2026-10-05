/** Arithmetic only. Preserve scan timestamps so separate same-day scans stay selectable.
 * Three complete scans are required; missing/non-finite values are never zero-filled.
 */
export function readingSeries(points = [], limit = 200) {
  const seen = new Set();
  return points.map((p) => {
    const at = p?.scanned_at;
    const e = p?.energy, s = p?.stress;
    const id = String(p?.exp_id ?? p?.id ?? at ?? '');
    return { id, at, d: String(at || '').slice(0, 10), e: Number.isFinite(e) ? e : null, s: Number.isFinite(s) ? s : null };
  }).filter(p => {
    if (!p.id || !/^\d{4}-\d{2}-\d{2}/.test(p.at || '') || !Number.isFinite(Date.parse(p.at)) || (p.e === null && p.s === null) || seen.has(p.id)) return false;
    seen.add(p.id); return true;
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-limit);
}
export function recentAverage(series = []) {
  const scans = series.slice(-3);
  if (scans.length < 3 || scans.some(p => !Number.isFinite(p.e) || !Number.isFinite(p.s))) return null;
  return { count: 3, from: scans[0].at, to: scans[2].at,
    energy: scans.reduce((n,p) => n + p.e, 0) / 3,
    stress: scans.reduce((n,p) => n + p.s, 0) / 3 };
}
