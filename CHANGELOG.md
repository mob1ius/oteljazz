# Changelog

## v1.9.1 — 2026-09-17

### Fixed

- **The live relay no longer logs an error for every rejected request.** A request refused before
  its body was read (wrong content type, oversized, or rate limited) left the body unread, and
  the runtime logged "Can't read from request stream after response has been sent" each time,
  once per rejected export. A rate-limited exporter could fill the log with them. The relay now
  reads and drops small declared bodies before answering, which covers the case that repeats.
  Rejections are still cheap: neither the protobuf decode nor the database write happens for them.
  Checked with a 200-request flood against a local relay: 112 rate-limited, no errors logged.
- Two approaches were tried and rejected on measurements, and the reasons are in the code:
  cancelling the body tore connections down mid-upload (8% of that flood failed with "Network
  connection lost" and a 500), and draining every body let a client that declares a large body
  and then sends little of it hang the request indefinitely. Only bodies that declare 64KB or
  less are drained; anything else is answered without touching the body, which logs once.

## v1.9.0 — 2026-09-17

Live mode gives the lead voice to a sensible agent instead of requiring one to be named
`orchestrator`. The synthetic demo sounds exactly as it did in v1.8.0.

### Changed

- **Who gets the lead voice.** One agent holds the unpooled lead ("planner") voice for a session;
  everyone else shares the three worker voices. It used to go only to an agent whose name was
  exactly `orchestrator`, so in most real systems nobody held it. Now it goes to the first agent
  that appears, and any span may claim it by setting `gen_ai.agent.role` (or `gen_ai.agent.type`)
  to `orchestrator`, `planner`, `supervisor`, `coordinator`, `lead`, `root` or `main`. A
  declaration wins whenever it arrives, so the lead can move if the system says so, and the
  previous holder simply rejoins the worker pool. The relay passes the attribute through, capped
  at 64 characters and escaped like every other span field.
- **The synthetic demo is unaffected**, byte for byte: its orchestrator is always the first agent
  to speak, so "first agent seen" picks exactly what the old name check did.
- Checked against a local relay with real OTel SDK spans: a stream whose first agent was
  `ingest-worker` and where `planner-service` declared the role gave the lead to
  `planner-service`; a stream with no role attribute gave it to whoever spoke first, with all
  132 spans played. `window.__oteljazzDebug()` now reports the current lead agent.

### Fixed

- **Live spans could be played out of order.** Since v1.5.1 an arriving span is moved forward to
  the next bar that hasn't been written yet, and that could place a span in an earlier bar than
  one that arrived before it (measured: four agents starting a session were heard in the order
  3, 4, 1, 2). Voice assignment is decided in the order spans are read, so this could hand the
  lead voice, or a worker voice, to the wrong agent. Arriving spans now keep their order.
- `engine/live_producer.py --declare-role` sets the role attribute on the orchestrator's spans,
  for testing this path.

## v1.8.0 — 2026-09-17

The browser demo's tempo now follows the swarm. Measured from Director's output with the new
`scripts/tempo_check.mjs` (seeds 1 to 40, 900s each). Nobody has listened to it for long yet.

### Added

- **A tempo that follows span throughput.** At the start of each chorus, the demo counts the
  spans that finished in the last 30 seconds and compares that rate with what is usual for this
  session. "Usual" is a slow average that takes about five minutes to catch up. Twice the usual
  rate means 14 BPM faster, half means 14 slower. The tempo stays between 76 and 120 and moves
  at most 12 BPM per chorus. The Python engine already had a tempo arc, stepped per section and
  scaled to the finished trace's own range. An endless stream has no finished trace, so the
  browser compares with its own recent normal instead, which also works for a system doing one
  span a minute or thousands a second. Live mode uses the same rule. Tempo changes only at
  chorus boundaries, never mid-phrase, and each change prints a `tempo` line in the terminal.
  Service mode shows the tempo that is currently playing.
- **Measured:**
  - Chorus tempos ranged from 76 to 113 BPM, with a median of 95 and 80% between 86 and 103.
  - The tempo changed about 6.6 times per 5 minutes, with a median step of 6 BPM. It sat at a
    limit in 0.1% of choruses.
  - The first change usually comes about 80 seconds in, because the first measurement only sets
    what "usual" means.
  - Tempo tracks its input, log(rate / usual), with a correlation of 0.91. It isn't 1 because
    of the limits and the step cap.
- **Timing checked across 14,158 bars and 223,656 notes:**
  - every bar starts where the previous one ended, and every bar in a chorus has that chorus's
    length;
  - no bass or solo note falls outside its own bar;
  - every sustained chord (53,859 checked) starts on its bar, or an eighth note early (the push),
    allowing for the drift lag.
- **Refactor first:** variable bar lengths were built with the tempo held at 96, and that build
  reproduced v1.7.0's output byte for byte before the tempo rule was switched on.

### Changed

- The solo line, drift detection and live mode were re-checked on this build. The solo is still
  100% in the chord and the register. Every simulated live span still plays. In a 10-minute live
  simulation with alternating busy and quiet two-minute stretches, the tempo went 96, 84, 76,
  88, 100, 105, 97 and back down, following them.
- **Correction to v1.6.0 and v1.7.0.** Those entries gave the share of injected drifts that
  become audible as 79.6% and 81.5%, from 40 sessions. Rerun over 150 sessions, the figure is
  about 72% (71.0% with the tempo arc, 73.6% with the tempo held at 96, so the tempo arc makes
  no meaningful difference). About 87% of audible drifts correspond to a real injection, not
  92% to 95%. The 40-session figures were sampling noise. `scripts/drift_validation.mjs` now uses
  150 sessions for this part. The detector's own recall (about 85% at the demo's settings) is
  measured separately and was not affected.
