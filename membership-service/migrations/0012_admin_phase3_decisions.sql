-- Control Center, Phase 3 owner decisions (docs/membership/CONTROL-CENTER.md §1, §3):
--   1. Goodwill coins are their own bucket: never expire, never taken back by a payment
--      refund (clawbackPurchased only touches `purchased`), shown separately in the wallet.
--      Spend order (default, owner can change): granted -> goodwill -> purchased -> legacy.
--      Existing rows are not rewritten (the ledgers are append-only): goodwill credited
--      before this migration stays in `purchased`, where it was booked.
--   2. Operators must change the initial password at first sign-in (must_change_password).
--      Every operator that exists when this runs was created with a password shown once by
--      the CLI, so they all start with the flag set.
--   3. Explicit execution / retry of an approved request: one row per attempt, a unique
--      attempt key (the operator's requestId), at most one running and at most one executed
--      attempt per request (unique partial indexes). Attempts are never deleted; a row is
--      updated only once, from `running` to its outcome.
--   4. audit_logs.reason: the written reason, on the audit row itself.

-- up
SET LOCAL search_path = membership, public;

ALTER TABLE coin_wallets ADD COLUMN goodwill_balance bigint NOT NULL DEFAULT 0 CHECK (goodwill_balance >= 0);
ALTER TABLE coin_transactions DROP CONSTRAINT coin_transactions_balance_type_check;
ALTER TABLE coin_transactions ADD CONSTRAINT coin_transactions_balance_type_check CHECK (balance_type IN ('granted', 'goodwill', 'purchased', 'legacy'));

CREATE OR REPLACE FUNCTION membership.wallet_mismatches()
RETURNS TABLE (wallet_id uuid, balance_type text, stored bigint, summed bigint) LANGUAGE sql STABLE AS $$
  WITH sums AS (
    SELECT w.id, b.t,
           CASE b.t WHEN 'granted' THEN w.granted_balance WHEN 'goodwill' THEN w.goodwill_balance WHEN 'purchased' THEN w.purchased_balance ELSE w.legacy_balance END AS stored,
           COALESCE((SELECT sum(delta_coins) FROM membership.coin_transactions x WHERE x.wallet_id = w.id AND x.balance_type = b.t), 0)::bigint AS summed
      FROM membership.coin_wallets w CROSS JOIN (VALUES ('granted'), ('goodwill'), ('purchased'), ('legacy')) AS b(t)
  )
  SELECT id, t, stored, summed FROM sums WHERE stored <> summed
$$;

ALTER TABLE operators ADD COLUMN must_change_password boolean NOT NULL DEFAULT true;
ALTER TABLE operators ADD COLUMN password_changed_at timestamptz;

ALTER TABLE audit_logs ADD COLUMN reason text CHECK (reason IS NULL OR length(reason) <= 4000);

CREATE TABLE admin_action_attempts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id        uuid NOT NULL REFERENCES admin_action_requests(id),
  attempt_no        integer NOT NULL CHECK (attempt_no >= 1),
  kind              text NOT NULL CHECK (kind IN ('initial', 'retry')),
  attempt_key       text NOT NULL UNIQUE CHECK (length(attempt_key) BETWEEN 8 AND 140),
  executed_by       uuid NOT NULL REFERENCES operators(id),
  reason            text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  outcome           text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'executed', 'failed', 'not_executed', 'abandoned')),
  result            jsonb,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  UNIQUE (request_id, attempt_no),
  CHECK ((outcome = 'running') = (finished_at IS NULL)),
  CHECK (kind = 'retry' OR attempt_no = 1)
);
CREATE UNIQUE INDEX admin_action_attempts_one_running ON admin_action_attempts (request_id) WHERE outcome = 'running';
CREATE UNIQUE INDEX admin_action_attempts_one_executed ON admin_action_attempts (request_id) WHERE outcome = 'executed';

CREATE FUNCTION membership.attempt_finish_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'admin_action_attempts is append-only (DELETE refused)' USING ERRCODE = 'restrict_violation'; END IF;
  IF OLD.outcome <> 'running' OR NEW.outcome = 'running'
     OR (NEW.id, NEW.request_id, NEW.attempt_no, NEW.kind, NEW.attempt_key, NEW.executed_by, NEW.reason, NEW.started_at)
        IS DISTINCT FROM (OLD.id, OLD.request_id, OLD.attempt_no, OLD.kind, OLD.attempt_key, OLD.executed_by, OLD.reason, OLD.started_at) THEN
    RAISE EXCEPTION 'an attempt is finished once and never changed after' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_action_attempts_finish_once BEFORE UPDATE OR DELETE ON admin_action_attempts
  FOR EACH ROW EXECUTE FUNCTION membership.attempt_finish_once();

-- down
SET LOCAL search_path = membership, public;
DROP TABLE admin_action_attempts;
DROP FUNCTION membership.attempt_finish_once();
ALTER TABLE audit_logs DROP COLUMN reason;
ALTER TABLE operators DROP COLUMN password_changed_at;
ALTER TABLE operators DROP COLUMN must_change_password;
CREATE OR REPLACE FUNCTION membership.wallet_mismatches()
RETURNS TABLE (wallet_id uuid, balance_type text, stored bigint, summed bigint) LANGUAGE sql STABLE AS $$
  WITH sums AS (
    SELECT w.id, b.t,
           CASE b.t WHEN 'granted' THEN w.granted_balance WHEN 'purchased' THEN w.purchased_balance ELSE w.legacy_balance END AS stored,
           COALESCE((SELECT sum(delta_coins) FROM membership.coin_transactions x WHERE x.wallet_id = w.id AND x.balance_type = b.t), 0)::bigint AS summed
      FROM membership.coin_wallets w CROSS JOIN (VALUES ('granted'), ('purchased'), ('legacy')) AS b(t)
  )
  SELECT id, t, stored, summed FROM sums WHERE stored <> summed
$$;
ALTER TABLE coin_transactions DROP CONSTRAINT coin_transactions_balance_type_check;
ALTER TABLE coin_transactions ADD CONSTRAINT coin_transactions_balance_type_check CHECK (balance_type IN ('granted', 'purchased', 'legacy'));
ALTER TABLE coin_wallets DROP COLUMN goodwill_balance;
