-- Legacy GHL memberships (architecture C: legacy stays billed by GHL until the
-- member chooses to move) and the controlled migration flow.
--
-- legacy_memberships is a READ-ONLY MIRROR of what GHL reports, filled by the
-- legacy reader. Nothing here changes GHL, a price, a payment method or course
-- access. Unknown or ambiguous rows are review items, never "inactive".

-- up
SET LOCAL search_path = membership, public;

CREATE TABLE legacy_memberships (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                   text NOT NULL DEFAULT 'ghl' CHECK (source = 'ghl'),
  external_subscription_id text NOT NULL,
  external_contact_id      text,                   -- GHL contact id as reported (may be re-keyed by a GHL merge)
  person_id                uuid REFERENCES persons(id),   -- set once the contact maps to a person
  payment_provider         text NOT NULL CHECK (payment_provider IN ('stripe', 'paypal', 'manual', 'unknown')),
  external_price_id        text,
  tier                     text CHECK (tier IS NULL OR tier ~ '^[a-z][a-z0-9_]{1,39}$'),   -- e.g. silver, gold, diamond
  mapping                  text NOT NULL CHECK (mapping IN ('mapped', 'unmapped', 'ambiguous')),
  reported_status          text NOT NULL,          -- verbatim from GHL; never normalised away
  amount_cents             bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency                 char(3),
  billing_interval         text CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year', 'week', 'day', 'other')),
  last_payment_at          timestamptz,            -- newest successful transaction seen
  paid_through_estimate    timestamptz,            -- last payment + one interval (an estimate, GHL gives no period end)
  stale_suspected          boolean NOT NULL DEFAULT false,   -- "no recent payment" - a REVIEW flag, never a cancellation
  review_state             text NOT NULL DEFAULT 'none' CHECK (review_state IN ('none', 'needs_review', 'reviewed')),
  review_reasons           text[] NOT NULL DEFAULT '{}',
  review_note              text,
  first_seen_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at             timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_subscription_id)
);
CREATE INDEX legacy_memberships_person ON legacy_memberships (person_id);
CREATE INDEX legacy_memberships_contact ON legacy_memberships (external_contact_id);

-- A controlled move from a legacy membership to a new tier (spec §11: an
-- invitation with a sweetener, never a deadline). The new subscription starts
-- billing only after the legacy one is paid through; staff cancel the GHL
-- subscription by hand and confirm it here. Code never cancels GHL.
CREATE TABLE migration_offers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id                 uuid NOT NULL REFERENCES persons(id),
  legacy_membership_id      uuid NOT NULL REFERENCES legacy_memberships(id),
  target_plan_version_id    uuid NOT NULL REFERENCES plan_versions(id),
  target_interval           text NOT NULL CHECK (target_interval IN ('month', 'year')),
  sweetener_months          integer NOT NULL DEFAULT 2 CHECK (sweetener_months BETWEEN 0 AND 12),
  status                    text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'checkout_started', 'subscribed', 'completed', 'withdrawn', 'declined')),
  billing_starts_at         timestamptz,            -- set at checkout: legacy paid-through + sweetener
  subscription_id           uuid REFERENCES subscriptions(id),
  legacy_cancel_confirmed_by text,                  -- staff member who cancelled the GHL subscription by hand
  legacy_cancel_confirmed_at timestamptz,
  offered_by                text NOT NULL,
  offered_at                timestamptz NOT NULL DEFAULT now(),
  accepted_at               timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'completed') = (legacy_cancel_confirmed_at IS NOT NULL))
);
-- At most one open offer per legacy membership.
CREATE UNIQUE INDEX migration_offers_one_open ON migration_offers (legacy_membership_id)
  WHERE status IN ('offered', 'accepted', 'checkout_started', 'subscribed');

-- down
SET LOCAL search_path = membership, public;
DROP TABLE migration_offers;
DROP TABLE legacy_memberships;
