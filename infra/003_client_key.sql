-- Adds a per-visitor grouping key and the flood guard's collapse count.
--   npx wrangler d1 execute oteljazz-logs --remote --file=infra/003_client_key.sql
--
-- Additive only: both columns are nullable or defaulted, so rows written before this migration
-- stay valid and queries that ignore the new columns are unaffected.
--
-- client_key is a keyed hash of the IP, NOT the IP. See src/crawler-log.js's clientKey() for the
-- derivation and infra/d1_schema.sql for what this does and does not protect.
ALTER TABLE requests ADD COLUMN client_key TEXT;
ALTER TABLE requests ADD COLUMN dup_count INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_requests_client_key ON requests (client_key, ts);
