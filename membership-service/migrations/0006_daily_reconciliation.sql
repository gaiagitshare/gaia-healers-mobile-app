-- Daily Stripe reconciliation: per-day run index, de-duplicated alerts, and the
-- coin-pack purchase <-> payment_ledger check. Numbered 0006 (0004 is the legacy
-- mirror, 0005 may be taken by a sibling branch); touches only new objects.
--
-- Nothing here schedules anything. The job (src/providers/stripe/daily-reconcile.js)
-- is run by hand or by a timer that is proposed in the README, not installed.

-- up
SET LOCAL search_path = membership, public;

-- Which UTC day each daily run covered. Append-only like reconciliation_runs:
-- a re-run of the same day is a NEW row, never an overwrite.
CREATE TABLE reconciliation_daily_runs (
  run_id          uuid PRIMARY KEY REFERENCES reconciliation_runs(id),
  provider        text NOT NULL CHECK (provider IN ('stripe', 'partner')),
  livemode        boolean NOT NULL DEFAULT false,
  day             date NOT NULL,
  overlap_seconds integer NOT NULL CHECK (overlap_seconds >= 0),
  request_cap     integer NOT NULL CHECK (request_cap >= 1),
  requests_made   integer NOT NULL CHECK (requests_made >= 0),
  coin_mismatches integer NOT NULL DEFAULT 0 CHECK (coin_mismatches >= 0),
  new_alerts      integer NOT NULL DEFAULT 0 CHECK (new_alerts >= 0),
  repeat_alerts   integer NOT NULL DEFAULT 0 CHECK (repeat_alerts >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_daily_runs_day ON reconciliation_daily_runs (provider, livemode, day);
CREATE TRIGGER reconciliation_daily_runs_append_only BEFORE UPDATE OR DELETE ON reconciliation_daily_runs
  FOR EACH ROW EXECUTE FUNCTION membership.refuse_change();

-- One OPEN alert per mismatch (kind + object + entry type). A re-run that sees
-- the same mismatch bumps seen_count / last_run_id; it does not alert again.
-- details holds ids, amounts and currencies only: never customer data.
CREATE TABLE reconciliation_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL CHECK (provider IN ('stripe', 'partner')),
  livemode      boolean NOT NULL DEFAULT false,
  mismatch_key  text NOT NULL CHECK (length(mismatch_key) BETWEEN 3 AND 400),
  kind          text NOT NULL,
  object_type   text,
  object_id     text,
  entry_type    text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_day     date NOT NULL,
  last_day      date NOT NULL,
  first_run_id  uuid NOT NULL REFERENCES reconciliation_runs(id),
  last_run_id   uuid NOT NULL REFERENCES reconciliation_runs(id),
  seen_count    integer NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  notified_at   timestamptz,                       -- set only after alert() succeeded; NULL = re-sent by the next run
  resolved_at   timestamptz,
  resolved_by   text,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE UNIQUE INDEX reconciliation_alerts_open ON reconciliation_alerts (provider, livemode, mismatch_key) WHERE status = 'open';

-- Coin packs: every `purchase` coin operation in [from, to) that came from a
-- Stripe charge (related payment ref `ch_…`, or referenced by a Stripe ledger
-- row) must have EXACTLY ONE Stripe ledger row ('charge', ch_…, 'charge')
-- pointing at it, for the same charge id; and every such ledger row occurring in
-- [from, to) must point at exactly one `purchase` operation. Each side is
-- matched regardless of the other side's timestamp, so a webhook processed
-- after midnight is not a false alarm. Must return no rows.
CREATE FUNCTION membership.coin_purchase_ledger_mismatches(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (kind text, coin_operation_id uuid, ledger_id bigint, charge_id text, coins bigint, amount_cents bigint)
LANGUAGE sql STABLE AS $$
  WITH ops AS (
    SELECT o.id, o.coins, o.related_entity_id
      FROM membership.coin_operations o
     WHERE o.kind = 'purchase' AND o.created_at >= p_from AND o.created_at < p_to
       AND ((o.related_entity_type = 'payment' AND o.related_entity_id LIKE 'ch\_%')
            OR EXISTS (SELECT 1 FROM membership.payment_ledger l WHERE l.coin_operation_id = o.id AND l.provider = 'stripe'))
  ), op_rows AS (
    SELECT ops.id, ops.coins, ops.related_entity_id, l.id AS ledger_id, l.provider_object_id, l.amount_cents,
           count(l.id) OVER (PARTITION BY ops.id) AS n
      FROM ops LEFT JOIN membership.payment_ledger l
        ON l.coin_operation_id = ops.id AND l.provider = 'stripe'
       AND l.provider_object_type = 'charge' AND l.entry_type = 'charge'
  ), led AS (
    SELECT l.id, l.provider_object_id, l.amount_cents, l.coin_operation_id, o.kind AS op_kind, o.coins
      FROM membership.payment_ledger l LEFT JOIN membership.coin_operations o ON o.id = l.coin_operation_id
     WHERE l.provider = 'stripe' AND l.provider_object_type = 'charge' AND l.entry_type = 'charge'
       AND l.occurred_at >= p_from AND l.occurred_at < p_to
  )
  SELECT 'purchase_without_ledger_row', id, NULL::bigint, related_entity_id, coins, NULL::bigint FROM op_rows WHERE n = 0
  UNION ALL
  SELECT 'purchase_with_multiple_ledger_rows', id, ledger_id, provider_object_id, coins, amount_cents FROM op_rows WHERE n > 1
  UNION ALL
  SELECT 'charge_ref_mismatch', id, ledger_id, provider_object_id, coins, amount_cents FROM op_rows
   WHERE n = 1 AND related_entity_id IS DISTINCT FROM provider_object_id
  UNION ALL
  SELECT 'ledger_row_without_purchase', coin_operation_id, id, provider_object_id, coins, amount_cents FROM led
   WHERE coin_operation_id IS NULL OR op_kind IS DISTINCT FROM 'purchase'
$$;

-- down
SET LOCAL search_path = membership, public;
DROP FUNCTION membership.coin_purchase_ledger_mismatches(timestamptz, timestamptz);
DROP TABLE reconciliation_alerts;
DROP TABLE reconciliation_daily_runs;
