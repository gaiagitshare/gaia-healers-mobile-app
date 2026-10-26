-- Gaia membership foundation (spec v2.5 §9, Phase 0 audit E/H).
--
-- Rules carried by the schema itself, not by callers:
--   * money is integer minor units, coins are integers, timestamps are UTC;
--   * every provider object has a unique external id;
--   * published plan versions are immutable (new price = new version);
--   * coin_transactions, payment_ledger, subscription_events and audit_logs are
--     append-only: UPDATE and DELETE are refused by trigger;
--   * a wallet's balances always equal the sum of its transactions (checked by
--     membership.wallet_mismatches(), asserted by the tests).
--
-- Nothing here touches the legacy JSON ledger, GHL or the partner platform.

-- up
CREATE SCHEMA IF NOT EXISTS membership;
SET LOCAL search_path = membership, public;

CREATE FUNCTION membership.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;

-- Identity --------------------------------------------------------------------
-- One person, many external identities. Gaia Practitioners does not share this
-- database: its accounts appear here only as identities with platform
-- 'gaia_practitioners'. An external id belongs to exactly one person; moving it
-- is an explicit, audited operation, never a silent re-key.
CREATE TABLE persons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'merged')),
  merged_into uuid REFERENCES persons(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'merged') = (merged_into IS NOT NULL))
);

CREATE TABLE person_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES persons(id),
  platform      text NOT NULL CHECK (platform IN ('gaia_healers', 'gaia_practitioners', 'ghl', 'stripe', 'event_manager', 'email')),
  kind          text NOT NULL,                 -- e.g. contact, practitioner_account, customer, location_contact
  external_id   text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  verified_at   timestamptz,
  linked_by     text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, kind, external_id)
);
CREATE INDEX person_identities_person ON person_identities (person_id);

-- Plans -----------------------------------------------------------------------
CREATE TABLE entitlement_definitions (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{1,79}$'),
  kind        text NOT NULL CHECK (kind IN ('feature', 'module', 'course_access', 'certification', 'support', 'community', 'listing', 'perk', 'discount')),
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  name            text NOT NULL,
  owner_type      text NOT NULL CHECK (owner_type IN ('gaia', 'practitioner')),
  practitioner_id uuid REFERENCES persons(id),      -- tenant for practitioner-owned plans (Phase 2)
  rank            integer NOT NULL DEFAULT 0,       -- ladder position, for upgrade/downgrade direction
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_type = 'practitioner') = (practitioner_id IS NOT NULL))
);

CREATE TABLE plan_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id              uuid NOT NULL REFERENCES plans(id),
  version              integer NOT NULL CHECK (version >= 1),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  is_legacy            boolean NOT NULL DEFAULT false,   -- grandfathered terms (spec §11)
  monthly_coin_grant   integer NOT NULL DEFAULT 0 CHECK (monthly_coin_grant >= 0),
  terms                jsonb NOT NULL DEFAULT '{}'::jsonb,  -- customer-facing terms snapshot
  published_at         timestamptz,
  retired_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version),
  CHECK ((status = 'draft') = (published_at IS NULL)),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE TABLE plan_version_prices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id    uuid NOT NULL REFERENCES plan_versions(id),
  billing_interval   text NOT NULL CHECK (billing_interval IN ('none', 'month', 'year')),
  amount_cents       bigint NOT NULL CHECK (amount_cents >= 0),
  currency           char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  UNIQUE (plan_version_id, billing_interval)
);

-- Provider price ids are attached after publication (a Stripe price is created
-- for an already-fixed version), so they live outside the immutable rows.
CREATE TABLE provider_price_refs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_price_id uuid NOT NULL REFERENCES plan_version_prices(id),
  provider              text NOT NULL CHECK (provider IN ('stripe', 'ghl', 'partner', 'simulated')),
  external_price_id     text NOT NULL,
  livemode              boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_price_id),
  UNIQUE (plan_version_price_id, provider, livemode)
);

CREATE TABLE plan_version_entitlements (
  plan_version_id  uuid NOT NULL REFERENCES plan_versions(id),
  entitlement_key  text NOT NULL REFERENCES entitlement_definitions(key),
  value            jsonb NOT NULL DEFAULT 'true'::jsonb,  -- true, or a quantity / percent
  PRIMARY KEY (plan_version_id, entitlement_key)
);

-- A published version (and its prices and entitlements) can never change; only
-- its status may move published -> retired.
CREATE FUNCTION membership.guard_plan_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'published plan version % cannot be deleted', OLD.id USING ERRCODE = 'restrict_violation'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF OLD.status = 'published' AND NEW.status = 'retired'
     AND (NEW.plan_id, NEW.version, NEW.is_legacy, NEW.monthly_coin_grant, NEW.terms, NEW.published_at)
         IS NOT DISTINCT FROM (OLD.plan_id, OLD.version, OLD.is_legacy, OLD.monthly_coin_grant, OLD.terms, OLD.published_at)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'plan version % is % and immutable', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER plan_versions_immutable BEFORE UPDATE OR DELETE ON plan_versions
  FOR EACH ROW EXECUTE FUNCTION membership.guard_plan_version();

