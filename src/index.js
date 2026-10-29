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
//
// The four app files are the exception, and the leading lookahead is what exempts them. They are
// the only server-visible evidence that a visitor's browser got past the HTML: a crawler that
// fetches "/" and stops looks identical to a person until app.js is requested, because only a
// script-executing browser asks for it. One client_key fetching "/" and then "/app.js" is a real
// browser; "/" alone is not.
//
// What this does NOT prove, checked in web/app.js rather than assumed: that anyone pressed play.
// The corpus model and every instrument sample are fetched during page load, inside the same
// chain that ends with the play button being enabled -- nothing is fetched at press time. So the
// funnel's last step is "the engine loaded", not "the engine ran". Measuring the press itself
// would take a beacon request, which is a new endpoint and deliberately out of scope here; until
// then the reports say "browser loaded the demo" and never "listened".
//
// Everything heavier stays excluded in wrangler.jsonc (a single page load pulls ~40 sample
// files), so this costs four Worker invocations per first visit, not forty-five.
const ASSET_RE = /^(?!\/(?:app|director|engine)\.js$|\/corpus_model_jazz\.json$).*\.(mp3|wav|ogg|png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|map|woff2?|ttf|eot)$/i;

const crawlerLog = createCrawlerLogHandler({ assetPattern: ASSET_RE });

// A session id lands in two places that must not take an arbitrary string: idFromName(), where
// every distinct value creates a Durable Object, and live_sessions.session, where it is the
// primary key. It is also the ONLY thing protecting a session, in both directions: knowing it
// lets you POST spans in, and it lets you open the WebSocket and read the real ones (agent
// names, tool names, operations, token counts).
//
// So ids are issued, not chosen. 32 lowercase hex characters, which is what
// `python3 -c "import secrets; print(secrets.token_hex(16))"` prints: 128 bits of randomness,
// the same shape every time, and a fixed-width primary key. The previous rule here allowed
// 16-64 characters of [A-Za-z0-9_-], which permitted "my-demo-session" as readily as a random
// one; before that it was "[^/]+", which took a two-character id and a two-kilobyte one equally.
//
// WHAT THIS DOES NOT DO: a regular expression checks shape, not entropy. Thirty-two zeroes match
// it. What changes is that the documented path produces a strong id and a memorable one is no
// longer something you can casually pick, not that a weak id has become impossible.
//
// Lowercase only, deliberately. idFromName("AB...") and idFromName("ab...") are DIFFERENT
// objects, so accepting mixed case without normalising would quietly give two people separate
// rooms for what they both believe is one id. One canonical spelling removes the question.
//
// THIS WIDTH IS COMMITTED. local/live-relay-hardening.md's Tier 3 derives the public session id
// as HMAC(secret, ingestToken), and that derivation must truncate to these same 32 hex
// characters. The repo's other HMAC (client_key, infra/d1_schema.sql) truncates to 16, which is
// right for a daily-rotating grouping key and wrong here: this one is a capability that grants
// read access to somebody's live telemetry. Matching it would force a second format change on a
// public endpoint, which is the thing this change exists to avoid having to do twice.
const SESSION_ID_RE = /^[0-9a-f]{32}$/;

// A Workers rate-limit binding was built here and removed, because it did not work. The intent
// was to throttle /live/* BEFORE idFromName(), which is the only point where a flood that uses a
// new session id every time can be refused at all -- the relay's own limiter lives on the object
// and so cannot see one. The binding attached correctly (wrangler showed it as
// "LIVE_LIMITER (120 requests/60s)"), limit() was reached on every request, and it returned
// {success:true} to all 700 requests of a single-window burst. No exception, nothing in the logs,
// and no documented plan requirement found. Whatever the cause, a security control that silently
// allows everything is worse than no control, because the config reads as though the route is
// protected. Removed rather than left as decoration.
//
// WHAT IS THEREFORE STILL UNMITIGATED, and measured against the deployed site on 2026-10-29
// rather than reasoned about: one POST to /live/<fresh 32-hex id>/v1/traces creates a Durable
// Object AND writes a live_sessions row, and nothing bounds how many. An empty body is the
// cheapest version -- zero bytes, a valid (if empty) ExportTraceServiceRequest, answered 200,
// one row with ingest_count=1 and span_count=0. A malformed body costs one row the same way via
// the decode_errors counter.
//
// So this is a data vector, not only a compute one. An earlier version of this comment said the
// opposite, on the grounds that live-relay.js's hasIngested gate had closed the database side.
// That gate closes the VIEWER door, which is the one that carries no payload and therefore the
// one a per-object check can actually hold. Ingest always carries a payload and a valid payload
// is free to build, so no unauthenticated per-object gate closes it -- it only changes which
// bytes the sender has to send.
//
// Closing it needs a check at the door, before idFromName(): either a working global limiter
// (the binding that was supposed to be one is the paragraph above) or Tier 3's ingest token in
// local/live-relay-hardening.md, which is the real fix and is a design change, not a patch.

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
      // Everything from here to idFromName() exists because idFromName() is the expensive step
      // and it cannot be undone: every distinct string is a new Durable Object, and Cloudflare
      // documents no cap on how many ("you can create and run as many separate Durable Objects
      // as you want"). Anything that can reject a request has to do it before this line.
      if (!SESSION_ID_RE.test(m[1])) {
        return new Response('not found', { status: 404 });
      }
      const id = env.LIVE_RELAY.idFromName(m[1]);
      return env.LIVE_RELAY.get(id).fetch(request);
    }

    return crawlerLog.fetch(request, env, ctx);
  },
};
