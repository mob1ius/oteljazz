/**
 * oteljazz.com Worker: serves the static site and records who is fetching it.
 *
 * Why this exists: Cloudflare's per-request logs (Logpush/Logpull) are Enterprise-only and
 * Instant Logs starts at Business, so the free plan offers no way to see individual requests.
 * Web Analytics is JavaScript-based and therefore blind to crawlers, which is exactly the
 * traffic worth observing here. This writes the rows Cloudflare will not.
 *
 * Routing note: only the paths listed under assets.run_worker_first in wrangler.jsonc reach this
 * script at all. Everything else is served straight from the asset store without invoking (or
 * billing) the Worker. Change that list, not this file, to alter what gets logged.
 *
 * Three rules, in order of importance:
 *   1. NEVER break the site. Every failure path still returns the response. A logging bug must
 *      not take the page down, least of all during a traffic spike.
 *   2. NEVER block the response. The insert runs in waitUntil(), after the response is away.
 *   3. NEVER store an IP address. See infra/d1_schema.sql for the reasoning.
 */

// Belt-and-braces against run_worker_first being widened later: even if an asset request reaches
// this script, it is not worth a row. .txt is deliberately absent -- a crawler fetching
// /robots.txt or /ai.txt is the single most interesting event this table can record.
const ASSET_RE = /\.(mp3|wav|ogg|png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|map|woff2?|ttf|eot)$/i;

// Self-identifying automation. Deliberately broad: the point is to catch crawlers, and a false
// positive on a human costs nothing here beyond an unsampled row.
const BOT_UA_RE = new RegExp(
  [
    'bot', 'crawl', 'spider', 'scrap', 'slurp', 'fetcher', 'headless',
    // Named AI/LLM crawlers, the actual subject of the exercise.
    'gptbot', 'oai-searchbot', 'chatgpt', 'openai', 'claude', 'anthropic', 'perplexity',
    'ccbot', 'google-extended', 'bytespider', 'amazonbot', 'applebot', 'meta-external',
    'cohere', 'diffbot', 'imagesift', 'omgili', 'timpi', 'youbot', 'webzio', 'firecrawl',
    // SEO and archival crawlers, worth separating from AI ones during analysis.
    'semrush', 'ahrefs', 'dataforseo', 'mj12', 'dotbot', 'ia_archiver',
    // Generic HTTP clients: an unlabelled scraper usually shows up as one of these.
    'curl', 'wget', 'python-requests', 'httpx', 'aiohttp', 'go-http', 'java/', 'okhttp',
    'scrapy', 'node-fetch', 'axios', 'libwww', 'lwp-', 'guzzle', 'postman',
  ].join('|'),
  'i'
);

// A real browser UA is Mozilla/5.0 plus an engine token. Anything matching neither this nor
// BOT_UA_RE is still treated as a bot: an unlabelled client is precisely what a quiet scraper
// looks like, and calling it human would be the more misleading default.
const BROWSER_UA_RE = /Mozilla\/5\.0.*(Chrome|Safari|Firefox|Edg|OPR|Trident)\//i;

// Bots logged in full; browser traffic sampled. This keeps the scientifically scarce data
// (crawler hits) from being crowded out of the daily write budget by a traffic spike, while
// leaving a weightable human baseline. The rate is stored per row rather than assumed, so it can
// be retuned later without making existing rows uninterpretable.
const BROWSER_SAMPLE_RATE = 0.1;

// Keep only scheme+host+path from a Referer. Query strings are where the sensitive parts live
// (tokens, search terms), and the referring page's identity is all the analysis needs.
function refererPathOnly(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return (u.origin + u.pathname).slice(0, 512);
  } catch {
    return null;              // unparseable Referer is not worth storing raw
  }
}

function isBotUA(ua) {
  if (!ua) return true;                     // no UA at all is not a browser
  if (BOT_UA_RE.test(ua)) return true;
  return !BROWSER_UA_RE.test(ua);
}