- Seeded links from v1.7.0 play at different tempos now, so they no longer replay identically.

## v1.7.0 — 2026-09-17

The browser's solo line is now a port of the Python engine's, motif included. Measured with the
new `scripts/melody_check.mjs` (seeds 1 to 40, 600s each); nothing here has been checked by
listening tests.

### Changed

- **A solo line with a shape.** Before, each solo note was a chord tone placed in a random
  octave, so consecutive notes jumped a median of 8 semitones (90th percentile 18) and the line
  never stated an idea. It also didn't match its own description, which mentioned arpeggio runs
  that were never played. Now, as in `engine/caidence.py`:
  - each note steps from the previous one, using the interval habits of one Weimar Jazz Database
    soloist at a time (rotating every 8 bars across 50 players), and stays within 18 semitones
    of its home note;
  - busier swarms bring faster notes, longer phrases, shorter rests and more 1-3-5-7 runs;
  - a four-note motif is stated, inverted or played backwards as whole phrases, and always
    stated as written when a phrase starts at the top of a chorus.
- **Measured:** median step 3 semitones (90th percentile 9), every note inside the chord shown
  at that moment and inside the register, 46.5% of notes on a 3rd or 7th (54.5% before).
  264 of 264 phrases that began at a chorus top stated the motif as written.
- **Sparser:** about 88 notes a minute, down from 181, because the Python rhythm leaves more
  space. Note density and velocity still follow how many agents are active, and nothing else
  about the telemetry reaches the solo.
- **Where it differs from the Python engine, on purpose:**
  - A new motif arrives whenever the key or mode changes, about every other chorus, because an
    endless stream has no single piece to own one.
  - Motif notes are chosen so each step moves in the motif's direction. The Python approach of
    taking the nearest suitable note kept a statement's up-and-down shape only 51% of the time
    here. This keeps it 86% of the time; the rest are probably mostly repeated tones where the
    chord changes under the motif, though that hasn't been measured.
  - A run that would leave the register moves by an octave as a whole.
  - Every solo note sounds inside the bar whose chord it was chosen for. In a first draft of
    this port, rounding and runs let 2% of notes land on the next chord.
- **Isolation:** the solo line now has its own random stream derived from the session seed.
  Moving the old solo onto that stream was done first. Its "everything except the solo"
  fingerprint then stayed identical through the rewrite, so the new solo changed nothing else
  in the music. That first step did change the rest of each seeded session once, so v1.6.x
  seeded links no longer replay the same way.
- `Director` takes the corpus's per-player interval tables (`performerIntervals`). Without them
  the line falls back to small steps.
- Drift figures from v1.6.0 re-checked on this build: 81.5% of injections become audible, and
  95% of audible drifts correspond to a real injection. Anomalies average 3.8 per 5 minutes
  (3.6 before), because the session's random stream shifted. Fill ticks are unchanged (median
  0.15ms, p99 0.9ms).

## v1.6.1 — 2026-09-17

### Fixed

