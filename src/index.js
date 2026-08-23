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

function isBotUA(ua) {
  if (!ua) return true;                     // no UA at all is not a browser
  if (BOT_UA_RE.test(ua)) return true;
  return !BROWSER_UA_RE.test(ua);
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

      const stmt = env.DB.prepare(
        `INSERT INTO requests
           (ts, path, method, ua, referer, country, asn, is_bot_ua, cf_verified_bot, sample_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        new Date().toISOString(),
        url.pathname.slice(0, 512),
        request.method,
        ua.slice(0, 512),
        (request.headers.get('referer') || '').slice(0, 512) || null,
        cf.country || null,
        typeof cf.asn === 'number' ? cf.asn : null,
        bot ? 1 : 0,
        verified,
        rate
      );

      // Fire-and-forget: the visitor's response is already on its way, and a rejected insert
      // (quota exhausted, transient D1 error) must not surface as a failed request.
      ctx.waitUntil(stmt.run().catch(() => {}));
    } catch {
      // Deliberately swallowed. Rule 1: never break the site to record a log line.
    }

    return response;
  },
};
