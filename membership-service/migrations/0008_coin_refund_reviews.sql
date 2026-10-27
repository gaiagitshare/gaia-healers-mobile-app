-- Coin-pack refunds whose coins were already partly spent (owner, 26 Oct 2026):
-- the unspent coins are taken back (existing rule); the value that could NOT be
-- recovered is recorded here and flagged for a human. Never a negative balance.

-- up
SET LOCAL search_path = membership, public;
CREATE TABLE coin_refund_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          uuid NOT NULL REFERENCES persons(id),
  provider           text NOT NULL DEFAULT 'stripe',
  refund_ref         text NOT NULL,                       -- the provider refund id
  charge_ref         text,
  coins_refunded     bigint NOT NULL CHECK (coins_refunded > 0),     -- coins the refund corresponds to
  coins_recovered    bigint NOT NULL CHECK (coins_recovered >= 0),
  coins_unrecovered  bigint NOT NULL CHECK (coins_unrecovered > 0),
  value_cents_unrecovered bigint NOT NULL CHECK (value_cents_unrecovered >= 0),
  currency           char(3) NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by        text,
  resolution         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  UNIQUE (provider, refund_ref),
  CHECK (coins_recovered + coins_unrecovered = coins_refunded),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL))
);
CREATE INDEX coin_refund_reviews_open ON coin_refund_reviews (created_at) WHERE status = 'open';

-- down
SET LOCAL search_path = membership, public;
DROP TABLE coin_refund_reviews;
