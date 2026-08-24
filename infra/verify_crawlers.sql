-- Crawler impersonation / compliance analysis.
--
--   npx wrangler d1 execute oteljazz-logs --remote --file=infra/verify_crawlers.sql
--
-- WHY THIS EXISTS. A user-agent is a claim the sender controls; an ASN is evidence the network
-- records. Sending `GPTBot/1.2` from a home broadband line takes one curl, and that was done
-- against this site during a security review -- the forged row logged from AS7922, a residential
-- ISP, and was indistinguishable from a genuine GPTBot hit by user-agent alone. Cloudflare's own
-- verifiedBot signal is not populated on this plan, so it cannot settle the question either.
--
-- Therefore: no claim in this dataset is evidence of anything until its ASN has been checked
-- against the ranges the named operator actually publishes. Any statement of the form "GPTBot
-- crawled despite robots.txt" that rests on the user-agent alone is not defensible, and a
-- reviewer would be right to reject it.
--
-- HOW TO USE. Query 1 lists which ASNs each claimed operator arrived from. Cross-check those
-- against the operator's own published ranges AT ANALYSIS TIME (OpenAI, Google, Perplexity and
-- others publish JSON range lists; they change, which is exactly why no allowlist is hardcoded
-- into the collector). An operator arriving from a consumer ISP or a VPS provider it does not
-- own is an impersonation, not a visit.
--
-- Note the finding this makes possible is better than the one originally planned: reporting
-- compliance AND impersonation together is a stronger result than compliance alone.

-- 1. Claim vs. origin. Every (claimed operator, ASN) pair seen, most active first.
--    Expect a genuine operator to appear from a small, stable set of ASNs it owns.
SELECT claimed_operator,
       asn,
       country,
       count(*)      AS hits,
       min(ts)       AS first_seen,
       max(ts)       AS last_seen
FROM requests
WHERE claimed_operator IS NOT NULL
GROUP BY claimed_operator, asn, country
ORDER BY claimed_operator, hits DESC;

-- 2. Spread check: an operator showing up from many unrelated ASNs is the signature of
--    impersonation (or of a distributed scraper wearing its name).
SELECT claimed_operator,
       count(DISTINCT asn) AS distinct_asns,
       count(*)            AS hits
FROM requests
WHERE claimed_operator IS NOT NULL
GROUP BY claimed_operator
ORDER BY distinct_asns DESC;

-- 3. THE COMPLIANCE QUESTION. Which claimed operators read robots.txt, and which then fetched
--    content anyway? Only meaningful for rows whose ASN survived the check above -- run this
--    filtered to verified ASNs before reporting any of it.
SELECT claimed_operator,
       sum(CASE WHEN path = '/robots.txt' THEN 1 ELSE 0 END) AS read_robots,
       sum(CASE WHEN path = '/ai.txt'     THEN 1 ELSE 0 END) AS read_ai_txt,
       sum(CASE WHEN path NOT IN ('/robots.txt', '/ai.txt') THEN 1 ELSE 0 END) AS fetched_content,
       min(ts) AS first_seen
FROM requests
WHERE claimed_operator IS NOT NULL
GROUP BY claimed_operator
ORDER BY fetched_content DESC;

-- 4. Unlabelled automation: no operator claimed, but not browser-shaped either. The quiet
--    scrapers. Worth watching for volume from a single ASN.
SELECT asn, country, count(*) AS hits, count(DISTINCT ua) AS distinct_uas
FROM requests
WHERE is_bot_ua = 1 AND claimed_operator IS NULL
GROUP BY asn, country
HAVING hits > 5
ORDER BY hits DESC;
