/**
 * LiveRelay: a Durable Object that accepts real OTLP/HTTP spans and broadcasts them to connected
 * browser tabs over WebSocket. v1 of the live path (see docs/ROADMAP.md's "A" section, and
 * engine/live.py's own docstring for the precedent of scoping a live path's v0.1 explicitly).
 *
 * WHAT THIS DOES: real spans arrive, get decoded, and broadcast in a shape carrying both a
 * ready-to-render terminal line AND the raw op/tool/tokens/status fields. app.js's live mode
 * consumes both: the terminal line for display, and the raw fields via director.js's
 * Director.feedSpan() to actually drive the chorale voicing, comp density, and anomaly
 * candidates -- the SAME per-span mapping the synthetic demo uses (see feedSpan's own comment
 * for how the shapes are kept identical on purpose).
 * WHAT'S STILL A REAL LIMITATION: only the literal agent name "orchestrator" gets the fixed
 * 1:1 "planner" voice VoicePool already reserves for it; every other real agent name pools onto
 * the generic worker voices, same as any synthetic subagent id does.
 *
 * One Durable Object instance per session id (see index.js's idFromName), so two people pointing
 * their own instrumented systems at oteljazz.com at the same time never see each other's spans --
 * each session id is its own isolated room. A session id is whatever string the operator picks
 * for their own OTLP endpoint path; there is no discovery or listing of active sessions.
 *
 * No auth on either route. Anyone who knows a session id can POST spans into it, AND can open the
 * WebSocket and read the real ones. An earlier version of this comment said the worst case was
 * "someone else's made-up spans appearing in your own browser tab, not any data disclosure",
 * which was only ever true of the write direction. Spans carry gen_ai.agent.name,
 * gen_ai.tool.name, gen_ai.operation.name and token counts from somebody's actual agent system,
 * so a session id that leaks is a read of that system's shape, not just a nuisance.
 *
 * A session id is therefore a password, and src/index.js enforces a shape that a password could
 * plausibly have (16-64 chars) before any request reaches this class. That is a floor, not a
 * guarantee: an id someone chose by hand is still an id someone can guess.
 * local/live-relay-hardening.md proposes the two things that would actually fix this -- issuing
 * random ids rather than accepting chosen ones, and splitting the read id from the write token so
 * that publishing one grants nothing about the other.
 *
 * OBSERVABILITY: this was the newest, least battle-tested code in the repo and, until this pass,
 * genuinely a black box -- decode failures and connection activity were caught and swallowed with
 * no visibility anywhere. Two layers now, matching the two-layer approach the crawler log
 * (src/crawler-log.js) already established rather than inventing a third paradigm:
 *   1. Structured console.log/error on every event (connect, disconnect, ingest, decode failure).
 *      Cloudflare's observability is already enabled for this Worker (wrangler.jsonc), so these
 *      are visible in the dashboard/`wrangler tail` with no further setup.
 *   2. A durable, queryable summary row per session in D1 (`live_sessions`, see
 *      infra/d1_schema.sql), the same way crawler activity is queryable after the fact rather
 *      than only visible while watching logs live.
 */

import { decodeExportTraceServiceRequest } from './otlp-decode.js';

