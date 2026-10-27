-- Provider adapters (Milestone E): reconciliation runs and the GHL sync
-- dead-letter queue. Numbered 0003 because 0002 belongs to Milestone D; the
-- two touch different tables and can be applied in either order.
--
-- Nothing here holds subscription truth: GHL is a CRM mirror (spec §16) and a
-- reconciliation run is evidence, not state.

-- up
SET LOCAL search_path = membership, public;

-- One row per reconciliation run; append-only so the alert history cannot be
-- rewritten after the fact.
CREATE TABLE reconciliation_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL CHECK (provider IN ('stripe', 'partner')),
  window_from    timestamptz NOT NULL,
  window_to      timestamptz NOT NULL,
  livemode       boolean NOT NULL DEFAULT false,
  complete       boolean NOT NULL,                 -- every page fetched; only then is "missing in provider" meaningful
  checked        integer NOT NULL CHECK (checked >= 0),
  matched        integer NOT NULL CHECK (matched >= 0),
  mismatch_count integer NOT NULL CHECK (mismatch_count >= 0),
  mismatches     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (window_to > window_from)
);
CREATE INDEX reconciliation_runs_window ON reconciliation_runs (provider, window_from);
CREATE TRIGGER reconciliation_runs_append_only BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION membership.refuse_change();

-- GHL sync failures a human must look at: exhausted retries, duplicate
-- contacts for one email (reported, never merged), identity conflicts.
-- One OPEN row per (person, reason); a repeat bumps attempts instead of piling up.
CREATE TABLE ghl_sync_dead_letters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES persons(id),
  contact_id   text,
  reason       text NOT NULL CHECK (reason IN ('provider_unavailable', 'duplicate_contacts', 'contact_missing', 'identity_conflict', 'rejected')),
  error_code   text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- contact ids, desired tag/field diff; never wellness data
  attempts     integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  text,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE UNIQUE INDEX ghl_sync_dead_letters_open ON ghl_sync_dead_letters (person_id, reason) WHERE status = 'open';

-- down
SET LOCAL search_path = membership, public;
DROP TABLE ghl_sync_dead_letters;
DROP TABLE reconciliation_runs;
