# OtelJazz

**An agent swarm, played as a jazz combo.** You don't read the trace. You hear it go wrong.

![A 1940s tabletop radio whose dial glass is an amber CRT terminal streaming live OpenTelemetry
spans from three concurrent AI subagents, one of them returning an error, above the chord
readout D-flat major 7.](docs/assets/hero.jpg)

The dial is not decoration. That's the live demo mid-run: OpenTelemetry GenAI spans from three
subagents working in parallel, one tool call failing, and the chord the ensemble is sounding as
it happens. A frozen frame of real engine output, not a mockup.

## The idea

A multi-agent system emits state changes in parallel, at machine speed. A human overseer's
visual attention is serial, foveal, and slow: a trace tree or dashboard gives no coverage at all
while you are in a meeting, reading code, or looking anywhere else. Hearing is the opposite —
preattentive, peripheral, and temporal.

The obvious approach, one instrument per agent, does not survive contact with an agent
population: independent voices stop being separately trackable past three or four, and an agent
population has no fixed ceiling. So the population is rendered as **one harmonic object**
instead — seven piano voices sharing a timbre and an onset grid so they fuse into a single
chord, with a solo line and a walking bass as the two deliberately segregable exceptions.

What you monitor is that one texture:

| You hear | It means |
|---|---|
| The chord thickens or thins | Agents becoming live / completing / going dark |
| Tempo rises and falls | Span throughput |
| A voice drifts off the shared attack | An agent diverging from its mandate |
| Voices that should be independent lock in unison | Candidate collusion signature |
| A wrong note enters, out of key | A poisoned spawn |
| A voice drops out mid-phrase | Silent failure or stall |

Harmony, voice-leading, and cadence come from a corpus mined from the **Weimar Jazz Database**
(406 solos, 74 performers). Telemetry drives dynamics only. Those wires never cross, which is
what keeps the telemetry channels decodable rather than smeared into general musical activity.

## Hear it

```bash
cd web && python3 -m http.server 8000
# open http://localhost:8000/demo.html and press play
```

Every visit generates a fresh, never-repeating session. It must be served over HTTP — its
`fetch()` calls for the corpus model and audio samples are blocked under `file://`.

For the Python engine (MIDI into Logic Pro X), the mock multi-agent pipeline, the live OTLP
receiver, and real-trace capture, see **[`docs/README.md`](docs/README.md)**.

## The paper

[**The Oversight Ensemble: A Jazz-Grounded Musical Grammar for Sonifying Multi-Agent AI
Coordination**](paper/07-oversight-ensemble-sonification.md) — the design, the corpus grounding,
the perceptual argument, and what the prototype does and does not establish.

The prototype establishes *mapping fidelity*: the musical output is measurably structured by the
telemetry driving it, with tempo and ensemble thickness moving independently across a run's
phases. It does **not** establish that a listener can decode that structure. That distinction is
kept explicit throughout rather than left for the prototype's existence to imply; a controlled
listening study is the obvious next step, not a claim made here.

Archived on Zenodo: [data](https://doi.org/10.5281/zenodo.22033353) (audio, note-event exports,
corpus model) and [code](https://doi.org/10.5281/zenodo.22035239).

## Repo layout

```
paper/    the paper, its design spec, figures, and review notes
engine/   the Python engine: caidence.py and everything it depends on
web/      the browser port: director.js / engine.js / demo.html, plus samples
docs/     orientation (README.md), CONCEPTS.md, ROADMAP.md
supplementary_audio/   five rendered examples accompanying the paper
zenodo_deposit/        the data deposit contents
```

## Regenerating the hero image

`web/hero.html` is a static, frozen-frame render of the demo, kept separate because a headless
screenshot of `demo.html` cannot get past its play button (Web Audio needs a real user gesture).
Its header comment explains where the span text came from and how to refresh it.

```bash
cd web && python3 -m http.server 8000    # in one terminal
# in another, from the repo root:
/Applications/Firefox.app/Contents/MacOS/firefox --headless --no-remote \
  --profile "$(mktemp -d)" --window-size=2764,1832 \
  --screenshot "$PWD/docs/assets/hero-full.png" "http://localhost:8000/hero.html"
sips -Z 1760 docs/assets/hero-full.png --out /tmp/hero_1760.png
sips -s format jpeg -s formatOptions 92 /tmp/hero_1760.png --out docs/assets/hero.jpg
rm docs/assets/hero-full.png
```

The render must happen at exactly 2764px wide — the radio is a fixed 2624px there, and the
`--s` scale factor in `hero.html` is derived from that width.
