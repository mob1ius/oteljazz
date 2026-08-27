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

-- 5. THE BLIND SPOT IN QUERY 4. Query 4 can only see automation that declares itself: it filters
--    on is_bot_ua = 1, and that flag is set by failing to look like a browser. A scraper that
--    sends a full Chrome user-agent matches no bot pattern, matches BROWSER_UA_RE, and is
--    therefore classified as a browser and sampled at BROWSER_SAMPLE_RATE (0.1) -- the same rate
--    as a human. So the quietest scrapers, the ones deliberately not announcing themselves, are
--    logged at one tenth the rate of the polite ones, and query 4 cannot see them at all.
--
--    That is a deliberate trade (the write budget is finite and crawler rows are the scarce
--    data), not a defect, but it has to be corrected for rather than forgotten. This query looks
--    in the sampled stream instead, and weights back up: every row here stands for roughly ten
--    real requests.
--
--    The tell is the ASN. A real browser arrives from a consumer ISP or a mobile carrier. A
--    browser user-agent arriving from a hosting provider, with no referer, walking many distinct
--    paths, is scraper-shaped whatever it calls itself. As with query 1, the ASN still has to be
--    looked up at analysis time -- this narrows the candidates, it does not convict them.
SELECT asn,
       country,
       count(*)                           AS sampled_hits,
       CAST(round(count(*) / avg(sample_rate)) AS INTEGER) AS est_real_hits,  -- real volume
       count(DISTINCT path)               AS distinct_paths,
       count(DISTINCT ua)                 AS distinct_uas,
       min(ts)                            AS first_seen,
       max(ts)                            AS last_seen
FROM requests
WHERE is_bot_ua = 0            -- browser-shaped: the half query 4 discards
  AND referer IS NULL          -- arrived cold, not by following a link
GROUP BY asn, country
HAVING count(DISTINCT path) >= 5
ORDER BY est_real_hits DESC;

-- 6. ORDERING, NOT JUST COUNTS. Query 3 reports that an operator read /robots.txt and that it
--    fetched content, but not which came first -- and those are different findings. "Read the
--    rules, then crawled anyway" is a compliance claim. "Crawled, then read the rules later" is
--    a crawler that had not yet looked, which is careless rather than defiant. Reporting the
--    first as though it were established, when the data cannot separate them, is the kind of
--    overclaim this file exists to prevent.
--
--    ts is ISO-8601 UTC, so lexicographic comparison is chronological comparison; no date
--    parsing is needed for this to be correct.
--
--    Still subject to the same rule as query 3: run it against verified ASNs before reporting.
WITH firsts AS (
  SELECT claimed_operator,
         min(CASE WHEN path =      '/robots.txt'             THEN ts END) AS first_robots,
         min(CASE WHEN path NOT IN ('/robots.txt', '/ai.txt') THEN ts END) AS first_content
  FROM requests
  WHERE claimed_operator IS NOT NULL
  GROUP BY claimed_operator
)
SELECT claimed_operator,
       first_robots,
       first_content,
       CASE
         WHEN first_robots  IS NULL              THEN 'never read robots.txt'
         WHEN first_content IS NULL              THEN 'read robots.txt only'
         WHEN first_robots  <  first_content     THEN 'read robots first, fetched anyway'
         ELSE                                         'fetched first, read robots later'
       END AS ordering
FROM firsts
ORDER BY ordering, claimed_operator;

-- A NOTE ON WHAT THIS FILE CANNOT ANSWER. robots.txt compliance is observable here: the file
-- was fetched or it was not, content was fetched or it was not, and the order is recorded.
-- ai.txt compliance is NOT. A row showing /ai.txt was fetched says the crawler read the
-- preference; nothing in this schema, or reachable from this site, shows whether the content
-- was subsequently used for training. read_ai_txt in query 3 is a fetch count and must never be
-- reported as a compliance rate. The asymmetry is the point: build findings on the half that is
-- measurable.
