# OtelJazz

Semantic sonification of multi-agent AI coordination as a real-time human oversight channel:
agent telemetry (OTel GenAI spans), turned into a musical cadence you can hear.

The engine is jazz-rooted: a 9-track piano trio texture -- 7 piano voices forming a chorale where
each track holds exactly one tone of the current seventh chord, 1 solo piano line whose density
tracks swarm activity, and a walking bass -- over a repeating form built from harmony mined from
the Weimar Jazz Database.

## Layout

```
engine/   the Python engine: caidence.py and everything it depends on
web/      the browser port: director.js/engine.js/demo.html and the audio sample libraries
docs/     this file and CONCEPTS.md
supplementary_audio/   five rendered examples
zenodo_deposit/        files for the data deposit (audio + note-events + corpus model), published at doi:10.5281/zenodo.22033353
```

Read the docs in this order:

1. [`CONCEPTS.md`](CONCEPTS.md) -- the design approach: the two-tier DIRECT/DERIVED signal
   model, and why dynamics and harmony never cross wires. The "why."
2. [`../CLAUDE.md`](../CLAUDE.md) -- the four working conventions that are load-bearing, and
   what breaking each one already caused.

## Engine files (`engine/`)

| File | What it is |
|---|---|
| `caidence.py` | The engine. Batch (compute-then-play) MIDI generation over the macOS IAC Driver bus. |
| `build_corpus_model.py` | Offline corpus miner (dev-only). Needs `corpus_raw/` (gitignored, re-download below). |
| `corpus_model_jazz.json` | **The live corpus.** Frozen chord-quality/root-transition statistics mined from the Weimar Jazz Database. `caidence.py` reads only this file at runtime (resolved relative to its own location, not cwd -- keep it next to `caidence.py`). |
| `swarm.py` | **Mock multi-agent pipeline + telemetry-derived form.** This is what demonstrates the mapping-fidelity claim -- ensemble thickness and tempo come from the pipeline's own shape, not authored. |
| `live.py` | Real OTLP/HTTP receiver + real-time player. |
| `live_producer.py` | Synthetic OTel span generator (real `opentelemetry-sdk`) for testing `live.py`. |
| `export_otel_trace.py` | `swarm.py`'s spans -> OTLP/JSON. Dev/inspection tool only. The browser demo generates its own spans client-side and does **not** load this output; the checked-in copy was deleted when hosting became real, since it was 208K of dead weight in a public deploy. |
| `import_otel_hook_trace.py` | A real captured Claude Code session (`.claude/hooks/capture.py`'s output) -> `caidence.py --trace`-loadable JSON. |
| `make_figures.py` | Regenerates the analysis figures. Run from `engine/`; pass `--outdir <dir>`. |

`corpus_raw/` (the raw Weimar Jazz Database download) is gitignored and not included in this
repo -- re-download it with the setup command below if you need to re-run the miner.

## Setup

```bash
cd engine
python3 -m venv ../.venv && ../.venv/bin/pip install mido python-rtmidi matplotlib numpy \
  opentelemetry-sdk opentelemetry-exporter-otlp-proto-http opentelemetry-proto music21

# Open "Audio MIDI Setup" -> Window -> Show MIDI Studio -> double-click "IAC Driver"
#   -> check "Device is online"

# Corpus model is already built and tracked (corpus_model_jazz.json). To re-mine it from scratch:
curl -o ../corpus_raw/wjazzd.db https://jazzomat.hfm-weimar.de/download/downloads/wjazzd.db
python3 build_corpus_model.py --source jazz --jazz-db ../corpus_raw/wjazzd.db
```

Logic Pro X track setup: **9 tracks** -- 8 Concert Grand (7 chord voices + 1 solo) plus a jazz
bass on ch9. The piano tracks are all the same patch because each holds exactly one note of the
current chord, sounding in tandem with the others (see `CONCEPTS.md` Section 3); the bass is a
separate instrument because it plays an independent walking line rather than a chord tone.
Confirm with `--test-note --channel N` after any track add/remove/reorder. A Logic-side track
reorder silently invalidates the channel table in `VOICES` -- no error, just wrong-sounding
output -- and this has been the real cause of a "bad mapping" more than once:

```
ch1 = arch1 (chord voice)             ch2 = planner
ch3 = worker1                         ch4 = worker2
ch5 = worker3                         ch6 = tools
ch7 = melody (solo piano, --demo only) ch8 = arch2 (chord voice)
ch9 = walking bass  <- a BASS instrument, not piano
```

The arch voices articulate on every chord change and are never silenced by section gating, so the
harmony always has a pulse. The bass is likewise never gated -- it's the anchor. Because the bass
owns the root, the piano voices comp rootless (guide tones first), which is standard practice.

## Running it

All commands below are run from `engine/`.

```bash
# ~30s calibration-shaped trace, fully deterministic (use for anything study-adjacent)
python3 caidence.py --port "IAC Driver Bus 1"

# ~110s dynamic demo, randomized seed each run (prints the seed for reproducing a good take)
python3 caidence.py --demo --port "IAC Driver Bus 1"
python3 caidence.py --demo --port "IAC Driver Bus 1" --seed 42

# The mock swarm: form derived from telemetry, not hand-authored. This is the one that
# demonstrates the claim -- ensemble thickness and tempo come from the pipeline's own shape.
python3 swarm.py --show                          # inspect the pipeline + derived form only
python3 caidence.py --swarm --port "IAC Driver Bus 1"
python3 caidence.py --swarm --fanout 6 --rounds 3 --port "IAC Driver Bus 1"

# Live: real-time OTLP receiver, then point a real or synthetic producer at it
python3 live.py --port "IAC Driver Bus 1"
python3 live_producer.py --trace swarm --speed 1.0  # in another terminal
```

## The browser port (`web/`)

`web/demo.html` (+ `director.js`/`engine.js`) ports the same grammar to the Web Audio API. It
must be served over HTTP, not opened via `file://` (its `fetch()` calls for the corpus model and
audio samples are blocked by browser CORS policy under `file://`):

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000/demo.html
```

## Live browser mode

The deployed demo at oteljazz.com plays a synthetic swarm by default. Point a real OTLP/HTTP
exporter at it instead and the browser demo itself, chorale voicing and anomaly detection
included, plays your real system's telemetry. This is separate from the receiver below: that one
feeds the Python engine's MIDI output, this one feeds the browser directly over a Cloudflare
Durable Object relay (`src/live-relay.js`).

Pick a session id (any string; it doubles as a shared secret -- see the security note in
`src/live-relay.js`'s header before using anything guessable), then:

```bash
# Point your OTLP/HTTP exporter's endpoint at:
#   https://oteljazz.com/live/<your-session-id>/v1/traces
# content-type must be application/x-protobuf -- the standard OTLP/HTTP default for every real
# SDK exporter. JSON encoding is not supported by this relay.

# Verify quickly using this repo's own test producer, which uses the real opentelemetry-sdk
# exporter rather than a hand-built payload:
cd engine
python3 -m venv .venv && source .venv/bin/activate   # if you haven't already, see Setup above
pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
python3 live_producer.py --trace synthetic --speed 4 \
  --endpoint https://oteljazz.com/live/<your-session-id>/v1/traces
```

Then open `https://oteljazz.com/?live=<your-session-id>` in a browser before or during that run.
The corpus/instrument load takes a moment as normal; press play once the button enables. Real
spans stream into the terminal and drive real chords/notes within about a second of arriving.

What maps: `gen_ai.agent.name` (falling back to `gen_ai.agent.id`) becomes the voice identity, an
agent literally named `orchestrator` gets the fixed lead voice, everything else pools onto the
worker voices the same way a synthetic subagent id does. `gen_ai.operation.name`,
`gen_ai.tool.name`, `gen_ai.usage.output_tokens`, and the span's OTel status code (`ERROR` maps to
the same dissonant/anomaly-eligible treatment a scripted error status gets) all carry through.

No listener discovery: only browser tabs open to your exact session id hear your spans, and
nobody else's spans can appear in yours. There's no server-side auth beyond the session id itself,
so don't reuse anything you wouldn't want a stranger to guess.

## Real-trace capture

`.claude/hooks/capture.py` is wired into this repo's own Claude Code hooks (`.claude/settings.json`)
and appends one JSON line per hook event to `.otel-hook-data/.state/local_spans/<session>.jsonl`
as this project itself gets worked on -- real telemetry, not author-authored. Convert a captured
session with `engine/import_otel_hook_trace.py`, then play it with `caidence.py --trace`. It
replaces the `opentelemetry-hooks` package's own local-spans feature, which is dead code in the
installed version -- see that script's module docstring for the details.

## Status

The engine and the browser port both run. The mapping is established; listener decoding is not
tested; a controlled listening study is the obvious next step.
