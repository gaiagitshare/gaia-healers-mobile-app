-- Membership 2.0 launch flags (owner, 26 Oct 2026). Server-enforced; production defaults to OFF.
-- Effective stage = min(stage stored here, MEMBERSHIP2_STAGE_CEILING in the server environment).
-- The environment ceiling defaults to OFF, so a deployment can never activate billing by itself.

-- up
SET LOCAL search_path = membership, public;

CREATE TABLE launch_state (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),           -- exactly one row
  stage         text NOT NULL DEFAULT 'OFF' CHECK (stage IN ('OFF', 'INTERNAL_PILOT', 'LIMITED_NEW_CUSTOMERS', 'ALL_NEW_CUSTOMERS')),
  limited_cap   integer NOT NULL DEFAULT 0 CHECK (limited_cap >= 0),  -- max new customers while LIMITED_NEW_CUSTOMERS
  changed_by    text NOT NULL DEFAULT 'migration',
  approval_ref  text,                                                  -- the GO decision / ticket for stages above INTERNAL_PILOT
  reason        text NOT NULL DEFAULT 'initial state',
  changed_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (stage IN ('OFF', 'INTERNAL_PILOT') OR approval_ref IS NOT NULL)
);
INSERT INTO launch_state DEFAULT VALUES;

CREATE TABLE launch_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_stage   text NOT NULL,
  to_stage     text NOT NULL,
  limited_cap  integer NOT NULL,
  changed_by   text NOT NULL,
  approval_ref text,
  reason       text NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER launch_history_append_only BEFORE UPDATE OR DELETE ON launch_history
  FOR EACH ROW EXECUTE FUNCTION membership.refuse_change();

CREATE TABLE pilot_members (
  person_id   uuid PRIMARY KEY REFERENCES persons(id),
  added_by    text NOT NULL,
  note        text,
  added_at    timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  removed_by  text
);

-- down
SET LOCAL search_path = membership, public;
DROP TABLE pilot_members;
DROP TABLE launch_history;
DROP TABLE launch_state;