CREATE FUNCTION membership.guard_plan_version_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM membership.plan_versions
   WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.plan_version_id ELSE OLD.plan_version_id END;
  IF st <> 'draft' THEN
    RAISE EXCEPTION '% of a % plan version cannot change', TG_TABLE_NAME, st USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.plan_version_id <> OLD.plan_version_id THEN
    RAISE EXCEPTION 'cannot move % between versions', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER plan_version_prices_immutable BEFORE INSERT OR UPDATE OR DELETE ON plan_version_prices
  FOR EACH ROW EXECUTE FUNCTION membership.guard_plan_version_child();
CREATE TRIGGER plan_version_entitlements_immutable BEFORE INSERT OR UPDATE OR DELETE ON plan_version_entitlements
  FOR EACH ROW EXECUTE FUNCTION membership.guard_plan_version_child();

-- Subscriptions ---------------------------------------------------------------
CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id                uuid NOT NULL REFERENCES persons(id),
  plan_version_id          uuid NOT NULL REFERENCES plan_versions(id),
  billing_interval         text NOT NULL CHECK (billing_interval IN ('none', 'month', 'year')),
  status                   text NOT NULL CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')),
  provider                 text NOT NULL CHECK (provider IN ('stripe', 'ghl', 'partner', 'manual', 'simulated')),
  provider_subscription_id text,
  provider_state_at        timestamptz,             -- provider time of the newest state applied (out-of-order guard)
  source                   text NOT NULL DEFAULT 'new' CHECK (source IN ('new', 'legacy_import', 'promotion', 'migration_offer')),
  trial_end                timestamptz,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  grace_until              timestamptz,
  cancel_at                timestamptz,             -- scheduled access end shown before confirming a cancel
  canceled_at              timestamptz,
  ended_at                 timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id),
  CHECK (provider IN ('manual', 'simulated') OR provider_subscription_id IS NOT NULL),
  CHECK (current_period_end IS NULL OR current_period_start IS NULL OR current_period_end > current_period_start)
);
CREATE INDEX subscriptions_person ON subscriptions (person_id);

CREATE TABLE subscription_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id),
  from_status      text,
  to_status        text NOT NULL,
  reason           text NOT NULL,
  webhook_event_id uuid,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER subscription_events_append_only BEFORE UPDATE OR DELETE ON subscription_events
  FOR EACH ROW EXECUTE FUNCTION membership.refuse_change();

-- Grants outside a subscription (promotions, manual grants, legacy promises).
CREATE TABLE entitlement_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES persons(id),
  entitlement_key text NOT NULL REFERENCES entitlement_definitions(key),
  value           jsonb NOT NULL DEFAULT 'true'::jsonb,
  source          text NOT NULL CHECK (source IN ('manual', 'promotion', 'legacy', 'partner')),
  source_ref      text,
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  revoked_at      timestamptz,
  granted_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX entitlement_grants_person ON entitlement_grants (person_id);

-- Coins -----------------------------------------------------------------------
-- Three buckets. granted: monthly allowance, use-it-or-lose-it. purchased: never
-- expires. legacy: migrated balances whose provenance is unproven (audit H,
-- decision N-4) -- never expires, spent last; stays 0 if the owner decides all
-- historical coins count as purchased.
CREATE TABLE coin_wallets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         uuid NOT NULL UNIQUE REFERENCES persons(id),
  granted_balance   bigint NOT NULL DEFAULT 0 CHECK (granted_balance >= 0),
  purchased_balance bigint NOT NULL DEFAULT 0 CHECK (purchased_balance >= 0),
  legacy_balance    bigint NOT NULL DEFAULT 0 CHECK (legacy_balance >= 0),
  granted_reset_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coin_packages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  coins        integer NOT NULL CHECK (coins > 0),
  bonus_coins  integer NOT NULL DEFAULT 0 CHECK (bonus_coins >= 0),
  price_cents  bigint NOT NULL CHECK (price_cents > 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One operation = one idempotent request (a grant, a purchase credit, a debit
-- hold...). The same key with the same request returns the original result; the
-- same key with a different request is a CONFLICT.
CREATE TABLE coin_operations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id           uuid NOT NULL REFERENCES coin_wallets(id),
  kind                text NOT NULL CHECK (kind IN ('grant', 'purchase', 'debit', 'refund', 'adjustment', 'migration_opening_balance')),
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash        text NOT NULL,
  coins               bigint NOT NULL CHECK (coins > 0),
  status              text NOT NULL CHECK (status IN ('completed', 'held', 'captured', 'released')),
  reason              text NOT NULL,
  related_entity_type text,
  related_entity_id   text,
  refunds_operation   uuid REFERENCES coin_operations(id),
  hold_expires_at     timestamptz,
  actor               text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,
  UNIQUE (wallet_id, idempotency_key),
  CHECK ((status = 'held') = (hold_expires_at IS NOT NULL AND settled_at IS NULL)),
  CHECK (kind = 'debit' OR status = 'completed')
);
CREATE INDEX coin_operations_holds ON coin_operations (hold_expires_at) WHERE status = 'held';
CREATE UNIQUE INDEX coin_operations_one_refund ON coin_operations (refunds_operation) WHERE refunds_operation IS NOT NULL;

