# Working conventions

OtelJazz renders OpenTelemetry GenAI spans from a multi-agent system as a jazz combo.
Layout: `engine/` (the Python engine, `caidence.py`
and everything it depends on), `web/` (the browser port), `docs/` (orientation and design
concepts), `src/` + `wrangler.jsonc` (the Cloudflare Worker serving oteljazz.com).

These four conventions are load-bearing. Each one exists because breaking it already caused a
real, hard-to-diagnose problem.

**`synthetic_trace()` is deterministic; `extended_demo_trace()` is not.** `synthetic_trace()` is
the calibration path: always seed=0, never randomized, byte-identical run to run. That property
is what makes any change to the mapping measurable. `extended_demo_trace()` is the listening
path: randomized by default via `--demo`, reproducible with `--seed N`. Don't blur the line, and
don't give `synthetic_trace()` a seed parameter.

**There is exactly one per-span mapping implementation.** The batch and live paths both call
`emit_span_events`. Never add a second one for live-mode convenience -- two copies of this
mapping will drift apart, and the drift will show up as "the live version sounds subtly wrong"
long before anyone finds the cause. The browser port has its own version of this same rule now
that it has a live path too (`web/director.js`'s `Director.feedSpan`, backing `oteljazz.com/?live=`):
`_generateBar` reads `this.swarm.spans` and has no branch for where a span came from.
`LiveSwarmAdapter` (live) and `SwarmEngine` (synthetic) are two different *populators* of that
array, not two different *interpretations* of what's in it. If a future change to live mode's
mapping needs `_generateBar` itself to branch on live-vs-synthetic, that is this rule breaking --
find the single-mapping way to express it instead.

**Dynamics are telemetry-driven; harmony is corpus-driven.** Velocity, tempo, and event density
come from the span stream. Harmony, voice-leading, and cadence come from the mined corpus model.
Crossing those wires makes the telemetry channels undecodable -- everything smears into
undifferentiated musical activity, which is precisely the failure an earlier design had.

**Check the Logic channel routing before blaming the mapping.** A track reorder in Logic silently
invalidates the channel table in `VOICES`: no error, just wrong-sounding output. Run
`--test-note --channel N` first. This has been the real cause more than once.

The browser port (`web/engine.js`, `web/director.js`) is a faithful port of the corpus model,
chorale voicing, walking bass, and liveness machinery, with several deliberate simplifications
documented in `web/engine.js`'s header comment. Read that header before assuming engine parity.
It also has its own live-OTLP path (`src/live-relay.js`, `src/otlp-decode.js`,
`Director.feedSpan`) independent of the Python engine's `live.py` -- real spans posted to
`oteljazz.com/live/<session>/v1/traces` drive real audio in a browser tab at
`oteljazz.com/?live=<session>`, not just the synthetic swarm. See `docs/README.md`'s "Live browser
mode" section for how to point something at it.
