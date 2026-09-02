/**
 * oteljazz.com Worker entry point: this project's own config for the reusable crawler-logging
 * handler in crawler-log.js, plus routing for the live-OTLP relay (live-relay.js). Kept
 * deliberately thin on the crawler-log side -- this file should only ever contain what is
 * actually specific to oteljazz.com, so a future project can copy crawler-log.js and
 * operator-claims.js wholesale and write a file that looks like this one, not like the old
 * monolithic version. See docs/ROADMAP.md's v1.3.0 section for why this split happened.
 */

import { createCrawlerLogHandler } from './crawler-log.js';

export { LiveRelay } from './live-relay.js';

// Belt-and-braces against run_worker_first being widened later in wrangler.jsonc: even if an
// asset request reaches this script, it is not worth a row. .txt is deliberately absent -- a
// crawler fetching /robots.txt or /ai.txt is the single most interesting event this table can
// record.
const ASSET_RE = /\.(mp3|wav|ogg|png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|map|woff2?|ttf|eot)$/i;

const crawlerLog = createCrawlerLogHandler({ assetPattern: ASSET_RE });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // /live/<session>/ws (browser viewer) and /live/<session>/v1/traces (OTLP ingest) both route
    // to the same Durable Object instance for that session id -- see live-relay.js's header for
    // why session id is the isolation boundary. Checked before the crawler log, and returned
    // directly rather than falling through to it: crawlerLog always tries env.ASSETS.fetch()
    // first, which would 404 on a path that was never a static file.
    const m = url.pathname.match(/^\/live\/([^/]+)\/(ws|v1\/traces)$/);
    if (m) {
      const id = env.LIVE_RELAY.idFromName(m[1]);
      return env.LIVE_RELAY.get(id).fetch(request);
    }

    return crawlerLog.fetch(request, env, ctx);
  },
};
