-- Control Center operators (Membership 2.0, Phase 3): named operator accounts, hashed sessions,
-- two-person action requests, append-only person notes, and the admin:operate client scope.
-- Secrets are never stored in clear: passwords are scrypt hashes, TOTP secrets are AES-256-GCM
-- encrypted with MEMBERSHIP_OPERATOR_KEY (outside the database), session tokens are SHA-256 hashes.

-- up
SET LOCAL search_path = membership, public;
ALTER TABLE api_clients DROP CONSTRAINT api_clients_scopes_check;
ALTER TABLE api_clients ADD CONSTRAINT api_clients_scopes_check CHECK (scopes <@ ARRAY['identity:read', 'identity:write', 'subscriptions:read', 'entitlements:read',
  'wallet:read', 'coins:quote', 'coins:debit', 'member:read', 'member:write', 'admin:operate']::text[]);

CREATE TABLE operators (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND length(email) <= 254),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  role             text NOT NULL CHECK (role IN ('viewer', 'support', 'finance', 'owner')),
  password_scrypt  text NOT NULL CHECK (password_scrypt LIKE 'scrypt$%'),
  totp_secret_enc  text NOT NULL CHECK (totp_secret_enc LIKE 'v1:%'),
  totp_last_step   bigint,                                   -- last accepted TOTP time step: a code is never accepted twice
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_logins    integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until     timestamptz,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz,
  disabled_at      timestamptz,
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

CREATE TABLE operator_sessions (
  token_sha256  text PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  operator_id   uuid NOT NULL REFERENCES operators(id),
  created_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,                       -- absolute limit (8 h); the 30 min idle limit is last_seen_at + 30 min
  revoked_at    timestamptz,
  ip_hash       text,
  ua_hash       text,
  CHECK (expires_at > created_at)
);
CREATE INDEX operator_sessions_operator ON operator_sessions (operator_id) WHERE revoked_at IS NULL;

CREATE TABLE admin_action_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action           text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  requested_by     uuid NOT NULL REFERENCES operators(id),
  required_role    text NOT NULL CHECK (required_role IN ('viewer', 'support', 'finance', 'owner')),
  dual             boolean NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'executed', 'failed')),
  decided_by       uuid REFERENCES operators(id),
  decided_at       timestamptz,
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  decision_key     text UNIQUE CHECK (decision_key IS NULL OR length(decision_key) BETWEEN 8 AND 120),   -- the approver's optional requestId: a replayed approve/reject returns the first outcome
  executed_at      timestamptz,
  result           jsonb,
  idempotency_key  text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  CHECK (decided_by <> requested_by),                        -- nobody approves their own request
  CHECK (dual OR decided_by IS NULL),
  CHECK (status <> 'executed' OR executed_at IS NOT NULL)
);
CREATE INDEX admin_action_requests_status ON admin_action_requests (status, created_at DESC);

CREATE TABLE person_notes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES persons(id),
  operator_id  uuid NOT NULL REFERENCES operators(id),
  body         text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_notes_person ON person_notes (person_id, id);
CREATE TRIGGER person_notes_append_only BEFORE UPDATE OR DELETE ON person_notes
  FOR EACH ROW EXECUTE FUNCTION membership.refuse_change();

-- down
SET LOCAL search_path = membership, public;
DROP TABLE person_notes;
DROP TABLE admin_action_requests;
DROP TABLE operator_sessions;
DROP TABLE operators;
ALTER TABLE api_clients DROP CONSTRAINT api_clients_scopes_check;
ALTER TABLE api_clients ADD CONSTRAINT api_clients_scopes_check CHECK (scopes <@ ARRAY['identity:read', 'identity:write', 'subscriptions:read', 'entitlements:read',
  'wallet:read', 'coins:quote', 'coins:debit', 'member:read', 'member:write']::text[]);
