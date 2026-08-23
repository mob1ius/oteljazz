/**
 * Cloudflare Pages Functions middleware: records who is fetching oteljazz.com.
 *
 * Why this exists at all: Cloudflare's own per-request logs (Logpush/Logpull) are Enterprise-only
 * and Instant Logs starts at Business, so on the free plan there is no way to see individual
 * requests. Web Analytics is JavaScript-based and therefore blind to exactly the traffic of
 * interest here -- crawlers, which do not run JS. This writes the rows Cloudflare will not.
 *
 * Three rules this follows, in order of importance:
 *   1. NEVER break the site. Every failure path returns the response anyway. A logging bug must
 *      not take the page down, least of all during a traffic spike.
 *   2. NEVER block the response. The insert runs inside waitUntil(), so it happens after the
 *      response is already on its way to the visitor.
 *   3. NEVER store an IP address. See infra/d1_schema.sql for the reasoning.
 */

// Requests for these are skipped. One page view pulls ~40 sample files, so logging assets would
// multiply write volume by roughly that factor and burn the free plan's daily write budget on
// rows that answer nothing. Note .txt is absent on purpose: a crawler fetching /robots.txt or
// /ai.txt is one of the most interesting events this table can capture.
const ASSET_RE = /\.(mp3|wav|ogg|png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|map|woff2?|ttf|eot)$/i;

// Self-identifying automation. Deliberately broad: the point is to catch crawlers, and a false
// positive on a human costs nothing here (the row is still recorded, just unsampled).
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

// A real browser UA is Mozilla/5.0 plus an engine token. Anything that matches neither this nor
// BOT_UA_RE is still treated as a bot: an unlabelled client is precisely what a quiet scraper
// looks like, and calling it "human" would be the more misleading default.
const BROWSER_UA_RE = /Mozilla\/5\.0.*(Chrome|Safari|Firefox|Edg|OPR|Trident)\//i;

// Bots are logged in full; browser traffic is sampled. This protects the crawler dataset -- the
// thing that is scientifically scarce -- from being crowded out of the daily write budget by a
// traffic spike, while still leaving a weightable human baseline. Raise toward 1.0 if volumes
// turn out to be modest; rows carry their own rate so old data stays interpretable either way.
const BROWSER_SAMPLE_RATE = 0.1;

function isBotUA(ua) {
  if (!ua) return true;                       // no UA at all is not a browser
  if (BOT_UA_RE.test(ua)) return true;
  return !BROWSER_UA_RE.test(ua);
}

export async function onRequest(context) {
  const { request, env, next, waitUntil } = context;

  // Serve first, decide about logging afterwards, so nothing here can delay the page.
  const response = await next();

  try {
    // No binding (local `wrangler pages dev`, or a preview deploy without D1) -> quietly skip.
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

    // Fire-and-forget: the visitor's response is already gone by the time this resolves, and a
    // rejected insert (quota exhausted, transient D1 error) must not surface as a failed request.
    waitUntil(stmt.run().catch(() => {}));
  } catch {
    // Deliberately swallowed. Rule 1: never break the site to record a log line.
  }

  return response;
}
