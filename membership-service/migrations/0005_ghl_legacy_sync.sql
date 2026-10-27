-- Legacy GHL reader runs, expected GHL grants (offer / community) and their
-- confirmations, and a 'partial_apply' dead-letter reason for tag transitions
-- that stopped half-way. Architecture C: Gaia only sets gaia-m: tags; GHL
-- workflows do the grant and the existing mirror workflows confirm it.

-- up
SET LOCAL search_path = membership, public;

-- One row per legacy reader pass. An incomplete pass (page cap, error) is
-- recorded here and writes nothing to legacy_memberships.
CREATE TABLE legacy_reader_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  complete           boolean NOT NULL,
  subscriptions_seen integer NOT NULL CHECK (subscriptions_seen >= 0),
  transactions_seen  integer NOT NULL CHECK (transactions_seen >= 0),
  pages              integer NOT NULL CHECK (pages >= 0),
  error_code         text,
  summary            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- counts and reasons only, never contact data
  CHECK (finished_at >= started_at)
);
CREATE INDEX legacy_reader_runs_finished ON legacy_reader_runs (finished_at DESC);
CREATE TRIGGER legacy_reader_runs_append_only BEFORE UPDATE OR DELETE ON legacy_reader_runs
  FOR EACH ROW EXECUTE FUNCTION membership.refuse_change();

-- What Gaia expects GHL to do after a tag change, and whether GHL confirmed it
-- (Course Access Granted/Removed Mirror and community mirror workflows).
-- A newer expectation for the same contact + target supersedes an older
-- pending one, so a quick grant -> revoke never raises a false alert.
CREATE TABLE ghl_expected_grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id        uuid NOT NULL REFERENCES persons(id),
  contact_id       text NOT NULL,
  entitlement_key  text NOT NULL,
  grant_type       text NOT NULL CHECK (grant_type IN ('offer', 'community')),
  ghl_id           text NOT NULL,
  via_tag          text NOT NULL,
  action           text NOT NULL CHECK (action IN ('grant', 'revoke')),
  map_version      integer NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'superseded')),
  expected_at      timestamptz NOT NULL,
  confirmed_at     timestamptz,
  confirmation_source text,
  alerted_at       timestamptz,
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX ghl_expected_grants_one_pending ON ghl_expected_grants (contact_id, grant_type, ghl_id) WHERE status = 'pending';
CREATE INDEX ghl_expected_grants_pending_age ON ghl_expected_grants (expected_at) WHERE status = 'pending';

ALTER TABLE ghl_sync_dead_letters DROP CONSTRAINT ghl_sync_dead_letters_reason_check;
ALTER TABLE ghl_sync_dead_letters ADD CONSTRAINT ghl_sync_dead_letters_reason_check
  CHECK (reason IN ('provider_unavailable', 'duplicate_contacts', 'contact_missing', 'identity_conflict', 'rejected', 'partial_apply'));

-- down
SET LOCAL search_path = membership, public;
DELETE FROM ghl_sync_dead_letters WHERE reason = 'partial_apply';
ALTER TABLE ghl_sync_dead_letters DROP CONSTRAINT ghl_sync_dead_letters_reason_check;
ALTER TABLE ghl_sync_dead_letters ADD CONSTRAINT ghl_sync_dead_letters_reason_check
  CHECK (reason IN ('provider_unavailable', 'duplicate_contacts', 'contact_missing', 'identity_conflict', 'rejected'));
DROP TABLE ghl_expected_grants;
DROP TABLE legacy_reader_runs;
