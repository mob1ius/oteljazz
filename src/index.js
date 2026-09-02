/**
 * oteljazz.com Worker entry point: this project's own config for the reusable crawler-logging
 * handler in crawler-log.js. Kept deliberately thin -- this file should only ever contain what
 * is actually specific to oteljazz.com, so a future project can copy crawler-log.js and
 * operator-claims.js wholesale and write a file that looks like this one, not like the old
 * monolithic version. See docs/ROADMAP.md's v1.3.0 section for why this split happened.
 */

import { createCrawlerLogHandler } from './crawler-log.js';

// Belt-and-braces against run_worker_first being widened later in wrangler.jsonc: even if an
// asset request reaches this script, it is not worth a row. .txt is deliberately absent -- a
// crawler fetching /robots.txt or /ai.txt is the single most interesting event this table can
// record.
const ASSET_RE = /\.(mp3|wav|ogg|png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|map|woff2?|ttf|eot)$/i;

export default createCrawlerLogHandler({ assetPattern: ASSET_RE });
