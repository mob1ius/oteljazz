# Instructions for Claude working in this directory

This is the cAIdence / OtelJazz project (semantic sonification of multi-agent AI coordination).
Layout: `paper/` (the submission + design spec + figures), `engine/` (the Python engine,
`caidence.py` and everything it depends on), `web/` (the browser port), `docs/` (this project's
own documentation: `README.md` orientation + file map, `BUILD_NOTES.md` running build log,
`ROADMAP.md` where the project is going).

## Every session

**Read `docs/BUILD_NOTES.md` first**, before making changes. It has decisions, tradeoffs, and bug
fixes from prior sessions that aren't obvious from the code alone -- especially anything under
its "Open work" section, which is the current state of in-progress work across context resets.

## After every build or ship

**Update `docs/BUILD_NOTES.md`.** Add a new entry at the top of the chronological log (newest first)
covering what changed and why -- not a diff summary, but the reasoning a future session with no
memory of this conversation would need: what was tried, what broke, what the tradeoff was, what
explicitly got scoped out and why. Update the "Where things stand" section at the top if the
overall state changed, and update "Open work" to reflect what's now done vs. still pending.

This exists because the project spans multiple sessions and context windows, and the code alone
doesn't carry the reasoning behind non-obvious decisions (e.g., why mode-shift is decoupled from
the chord-degree sequence, why `synthetic_trace()` must never take a random seed, why the pad
voice-leading fix mattered). Losing that reasoning means re-deriving it, or worse, re-breaking
something that was already fixed for a documented reason.

## Working conventions already established (see BUILD_NOTES.md for the reasoning)

- `synthetic_trace()` is the calibration-shaped path: always deterministic, seed=0, never
  randomized. `extended_demo_trace()` is the demo/listening path: randomized seed by default via
  `--demo`, reproducible with `--seed N`. Don't blur this line.
- The batch and live paths share exactly one per-span mapping implementation
  (`emit_span_events`). Never add a second one for live-mode convenience -- they will drift.
- Dynamics (velocity, tempo where implemented, event density) are telemetry-driven; harmony,
  voice-leading, and cadence shape are corpus-driven. Don't cross those wires -- an overseer
  needs the telemetry channels to stay decodable.
- Before attributing a "wrong" sound to the musical mapping, verify the actual Logic MIDI
  channel routing with `--test-note --channel N`. A Logic-side track reorder silently breaks the
  channel table in `VOICES` with no error, just wrong-sounding output, and this has been the
  real cause more than once.