- **The demo now plays in the key it shows.** Each session picks a random key, and a new chorus
  may modulate, but only the chord readout ever used the key; everything audible was generated
  in C. So in 11 of 12 keys the dial named chords that weren't sounding, and key changes were
  silent (major and minor switches were heard, nothing else). Measured over 20 sessions and 1,600
  bars: the sustained chord matched the displayed chord in 257 bars. Chords, bass, solo line,
  error grace notes and the capture-spike cluster now use the current key. The V to I cadence
  accent still works on the key-relative chord, as before.
- Checked: every note's voice, timing, length and velocity is identical to v1.6.0; only pitches
  moved. Sustained chord notes now match the readout 99.8% of the time (6,363 of 6,377), the
  solo line 99.4%, and the walking bass 77% (it uses passing tones on purpose). The few misses
  left in that check look like per-span notes whose rounded start time falls in the next bar,
  not wrong chords. Seeded links from v1.6.0 play the same rhythm in the correct
  key.

## v1.6.0 — 2026-09-17

Goal-drift is now detected from the spans rather than triggered at random. Everything in this
release was checked against synthetic, injected drift only; nothing here shows the detector
finds drift in a real system.

### Added

- **Detected goal-drift, in the browser and in the Python engine.** A new detector looks back 40
  seconds over spans that have finished. It compares each span's duration with other agents'
  spans of the same kind (the same MCP server for tool calls, the same operation otherwise), and
  flags an agent whose latency is trending upward and is still well above its peers. It is the
  only way the drift signature starts in the browser, in both the synthetic demo and live mode,
  and it reads the same span list either way. The terminal line names the agent and how many
  times its peers' latency it is running at.
- **Injected drift in the synthetic swarm.** In each fan-out round there is a 15% chance that one
  subagent gets slower at its own work, reaching three times its normal latency over 10 seconds.
  Nothing downstream is told; the detector has to notice.
- **Why latency and not onset lag.** The existing Python detector, which compares each voice's
  first span in a bar against the beat, found nothing when ported to the browser's spans: their
  natural timing spread is about 0.59s, against the 30ms it was validated on. A live stream also
  can't support it, because exporters send spans when they end, often in batches. Durations
  survive both. The onset-lag detector in `engine/drift_detect.py` is unchanged.
- **Measured** (`scripts/drift_validation.mjs`, seeds 1 to 40, 600s each):
  - With nothing injected, it fires in 2.5% of 16-bar windows.
  - At the demo's 3x slowdown it finds 84.8% of injections (85.5% of those long enough to test).
    At 2x it finds 47.8%, at 4x 87.9%, at 6x 89.6%.
  - When injections are running, some firings name an agent that is not the drifting one: 11.6%
    at the demo's settings, and between 6.0% and 16.8% across the other sizes and rates tested.
  - End to end, 79.6% of injections become audible, a median 15.5s after the slowdown begins.
    91.8% of audible drifts correspond to a real injection.
  - The original target was 95% recall. It was not reached, and further threshold tuning had
    stopped improving it.
- **Python engine.** `drift_detect.detect_latency_drift` is a line-for-line port with the same
  constants. `engine/drift_parity_check.py` runs both on the same spans: 3,180 evaluations, no
  disagreements, statistics equal to 1e-14. `caidence.py --detect-drift=latency` uses it, and a
  bare `--detect-drift` still means onset lag. Injection in `swarm.py`, `caidence.py --swarm` and
  `live_producer.py` is opt-in (`--inject-latency-drift`). With the flag off, their output is
  byte-identical to before, so `seed_sweep.py` and the figures are unaffected.
  `live_producer.py --batch-delay-ms` exports in batches, the way most real SDK setups do.

### Changed

- Conflict, capture spike and collusion are still triggered at random, and drift is no longer one
  of the random choices. A random anomaly waits while the detector has a finding. A detected drift
  may start as soon as a random anomaly has ended, without waiting out its 30s gap; two detected
  drifts still keep that gap. If the drifting agent has lost its shared voice, the drift plays on
  the voice it last held, provided that voice is still sounding. Together these raised the share
  of injected drifts that become audible from 45% to about 80%. Anomalies now average 3.6 per
  5 minutes, up from about 2.9.
- Seeded replays of v1.5.x sessions no longer match: the synthetic swarm now makes extra random
  draws. New baselines are in `scripts/director_fingerprint.mjs`.
- README and `docs/CONCEPTS.md` now say exactly which anomalies are detected and how far that
  has been checked. The README had described the live demo as including "anomaly detection",
  which was true of none of the four signatures until this release and is now true of one.

