/**
 * Minimal OTLP/HTTP protobuf decoder for ExportTraceServiceRequest.
 *
 * Hand-rolled rather than a dependency (protobufjs etc.): pulling in a general-purpose protobuf
 * library for a handful of known, stable field numbers from one fixed schema (opentelemetry-proto
 * v1, unchanged for years) is a lot of bundle weight for what amounts to a generic varint/
 * length-delimited walk. Matches this project's existing bias against third-party origins and
 * unnecessary dependencies (see demo.html's CSP comment on why Tone.js is vendored, not CDN-
 * loaded). Verified against real output: engine/live_producer.py's actual OTLPSpanExporter bytes,
 * not a hand-constructed fixture.
 *
 * Only decodes the fields this project's mapping actually reads (span name/timing/status/
 * attributes). Anything else in a real span is silently walked past, not preserved -- this is a
 * consumer, not a general OTLP tool.
 */

// --- generic protobuf wire format -------------------------------------------------------------
// Every field is (fieldNumber << 3 | wireType) as a varint tag, then a payload shaped by
// wireType: 0=varint, 1=fixed64, 2=length-delimited (bytes/string/submessage), 5=fixed32.

function readVarint(buf, pos) {
  let result = 0n, shift = 0n;
  // A real varint is at most 10 bytes (64 bits, 7 bits/byte). Without this cap, a garbage byte
  // stream where every byte happens to have its continuation bit set reads past the buffer
  // forever -- buf[pos] on an out-of-bounds index is `undefined` in JS, not a thrown error, and
  // `undefined & 0x80` coerces to 0, which would eventually break the loop on its own, but only
  // after walking arbitrarily far past the buffer first. Capped rather than relying on that.
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error("varint runs past end of buffer");
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  throw new Error("varint longer than 10 bytes");
}

// Walks one message into { fieldNumber: [ {wireType, start, end} ... ] }, non-recursively --
// submessages are sliced out as raw byte ranges and decoded again on demand by the caller, so
// this same function handles every nesting level (ExportTraceServiceRequest, ResourceSpans,
// ScopeSpans, Span, KeyValue, AnyValue) without needing a schema.
function decodeMessage(buf, start, end) {
  const fields = {};
  let pos = start;
  while (pos < end) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    let fieldStart, fieldEnd;
    if (wireType === 0) {
      let v; [v, pos] = readVarint(buf, pos);
      fieldStart = v; fieldEnd = null;               // varint value stored directly as bigint
    } else if (wireType === 1) {
      fieldStart = pos; fieldEnd = pos + 8; pos = fieldEnd;
    } else if (wireType === 2) {
      let len; [len, pos] = readVarint(buf, pos);
      fieldStart = pos; fieldEnd = pos + Number(len); pos = fieldEnd;
    } else if (wireType === 5) {
      fieldStart = pos; fieldEnd = pos + 4; pos = fieldEnd;
    } else {
      // Wire types 3/4 (deprecated START_GROUP/END_GROUP) never appear anywhere in a real OTLP
      // trace export -- this isn't a general-purpose protobuf library tolerating an unknown-but-
      // legitimate field from some future proto revision, it's a consumer of one specific, stable
      // schema. Throwing here (rather than the silent `break` this used to be) is what actually
      // catches garbage input: found live, a POST of a plain string returned 200 with 0 spans
      // instead of 400, because its first tag byte happened to decode to an invalid wire type and
      // the old silent-stop behavior read that as "a valid but empty message" instead of what it
      // was, garbage from the very first byte.
      throw new Error(`unsupported wire type ${wireType} for field ${fieldNumber}`);
    }
    // A length-delimited field (wire type 2, the one that matters in practice) can declare any
    // length at all, including one running past the actual buffer -- the only field a
    // non-protobuf payload can claim an arbitrarily large size for. JS silently returns
    // `undefined` on an out-of-bounds typed-array read rather than throwing, so without this
    // check malformed input parsed "successfully" into nonsense instead of failing loudly.
    // Found live: a POST of random bytes to /v1/traces returned 200 with 0 spans instead of the
    // intended 400, defeating the whole point of tracking decode_errors in live_sessions
    // (infra/d1_schema.sql) -- this is that fix.
    if (fieldEnd !== null && fieldEnd > buf.length) {
      throw new Error(`field ${fieldNumber} (wire type ${wireType}) declares length past end of buffer`);
    }
    (fields[fieldNumber] ??= []).push({ wireType, start: fieldStart, end: fieldEnd });
  }
  return fields;
}

