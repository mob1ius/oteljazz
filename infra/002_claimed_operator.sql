-- Adds the CLAIM half of the claim-vs-evidence split (see src/index.js).
--   npx wrangler d1 execute oteljazz-logs --remote --file=infra/002_claimed_operator.sql
ALTER TABLE requests ADD COLUMN claimed_operator TEXT;
CREATE INDEX IF NOT EXISTS idx_requests_claimed ON requests (claimed_operator);