Detection runs on every generated bar. A 1.5s fill tick now takes a median of 0.15ms (p99 1.0ms,
worst 4.3ms across 30 half-hour sessions), and the first fill at start-up takes up to 7.0ms. No new files are served, so the site's request pattern and the crawler dataset are
unaffected.

## v1.5.1 — 2026-09-17

Two live-mode bugs, both found while testing drift detection against a local relay. Neither
affects the default synthetic demo; its output is byte-identical to v1.5.0.

### Fixed

- **Live relay stopped accepting spans after 50 requests.** The ingest rate limiter's window
  start was never initialised, so the "one second has passed" check compared against `NaN`,
  never passed, and the counter never reset. Each session's relay instance therefore accepted
  50 ingest POSTs in total and answered every later one with 429 for as long as the instance
  stayed alive, which an open browser tab keeps it doing. A real exporter hits that within
  minutes. Earlier live checks sent fewer than 50 requests, which is why it went unnoticed.
  The limit is now 50 per second, as intended. Checked locally with 132 single-span POSTs: all
  returned 200.
- **Most live spans were never played.** An arriving span was stamped at the playback frontier,
  but the generator had usually already written the bar containing that moment, and bars are
  never revisited, so the span sat unread. In simulation 50 of 286 spans reached the music; in
  a real local run through the relay, 40 of 143. A span stamped behind the frontier now moves
  forward by whole bars, keeping its position inside the bar. All 300 simulated spans and all
  132 relayed spans now play. The cost is up to one bar (2.5s) of extra delay, so live spans
  are heard roughly 1.5 to 4 seconds after they arrive. The per-span mapping itself is unchanged.

Site request pattern unchanged. Live ingest now succeeds where it used to 429, so
`live_sessions` counters and relay logs will show more accepted ingests per session.

## v1.5.0 — 2026-09-16

### Added

- **Reduced motion.** With the operating system's reduce-motion setting on, the cabinet stops
  moving on its own. That covers the CRT tear, error bleed, voice flicker and birth swell, the
  warm-up and boot animations, CRT flicker and jitter, the caret blink, the boot ticker, and the
  glass breathing and cone motion. Effects that carry a signal keep a static form for the same
  duration: an anomaly briefly brightens the glass, an ERROR span tints it red, and a new voice's
  LED lights steadily. The per-note activity flicker has no static form, because switching on and
  off at note rate would still be flashing, so it goes dark. The VU needle keeps reading the
  level in five fixed positions at about 4Hz. The meter itself still runs at 30Hz, so
  `--audio-rms` never freezes. Previously only the narrow-layout dial wave honoured the setting.
  Checked by inverting the media condition in a scratch build: no running animations anywhere
  on the page, static states present, `--audio-rms` still updating, layout unchanged at 375px and
  768px. With the setting off, the page behaves as in v1.4.1.
- `scripts/director_fingerprint.mjs`: runs `Director` headless in Node and hashes everything it
  schedules for a given seed. Two runs with the same seed must print the same hash, so any change
  can be compared before and after. Baselines for v1.4.1 are in its header. It does not see
  app.js, so station drift is outside what it checks.

### Changed

- **Station drift is now seeded and runs on the audio clock.** It moves the tuning filter and
  static level, so it is part of what you hear, but it used `Math.random()` and page timers. Two
  sessions opened from the same `?seed=` link could therefore sound different. It now draws from
  its own random stream derived from the session seed (kept separate from the music's stream, so
  the notes are unaffected), and the check and every knob step are scheduled at Transport times
  rather than on `setInterval`. Same odds (6% per check) and same 45s spacing, now counted in
  playback time: pausing pauses it, and it keeps running in a hidden page. Each drift is listed
  in `__oteljazzDebug().stationDrift`. Checked in a scratch build with a 5s check at 50% odds:
  two runs of seed 12345 drifted at the same transport times (20s, 25s, 35s) with the same
  direction and depth, and gave identical knob-state sequences over 35s. The filter cutoff matched
  to within 0.67%, since each glide starts from the moment the step runs. Seed 99 gave a different
  sequence, matching an offline replay of the same stream.
- The `web/engine.js` header no longer lists comp push as missing (director.js has had it for
  some time), and now describes the `?seed=` replay path instead of saying sessions cannot be
  reproduced.

Site request pattern unchanged: no new files are served, so the crawler dataset is unaffected.
Director output is byte-identical to v1.4.1 for seeds 12345 and 99 (300s) and 12345 (1800s).

