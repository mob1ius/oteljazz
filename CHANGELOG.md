# Changelog

## v1.3.3 — 2026-09-02

The project-wide diagnostic gap: `src/crawler-log.js`, which runs on every page view, had two
completely empty `catch {}` blocks around its D1 insert and its own top-level request handling.
Correct that a logging failure must never surface as a broken page (Rule 1, that file's own
header) -- wrong that it also meant nobody would ever know if it broke. A quietly exhausted D1
write budget or a transient outage could stop the crawler dataset from accumulating for hours
with nothing to notice it, on the single highest-traffic code path in the whole repo.

### Fixed

- Both swallowed catches now `console.error` a structured JSON line (source, event, error
  detail) instead of nothing, matching the pattern `src/live-relay.js` already got in v1.3.1 --
  a pattern that had already caught a real bug there once. The one remaining silent catch
  (`refererPathOnly`'s unparseable-Referer case) stays silent on purpose: it's routine and benign,
  logging it would be noise instead of signal, not a corresponding gap.
- Verified deployed: real page load still 200s, dry-run bundle resolved clean, no behavior change
  toward visitors -- the fix is purely that a failure is now visible via `wrangler tail`/dashboard
  instead of nowhere at all.

## v1.3.2 — 2026-09-02

Security hardening pass on the live-OTLP relay, the newest and least-reviewed attack surface in
the repo: a public, unauthenticated ingest endpoint whose output gets rendered with `innerHTML`.
One real, exploitable finding; two proactive hardenings. All three verified against the deployed
site with adversarial input, not just read for plausibility.

### Fixed

- **Stored HTML injection.** `spanToLine` (`src/live-relay.js`) embedded `gen_ai.operation.name`
  and `gen_ai.tool.name` directly into an HTML template with no escaping; `web/app.js` did the
  same with `gen_ai.agent.name` in its own wrapping template. Both are attacker-controlled --
  this relay has no auth, so anyone who knows a session id can set these via their own OTLP
  exporter -- and both landed in `pushTerm`'s `innerHTML` sink. The site's CSP (`script-src
  'self'`) blocks inline `<script>`/event-handler execution, but `style-src` allows
  `'unsafe-inline'` and plain HTML injection (fake links, visual spoofing) isn't a CSP concern at
  all, so this was a real bug, not one the CSP already covered. Fixed by escaping once,
  server-side, in `spanToLine`, and having the client consume the resulting `line` as already-safe
  with no further interpolation of raw fields -- app.js's own template literal (the second
  injection point) was removed rather than patched, so there is exactly one place HTML gets built
  from untrusted data instead of two to keep in sync. Verified with a real OTel SDK span carrying
  `<script>`/`<img onerror>`/`javascript:` payloads in its attributes: the broadcast `line` field
  came back fully entity-escaped, and the raw `op`/`tool` fields (which feed `feedSpan`'s
  non-HTML audio mapping) stayed correctly untouched.

### Added

- A hard 2MB request body cap on `/v1/traces`, checked against `Content-Length` before the body
  is even read and against the actual decoded length as a backstop.
- A 50-requests/second rate limit per session on ingest, checked before decode or any D1 write --
  the same amplification risk `src/crawler-log.js`'s flood guard already exists to prevent
  (unauthenticated ingest with an unconditional write per request can exhaust the shared D1 write
  budget for every session on this Worker, not just the one being flooded). Verified against the
  deployed site with 60 concurrent requests: exactly 50 passed through to decode, exactly 10 were
  rejected with 429, matching the threshold precisely under real concurrent load.

## v1.3.1 — 2026-09-02

Runtime observability for the live-OTLP relay, which shipped in v1.3.0 as a genuine black box --
decode failures and connection activity were caught and swallowed with no visibility anywhere.
Plus a setup guide for the feature itself, which also didn't exist yet.

### Added

- `live_sessions` table (`infra/d1_schema.sql`) -- one row per session id, upserted on every
  event, tracking span/ingest/decode-error/connect counts and first/last-seen. Durable and
  queryable after the fact, matching how crawler activity is already queryable, rather than only
  visible while watching logs live.
- Structured `console.log`/`console.error` on every event in `src/live-relay.js` (connect,
  disconnect, ingest, decode failure), each carrying the session id explicitly since Cloudflare's
  log viewer doesn't group by Durable Object instance on its own. Visible immediately in
  `wrangler tail` or the dashboard -- observability was already enabled (`wrangler.jsonc`), this
  just gives it something worth showing.
- `docs/README.md`'s new "Live browser mode" section: how to point a real OTLP/HTTP exporter at
  the relay and what actually maps to what, using `engine/live_producer.py` (already in the repo,
  already verified against this exact path) as the reference example.

### Fixed

