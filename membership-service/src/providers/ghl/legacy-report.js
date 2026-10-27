/**
 * Legacy reconciliation report (read-only): what the GHL mirror holds.
 * Counts by tier / provider / reported status, the review list, the stale
 * suspects and mirror freshness. Nothing here writes.
 */
export async function legacyReport(pool, { now = new Date() } = {}) {
  const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
  const counts = async (col) => Object.fromEntries((await q(`SELECT coalesce(${col}, '(none)') AS k, count(*)::int AS n FROM legacy_memberships GROUP BY 1 ORDER BY 1`)).map((r) => [r.k, r.n]));
  const listCols = `id, external_subscription_id, external_contact_id, person_id, tier, mapping, payment_provider, reported_status,
                    last_payment_at, paid_through_estimate, stale_suspected, review_state, review_reasons, last_seen_at`;
  const [byTier, byProvider, byStatus, byMapping] = [await counts('tier'), await counts('payment_provider'), await counts('reported_status'), await counts('mapping')];
  const review = await q(`SELECT ${listCols} FROM legacy_memberships WHERE review_state = 'needs_review' ORDER BY tier NULLS LAST, external_subscription_id`);
  const stale = await q(`SELECT ${listCols} FROM legacy_memberships WHERE stale_suspected ORDER BY paid_through_estimate NULLS FIRST, external_subscription_id`);
  const fresh = (await q('SELECT max(last_seen_at) AS last_seen, count(*)::int AS total, count(*) FILTER (WHERE person_id IS NULL)::int AS unlinked FROM legacy_memberships'))[0];
  const lastRun = (await q('SELECT finished_at, complete, error_code FROM legacy_reader_runs ORDER BY finished_at DESC LIMIT 1'))[0] || null;
  const lastComplete = (await q('SELECT max(finished_at) AS at FROM legacy_reader_runs WHERE complete'))[0].at;
  return {
    generatedAt: now,
    total: fresh.total,
    unlinked: fresh.unlinked,
    byTier, byProvider, byStatus, byMapping,
    review, stale,
    freshness: { lastSeenAt: fresh.last_seen, lastCompleteRunAt: lastComplete, lastRun },
  };
}
