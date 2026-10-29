/**
 * oteljazz.com Worker entry point: this project's own config for the reusable crawler-logging
 * handler in crawler-log.js, plus routing for the live-OTLP relay (live-relay.js). Kept
 * deliberately thin on the crawler-log side -- this file should only ever contain what is
 * actually specific to oteljazz.com, so a future project can copy crawler-log.js and
 * operator-claims.js wholesale and write a file that looks like this one, not like the old
 * monolithic version. See docs/ROADMAP.md's v1.3.0 section for why this split happened.
 */

import { createCrawlerLogHandler } from './crawler-log.js';
import { tokenAuthorizes } from './live-token.js';

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
// primary key.
//
// It used to be the only thing protecting a session, in both directions, and the comment here
// said so. It is now the READ half of a pair: it grants reading the session's spans (agent names,
// tool names, operations, token counts) and nothing else. Writing needs the ingest token it was
// derived from -- see src/live-token.js, and the route gate below.
//
// Ids are issued, not chosen, and as of v1.13.0 they are no longer even generated directly: a
// session id is HMAC(secret, token) truncated to 32 hex, so it is minted by deriving it from a
// token rather than by rolling 16 random bytes. The shape is identical, which is the point --
// v1.12.2 committed to this exact width so that landing the split would not be a second format
// change on a public endpoint. The rule before that allowed 16-64 characters of [A-Za-z0-9_-],
// which permitted "my-demo-session" as readily as a random one; before that it was "[^/]+".
//
// The 32 is not arbitrary. The repo's other HMAC (client_key, infra/d1_schema.sql) truncates to
// 16, which is right for a daily-rotating grouping key and wrong here: this one is a capability
// that grants read access to somebody's live telemetry for as long as the session lasts.
//
// WHAT THIS REGEX DOES NOT DO: it checks shape, not provenance. Thirty-two zeroes match it, and
// so does any other well-formed string someone invents. That no longer admits a writer, since
// writing needs a token whose derivation lands on the id in the path, but it does still admit a
// READER -- to a session that cannot exist, where they will wait forever for spans that nobody
// can send. That is the viewer-door cost noted below, and it is the reason this check stays even
// though the token gate is strictly stronger.
//
// Lowercase only, deliberately. idFromName("AB...") and idFromName("ab...") are DIFFERENT
// objects, so accepting mixed case without normalising would quietly give two people separate
// rooms for what they both believe is one id. One canonical spelling removes the question, and
// the derivation only ever emits lowercase.
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
// WHAT THIS LEFT OPEN, and what has since been closed. Measured against the deployed site on
// 2026-10-29 rather than reasoned about: one POST to /live/<fresh 32-hex id>/v1/traces created a
// Durable Object AND wrote a live_sessions row, with nothing bounding how many. An empty body was
// the cheapest version -- zero bytes, a valid (if empty) ExportTraceServiceRequest, answered 200,
// one row with ingest_count=1 and span_count=0. A malformed body cost a row the same way through
// the decode_errors counter.
//
// No per-object gate could close that. live-relay.js's hasIngested gate closes the VIEWER door,
// which works because a viewer connection carries no payload; ingest always carries one and a
// valid one is free to build, so a gate inside the object only changes which bytes get sent. It
// needed a check at the door, which is the ingest token above.
//
// STILL OPEN, deliberately: the viewer route. GET /live/<any well-formed id>/ws creates a Durable
// Object for that id, and nothing bounds how many distinct ids someone tries. That costs object
// starts and nothing else -- no row is written, because hasIngested gates it, and no span is
// readable, because none ever arrives. It is a compute-cost vector with no data component, which
// is the honest version of what the paragraph above used to claim about ingest. Closing it would
// need either a working limiter ahead of idFromName (the binding below was supposed to be one) or
// a token on the read side too, which would defeat the point of a publishable session id.

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
      const [, session, route] = m;
      // Everything from here to idFromName() exists because idFromName() is the expensive step
      // and it cannot be undone: every distinct string is a new Durable Object, and Cloudflare
      // documents no cap on how many ("you can create and run as many separate Durable Objects
      // as you want"). Anything that can reject a request has to do it before this line.
      if (!SESSION_ID_RE.test(session)) {
        return new Response('not found', { status: 404 });
      }

      // THE WRITE DOOR. Ingest needs the session's ingest token; reading needs only the id. See
      // src/live-token.js for why re-deriving the id from the presented token and requiring it to
      // match the path is the entire proof, and why that means the token needs no signature.
      //
      // Gated on the ROUTE, not on the method. A GET or an OPTIONS to v1/traces without a token
      // must be refused here too -- letting one through to be rejected by the Durable Object
      // would still have created the object, which is the cost this is here to avoid.
      if (route === 'v1/traces') {
        // Fail closed. With no secret configured nothing can be verified, so nothing is
        // accepted. deriveSessionId throws rather than returning a falsy answer precisely so
        // that this cannot degrade into an open door by accident; the alternative -- treating a
        // missing secret as "no auth required", which is what crawler-log.js does for its own
        // optional secret -- would turn a deployment mistake into anyone-can-write.
        const auth = request.headers.get('authorization') || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        let authorized = false;
        try {
          authorized = token ? await tokenAuthorizes(env.LIVE_RELAY_SECRET, token, session) : false;
        } catch (err) {
          console.log(JSON.stringify({
            source: 'live-ingest', event: 'secret_missing', session, message: err.message,
          }));
          authorized = false;
        }
        if (!authorized) {
          // 401, not the 404 a malformed id gets, and it leaks nothing: tokenAuthorizes performs
          // no lookup, so this answer is identical for a live session, a long-dead one and one
          // that never existed. What it does buy is the operator who simply forgot the header
          // getting told so instead of debugging a silent 404.
          //
          // The token is deliberately absent from this log line and from every other one. A
          // credential that reaches the logs is a credential that outlives its session, which is
          // also why it travels in a header and there is no ?token= fallback: query strings are
          // the part of a URL that gets logged, cached and referred onward.
          console.log(JSON.stringify({
            source: 'live-ingest', event: 'ingest_unauthorized', session,
            reason: token ? 'token does not match session' : 'no bearer token',
          }));
          //
          // This answers WITHOUT reading the body, and deliberately does not borrow
          // live-relay.js's reject() drain helper. That helper exists because answering an unread
          // body made the runtime log "Can't read from request stream after response has been
          // sent" once per rejection, which is a real cost on a path a misconfigured exporter
          // retries forever -- and a rejection here is exactly that path. But the warning comes
          // from the Worker-to-Durable-Object sub-request, which only exists once .fetch(request)
          // has handed the stream on. This rejection happens before idFromName, so there is no
          // sub-request and nothing to drain. Measured: 37 unauthenticated exports from the real
          // SDK, 28 batched ones with a wrong token, and one unread 1MB body all produced 0 of
          // those log lines. Adding a drain here would read an attacker's body for no reason.
          return new Response('unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="oteljazz-live"' },
          });
        }
      }

      const id = env.LIVE_RELAY.idFromName(session);
      return env.LIVE_RELAY.get(id).fetch(request);
    }

    return crawlerLog.fetch(request, env, ctx);
  },
};
