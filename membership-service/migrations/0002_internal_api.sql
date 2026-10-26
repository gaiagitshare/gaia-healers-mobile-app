-- Internal membership API (Milestone D): authenticated service clients, the
-- server-side coin price list, and single-use coin quotes.
--
-- Callers never send a coin amount for a debit: they ask for a quote for an
-- action, show it, then hold against the quote. The price comes from
-- coin_action_prices, so a client cannot under- or over-charge.

-- up
SET LOCAL search_path = membership, public;

-- A client is a calling service (the Gaia Healers proxy, the Gaia Practitioners
-- platform, a practitioner-scoped integration). Only a SHA-256 of its token is
-- stored. A client with practitioner_id is tenant-scoped: it can only see people
-- subscribed to that practitioner's plans, and only read scopes are allowed.
CREATE TABLE api_clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_.-]{2,59}$'),
  token_sha256    text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  scopes          text[] NOT NULL,
  practitioner_id uuid REFERENCES persons(id),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  CHECK (scopes <@ ARRAY['identity:read', 'subscriptions:read', 'entitlements:read', 'wallet:read', 'coins:quote', 'coins:debit']::text[]),
  CHECK (practitioner_id IS NULL OR scopes <@ ARRAY['subscriptions:read', 'entitlements:read']::text[])
);

CREATE TABLE coin_action_prices (
  action_key  text PRIMARY KEY CHECK (action_key ~ '^[a-z][a-z0-9_.]{1,79}$'),
  coins       integer NOT NULL CHECK (coins > 0),
  description text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coin_quotes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         uuid NOT NULL REFERENCES persons(id),
  client_id         uuid NOT NULL REFERENCES api_clients(id),
  action_key        text NOT NULL REFERENCES coin_action_prices(action_key),
  coins             integer NOT NULL CHECK (coins > 0),
  expires_at        timestamptz NOT NULL,
  used_by_operation uuid UNIQUE REFERENCES coin_operations(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coin_quotes_person ON coin_quotes (person_id);

-- down
SET LOCAL search_path = membership, public;
DROP TABLE coin_quotes;
DROP TABLE coin_action_prices;
DROP TABLE api_clients;
