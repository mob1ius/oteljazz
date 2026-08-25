-- D1 schema for the oteljazz.com crawler log.
--
-- Apply with:
--   npx wrangler d1 execute oteljazz-logs --remote --file=infra/d1_schema.sql
--
-- WHAT THIS DELIBERATELY DOES NOT STORE: IP addresses. The research question is which crawlers
-- arrive and whether they honor robots.txt, and that is answerable from user-agent, ASN, and
-- timing. Storing IPs would make this a personal-data collection with the GDPR obligations that
-- follow, for no analytical gain. The site otherwise sets no cookies and no storage of any kind;
-- keep it that way. ASN and country are coarse and are the useful part: ASN is what identifies
-- the operator behind an unlabelled crawler, which a spoofable user-agent string cannot.

CREATE TABLE IF NOT EXISTS requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               TEXT    NOT NULL,  -- ISO-8601 UTC
  path             TEXT    NOT NULL,
  method           TEXT    NOT NULL,
  ua               TEXT,              -- truncated to 512 chars
  referer          TEXT,
  country          TEXT,              -- Cloudflare's two-letter code
  asn              INTEGER,           -- operator identity for unlabelled crawlers
  is_bot_ua        INTEGER NOT NULL,  -- our own heuristic (see functions/_middleware.js)
  cf_verified_bot  INTEGER,           -- Cloudflare's verdict; NULL when unavailable on this plan
  -- 1.0 means every matching request was recorded. Browser traffic is sampled, so rows must be
  -- weighted by 1/sample_rate to reconstruct real volumes. Recorded per row rather than assumed,
  -- because the rate may be retuned later and old rows must stay interpretable.
  sample_rate      REAL    NOT NULL,
  -- The operator a request CLAIMS to be, parsed from the user-agent. Deliberately separate from
  -- asn: the claim is spoofable in one curl, the network it arrived from is not. Keeping them in
  -- different columns is what makes impersonation detectable rather than assumed away.
  claimed_operator TEXT,
  -- What the client actually GOT, not merely what it asked for. Without this a probe for
  -- /.env is indistinguishable from a successful read of it, and "crawler requested N paths"
  -- cannot be separated from "crawler retrieved N paths" -- the first question a reviewer
  -- asks of scan traffic.
  status           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_requests_ts        ON requests (ts);
CREATE INDEX IF NOT EXISTS idx_requests_bot_ts    ON requests (is_bot_ua, ts);
CREATE INDEX IF NOT EXISTS idx_requests_path      ON requests (path);
CREATE INDEX IF NOT EXISTS idx_requests_status    ON requests (status);