CREATE TABLE coin_transactions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_id     uuid NOT NULL REFERENCES coin_wallets(id),
  operation_id  uuid NOT NULL REFERENCES coin_operations(id),
  balance_type  text NOT NULL CHECK (balance_type IN ('granted', 'purchased', 'legacy')),
  delta_coins   bigint NOT NULL CHECK (delta_coins <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  reason        text NOT NULL CHECK (reason IN ('grant', 'grant_expiry', 'purchase', 'debit_hold', 'hold_release', 'refund', 'adjustment', 'migration_opening_balance')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coin_transactions_wallet ON coin_transactions (wallet_id, id);
CREATE TRIGGER coin_transactions_append_only BEFORE UPDATE OR DELETE ON coin_transactions
  FOR EACH ROW EXECUTE FUNCTION membership.refuse_change();

-- Wallets whose stored balances differ from their transaction sums (must be empty).
CREATE FUNCTION membership.wallet_mismatches()
RETURNS TABLE (wallet_id uuid, balance_type text, stored bigint, summed bigint) LANGUAGE sql STABLE AS $$
  WITH sums AS (
    SELECT w.id, b.t,
           CASE b.t WHEN 'granted' THEN w.granted_balance WHEN 'purchased' THEN w.purchased_balance ELSE w.legacy_balance END AS stored,
           COALESCE((SELECT sum(delta_coins) FROM membership.coin_transactions x WHERE x.wallet_id = w.id AND x.balance_type = b.t), 0)::bigint AS summed
      FROM membership.coin_wallets w CROSS JOIN (VALUES ('granted'), ('purchased'), ('legacy')) AS b(t)
  )
  SELECT id, t, stored, summed FROM sums WHERE stored <> summed
$$;

-- Webhooks --------------------------------------------------------------------
CREATE TABLE webhook_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL CHECK (provider IN ('stripe', 'ghl', 'partner')),
  event_id         text NOT NULL,
  event_type       text NOT NULL,
  livemode         boolean NOT NULL DEFAULT false,
  provider_created_at timestamptz,
  payload          jsonb NOT NULL,
  payload_sha256   text NOT NULL,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'failed', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX webhook_events_queue ON webhook_events (next_attempt_at) WHERE status IN ('received', 'failed');

-- Payment ledger --------------------------------------------------------------
-- Signed amounts: charges positive, refunds / dispute losses / fees negative.
CREATE TABLE payment_ledger (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id            uuid REFERENCES persons(id),
  provider             text NOT NULL CHECK (provider IN ('stripe', 'ghl', 'partner', 'simulated')),
  provider_object_type text NOT NULL,          -- invoice, charge, refund, dispute, ...
  provider_object_id   text NOT NULL,
  entry_type           text NOT NULL CHECK (entry_type IN ('charge', 'refund', 'dispute', 'dispute_reversal', 'fee', 'adjustment')),
  amount_cents         bigint NOT NULL,
  currency             char(3) NOT NULL,
  subscription_id      uuid REFERENCES subscriptions(id),
  coin_operation_id    uuid REFERENCES coin_operations(id),
  webhook_event_id     uuid REFERENCES webhook_events(id),
  livemode             boolean NOT NULL DEFAULT false,
  occurred_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_object_type, provider_object_id, entry_type),
  CHECK ((entry_type = 'charge' AND amount_cents >= 0) OR (entry_type IN ('refund', 'dispute', 'fee') AND amount_cents <= 0) OR entry_type IN ('dispute_reversal', 'adjustment'))
);
CREATE TRIGGER payment_ledger_append_only BEFORE UPDATE OR DELETE ON payment_ledger
  FOR EACH ROW EXECUTE FUNCTION membership.refuse_change();

-- Audit -----------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL CHECK (actor_type IN ('admin', 'person', 'system', 'provider', 'partner')),
  actor_id    text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  request_id  text
);
CREATE INDEX audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION membership.refuse_change();

-- down
DROP SCHEMA membership CASCADE;
