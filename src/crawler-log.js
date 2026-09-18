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
 *   3. NEVER store an IP address. What IS stored is client_key: a daily-rotating keyed hash of
 *      it, which is pseudonymous rather than anonymous and is described as such everywhere it is
 *      mentioned (README.md, web/ai.txt, infra/d1_schema.sql). The address itself never reaches
 *      the database, and the key is unlinkable across days by anyone, ourselves included.
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

// --- per-visitor grouping without a per-visitor identifier -------------------------------------
//
// Every question about a *visitor* rather than a request -- did anyone actually start the audio,
// is this one scanner or fifty, how much did the flood guard swallow -- needs some stable key.
// (ASN, user-agent) was the alternative and it is useless for this: it merges an entire consumer
// ISP into one "visitor". So: HMAC of the IP under a secret the database never sees, with the UTC
// date mixed into the message so the key rotates daily and nothing links across days.
//
// The secret lives in Cloudflare's secret store (LOG_CLIENT_KEY_SECRET) and must never be
// committed or exported alongside the rows -- the rows are only pseudonymous while the two are
// kept apart. No secret configured is a supported state: client_key is NULL and everything else
// still works, which is what keeps this module reusable by a project that does not want it.
let signingKey = null;         // { secret, key } -- importKey per request would be wasteful
async function importSigningKey(secret) {
  if (signingKey && signingKey.secret === secret) return signingKey.key;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  signingKey = { secret, key };
  return key;
}

async function clientKey(secret, ip, isoTs) {
  if (!secret || !ip) return null;
  const key = await importSigningKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${isoTs.slice(0, 10)}\n${ip}`));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;                  // 64 bits is ample to separate visitors and short enough to read
}

// Sampling decided by the visitor, not by the request. A funnel (page -> app.js -> corpus model)
// only exists if the same visitor's requests are either all logged or all dropped; independent
// coin flips per request would leave a 10% sample holding almost no complete chains, and the
// resulting "nobody pressed play" would be an artifact of the sampler. Derived from client_key,
// so it rotates daily along with it. Falls back to a per-request flip only when there is no key.
function sampledIn(key, rate) {
  if (rate >= 1) return true;
  if (!key) return Math.random() < rate;
  return parseInt(key.slice(0, 6), 16) / 0x1000000 < rate;
}

// The flood guard collapses duplicates into one row; these are the counts at which it bothers to
// write the collapsed total back. Logarithmic on purpose: the guard exists because unbounded
// writes would exhaust the daily budget, so counting must not reintroduce a write per request. A
// flood costs about nine updates per path-minute instead of one insert per request, and dup_count
// is a floor -- exact at the last checkpoint passed.
const DUP_CHECKPOINTS = new Set([2, 5, 10, 25, 50, 100, 250, 500, 1000]);
const dupCheckpoint = (n) => DUP_CHECKPOINTS.has(n) || (n > 1000 && n % 1000 === 0);
const dupMarker = (id, n) =>
  new Response(JSON.stringify({ id, n }), { headers: { 'cache-control': 'max-age=90' } });

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
 * @param {number} [sampleRate=0.1] - fraction of non-bot (browser) VISITORS to log. Bots are
 *   always logged in full regardless of this value; this only thins the human baseline so a
 *   traffic spike can't exhaust the write budget before it exhausts anything else. Visitors, not
 *   requests: the draw is derived from client_key (see sampledIn), so a sampled-in visitor's whole
 *   day is present and a sampled-out visitor's is entirely absent. Rows still carry the rate, and
 *   real volume is still SUM(1/sample_rate).
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
        // The sampling decision moved into the async block below, because it now depends on the
        // client key and deriving that is async. Nothing is lost by deciding late: the response
        // has already left either way, and a dropped sample costs one HMAC.

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
          client: null,           // filled in below; deriving it is async
        };
        const ip = request.headers.get('cf-connecting-ip') || '';

        // Everything below runs AFTER the response is on its way. The dedupe check needs an
        // await, and rule 2 says the visitor never waits for logging.
        ctx.waitUntil((async () => {
          try {
            // Pseudonymous grouping key first: the sampling decision below is derived from it, so
            // that one visitor is either wholly in the sample or wholly out of it.
            row.client = await clientKey(env.LOG_CLIENT_KEY_SECRET, ip, row.ts);
            if (!sampledIn(row.client, rate)) return;

            // Flood guard. Bots deliberately bypass browser sampling, so without this a few
            // thousand requests with bot-shaped user-agents would exhaust D1's free daily write
            // budget -- destroying the launch-day dataset, which is the one-time observable this
            // whole thing exists to capture. Verified as a real hole against the original
            // deploy: 12 concurrent forged-bot requests all wrote rows.
            //
            // One row per (client, path) per minute, and that row now carries dup_count: how many
            // requests it stands for. The window is a fixed minute bucket in the key rather than a
            // sliding TTL, because a sliding window that each duplicate renews would keep a busy
            // client collapsed into a single row indefinitely -- the cadence of a flood is part of
            // what the scan exhibits are reading. The IP is used only as a cache key here and is
            // never stored, so the no-IP rule still holds. Keyed by the request's own hostname,
            // not a hardcoded one, so this dedupe namespace never collides across two different
            // deploys of this same module on the same Cloudflare account's edge cache.
            const bucket = Math.floor(Date.parse(row.ts) / 60000);
            const dupKey = ip
              ? new Request(`https://dedupe.${url.hostname}.invalid/${bucket}/${encodeURIComponent(ip)}${row.path}`)
              : null;

            if (dupKey) {
              const seen = await caches.default.match(dupKey);
              if (seen) {
                // Already recorded this client+path this minute: no new row, just a bigger count
                // on the row that already exists, and only at a checkpoint.
                let marker = null;
                try { marker = await seen.json(); } catch { /* unreadable marker: still a dup */ }
                if (marker && marker.id) {
                  const n = (marker.n || 1) + 1;
                  await caches.default.put(dupKey, dupMarker(marker.id, n));
                  if (dupCheckpoint(n)) {
                    await env.DB.prepare(`UPDATE ${tableName} SET dup_count = ? WHERE id = ?`)
                      .bind(n, marker.id).run();
                  }
                }
                return;
              }
            }

            const insert = await env.DB.prepare(
              `INSERT INTO ${tableName}
                 (ts, path, method, ua, referer, country, asn, claimed_operator,
                  is_bot_ua, cf_verified_bot, sample_rate, status, client_key, dup_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
            ).bind(
              row.ts, row.path, row.method, row.ua, row.referer, row.country,
              row.asn, row.claimed, row.bot, row.verified, row.rate, row.status, row.client
            ).run();

            // Park the new row's id with the dedupe marker so the duplicates that follow know
            // which row to count up. If the id is unavailable for any reason the marker still
            // suppresses duplicate rows -- it just cannot count them, which is the old behaviour.
            if (dupKey) {
              await caches.default.put(dupKey, dupMarker(insert?.meta?.last_row_id ?? null, 1));
            }
          } catch (err) {
            // Still never surfaces as a failed request -- the response is already away by the
            // time this runs (see the comment above ctx.waitUntil). What changed is that this
            // used to swallow the error toward US too, not just toward the visitor: a quietly
            // exhausted D1 write budget or a transient outage could stop the crawler dataset from
            // accumulating for hours with nothing to notice it. Logging the failure doesn't
            // compromise "never break the site," it just stops "never break the site" from also
            // meaning "never find out it broke."
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
