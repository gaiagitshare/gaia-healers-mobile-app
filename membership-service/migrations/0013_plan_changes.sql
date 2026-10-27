-- Plan changes (owner decision 2026-10-26, docs/membership/INTEGRATIONS.md §6):
--   * upgrade: Stripe item update with proration_behavior=always_invoice and
--     payment_behavior=pending_if_incomplete. The higher tier (and the coin allowance
--     difference) is applied only when the verified invoice.paid webhook for the
--     prorated invoice arrives, never from the API response;
--   * downgrade and annual <-> monthly switch: a Stripe subscription schedule switches
--     the price at the period end (no proration, no refund); the member keeps the paid
--     tier until then and can cancel the scheduled change (schedule released).
-- One row per requested change. At most ONE pending change per subscription (partial
-- unique index). A member's retry under the same Idempotency-Key finds its row again.
-- Rows are never deleted; history also goes to subscription_events and audit_logs.

-- up
SET LOCAL search_path = membership, public;

CREATE TABLE subscription_changes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id       uuid NOT NULL REFERENCES subscriptions(id),
  person_id             uuid NOT NULL REFERENCES persons(id),
  kind                  text NOT NULL CHECK (kind IN ('upgrade', 'downgrade', 'interval_switch')),
  timing                text NOT NULL CHECK (timing IN ('after_payment', 'period_end')),
  from_plan_version_id  uuid NOT NULL REFERENCES plan_versions(id),
  from_interval         text NOT NULL CHECK (from_interval IN ('month', 'year')),
  to_plan_version_id    uuid NOT NULL REFERENCES plan_versions(id),
  to_interval           text NOT NULL CHECK (to_interval IN ('month', 'year')),
  to_price_id           uuid NOT NULL REFERENCES plan_version_prices(id),
  status                text NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested', 'pending_payment', 'scheduled', 'applied', 'canceled', 'expired', 'failed')),
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash          text NOT NULL,
  cancel_key            text CHECK (cancel_key IS NULL OR length(cancel_key) BETWEEN 8 AND 200),
  effective_at          timestamptz,
  amount_due_cents      bigint CHECK (amount_due_cents IS NULL OR amount_due_cents >= 0),
  currency              text,
  payment_required      boolean NOT NULL DEFAULT false,
  payment_url           text CHECK (payment_url IS NULL OR payment_url LIKE 'https://%'),
  provider_invoice_id   text,
  provider_schedule_id  text,
  coins_granted         integer CHECK (coins_granted IS NULL OR coins_granted >= 0),
  end_reason            text,
  requested_by          text NOT NULL,
  request_id            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  paid_at               timestamptz,
  applied_at            timestamptz,
  ended_at              timestamptz,
  UNIQUE (subscription_id, idempotency_key),
  CHECK ((timing = 'after_payment') = (kind = 'upgrade')),
  CHECK (status <> 'scheduled' OR (timing = 'period_end' AND effective_at IS NOT NULL AND provider_schedule_id IS NOT NULL)),
  CHECK (status <> 'pending_payment' OR timing = 'after_payment'),
  CHECK ((status IN ('applied', 'canceled', 'expired', 'failed')) = (ended_at IS NOT NULL OR applied_at IS NOT NULL))
);
CREATE UNIQUE INDEX subscription_changes_one_pending ON subscription_changes (subscription_id)
  WHERE status IN ('requested', 'pending_payment', 'scheduled');
CREATE INDEX subscription_changes_person ON subscription_changes (person_id, created_at DESC);
CREATE INDEX subscription_changes_invoice ON subscription_changes (provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;
CREATE INDEX subscription_changes_schedule ON subscription_changes (provider_schedule_id) WHERE provider_schedule_id IS NOT NULL;

-- down
SET LOCAL search_path = membership, public;
DROP TABLE subscription_changes;
