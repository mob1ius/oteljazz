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
 * No auth on ingest. Anyone who knows a session id can POST spans into it. Acceptable for v1
 * because a session id is a shared secret by construction (you have to know it to point your own
 * exporter at it) and the worst case is someone else's made-up spans appearing in your own
 * browser tab, not any data disclosure. Revisit if this ever needs to be safe against a
 * genuinely adversarial party knowing the id.
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

function spanToLine(span) {
  const attrs = span.attributes || {};
  const service = attrs['gen_ai.agent.name'] || attrs['gen_ai.agent.id'] || 'unknown';
  const op = attrs['gen_ai.operation.name'] || span.name || 'span';
  const tool = attrs['gen_ai.tool.name'];
  const tokens = attrs['gen_ai.usage.output_tokens'];
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
  return { t: tS, durS, service, line, status: span.status, op, tool: tool || null, tokens: tokens ?? null };
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
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.add(server);
      this._log('ws_connect', { openSockets: this.sockets.size });
      this._touchSession({ wsConnects: 1 });
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
          return new Response('expected application/x-protobuf', { status: 415 });
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
          return new Response('payload too large', { status: 413 });
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
          return new Response('rate limited', { status: 429 });
        }

        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > MAX_BODY_BYTES) {
          this._log('ingest_rejected', { reason: 'payload too large (actual)', actualLen: bytes.length });
          return new Response('payload too large', { status: 413 });
        }
        const spans = decodeExportTraceServiceRequest(bytes);
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
        await this._touchSession({ spans: spans.length, ingests: 1 });
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
        return new Response(`decode error: ${err.message}`, { status: 400 });
      }
    }

    this._log('not_found', { path: url.pathname, method: request.method });
    return new Response('not found', { status: 404 });
  }
}