## v1.4.1 — 2026-09-10

### Removed

- The chord-change light sweep across the bezel (v1.4.0). It read as a cheap screen effect laid
  over a photograph rather than light on metal, and cost more than it added.
- The "Copy link to this exact session" button under the radio. It copied the identical
  `?seed=` URL the model plate already copies; two controls for one action.

### Changed

- The model plate moved off the photo and onto the lower control strip. As an overlay on the
  image it sat on top of the bezel's baked-in brass and screws and clashed with it; the strip is
  CSS the page controls, with room either side of the switches. Restyled as a mounted maker's
  badge -- engraved serif caps matching the VOLUME/TUNING lettering in the photo, brushed-brass
  face, a screw at each end -- instead of a translucent monospace tag. Takes its own centred row
  under the switches below 960px. It is now the only share control, so it picked up the removed
  button's clipboard fallback for non-secure contexts and an accessible name.

### Fixed

- A second click on the plate within its 1.4s "Copied" window left it stuck showing "Copied":
  the restore captured the current text at click time. It now restores the fixed serial.
- On tablets and phones (below 820px) the control strip was covering the play button and VU
  meter. Its negative top margin exists to tuck it over the photo's empty bottom edge on desktop,
  but at narrow widths the dial panel moves out below the photo, so the same margin dragged the
  strip up over the panel's controls instead. Narrow layout now gives the strip a normal gap and
  its own rounded corners, and restores the photo's bottom corners, which had been squared off on
  the assumption the strip docked there. Pre-existing since the strip was attached; surfaced while
  checking the new badge's narrow layout.

## v1.4.0 — 2026-09-09

Cabinet effects, an analog VU meter, a typeable console, and a performance/security pass. The
demo previously reacted to telemetry only through audio and a text feed; most of what follows
makes the cabinet itself respond to signals the engine was already emitting.

### Added

- **Anomaly CRT tear.** Drift/collusion/poisoned-spawn now desyncs the dial: a displaced scanline
  band sweeps down and the text skews for ~400ms. The anomaly is the point of the whole grammar
  and was previously audio-only, with the screen perfectly calm during the one moment the design
  exists for. Fires at REVEAL time (`oversight-grammar` marker) so it lands with what is heard.
- **Error bleed.** An `ERROR`-status span warms the whole glass red for a beat. The characters
  were already red, but at any distance where individual characters aren't legible a failure
  looked identical to a success -- which is most of the time, for a display meant to be watched
  peripherally.
- **Voice birth surge.** A voice's first appearance in a session gets a brighter, slower swell,
  distinct from the ordinary per-note activity flicker: an agent spawning and an agent merely
  being busy were previously indistinguishable at a glance.
- **Chord-change brass sweep.** A specular highlight travels across the cabinet on each chord
  change. Harmony is the one channel deliberately NOT telemetry-driven (CLAUDE.md), so it gets a
  slower, material cue rather than the electrical vocabulary everything else uses.
- **Analog VU meter with real ballistics**, replacing eight digital bars -- a 1980s artifact on a
  1940s cabinet. Driven by actual master-output RMS via `Tone.Meter`, not the random per-tick
  heights the bars used. Asymmetric follower: fast attack, slow release.
- **Filament breathing and speaker-cone motion**, both from the same RMS (`--audio-rms`). The
  glass swells with the music; the grille moves by well under a percent. Consciously invisible.
- **Cold-start warmth ramp.** The glass starts cold and dim and settles to amber across the boot
  warm-up, like a valve heater coming up.
- **A typeable console.** Click the dial glass (or press backtick) for a cursor: `help`, `whoami`,
  `ls`, `seed`, `chord`, `voices`, `about`, `clear`, `exit`. The terminal was already a convincing
  fake; letting people touch it was the unrealized move.
- **Service mode (konami).** Exposes the internals `window.__oteljazzDebug()` already returned but
  which were console-only: transport time, queue depths, cursors, seed. The sequence's arrow keys
  also nudge the knobs, but up-up-down-down and left-right-left-right each net to zero, so the
  dial lands exactly where it started.
- **Station drift.** Rarely, the dial wanders off station on its own and the signal degrades
  before settling back. Goes through the tuning knob's own programmatic handle, so the audible
  result is identical to a listener having nudged it -- no second audio path.
- **Model plate.** The session seed etched on the cabinet as a serial number, click to copy. The
  share feature's own value, surfaced inside the fiction rather than only on a button below it.

### Performance