- `src/otlp-decode.js` never bounds-checked a length-delimited field's declared length against
  the actual buffer, and treated an unsupported wire type as "stop and return what's parsed so
  far" rather than an error. Found by the observability work above, immediately: a POST of a
  plain string to `/v1/traces` returned 200 with 0 spans instead of 400, because its first tag
  byte happened to decode to an invalid wire type and the old behavior read that as a validly
  empty message instead of what it was, garbage from the first byte. Both gaps meant
  `decode_errors` could never actually increment no matter how malformed the input. Fixed with an
  explicit bounds check and a hard error on an unsupported wire type -- this decoder consumes one
  specific, stable proto schema, not an arbitrary one, so there's no legitimate case where an
  unrecognized wire type should be silently tolerated. Verified: garbage now returns 400 and
  increments `decode_errors`; real OTel SDK payloads still decode and drive audio exactly as
  before (regression-checked against the deployed site, not just locally).

## v1.3.0 — 2026-09-02

Live OTLP, including real audio: the browser demo can now be driven by a real, running system's
telemetry instead of only the synthetic swarm, and the crawler-logging Worker is now a reusable
module rather than a site-specific file. Two independent efforts, both scoped in
`docs/ROADMAP.md`.

### Added

- `src/otlp-decode.js` — a hand-rolled OTLP/HTTP protobuf decoder for `ExportTraceServiceRequest`,
  no dependency. Verified against real bytes from `engine/live_producer.py`'s actual
  `OTLPSpanExporter`, not a hand-built fixture, including a genuine `ERROR` status span.
- `src/live-relay.js` — a Durable Object (`LIVE_RELAY` binding), one instance per session id,
  accepting OTLP/HTTP POSTs at `/live/<session>/v1/traces` and broadcasting decoded spans to any
  browser WebSocket at `/live/<session>/ws`.
- `web/director.js`'s `LiveSwarmAdapter` and `Director.feedSpan(span, nowS)` — real spans now
  drive the same chorale voicing, comp density, and anomaly-signature logic the synthetic swarm
  does. `_generateBar`'s mapping is unchanged and unaware which source populated it; `feedSpan`
  only changes what feeds `swarm.spans`, converting a real span into the exact shape
  `SwarmEngine._add` already produces. One per-span mapping, two populators.
- `web/app.js`'s `startLiveMode()`, behind `?live=<session>`, entirely separate from the synthetic
  boot chain. Reuses `startEngine()`/`wireDirectorCallbacks()` unchanged; only `currentLookaheadS`
  differs (1.5s live vs. 24s synthetic, since there is nothing to pre-generate for a span that
  hasn't happened yet).
- `src/operator-claims.js` and `src/crawler-log.js` — the crawler-logging Worker extracted from
  `src/index.js` into a reusable module (`createCrawlerLogHandler({ assetPattern, sampleRate,
  tableName })`), so a future project's site drops it in rather than hand-porting it. `index.js`
  is now an 11-line config wrapper. Dedupe-cache namespace derived from the request's own hostname
  instead of hardcoded, so two deploys never collide.

### Fixed

- A real clock bug in live audio, found via `window.__oteljazzDebug()` mid-build and fixed before
  shipping, not left in: an early version stamped incoming spans against `performance.now()` since
  Director construction, a different clock origin than `Tone.Transport.seconds`, which
  `_generateBar`'s bar windows actually use and which only starts counting at play. Spans arrived
  timestamped later than any bar the fill loop had reached and were silently never consumed.
- `infra/d1_schema.sql`'s header genericized for a per-project database name (part of the
  crawler-log extraction above), and a stale `functions/_middleware.js` comment reference fixed,
  left over from before this project moved off Cloudflare Pages Functions.

## v1.2.1 — 2026-09-02

Crawler classification fix, found live in the launch data.

### Fixed

- `src/index.js` — `OPERATOR_CLAIMS` recognized `ClaudeBot` but not `Claude-SearchBot`, a
  separate token in Anthropic's own documented UA taxonomy (training crawl, search-index fetch,
  and user-triggered fetch are three distinct UAs, not one). The hyphen broke the pattern match,
  so a self-identifying crawler with a contact email in its own UA string was logged as a bot but
  left `claimed_operator=NULL`, indistinguishable from generic unlabeled noise. Added
  `claude-searchbot` and `claude-user` as their own entries.
- Backfilled 155 historical rows in the `requests` table matching the corrected pattern. Once
  reclassified, `claude-searchbot` turned out to be Anthropic's **highest-volume** crawler on the
  site (155 rows vs. 70 for `claudebot`), a fact the previous classifier made invisible rather
  than wrong. Worth carrying forward as a general lesson: a crawler taxonomy has to track a
  vendor's actual UA family, not one representative pattern per vendor, or real volume silently
  disappears into the unlabeled bucket.

## v1.2.0 — 2026-08-28

Browser demo hardening and the crawler-tracking research infrastructure, both shipped and
deployed for the public launch.

### Fixed

