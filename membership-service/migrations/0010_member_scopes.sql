-- Member-facing scopes for the Gaia Healers proxy (the member gateway). Platform clients only:
-- tenant (practitioner) clients stay limited to read scopes by the existing CHECK.

-- up
SET LOCAL search_path = membership, public;
ALTER TABLE api_clients DROP CONSTRAINT api_clients_scopes_check;
ALTER TABLE api_clients ADD CONSTRAINT api_clients_scopes_check CHECK (scopes <@ ARRAY['identity:read', 'identity:write', 'subscriptions:read', 'entitlements:read',
  'wallet:read', 'coins:quote', 'coins:debit', 'member:read', 'member:write']::text[]);

-- down
SET LOCAL search_path = membership, public;
ALTER TABLE api_clients DROP CONSTRAINT api_clients_scopes_check;
ALTER TABLE api_clients ADD CONSTRAINT api_clients_scopes_check CHECK (scopes <@ ARRAY['identity:read', 'subscriptions:read', 'entitlements:read', 'wallet:read', 'coins:quote', 'coins:debit']::text[]);