- `assets/radio_overlay.png` (1525 KB) converted to WebP (138 KB) -- **91% smaller**, and the
  single largest asset on the site by a wide margin. It was a pure RGB photograph with no alpha
  channel shipped as a PNG. Verified before switching: PSNR ~40 dB, and a 2x-zoom comparison of
  the herringbone speaker grille (the highest-frequency region in the image) is visually
  indistinguishable. Total payload 4.3 MB -> 3.0 MB.
- `vendor/Tone.js` now loads with `defer`. It was render-blocking: the parser stopped to download
  and execute 341 KB before the cabinet could paint. Safe because `app.js` only touches the `Tone`
  global inside functions, and a deferred classic script and a module script both execute in the
  deferred phase in document order.
- Removed `mostRecentSpanBefore` from `web/engine.js` -- dead code, no callers remained.
- Measured and deliberately did NOT change `pushTerm`'s `innerHTML` rebuild: 45us per call at
  roughly one span per second is 0.045 ms/sec. It looked like a hot path and isn't; the terminal
  needs its markup, and `textContent` (2.7us) can't carry it.

### Fixed

- **A background-throttling bug introduced during this work and caught before it shipped.** The
  audio-meter pump first used `requestAnimationFrame`, which does not fire at all in a hidden or
  occluded page -- precisely the anti-pattern this file already carries a warning about, and
  precisely how an OBS Browser Source (how this demo is captured) renders. It published a frozen
  `0.000` while the meter itself read a healthy -35 dB. Moved to `Tone.Transport.scheduleRepeat`,
  which rides the AudioContext clock, and re-verified with `document.hidden === true`.
- `src/live-relay.js`: capped concurrent WebSocket viewers per session at 32. Ingest already had
  a 2 MB body limit and a rate limit; the viewer side had neither, leaving the one genuinely
  unbounded resource on a public, unauthenticated endpoint -- sockets accumulate in a Set and
  every ingest broadcasts to all of them, so idle connections cost memory *and* multiply per-span
  send work.
- Accessibility: the console was click-only, leaving keyboard users no path to it at all (now
  backtick from anywhere, or Enter on the focused glass, which is `tabindex="0"` with a role and
  label). The power button's accessible name was a bare glyph and now tracks state as Play/Pause.

### Security note

The console echoes typed input back through `pushTerm()`, which renders with `innerHTML` -- the
same sink, and the same rule, as `src/live-relay.js` escaping OTLP attributes server-side. Input
is escaped on the way in; verified by typing `<img src=x onerror=alert(1)>` and confirming no
element is created.

## v1.3.4 — 2026-09-02

Expanded the v1.3.3 silent-catch sweep project-wide (Python engine, browser, the Claude Code
hook), not just the Worker. Grepped every catch/except across the whole repo, kept the ones that
are genuinely benign (sys.exit on missing deps, expected queue/statistics edge cases, feature
detection with a documented fallback) and fixed the four that weren't.

### Fixed

- `web/app.js` -- a WebSocket message that fails to parse in live mode was silently dropped.
  live-relay.js is the only sender, so this would only fire on a real bug or genuine corruption,
  but a silent failure here reads exactly like the terminal-freeze bug this session's own
  stall-detector was built to catch: spans just stop appearing with no clue why. Now logged.
- `engine/build_corpus_model.py` -- a chord that failed roman-numeral analysis inside an
  otherwise-successful piece vanished with zero trace, not even a count, unlike its sibling
  per-piece catch which at least tracked one. This feeds the actual corpus numbers the paper
  cites, so an uncounted drop rate there was a research-integrity gap, not just a missing log
  line -- no way to tell "a few odd chords, expected" from "something's quietly eating most of
  the data." Added a counter (`chord_errored`) reported in both the progress line and the final
  summary. Both of the file's per-piece `except Exception as e:` blocks captured `e` and only
  counted it without ever printing it; now both do.
- `.claude/hooks/capture.py` -- the hook capturing real Claude Code session telemetry (the actual
  data behind this project's "real-trace capture" feature) failed completely silently on any
  error. Fail-open is correct and unchanged -- this must never block the session it's hooked
  into, same reasoning as crawler-log.js's Rule 1 -- but stdout is the hook's own protocol
  response, so a diagnostic can't go there without corrupting it. Now written to stderr instead,
  which Claude Code doesn't treat as part of the response contract. Verified with malformed
  input: stdout still returns exactly `{"continue": true}`, stderr now carries the actual error.

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
