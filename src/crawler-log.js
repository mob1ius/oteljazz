/**
 * Reusable Cloudflare Worker request logger, extracted from the OtelJazz launch (v1.3.0) so the
 * next site launch drops it in instead of hand-porting src/index.js and risking reintroducing a
 * bug already fixed once (see operator-claims.js's header).
 *
 * Why this exists at all: Cloudflare's per-request logs (Logpush/Logpull) are Enterprise-only and
 * Instant Logs starts at Business, so the free plan offers no way to see individual requests.
 * Web Analytics is JavaScript-based and therefore blind to crawlers, which is exactly the traffic
 * worth observing here. This writes the rows Cloudflare will not.
 *
 * Three rules, in order of importance, unchanged from the original:
 *   1. NEVER break the site. Every failure path still returns the response. A logging bug must
 *      not take the page down, least of all during a traffic spike.
 *   2. NEVER block the response. The insert runs in waitUntil(), after the response is away.
 *   3. NEVER store an IP address. See infra/d1_schema.sql for the reasoning.
 *
 * Usage: createCrawlerLogHandler({ assetPattern }) returns a `{ fetch }` object suitable for a
 * default export. Routing note carries over per deploy: only the paths listed under
 * assets.run_worker_first in that project's wrangler.jsonc reach this handler at all.
 */

import { claimedOperator } from './operator-claims.js';

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

/**
 * @param {RegExp} assetPattern - matches static-asset paths to skip logging entirely. Required,
 *   and deliberately per-deploy rather than a shared default: two projects rarely ship the same
 *   set of extensions, and getting this wrong either logs noise (pattern too narrow) or silently
 *   drops real pages that happen to share an extension with an asset (pattern too broad). .txt is
 *   deliberately excludable from any project's pattern -- a crawler fetching /robots.txt or
 *   /ai.txt is often the single most interesting event this table can record.
 * @param {number} [sampleRate=0.1] - fraction of non-bot (browser) traffic to log. Bots are
 *   always logged in full regardless of this value; this only thins the human baseline so a
 *   traffic spike can't exhaust the write budget before it exhausts anything else.
 * @param {string} [tableName='requests'] - D1 table name. Trusted, deploy-time config, not user
 *   input, so straight interpolation into the SQL is safe; D1's bind() can't parameterize a table
 *   name.
 */
export function createCrawlerLogHandler({ assetPattern, sampleRate = 0.1, tableName = 'requests' } = {}) {
  if (!assetPattern) throw new Error('createCrawlerLogHandler requires an assetPattern');

  return {
    async fetch(request, env, ctx) {
      // Serve from the asset store first. _headers (the CSP and caching rules built into the
      // deployed site) is applied by the asset server on this path, so responses carry it exactly
      // as they would if this Worker were not in front.
      const response = await env.ASSETS.fetch(request);

      try {
        // No binding (local dev without --d1, or a deploy before the D1 id is filled in) -> skip.
        if (!env.DB) return response;

        const url = new URL(request.url);
        if (assetPattern.test(url.pathname)) return response;

        const ua = request.headers.get('user-agent') || '';
        const bot = isBotUA(ua);
        const rate = bot ? 1.0 : sampleRate;
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
          referer: refererPathOnly(request.headers.get('referer')),
          country: cf.country || null,
          asn: typeof cf.asn === 'number' ? cf.asn : null,
          claimed: claimedOperator(ua),
          bot: bot ? 1 : 0,
          verified,
          rate,
          // Captured here, not inside waitUntil: `response` is consumed by the runtime once
          // returned, and reading .status later would be racing that.
          status: typeof response.status === 'number' ? response.status : null,
        };
        const ip = request.headers.get('cf-connecting-ip') || '';

        // Everything below runs AFTER the response is on its way. The dedupe check needs an
        // await, and rule 2 says the visitor never waits for logging.
        ctx.waitUntil((async () => {
          try {
            // Flood guard. Bots deliberately bypass browser sampling, so without this a few
            // thousand requests with bot-shaped user-agents would exhaust D1's free daily write
            // budget -- destroying the launch-day dataset, which is the one-time observable this
            // whole thing exists to capture. Verified as a real hole against the original
            // deploy: 12 concurrent forged-bot requests all wrote rows.
            //
            // One row per (client, path) per minute. That preserves what the research needs
            // (which operators arrived, when, and what they asked for) while removing the
            // amplification: a flood from one source now costs one row per path instead of
            // unbounded rows. The IP is used only as a cache key here and is never stored, so
            // the no-IP rule still holds. Keyed by the request's own hostname, not a hardcoded
            // one, so this dedupe namespace never collides across two different deploys of this
            // same module on the same Cloudflare account's edge cache.
            if (ip) {
              const key = new Request(
                `https://dedupe.${url.hostname}.invalid/${encodeURIComponent(ip)}${row.path}`
              );
              const seen = await caches.default.match(key);
              if (seen) return;                       // already recorded this client+path recently
              await caches.default.put(
                key,
                new Response('1', { headers: { 'cache-control': 'max-age=60' } })
              );
            }

            await env.DB.prepare(
              `INSERT INTO ${tableName}
                 (ts, path, method, ua, referer, country, asn, claimed_operator,
                  is_bot_ua, cf_verified_bot, sample_rate, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              row.ts, row.path, row.method, row.ua, row.referer, row.country,
              row.asn, row.claimed, row.bot, row.verified, row.rate, row.status
            ).run();
          } catch (err) {
            // Still never surfaces as a failed request -- the response is already away by the
            // time this runs (see the comment above ctx.waitUntil). What changed is that this
            // used to swallow the error toward US too, not just toward the visitor: a quietly
            // exhausted D1 write budget or a transient outage could stop the crawler dataset from
            // accumulating for hours with nothing to notice it. This is this project's own
            // OtelJazz.mike-516.workers.dev's echo of the exact gap src/live-relay.js had until a
            // security/observability pass found it -- same fix, applied here for the same reason:
            // logging the failure doesn't compromise "never break the site," it just stops
            // "never break the site" from also meaning "never find out it broke."
            console.error(JSON.stringify({ source: 'crawler-log', event: 'd1_write_failed', error: String(err), path: row.path }));
          }
        })());
      } catch (err) {
        console.error(JSON.stringify({ source: 'crawler-log', event: 'request_handling_failed', error: String(err) }));
      }

      return response;
    },
  };
}
