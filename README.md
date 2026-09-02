# OtelJazz

![A 1940s tabletop radio whose dial glass is an amber CRT terminal streaming live OpenTelemetry
spans from three concurrent AI subagents, one of them returning an error, above the chord
readout D-flat major 7.](docs/assets/hero.jpg)

**An agent swarm, played as a jazz combo.**

The dial is not decoration: this is the demo mid-run, OpenTelemetry GenAI spans from three
subagents in parallel, one tool call failing, and the chord the ensemble is sounding as it
happens. A frozen frame of real engine output, not a mockup.

**[Listen at oteljazz.com](https://oteljazz.com)**. Every visit generates a different session, in
your browser, in about three seconds. No signup, no backend, no cookies.

---

## The problem this started from

A multi-agent system emits state changes in parallel, at machine speed. Human attention is
serial, foveal, slow: a trace tree gives zero coverage while you're in a meeting, reading code,
anywhere else. Hearing is the opposite, preattentive, peripheral, temporal. So: render the
telemetry as sound.

Not new; datacenter services have had sonic monitors for over a decade. What's different about a
swarm: the population has no fixed ceiling, it grows and shrinks at runtime, and what matters is
semantic, not physical, not where something is or how loaded it is, but whether a goal has
drifted, whether two agents are coordinating in a way they shouldn't, whether one has quietly
stopped.

Everything below follows from taking that seriously, and most of it started as something that
sounded wrong.

---

## Five decisions, and what forced each one

### 1. One instrument per agent doesn't survive contact with a swarm

The obvious design gives every agent its own voice, the way a subway map gives every line one;
that works for a fixed, modest line count. It fails here: independent streams stop being
trackable past three or four, worse when voices share a timbre, and an agent population blows
through that limit by design.

So the population renders as **one harmonic object** instead: seven piano voices sharing a
timbre, onset grid, and voice-led motion, withholding every cue that would let you pull them
apart, fusing into a single chord. A solo line and walking bass sit outside that mass as the two
segregable exceptions. Perceptual load: roughly three objects, not nine.

What you monitor is that one texture; the oversight signals are properties *of it*:

| You hear | It means |
|---|---|
| The chord thickens or thins | Agents becoming live / completing / going dark |
| Tempo rises and falls | Span throughput *(Python engine; the browser demo runs at a fixed tempo)* |
| A voice slides off the shared attack | An agent diverging from its mandate |
| Voices that should be independent lock in unison | Candidate collusion signature |
| A wrong note enters, out of key | A poisoned spawn |
| A voice drops out mid-phrase | Silent failure or stall |

### 2. Voices that don't know about each other sound like a mistake, not a chord

The first implementation hashed each span independently to a pitch in the current mode: every
note individually defensible, the result unlistenable, five soloists in the same key rather than
five-part writing, no harmonic relationship between them. It read as noise.

The fix moved pitch from a per-span decision to a per-chord one: **one shared seven-voice voicing
is computed at each chord change** and held, voice-led as a group, range-constrained, never
crossing, with a parallel-fifth-and-octave avoidance pass. A span now just re-articulates the
tone its voice already holds; rhythm and dynamics stay per-span, fully telemetry-driven. Verified
across a 20-chord synthetic walk and a full demo run: zero voice crossings, down from roughly a
third of all steps.

### 3. Telemetry must not touch harmony

An early version drew chord changes from each telemetry window, so different activity produced
different roots: harmonically incoherent, and worse, indistinguishable from noise, since with the
form moving too there was nothing to hear the dynamics against.

Now the harmonic form is fixed once per session and tiled. **Telemetry drives dynamics only**:
tempo, thickness, articulation density, anomaly signals. Form isn't an oversight channel, it's
the grammar that makes the other channels legible, the single most important rule in the
codebase, and why the telemetry stays decodable instead of smearing into general musical
activity.

### 4. A melody can walk into the ceiling and stay there

After the structural work landed, the output was still bad, and the cause wasn't structural: the
solo line's contour walk had no mean reversion, drifted upward, hit MIDI note 127, and the clamp
pinned it there permanently, since the clamped value fed back in as the next step's anchor.
Measured on a 115-second run: **70% of melody notes sat in [120, 127]**, effectively one repeated
pitch for a hundred seconds, on the loudest, highest voice in the mix.

Fixed with a bounded, reflecting walk plus an octave-fold safety net. Recorded here because it's
the most useful kind of bug: the architecture was right, and one missing constraint in a random
walk made all of it sound broken.

### 5. Drift had to attack the cue that fusion depends on

Goal-drift was originally a pitch bend, the drifting voice slowly flattening: wrong cue, since
the design deliberately withholds pitch-based segregation cues so the seven voices fuse. A bend
fights the architecture.

The signature is now an **onset lag**: the drifting voice's attack ramps up to 45 ms late while
the other six stay locked to the shared grid, an onset-grid violation that attacks fusion
directly. The bend still fires, demoted to a secondary micro-cue.

45 ms was set by ear during development, not derived from a published threshold: none transfers
cleanly, since this is a deliberate departure from a machine-precise baseline rather than one
voice among natural ensemble jitter. Whether it's noticeable is an open question, stated as one.

---

## Where the harmony comes from

Nothing about the harmonic language is invented. It's mined from the
[Weimar Jazz Database](https://jazzomat.hfm-weimar.de/): transcribed solos from Parker, Coltrane,
Davis, Rollins and seventy others. **456 solos, 406 used after filtering, 74 performers.**

The model is a root-transition matrix plus a chord-quality distribution per root, checked against
theory rather than assumed, and it recovers textbook practice on its own:

- The three strongest transitions chain into **vi-ii-V-I**, the standard turnaround.
- From the dominant, the next root is the tonic **81%** of the time.
- The chord on the second degree is minor **70%** of the time; on the fifth degree it's a
  dominant seventh **83%** of the time. That's ii-V, recovered from data.

The browser port fetches and uses **the same mined file** as the Python engine, not a
reimplemented approximation.

---

## What this establishes, and what it does not

The prototype establishes **mapping fidelity**: musical output measurably structured by the
telemetry driving it. Across a run's phases, tempo returns to its opening value while ensemble
thickness doesn't, two telemetry-driven channels dissociating rather than moving together, in
three of four checked seeds. A property of the Python engine, which has both channels.

It does **not** establish that a listener can decode any of it: no listening study has been run.
Everything above is a design argument from the perceptual literature plus measurements of the
mapping's own behavior, kept explicit rather than left for the prototype's existence to imply. A
controlled study is the obvious next step, not a claim made here.

By default, the demo's telemetry is a **synthetic swarm generated in your browser**. That's what
oteljazz.com plays for every visitor who just presses play. Real capture also exists: a Claude
Code hook writing real `gen_ai.*` spans, and an OTLP receiver that accepts live protobuf on :4318
for the Python engine's MIDI output. Point your own OTLP exporter at
`oteljazz.com/live/<session>/v1/traces` and open `oteljazz.com/?live=<session>` to hear the
browser demo itself driven by that same real data, chorale voicing and anomaly detection included,
not just the terminal echoing span text. No listener discovery, no auth beyond the session id
itself being a shared secret (`src/live-relay.js`); only an agent literally named `orchestrator`
gets the fixed lead voice, everything else pools onto the worker voices like a synthetic subagent
would (`web/director.js`'s `feedSpan`).

---

## Run it

```bash
cd web && python3 -m http.server 8000
# open http://localhost:8000/demo.html and press play
```

Must be served over HTTP: the corpus model and audio samples are fetched, and `fetch()` is
blocked under `file://`.

For the Python engine (MIDI into Logic Pro X), the mock pipeline, the live OTLP receiver, and
real-trace capture, see **[`docs/README.md`](docs/README.md)**. The design itself is written up
in **[`docs/CONCEPTS.md`](docs/CONCEPTS.md)**.

## Layout

```
engine/   the Python engine (caidence.py and its deps)
web/      the browser port + audio samples
docs/     orientation and the design writeup
src/      the Cloudflare Worker serving oteljazz.com
supplementary_audio/   five rendered examples
zenodo_deposit/        the data deposit contents
```

## License

The code in this repository (the Python engine, the browser port, and the Worker) is MIT
licensed; see [`LICENSE`](LICENSE).

That covers the code and **not** the bundled third-party material, which keeps its own terms and
is not relicensed by it:

- `web/samples/salamander_piano/`: CC BY 3.0
- `web/samples/pizz_bass/`: University of Iowa MIS terms
- `engine/corpus_model_jazz.json`, `web/corpus_model_jazz.json`: derived from an ODbL database
  and therefore **ODbL**, including its share-alike condition. A further derivative of this
  model carries the same obligation.

## Attribution

These are license conditions, not courtesies. Anything reusing the audio or the harmonic model
carries them:

- Piano: [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander
  Holm. CC BY 3.0
- Bass: [University of Iowa Musical Instrument Samples](https://theremin.music.uiowa.edu/),
  Lawrence Fritts
- Harmony: [Weimar Jazz Database](https://jazzomat.hfm-weimar.de/), Jazzomat Research Project.
  ODbL
