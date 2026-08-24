# OtelJazz

**An agent swarm, played as a jazz combo.** You don't read the trace. You hear it go wrong.

![A 1940s tabletop radio whose dial glass is an amber CRT terminal streaming live OpenTelemetry
spans from three concurrent AI subagents, one of them returning an error, above the chord
readout D-flat major 7.](docs/assets/hero.jpg)

The dial is not decoration. That's the demo mid-run: OpenTelemetry GenAI spans from three
subagents working in parallel, one tool call failing, and the chord the ensemble is sounding as
it happens. A frozen frame of real engine output, not a mockup.

**[Listen at oteljazz.com](https://oteljazz.com)** — every visit generates a different session,
in your browser, in about three seconds. No signup, no backend, no cookies.

---

## The problem this started from

A multi-agent system emits state changes in parallel, at machine speed. A human overseer's visual
attention is serial, foveal, and slow. A trace tree gives you no coverage at all while you're in a
meeting, reading code, or looking anywhere else. Hearing is the opposite — preattentive,
peripheral, temporal. So: render the telemetry as sound.

That idea isn't new. Datacenter services have been given instruments for over a decade. What's
different about an agent swarm is that the population has no fixed ceiling — it grows and shrinks
at runtime — and what matters about it is semantic, not physical. Not where something is or how
loaded it is, but whether an agent's goal has drifted, whether two are coordinating in a way they
shouldn't, whether one has quietly stopped.

Everything below is a consequence of taking that seriously, and most of it started as something
that sounded wrong.

---

## Five decisions, and what forced each one

### 1. One instrument per agent doesn't survive contact with a swarm

The obvious design gives every agent its own voice. It's what you'd do for a subway system with
a fixed line count, and it works there. It does not work here: independent auditory streams stop
being separately trackable past three or four, and the degradation is worse when the voices share
a timbre. An agent population blows through that limit by design.

So the population is rendered as **one harmonic object** instead. Seven piano voices share a
timbre, an onset grid, and voice-led motion — deliberately withholding every cue that would let
you pull them apart — so they fuse into a single chord. A solo line and a walking bass sit outside
that mass as the two intentionally segregable exceptions. Perceptual load is roughly three
objects, not nine streams.

What you monitor is that one texture, and the oversight signals are properties *of it*:

| You hear | It means |
|---|---|
| The chord thickens or thins | Agents becoming live / completing / going dark |
| Tempo rises and falls | Span throughput *(Python engine; the browser demo runs at a fixed tempo)* |
| A voice slides off the shared attack | An agent diverging from its mandate |
| Voices that should be independent lock in unison | Candidate collusion signature |
| A wrong note enters, out of key | A poisoned spawn |
| A voice drops out mid-phrase | Silent failure or stall |

### 2. Voices that don't know about each other sound like a mistake, not a chord

The first implementation hashed each span independently to a pitch in the current mode. Every
note was individually defensible and the result was unlistenable — five soloists in the same key
rather than five-part writing, with no harmonic relationship between voices. It read as noise.

The fix moved pitch from a per-span decision to a per-chord one. **One shared seven-voice voicing
is computed at each chord change** and held: voice-led as a group, range-constrained per voice,
never crossing, with a parallel-fifth-and-octave avoidance pass. A span now just re-articulates
the tone its voice already holds. Rhythm and dynamics stay per-span and fully telemetry-driven;
the only thing lost was an uninformative hash. Verified across a 20-chord synthetic walk and a
full demo run: zero voice crossings, down from roughly a third of all steps.

### 3. Telemetry must not touch harmony

An early version drew chord changes from each telemetry window, so different activity produced
different roots. It was harmonically incoherent and — the important part — *indistinguishable
from noise*, because with the form moving too there was nothing to hear the dynamics against.

Now the harmonic form is fixed once per session and tiled. **Telemetry drives dynamics only**:
tempo, thickness, articulation density, anomaly signals. Form isn't an oversight channel; it's
the grammar that makes the other channels legible. This separation is the single most important
rule in the codebase, and it's why the telemetry stays decodable instead of smearing into
general musical activity.

### 4. A melody can walk into the ceiling and stay there

After the structural work landed, the output was still bad, and the cause was not structural. The
solo line's contour walk had no mean reversion: it drifted upward, hit MIDI note 127, and the
clamp pinned it there permanently, because the clamped value fed back in as the next step's
anchor. Measured on a 115-second run: **70% of melody notes sat in [120, 127]** — effectively one
repeated pitch for a hundred seconds, on the loudest and highest voice in the mix.

Fixed with a bounded, reflecting walk plus an octave-fold safety net. It's recorded here because
it's the most useful kind of bug: everything about the architecture was right, and one missing
constraint in a random walk made all of it sound broken.

### 5. Drift had to attack the cue that fusion depends on

Goal-drift was originally a pitch bend — the drifting agent's voice slowly flattening. That was
the wrong cue, and the reason is the design's own doing: the chorale *deliberately withholds*
pitch-based segregation cues so the seven voices will fuse. A bend fights the architecture.

The signature is now an **onset lag**. The drifting voice's attack ramps up to 45 ms late while
the other six stay locked to the shared grid — an onset-grid violation, which attacks fusion
directly rather than working against it. The bend still fires, demoted to a secondary micro-cue.

45 ms was set by ear during development. It is not derived from a published threshold, and no
published threshold transfers cleanly, because this is a deliberate departure from a
machine-precise baseline rather than one voice among natural ensemble jitter. Whether it's
noticeable is an open question, stated as one.

---

## Where the harmony comes from

Nothing about the harmonic language is invented. It's mined from the
[Weimar Jazz Database](https://jazzomat.hfm-weimar.de/) — transcribed solos from Parker, Coltrane,
Davis, Rollins and seventy others. **456 solos, 406 used after filtering, 74 performers.**

The model is a root-transition matrix plus a chord-quality distribution per root. Checked against
theory rather than assumed, and it recovers textbook practice on its own:

- The three strongest transitions in the matrix chain into **vi–ii–V–I**, the standard turnaround.
- From the dominant, the next root is the tonic **81%** of the time.
- The chord on the second degree is minor **70%** of the time; on the fifth degree it's a dominant
  seventh **83%** of the time — ii–V, recovered from data.

The browser port fetches and uses **the same mined file** as the Python engine. It is not a
reimplemented approximation.

---

## What this establishes, and what it does not

The prototype establishes **mapping fidelity**: the musical output is measurably structured by the
telemetry driving it. Across a run's phases, tempo returns to its opening value while ensemble
thickness does not — two telemetry-driven channels dissociating rather than moving as one, in
three of four checked seeds. That's a property of the Python engine, which has both channels.

It does **not** establish that a listener can decode any of it. No listening study has been run.
Everything above is a design argument from the perceptual literature plus measurements of the
mapping's own behavior, and the distinction is kept explicit throughout rather than left for the
prototype's existence to imply. A controlled study is the obvious next step, not a claim made
here.

The demo's telemetry is a **mock swarm generated in your browser**. Real capture exists in this
repo — a Claude Code hook writing real `gen_ai.*` spans, and an OTLP receiver that accepts live
protobuf on :4318 — but that is not what oteljazz.com is playing.

---

## Run it

```bash
cd web && python3 -m http.server 8000
# open http://localhost:8000/demo.html and press play
```

Must be served over HTTP — the corpus model and audio samples are fetched, and `fetch()` is
blocked under `file://`.

For the Python engine (MIDI into Logic Pro X), the mock pipeline, the live OTLP receiver, and
real-trace capture, see **[`docs/README.md`](docs/README.md)**. The design itself is written up in
**[`docs/CONCEPTS.md`](docs/CONCEPTS.md)**.

## The paper

[**The Oversight Ensemble: A Jazz-Grounded Musical Grammar for Sonifying Multi-Agent AI
Coordination**](paper/07-oversight-ensemble-sonification.md) — currently **under review** at the
Journal of the Audio Engineering Society. Not accepted, not published.

Archived on Zenodo: [data](https://doi.org/10.5281/zenodo.22033353) (audio, note-event exports,
corpus model) and [code](https://doi.org/10.5281/zenodo.22035239).

## Layout

```
paper/    the paper, its design spec, and figures
engine/   the Python engine (caidence.py and its deps)
web/      the browser port + audio samples
docs/     orientation and the design writeup
src/      the Cloudflare Worker serving oteljazz.com
supplementary_audio/   five examples from the paper
zenodo_deposit/        the data deposit contents
```

## Attribution

These are license conditions, not courtesies. Anything reusing the audio or the harmonic model
carries them:

- Piano: [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander
  Holm — CC BY 3.0
- Bass: [University of Iowa Musical Instrument Samples](https://theremin.music.uiowa.edu/) —
  Lawrence Fritts
- Harmony: [Weimar Jazz Database](https://jazzomat.hfm-weimar.de/), Jazzomat Research Project —
  ODbL
