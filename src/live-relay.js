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
 */

import { decodeExportTraceServiceRequest } from './otlp-decode.js';

// gen_ai.* attribute names this reads, matching the semantic conventions engine/caidence.py and
// engine/live_producer.py already use -- see live_producer.py's emit_one for the producer side
// of this exact same attribute set.
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

  let line = `<span class="dim">span</span> ${op}`;
  if (tool) line += ` <span class="dim">tool=</span>${tool}`;
  if (tokens != null) line += ` <span class="dim">tokens=</span>${tokens}`;
  line += span.status === 'error'
    ? ` <span class="err">ERROR</span>`
    : ` <span class="ok">OK</span>`;

  // `line` is pre-built HTML for the terminal (app.js's default consumer, always used).
  // op/tool/tokens are the same values in raw form, for feedSpan()'s audio mapping (app.js,
  // live-mode only) -- added rather than making that path re-derive them from `line`'s HTML.
  return { t: tS, durS, service, line, status: span.status, op, tool: tool || null, tokens: tokens ?? null };
}

export class LiveRelay {
  constructor(state) {
    this.state = state;
    this.sockets = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.add(server);
      server.addEventListener('close', () => this.sockets.delete(server));
      server.addEventListener('error', () => this.sockets.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/v1/traces')) {
      try {
        const contentType = request.headers.get('content-type') || '';
        if (!contentType.includes('application/x-protobuf') && !contentType.includes('application/octet-stream')) {
          return new Response('expected application/x-protobuf', { status: 415 });
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        const spans = decodeExportTraceServiceRequest(bytes);
        const lines = spans.map(spanToLine);
        const msg = JSON.stringify({ type: 'spans', spans: lines });
        for (const ws of this.sockets) {
          try { ws.send(msg); } catch { this.sockets.delete(ws); }
        }
        // Empty body, 200: a valid ExportTraceServiceResponse indicating full success with no
        // partial-success field set, per the OTLP spec -- a real exporter doesn't need the reply
        // parsed to know it worked, just the status code.
        return new Response(null, { status: 200 });
      } catch (err) {
        // A malformed export must not look like a server crash to the exporter, which would
        // trigger its own retry/backoff logic against a session that will never recover with a
        // retry. 400 tells it to stop trying this specific payload.
        return new Response(`decode error: ${err.message}`, { status: 400 });
      }
    }

    return new Response('not found', { status: 404 });
  }
}
