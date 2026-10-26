-- Migration safeguards (owner, 26 Oct 2026):
--   * the free-months sweetener is a policy setting, OFF (0) by default;
--   * new recurring billing never starts until the legacy cancellation is VERIFIED
--     (staff report it AND the read-only GHL mirror shows it ended) or an
--     authorized exception is documented;
--   * billing holds are recorded (each one extends the new subscription's trial).

-- up
SET LOCAL search_path = membership, public;

ALTER TABLE migration_offers ALTER COLUMN sweetener_months SET DEFAULT 0;

ALTER TABLE migration_offers DROP CONSTRAINT migration_offers_status_check;
ALTER TABLE migration_offers ADD CONSTRAINT migration_offers_status_check
  CHECK (status IN ('offered', 'accepted', 'checkout_started', 'subscribed', 'cancel_reported', 'completed', 'withdrawn', 'declined'));

ALTER TABLE migration_offers
  ADD COLUMN legacy_cancel_verified_at timestamptz,         -- the mirror saw GHL report the legacy subscription ended
  ADD COLUMN exception_authorized_by   text,
  ADD COLUMN exception_reason          text CHECK (exception_reason IS NULL OR length(exception_reason) >= 10),
  ADD COLUMN exception_at              timestamptz,
  ADD COLUMN billing_holds             integer NOT NULL DEFAULT 0,
  ADD COLUMN last_billing_hold_at      timestamptz;

ALTER TABLE migration_offers DROP CONSTRAINT migration_offers_check;
ALTER TABLE migration_offers ADD CONSTRAINT migration_offers_completion_check CHECK (
  status <> 'completed'
  OR (legacy_cancel_confirmed_at IS NOT NULL AND legacy_cancel_verified_at IS NOT NULL)
  OR (exception_at IS NOT NULL AND exception_authorized_by IS NOT NULL AND exception_reason IS NOT NULL));
ALTER TABLE migration_offers ADD CONSTRAINT migration_offers_exception_complete CHECK (
  (exception_at IS NULL) = (exception_authorized_by IS NULL) AND (exception_at IS NULL) = (exception_reason IS NULL));

DROP INDEX migration_offers_one_open;
CREATE UNIQUE INDEX migration_offers_one_open ON migration_offers (legacy_membership_id)
  WHERE status IN ('offered', 'accepted', 'checkout_started', 'subscribed', 'cancel_reported');

-- down
SET LOCAL search_path = membership, public;
DROP INDEX migration_offers_one_open;
CREATE UNIQUE INDEX migration_offers_one_open ON migration_offers (legacy_membership_id)
  WHERE status IN ('offered', 'accepted', 'checkout_started', 'subscribed');
ALTER TABLE migration_offers DROP CONSTRAINT migration_offers_exception_complete;
ALTER TABLE migration_offers DROP CONSTRAINT migration_offers_completion_check;
ALTER TABLE migration_offers
  DROP COLUMN legacy_cancel_verified_at, DROP COLUMN exception_authorized_by, DROP COLUMN exception_reason,
  DROP COLUMN exception_at, DROP COLUMN billing_holds, DROP COLUMN last_billing_hold_at;
ALTER TABLE migration_offers ADD CONSTRAINT migration_offers_check CHECK ((status = 'completed') = (legacy_cancel_confirmed_at IS NOT NULL));
ALTER TABLE migration_offers DROP CONSTRAINT migration_offers_status_check;
ALTER TABLE migration_offers ADD CONSTRAINT migration_offers_status_check
  CHECK (status IN ('offered', 'accepted', 'checkout_started', 'subscribed', 'completed', 'withdrawn', 'declined'));
ALTER TABLE migration_offers ALTER COLUMN sweetener_months SET DEFAULT 2;