function asString(buf, f) {
  return new TextDecoder().decode(buf.subarray(f.start, f.end));
}
function asVarintNumber(f) {
  return Number(f.start);                             // wireType 0 stores the bigint in .start, see decodeMessage
}
function asFixed64Number(buf, f) {
  return Number(new DataView(buf.buffer, buf.byteOffset + f.start, 8).getBigUint64(0, true));
}

// --- OTLP-specific extraction -----------------------------------------------------------------

// AnyValue: field 1=string, 2=bool, 3=int, 4=double, 7=bytes. array/kvlist (5/6) not needed here.
function decodeAnyValue(buf, start, end) {
  const f = decodeMessage(buf, start, end);
  if (f[1]) return asString(buf, f[1][0]);
  if (f[2]) return asVarintNumber(f[2][0]) !== 0;
  if (f[3]) return asVarintNumber(f[3][0]);
  if (f[4]) return asFixed64Number(buf, f[4][0]);
  return null;
}

function decodeAttributes(buf, kvFields) {
  const out = {};
  for (const kv of kvFields || []) {
    const f = decodeMessage(buf, kv.start, kv.end);
    if (!f[1] || !f[2]) continue;
    const key = asString(buf, f[1][0]);
    out[key] = decodeAnyValue(buf, f[2][0].start, f[2][0].end);
  }
  return out;
}

// Status.code: field 3, varint. 0=UNSET, 1=OK, 2=ERROR (matches Status/StatusCode in the OTel
// SDK's own trace.Status, e.g. StatusCode.ERROR used by engine/live_producer.py).
function decodeStatus(buf, f) {
  if (!f) return "unset";
  const m = decodeMessage(buf, f.start, f.end);
  const code = m[3] ? asVarintNumber(m[3][0]) : 0;
  return code === 2 ? "error" : code === 1 ? "ok" : "unset";
}

function decodeSpan(buf, start, end) {
  const f = decodeMessage(buf, start, end);
  const attributes = decodeAttributes(buf, f[9]);
  return {
    name: f[5] ? asString(buf, f[5][0]) : "",
    startTimeUnixNano: f[7] ? asFixed64Number(buf, f[7][0]) : 0,
    endTimeUnixNano: f[8] ? asFixed64Number(buf, f[8][0]) : 0,
    status: decodeStatus(buf, f[15] && f[15][0]),
    attributes,
  };
}

/**
 * @param {Uint8Array} bytes - raw body of an OTLP/HTTP POST to /v1/traces, content-type
 *   application/x-protobuf.
 * @returns {Array<object>} flattened spans, one entry per span across every resource/scope in
 *   the request, each `{name, startTimeUnixNano, endTimeUnixNano, status, attributes}`.
 */
export function decodeExportTraceServiceRequest(bytes) {
  const top = decodeMessage(bytes, 0, bytes.length);
  const spans = [];
  for (const rs of top[1] || []) {                                   // resource_spans
    const rsFields = decodeMessage(bytes, rs.start, rs.end);
    for (const ss of rsFields[2] || []) {                             // scope_spans
      const ssFields = decodeMessage(bytes, ss.start, ss.end);
      for (const sp of ssFields[2] || []) {                           // spans
        spans.push(decodeSpan(bytes, sp.start, sp.end));
      }
    }
  }
  return spans;
}