// A user-agent is a CLAIM, not evidence: anyone can send `GPTBot/1.2` from a home connection in
// one curl, and this was demonstrated against the live site (a forged GPTBot hit logged from
// AS7922, a residential ISP). Cloudflare's own verifiedBot signal is not populated on this plan,
// so it cannot arbitrate. What CAN arbitrate is the ASN, which Cloudflare records from the
// connection itself and the sender does not control.
//
// So the claim is recorded separately from the evidence. `claimed_operator` is what the UA says
// it is; `asn` is where it actually came from. A row claiming an operator from an ASN that
// operator does not use is an impersonation, and that is now a query rather than a guess (see
// infra/verify_crawlers.sql). Deliberately no hardcoded ASN allowlist here: published crawler
// ranges change, and baking a possibly-stale list into the collector would silently mislabel
// rows at the moment of collection, where it can never be corrected. Classification belongs at
// analysis time, against ranges fetched then.
const OPERATOR_CLAIMS = [
  ['gptbot', /GPTBot/i],
  ['oai-searchbot', /OAI-SearchBot/i],
  ['chatgpt-user', /ChatGPT-User/i],
  ['claudebot', /ClaudeBot|anthropic-ai|Claude-Web/i],
  ['perplexitybot', /PerplexityBot/i],
  ['perplexity-user', /Perplexity-User/i],
  ['ccbot', /CCBot/i],
  ['google-extended', /Google-Extended/i],
  ['googlebot', /Googlebot/i],
  ['bingbot', /bingbot/i],
  ['applebot', /Applebot/i],
  ['bytespider', /Bytespider/i],
  ['amazonbot', /Amazonbot/i],
  ['meta-externalagent', /meta-externalagent|FacebookBot/i],
  ['duckduckbot', /DuckDuckBot/i],
];

function claimedOperator(ua) {
  if (!ua) return null;
  for (const [name, re] of OPERATOR_CLAIMS) if (re.test(ua)) return name;
  return null;                              // self-identifies as nobody in particular
}

export default {
  async fetch(request, env, ctx) {
    // Serve from the asset store first. _headers (the CSP and caching rules built into dist/) is
    // applied by the asset server on this path, so responses carry it exactly as they would if
    // the Worker were not in front.
    const response = await env.ASSETS.fetch(request);

    try {
      // No binding (local dev without --d1, or a deploy before the D1 id is filled in) -> skip.
      if (!env.DB) return response;

      const url = new URL(request.url);
      if (ASSET_RE.test(url.pathname)) return response;

      const ua = request.headers.get('user-agent') || '';
      const bot = isBotUA(ua);
      const rate = bot ? 1.0 : BROWSER_SAMPLE_RATE;
      if (!bot && Math.random() >= rate) return response;

      const cf = request.cf || {};
      // botManagement is not populated on every plan; record NULL rather than guessing.
      const verified =
        cf.botManagement && typeof cf.botManagement.verifiedBot === 'boolean'
          ? (cf.botManagement.verifiedBot ? 1 : 0)
          : null;

      const row = {
        ts: new Date().toISOString(),
        path: url.pathname.slice(0, 512),
        method: request.method,
        ua: ua.slice(0, 512),
        // Origin + path only, never the query string. A referer routinely carries session
        // tokens, search terms, and private document URLs -- storing it whole would quietly
        // collect more sensitive data than the IP address this schema deliberately omits.
        // Verified against a live request carrying "?token=..." before this was added.
        referer: refererPathOnly(request.headers.get('referer')),
        country: cf.country || null,
        asn: typeof cf.asn === 'number' ? cf.asn : null,
        claimed: claimedOperator(ua),
        bot: bot ? 1 : 0,
        verified,
        rate,
      };
      const ip = request.headers.get('cf-connecting-ip') || '';

      // Everything below runs AFTER the response is on its way. The dedupe check needs an await,
      // and rule 2 says the visitor never waits for logging.
      ctx.waitUntil((async () => {
        try {
          // Flood guard. Bots deliberately bypass browser sampling, so without this a few
          // thousand requests with bot-shaped user-agents would exhaust D1's free daily write
          // budget -- destroying the launch-day dataset, which is the one-time observable this
          // whole thing exists to capture. Verified as a real hole: 12 concurrent forged-bot
          // requests all wrote rows.
          //
          // One row per (client, path) per minute. That preserves what the research needs (which
          // operators arrived, when, and what they asked for) while removing the amplification: a
          // flood from one source now costs one row per path instead of unbounded rows. The IP is
          // used only as a cache key here and is never stored, so the no-IP rule still holds.
          if (ip) {
            const key = new Request(
              `https://dedupe.oteljazz.invalid/${encodeURIComponent(ip)}${row.path}`
            );
            const seen = await caches.default.match(key);
            if (seen) return;                       // already recorded this client+path recently
            await caches.default.put(
              key,
              new Response('1', { headers: { 'cache-control': 'max-age=60' } })
            );
          }

          await env.DB.prepare(
            `INSERT INTO requests
               (ts, path, method, ua, referer, country, asn, claimed_operator,
                is_bot_ua, cf_verified_bot, sample_rate)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            row.ts, row.path, row.method, row.ua, row.referer, row.country,
            row.asn, row.claimed, row.bot, row.verified, row.rate
          ).run();
        } catch {
          // Swallowed: a rejected insert (quota exhausted, transient D1 error) must never
          // surface as a failed request.
        }
      })());
    } catch {
      // Deliberately swallowed. Rule 1: never break the site to record a log line.
    }

    return response;
  },
};