- Terminal freeze on the live demo, two separate causes. An unrenderable span line could wedge
  the reveal cursor permanently, since it only advanced after a successful render; now guarded so
  a render failure can't stall the queue. Background/occluded browser tabs throttle `setInterval`,
  which the fill and UI-render loops depended on; both moved to `Tone.Transport.scheduleRepeat`,
  which uses a Worker-based clock exempt from that throttling.
- Knob pointer indicator drifting off the physical knob when turned.
- Knobs were hidden entirely below 820px viewport width on the reasoning that they're too small
  to hit on a phone. True for volume, which has a hardware substitute; not true for tuning, which
  has none and drives all of the knob work below. Restored on mobile with a 44px touch target
  (up from ~26px) instead of being removed.

### Added

- A tube-radio boot warm-up (scrolling note ticker, tube-glow CSS) that plays once, for a fixed
  2100ms, triggered by the visitor's own first press of the power button rather than during
  background asset loading, where it either flashed by too fast to read or ran in a state
  requiring no visitor interaction with the terminal.
- Current-draw dimming and terminal jitter tied to the volume/tuning knobs at their extremes;
  asymmetric squelch character and an audible sweep on the tuning dial depending on which side of
  center and how far.
- A minimalist GitHub icon linking the repo, next to the on-page caption.
- Automatic stall-bracketing diagnostics (`window.__oteljazzDebug`, auto-logged START/RECOVERED
  console warnings with full queue-state snapshots) for catching a real freeze with zero reaction
  time, tuned to a 5000ms threshold after an earlier 1500ms threshold proved too sensitive to the
  synthetic swarm's own natural pacing.
- Crawler-tracking research infrastructure: a D1-backed request log (`infra/d1_schema.sql`)
  recording timestamp, path, method, UA, referer (path only), country, ASN, a bot heuristic, the
  UA's claimed operator identity, sample rate, and response status, with no IP address ever
  stored. Bots logged in full; browser traffic sampled (10%) with the rate stored per row so
  volumes reconstruct later. Deliberately separates what a UA *claims* to be from the ASN it
  actually arrived from, since the first is spoofable in one `curl` and the second is not.

### Changed

- Favicon replaced with a legible high-contrast VU-bar glyph; filename versioned
  (`favicon-v2.png`) since browsers cache favicons independently of normal HTTP caching and often
  ignore a same-URL change.
- Tab title and meta description corrected to match the on-page caption and to use "spans"
  instead of "trace" throughout, the technically accurate term for a per-span streaming mapping.
- README compressed, restructured image-first, and corrected to the same terminology.

## v1.1.0 — 2026-08-26

Corrects a result. The v1.0.0 archive should not be used to reproduce the accompanying
paper's Section 4.

### Retracted

**Tempo and ensemble thickness are not independent channels.** v1.0.0 and the earlier
draft of the paper claimed they were, on the strength of four hand-picked seeds. A
1000-seed sweep shows the change in tempo and the change in thickness correlate at
**r = +0.735 [0.705, 0.762], r² = 0.54** — the two share about half their variance. In
hindsight this should have been expected: a busier swarm raises span arrival rate and
live-agent count together, and calling them independently driven confused separate
attributes with separate processes.

What survives is weaker and still sufficient: the channels are **correlated but not
redundant**. Among the 771 runs whose tempo ends at the clamp floor, thickness still
ranges over 3–7 voices, with variance 1.29 against 1.67 across all 1000 runs — knowing
tempo has bottomed out narrows thickness very little. A channel with no residual
information would be decoration; this one has some.

### Added

- `engine/seed_sweep.py` — the sweep behind the correction. Deterministic (seeds
  `0..n-1`, one run each), goes through `caidence.py --export-events` rather than
  reimplementing the mapping, and reports Pearson r with a Fisher-z interval, Wilson
  intervals on every proportion, and the conditional-variance figures. Reruns are
  byte-identical.

  ```
  python3 engine/seed_sweep.py --n 1000 --out seed_sweep_1000.json
  ```

  Note the guard it prints: the conditional variance retained under a bottomed-out
  tempo (77%) is **not** 1 − r² (46%). They are different quantities and an earlier
  draft conflated them.

### Fixed

- `engine/make_figures.py` — panel C of the channels figure was titled "ensemble
  thickness does NOT return: the channels are independent". It now reads "thickness does
  not follow tempo down (r = 0.74 over 1000 seeds)". Regenerating the figure from
  v1.0.0 reproduces the retracted claim; regenerating from v1.1.0 does not.

### Unchanged

`caidence.py`, `drift_detect.py` and `swarm.py` differ from v1.0.0 in comments only, and
`corpus_model_jazz.json` is byte-identical. The engine that produced the sweep is the
engine that was archived — only the analysis script and one figure title are new.

## v1.0.0 — 2026-08-20

Initial release. Retire cAIdence as the project name; OtelJazz is correct throughout.