// gen_ai.* attribute names this reads, matching the semantic conventions engine/caidence.py and
// engine/live_producer.py already use -- see live_producer.py's emit_one for the producer side
// of this exact same attribute set.
// Every gen_ai.* attribute below is attacker-controlled: this relay has no auth (see class
// header), so anyone who knows a session id can put arbitrary strings in these fields via their
// own OTLP exporter. app.js's pushTerm() renders the result with innerHTML, not textContent (the
// terminal needs the <span class="dim/ok/err"> markup), so an unescaped attribute value is a
// straightforward stored HTML-injection bug -- found in a security pass, not exploited live. This
// site's CSP (script-src 'self') blocks inline <script>/event-handler execution, but style-src
// allows 'unsafe-inline' and plain HTML injection (fake links, visual spoofing) isn't a CSP
// concern at all, so escaping here is load-bearing, not just defense in depth on top of the CSP.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// A rejection that answers without touching the body makes the runtime log "Can't read from
// request stream after response has been sent" for every rejected request (once per 429 while
// testing an exporter against a local relay). Cancelling the body instead is worse: it tears the
// connection down mid-upload, which showed up as "Network connection lost" and a 500 for 8% of a
// 200-request flood. So the body is read and dropped. What makes a rejection cheap is skipping
// the protobuf decode and the D1 write, both of which still happen only for accepted requests.
// Draining is only safe when the sender has declared a small body: a client that declares 3MB
// and then sends 60KB leaves the drain waiting forever (measured -- it hung the request), and
// cancelling instead tears the connection down mid-upload (measured: "Network connection lost"
// and a 500 for 8% of a 200-request flood). So a small declared body is read and dropped, which
// is what removes the log line in the case that actually repeats -- an exporter being rate
// limited -- and anything else is answered without touching the body, leaving the runtime to log
// once that the stream was never read. Rejections stay cheap either way: neither the protobuf
// decode nor the D1 write happens for them.
const DRAINABLE_BYTES = 64 * 1024;

async function reject(request, body, init) {
  const declared = Number(request.headers.get('content-length') || 0);
  const reader = declared > 0 && declared <= DRAINABLE_BYTES && request.body && request.body.getReader
    ? request.body.getReader() : null;
  if (reader) {
    try { while (!(await reader.read()).done) { /* discard */ } } catch { /* client hung up */ }
  }
  return new Response(body, init);
}

// Every attribute below is attacker-controlled and none of them had a length bound except `role`,
// which was clamped to 64 from the start. An unbounded gen_ai.operation.name went into the
// terminal line, into the broadcast string, and from there into innerHTML on every connected
// tab -- escaped, so not injection, but nothing stopped one span from carrying a megabyte. 128 is
// well past any real agent, tool or operation name. Clamping here rather than at the call sites
// keeps it in one place, next to the escaping that has the same reason for existing.
const MAX_FIELD_CHARS = 128;
const clamp = (v, n = MAX_FIELD_CHARS) => (v == null ? v : String(v).slice(0, n));

function spanToLine(span) {
  const attrs = span.attributes || {};
  const service = clamp(attrs['gen_ai.agent.name'] || attrs['gen_ai.agent.id'] || 'unknown');
  const op = clamp(attrs['gen_ai.operation.name'] || span.name || 'span');
  const tool = clamp(attrs['gen_ai.tool.name']);
  // Which agent leads (takes the unpooled "planner" voice) is otherwise just "whoever spoke
  // first" -- see web/engine.js's LEAD ASSIGNMENT. There is no GenAI convention for an agent's
  // role, so this reads the two spellings a producer is likeliest to use. Like every other
  // attribute here it is attacker-controlled; it only ever selects a voice, and it reaches the
  // page as data (see the escaping note above), never as markup.
  const role = attrs['gen_ai.agent.role'] || attrs['gen_ai.agent.type'] || null;
  // Coerced to a finite number or dropped, rather than clamped as a string. This one is not only
  // a length question: director.js's feedSpan does Math.round(span.tokens || 50) and passes the
  // result to tokensToVelocity, so a non-numeric value arrives at the audio path as NaN and a
  // note gets scheduled with a NaN velocity. A token count that is not a number is not a token
  // count, so it is treated as absent.
  const rawTokens = Number(attrs['gen_ai.usage.output_tokens']);
  const tokens = Number.isFinite(rawTokens) ? rawTokens : null;
  const tS = span.startTimeUnixNano ? span.startTimeUnixNano / 1e9 : 0;
  const durS = span.endTimeUnixNano && span.startTimeUnixNano
    ? (span.endTimeUnixNano - span.startTimeUnixNano) / 1e9
    : 0;

  // All HTML construction from untrusted data happens exactly here, once -- app.js consumes
  // `line` as already-safe and does no interpolation of its own with raw span fields (it used to,
  // via span.service in its own template literal; that was a second, separate injection point,
  // fixed by building the full line including the [service] prefix here instead). The raw
  // op/tool/tokens/service fields below stay UNescaped: those feed Director.feedSpan()'s audio
  // mapping, a non-HTML consumer, where HTML-escaping a legitimate tool name would just corrupt it.
  let line = `<span class="dim">[${escapeHtml(service)}]</span> <span class="dim">span</span> ${escapeHtml(op)}`;
  if (tool) line += ` <span class="dim">tool=</span>${escapeHtml(tool)}`;
  if (tokens != null) line += ` <span class="dim">tokens=</span>${escapeHtml(tokens)}`;
  line += span.status === 'error'
    ? ` <span class="err">ERROR</span>`
    : ` <span class="ok">OK</span>`;

  // `line` is pre-built HTML for the terminal (app.js's default consumer, always used).
  // op/tool/tokens are the same values in raw form, for feedSpan()'s audio mapping (app.js,
  // live-mode only) -- added rather than making that path re-derive them from `line`'s HTML.
  return { t: tS, durS, service, line, status: span.status, op, tool: tool || null,
           tokens: tokens ?? null, role: role ? String(role).slice(0, 64) : null };
}

