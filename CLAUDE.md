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
long before anyone finds the cause.

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