export class LiveRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
    // The session id this instance was addressed by -- learned from the first request's path
    // rather than passed at construction, since idFromName() on the Worker side is what actually
    // determines which instance a request reaches; this instance has no other way to know its
    // own name. Cached after the first request since every request to one instance carries the
    // same session id by construction (see index.js's routing regex).
    this.session = null;
    // Ingest rate-limit window (see fetch). Must start numeric: left undefined, `now - undefined`
    // is NaN, the "window elapsed" test is never true, and the counter never resets -- which
    // capped every instance at 50 ingest requests for its whole lifetime, not 50 per second.
    this.rateWindowStartMs = 0;
    this.rateWindowCount = 0;
    // Same window, same reasoning, for the WebSocket upgrade -- which had neither a rate limit
    // nor a body to pay for, making it the cheapest way in the codebase to turn one GET into one
    // D1 row (see _touchSession's caller below).
    this.wsWindowStartMs = 0;
    this.wsWindowCount = 0;
    // Whether this instance has ever accepted a span. It gates the D1 write for viewer
    // connections: a session nobody has ever exported to is not worth a row, and writing one on
    // an unauthenticated GET is exactly the unbounded-insert path this is here to close. Held in
    // memory rather than read back from D1 on purpose -- a read per connect to avoid a write per
    // connect would make the attacker's path more expensive for us, not for them. It resets when
    // the object is evicted, which is acceptable because eviction resets their progress too.
    this.hasIngested = false;
    // Viewer connections that arrived before the first span. Opening the tab and then starting
    // the exporter is the normal order, so dropping these outright would undercount every real
    // session; they are flushed by the first successful ingest instead.
    this.pendingWsConnects = 0;
  }

  // Every log line carries the session id explicitly rather than relying on log-stream context
  // to correlate them, since Cloudflare's log viewer doesn't group by Durable Object instance for
  // you -- see the class header's OBSERVABILITY note.
  _log(event, detail = {}) {
    console.log(JSON.stringify({ source: 'live-relay', session: this.session, event, ...detail }));
  }
  _logError(event, err, detail = {}) {
    console.error(JSON.stringify({ source: 'live-relay', session: this.session, event, error: String(err), ...detail }));
  }

  // Upserts one row in live_sessions (see infra/d1_schema.sql). Best-effort: a failed write here
  // must never break ingest or the WebSocket connection, matching src/crawler-log.js's own rule
  // that a logging bug can't take the actual feature down with it -- see that file's header for
  // the precedent this follows.
  async _touchSession(fields) {
    if (!this.env.DB) return;                          // no binding in local dev without --d1
    const now = new Date().toISOString();
    try {
      await this.env.DB.prepare(
        `INSERT INTO live_sessions (session, first_seen, last_seen, span_count, ingest_count, decode_errors, ws_connects)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session) DO UPDATE SET
           last_seen      = excluded.last_seen,
           span_count     = span_count     + excluded.span_count,
           ingest_count   = ingest_count   + excluded.ingest_count,
           decode_errors  = decode_errors  + excluded.decode_errors,
           ws_connects    = ws_connects    + excluded.ws_connects`
      ).bind(
        this.session, now, now,
        fields.spans || 0, fields.ingests || 0, fields.decodeErrors || 0, fields.wsConnects || 0
      ).run();
    } catch (err) {
      this._logError('d1_write_failed', err);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!this.session) {
      const m = url.pathname.match(/^\/live\/([^/]+)\//);
      this.session = m ? m[1] : 'unknown';
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      // Ingest already has a body-size cap and a rate limit; the viewer side had neither, which
      // left the one genuinely unbounded resource on this whole object. Sockets accumulate in a
      // Set and every ingest broadcasts to all of them, so N idle connections cost memory AND
      // multiply the per-span send work -- on a public, unauthenticated endpoint where anyone
      // knowing a session id can open as many as they like. 32 is far above real use (a few
      // browser tabs watching one session) and far below anything that threatens the DO's memory
      // limit. Rejected with 503, not 429: this is "this room is full", not "you are being
      // throttled", and a legitimate viewer should retry rather than back off permanently.
      const MAX_SOCKETS = 32;
      if (this.sockets.size >= MAX_SOCKETS) {
        this._log('ws_rejected', { reason: 'socket_limit', openSockets: this.sockets.size });
        return new Response('too many concurrent viewers for this session', { status: 503 });
      }

      // MAX_SOCKETS caps how many sockets are open at once; it says nothing about how fast they
      // may be opened and closed, and a connect that is immediately dropped still costs an object
      // start and (before the hasIngested gate below) a D1 write. 20 upgrades a second is far
      // above a few tabs reconnecting after a deploy. Per-instance like the ingest limiter, with
      // the same caveat: a new session id is a new instance with a fresh counter, so this bounds
      // one session being hammered and not a sweep across ids. Nothing covers that sweep today --
      // the Workers rate-limit binding that was meant to, ahead of idFromName(), did not work and
      // was removed (see src/index.js). What the sweep can still cost is object starts, not rows:
      // the hasIngested gate below is what closed the database side of it.
      const nowWs = Date.now();
      if (nowWs - this.wsWindowStartMs > 1000) {
        this.wsWindowStartMs = nowWs;
        this.wsWindowCount = 0;
      }
      this.wsWindowCount += 1;
      if (this.wsWindowCount > 20) {
        this._log('ws_rate_limited', { windowCount: this.wsWindowCount });
        return new Response('rate limited', { status: 429 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.add(server);
      this._log('ws_connect', { openSockets: this.sockets.size });
      // Deliberately NOT an unconditional D1 write. See hasIngested in the constructor: until a
      // span has actually arrived for this session, a viewer connection is indistinguishable from
      // someone sweeping ids, and the row it would write is attacker-chosen. The log line above
      // still records the connection either way.
      if (this.hasIngested) {
        this._touchSession({ wsConnects: 1 });
      } else {
        this.pendingWsConnects += 1;
      }
      server.addEventListener('close', () => {
        this.sockets.delete(server);
        this._log('ws_close', { openSockets: this.sockets.size });
      });
      server.addEventListener('error', (e) => {
        this.sockets.delete(server);
        this._logError('ws_error', e.message || e, { openSockets: this.sockets.size });
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/v1/traces')) {
      try {
        const contentType = request.headers.get('content-type') || '';
        if (!contentType.includes('application/x-protobuf') && !contentType.includes('application/octet-stream')) {
          this._log('ingest_rejected', { reason: 'bad content-type', contentType });
          return await reject(request, 'expected application/x-protobuf', { status: 415 });
        }

        // Rejected upfront, before reading the body: a real OTLP export batch from any of this
        // repo's own producers is KB-sized; 2MB is generous headroom for a legitimately large
        // batch while still bounding the worst case. There is no auth on this endpoint (see class
        // header), so this is the only thing standing between an attacker and an unbounded read
        // into memory per request.
        const MAX_BODY_BYTES = 2 * 1024 * 1024;
        const declaredLen = Number(request.headers.get('content-length') || 0);
        if (declaredLen > MAX_BODY_BYTES) {
          this._log('ingest_rejected', { reason: 'payload too large', declaredLen });
          return await reject(request, 'payload too large', { status: 413 });
        }

        // Rate limit, checked before decode/D1 so a flood costs as little CPU as possible per
        // request. Same underlying risk src/crawler-log.js's flood guard was built for --
        // unauthenticated ingest with an unconditional D1 write per request would otherwise let a
        // burst of requests (malicious or just a runaway exporter retry loop) exhaust the D1
        // write budget for every session on this Worker, not just this one. Global per-instance
        // counter, not per-client: this is one session being asked to accept spans faster than a
        // real telemetry stream plausibly would, regardless of how many distinct senders that is.
        const nowMs = Date.now();
        if (nowMs - this.rateWindowStartMs > 1000) {
          this.rateWindowStartMs = nowMs;
          this.rateWindowCount = 0;
        }
        this.rateWindowCount = (this.rateWindowCount || 0) + 1;
        if (this.rateWindowCount > 50) {
          this._log('ingest_rate_limited', { windowCount: this.rateWindowCount });
          return await reject(request, 'rate limited', { status: 429 });
        }

        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > MAX_BODY_BYTES) {
          this._log('ingest_rejected', { reason: 'payload too large (actual)', actualLen: bytes.length });
          return new Response('payload too large', { status: 413 });
        }
        const decoded = decodeExportTraceServiceRequest(bytes);
        // The body cap bounds what arrives; it does not bound what one body expands into. A 2MB
        // protobuf of minimal spans decodes to a very large array, every element becomes an
        // object in one JSON.stringify, and that one string is then sent to up to MAX_SOCKETS
        // sockets -- so a single accepted request is amplified 32 times. A real export batch from
        // this repo's own producers is tens of spans; 2,000 is headroom, not a limit anyone
        // legitimate will meet. Extra spans are dropped rather than the batch rejected: a
        // too-large batch from a real exporter should still play, and the count is logged.
        const MAX_SPANS_PER_EXPORT = 2000;
        const spans = decoded.length > MAX_SPANS_PER_EXPORT
          ? decoded.slice(0, MAX_SPANS_PER_EXPORT)
          : decoded;
        if (decoded.length > spans.length) {
          this._log('ingest_truncated', { received: decoded.length, kept: spans.length });
        }
        const lines = spans.map(spanToLine);
        const msg = JSON.stringify({ type: 'spans', spans: lines });
        let delivered = 0;
        for (const ws of this.sockets) {
          try { ws.send(msg); delivered++; } catch (err) {
            this.sockets.delete(ws);
            this._logError('ws_send_failed', err);
          }
        }
        this._log('ingest', { spanCount: spans.length, deliveredTo: delivered, listeningSockets: this.sockets.size });
        // First real span for this instance: the session is now known to be in use, so the viewer
        // connections that were held back above are worth recording after all.
        const flushed = this.pendingWsConnects;
        this.pendingWsConnects = 0;
        this.hasIngested = true;
        await this._touchSession({ spans: spans.length, ingests: 1, wsConnects: flushed });
        // Empty body, 200: a valid ExportTraceServiceResponse indicating full success with no
        // partial-success field set, per the OTLP spec -- a real exporter doesn't need the reply
        // parsed to know it worked, just the status code.
        return new Response(null, { status: 200 });
      } catch (err) {
        // A malformed export must not look like a server crash to the exporter, which would
        // trigger its own retry/backoff logic against a session that will never recover with a
        // retry. 400 tells it to stop trying this specific payload.
        this._logError('decode_failed', err);
        await this._touchSession({ decodeErrors: 1 });
        // The exporter needs the status code, not the reason: 400 already tells it to stop
        // retrying this payload. The decoder's own message describes internals of a parser
        // handed attacker-controlled bytes, and it was being handed straight back to whoever
        // sent them. It stays in the log line above, where it is actually useful.
        return new Response('malformed OTLP payload', { status: 400 });
      }
    }

    this._log('not_found', { path: url.pathname, method: request.method });
    return new Response('not found', { status: 404 });
  }
}
