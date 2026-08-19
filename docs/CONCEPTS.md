# cAIdence: design concepts

This document exists for the parallel academic-paper session (Blue Sky paper idea) as much as for
future engineering sessions here. It explains the *approach*, not the *code* -- for code detail,
read `caidence.py` itself; for what was tried and rejected, read `BUILD_NOTES.md`. This is the
"why it's built this way" layer between the two: the design decisions that would otherwise have
to be re-derived by reading commits, and that the paper needs stated plainly to argue for the
mapping's validity.

Written for: someone drafting the methods/design section of the paper, who needs to understand
the actual engineering choices behind "sonifying multi-agent AI coordination for oversight" well
enough to defend them, not just describe the output.

**Musical idiom**: the engine is jazz, end to end -- an 8-track all-piano ensemble over
seventh-chord harmony mined from real jazz standards. An earlier version used Romantic-era
Lieder and common-practice triadic harmony; that model is fully retired, not a supported
alternative, so anything describing the mapping in terms of diatonic scale degrees or Roman
numerals is out of date. What did NOT change in that transition is everything in Sections 1-6
below except the specific harmonic vocabulary: the two-tier signal design, the
telemetry-vs-corpus separation, the anomaly signatures, and the mode-shift decoupling are all
idiom-independent by construction, which is itself worth stating in the paper -- the approach
isn't specific to one musical style.

---

## 1. The gap being defended: perception, not capture

The premise of this whole project is NOT "telemetry contains signals humans currently miss." OTel
traces already capture drift, conflict, tool errors, and collusion-shaped behavior if you go
looking -- dashboards, alerting rules, and post-hoc analysis all already do this. What they don't
do is let a human *notice* an emerging pattern while it's still forming, without staring at a
screen. Vision (a dashboard) demands foreground attention. Hearing is a background sense: you can
process an unfolding pattern while doing something else, the way an experienced driver notices an
engine's pitch change without looking at a tachometer.

So the paper's claim is about **perceptual bandwidth for background monitoring**, not about
detection capability that doesn't already exist elsewhere. Every design decision below follows
from taking that claim seriously: a sonification that requires the listener's full foreground
attention to parse (constant harmonic ambiguity, no consistent voice-to-role mapping, arbitrary
pitch choices) would fail on its own terms even if it were technically accurate.

## 2. Two-tier signal design: DIRECT vs. DERIVED

The mapping spec (`08-sonification-mapping-spec.md`) splits telemetry into two tiers, and the
engine's architecture mirrors that split exactly:

- **DIRECT tier**: structure and activity read straight off a span with no inference --
  which agent, what operation, how many tokens, how long it took, whether it errored. This is
  `emit_span_events()`, the one function that turns a span into notes. It doesn't need to know
  anything about the piece's history to do its job; it's a pure function of the span plus the
  currently-active chord/mode/section context.
- **DERIVED tier**: patterns that only exist across multiple spans or a whole trace -- goal
  drift, a capture spike after external ingestion, conflict escalating into convergence,
  collusion between voices that shouldn't be coordinating. These require state or a detection
  window; in the current engine they're SCRIPTED (explicit flags on hand-authored spans:
  `drift_start`, `capture_spike`, `conflict_start`, `collusion_start`), not derived from real
  telemetry. Building real-time derived-signal detection (the embedding-based or statistical
  detectors that would replace the scripted flags) is future work, explicitly deferred as the
  spec's own "ambitious tier" (Section 9).

This split matters for the paper because it's honest about what's proven and what's aspirational:
the DIRECT tier is a working, real-time-capable mapping today (see `live.py`); the DERIVED tier
is currently a demonstration of what the *finished instrument* should sound like once real
detectors exist, not a claim that detection itself is solved.

## 3. Dynamics are telemetry-driven; harmony is corpus-driven and chord-level, never per-span

Every note in the DIRECT tier has two independent decisions behind it:

- **WHICH note** (pitch, chord tone, voice-leading, cadence shape, inversion): the chord itself
  comes from a fixed repeating FORM generated once per piece (see Section 3a), and
  `jazz_chorale_voicing()` decides how that chord is spread across the 7 chord voices. This governs
  what's *stylistically plausible* -- the layer that makes the piece sound like music instead of
  a sequence of correct-but-arbitrary beeps. Critically, pitch is decided ONCE PER CHORD CHANGE,
  not once per span: `jazz_chorale_voicing()` computes a single shared voicing for all 7 voices
  together (voice-led as a group, register-constrained, non-crossing, doubling chosen
  deliberately, parallel fifths/octaves corrected), and every span for a given voice simply
  re-articulates that voice's currently-assigned tone. This replaced an earlier per-span design
  (each span independently hashing its own chord tone) that sounded like "randomized notes that
  splatter" -- voices picking pitches with zero knowledge of each other produced constant
  unintended doublings and crossed voices even though every individual pitch was harmonically
  correct.

  A second split lives inside this one, and is worth keeping straight: mined corpus statistics
  and music-theoretic spelling are different kinds of knowledge, and are deliberately kept in
  separate places. The corpus decides which *cell* (ii-V, iii-VI7, tritone sub, ...) follows
  which, scored by real root-motion statistics; hand-authored tables decide what a cell and a
  quality actually spell (`JAZZ_CELLS`, `JAZZ_CHORD_TONES` -- a dominant is 1-3-5-b7-9-13, a ii
  is min7). Collapsing them into one source would either make the corpus decorative or make the
  theory unfalsifiable.

## 3a. The form: fixed changes, varied treatment

The single most important structural fact about the engine: **the harmony is a fixed, repeating
form, and telemetry never changes it.** One chorus of changes (16 bars) is generated per piece,
opening on the tonic and closing on a ii-V turnaround that resolves back to the top, then tiled
across the whole piece. Telemetry varies the *treatment* of those changes -- voicing and
inversion, which voices articulate and when, the solo's note density -- but never which chord is
sounding.

This was not the original design, and the reason it changed is worth recording because it is the
clearest empirical lesson the project has produced. An earlier version drew each chord's quality
independently from the corpus's mined per-root distribution. Every individual draw was
corpus-faithful, and the result was unlistenable: the tonic came out major, then dominant, then
minor within a single piece, so no key was ever established, and because nothing repeated there
was no theme either. Statistical fidelity to a corpus at the level of individual events does not
produce music; a listener needs a stable referent to hear deviation *from*.

That has a direct methodological consequence for the paper, beyond aesthetics. The whole premise
(Section 1) is that a listener can notice an anomaly in the background without foreground
attention. That only works if the healthy baseline is *predictable* -- if the listener has
internalized "this is what the system sounds like when it's fine." A through-composed,
never-repeating harmony gives them nothing to internalize, so every moment is equally novel and
an anomaly has no relief against which to register. The repeating form is what makes the baseline
learnable, and therefore what makes deviation perceptible. Fixed changes are a perceptual
requirement, not a stylistic preference.
- **HOW LOUD, HOW LONG, HOW OFTEN** (velocity, duration, note density, tempo): computed directly
  from telemetry (`tokens_to_velocity`, `latency_to_duration`, span timing itself, per-section
  tempo, and the solo line's activity-driven note density). This is the layer that actually
  carries information about system state, and it's still entirely per-span for the chord voices
  -- a span's own duration/velocity/onset never moved to the chord level, only its PITCH did.

The reason dynamics and harmony must never cross is the paper's core validity argument: if the
corpus model were allowed to influence *dynamics* (e.g. a "more dramatic" composer style making
bursts louder regardless of actual token throughput), a listener's inference from loudness back
to system state would be corrupted by stylistic noise. The listener needs "louder means more
tokens," full stop, with no exceptions the corpus might introduce. Symmetrically, if telemetry
were allowed to influence *harmony* at the per-span level (e.g. an error literally changing which
scale degree the piece uses, rather than adding a grace note on top of the otherwise-unbroken
progression), the piece would lose its stylistic coherence every time something interesting
happened -- exactly backwards, since interesting-to-a-human moments are also the moments where
you most need the underlying music to stay legible as music.

Two narrow, deliberate exceptions, both COARSE and chord-level rather than per-span:
`_bass_tone_index()` picks which chord tone the bass voice carries (i.e. the inversion) from
`activity_level` -- the count of distinct agents active in the current chord window; and the solo
line's note density and arpeggio-run probability scale with that same signal (busy swarm = long
flurries, quiet swarm = minimalist). Both are intentional and scoped (see Section 7): they use
how MANY agents are active, not which one or what it did, and they shape harmonic stability and
textural density rather than any individual pitch. The rule that per-span telemetry never touches
pitch is intact; what these add is that aggregate, chord-window-level activity shapes the
harmony's inversion and the solo's busyness -- the "agent ecosystem drives chord choices...and
inversions" design the project is deliberately building toward (see Section 9's open question
about extending this further).

## 4. Consonance is the default; dissonance is a reserved budget

The healthy baseline -- no drift, no conflict, no errors -- is deliberately consonant *in the
jazz sense*: every voice on a real chord tone of the current 7th chord (extensions and all), a
corpus-plausible progression, coordinated voice-leading. Note that "consonant" here includes
sonorities common-practice tonality would call dissonant -- a b7 or a 9th is a stable, expected
color in this idiom, not tension needing resolution. Dissonance in the *signal* sense (chromatic
clusters landing off every chord tone, static sharp pitch-bends, forced unisons) is spent ONLY on
anomaly signatures, and is computed relative to the current chord's own tones rather than a fixed
diatonic scale -- there isn't one fixed scale over a chromatically-moving jazz progression the
way there is in common-practice tonality. This is what makes
the anomalies audible as anomalies: a listener's ear calibrates to "the healthy state sounds like
this," and every anomaly signature is defined as a specific, distinct departure from that
baseline (see Section 5 below), not just "more dissonant in general." A system that was
dissonant all the time would have nothing to depart FROM.

## 5. Five anomaly signatures, and why each is spectrally/temporally distinct from the others

If two different failure modes produced acoustically similar signatures, a listener couldn't
distinguish them by ear -- which would defeat the point (the paper's claim isn't just "you can
hear that something is wrong," it's "you can hear roughly WHAT is wrong"). Each signature was
designed to be distinct along a different axis:

- **Goal drift**: a slow, continuous pitch-bend ramp on the target voice, held sour once it
  arrives. Axis: gradual + continuous + never resolves.
- **Capture spike**: a sharp, discrete chromatic cluster landing exactly at an external-ingestion
  point. Axis: sudden + discrete + correlated with a specific triggering event.
- **Conflict -> convergence**: a static (not ramping) sharp bend held for a window, then an
  explicit two-voice cadential resolution. Axis: static + resolves (unlike drift, which doesn't).
- **Collusion**: two normally-independent voices forced into an unexpected tight unison,
  overriding their own per-agent pitches. Axis: identity change (two voices become one), not a
  pitch distortion at all.
- **Tool error**: a single dissonant grace note computed relative to the erroring voice's own
  just-played pitch (not a fixed absolute pitch, which could be an unnaturally huge leap for a
  low voice or accidentally land back on a chord tone for another). Axis: instantaneous,
  voice-local, no duration.

## 6. Mode-shift recolors the same tune; it never substitutes a different one

The engine can render the piece in either major or minor (`regime_schedule`), but both are
realizations of the SAME form. The cell vocabulary (`JAZZ_CELLS`) defines major and minor entries
as index-aligned functional analogues, and a form is generated as a sequence of cell *indices* --
so the major and minor realizations share their functional progression bar for bar, and mostly
their roots too. A mode shift is therefore modal interchange: the same tune, recolored, still
recognizable as itself. It never swaps in different changes.

This is a deliberate methodological choice for the paper's eventual detectability study (spec
Section 5.2): if mode-shift also changed which chords appear, then in a minor-mode window an
anomaly's detectability couldn't be cleanly separated from "the listener also just noticed the
piece went to minor." Keeping the progression fixed means a mode change and an anomaly signature
are independent variables, not confounded ones -- important for any experiment that wants to
claim "listeners detected X specifically because of the anomaly," not "because everything sounded
different around then for several possible reasons at once." It also preserves the property
Section 3a argues is load-bearing: the listener's learned baseline survives the mode shift,
because it is still the same tune.

This is also why `synthetic_trace()` (the calibration-shaped ~30s path) never uses
`regime_schedule` at all -- it stays major throughout, by design, so it's a clean baseline
uncontaminated by any mode variable.

## 7. Sections as the arrangement layer: tempo and texture over fixed changes

`sections` (see `BUILD_NOTES.md` for the build log) treats a piece as a sequence of movements.
Since the form (Section 3a) supplies the harmony and its own cadence every chorus, sections
deliberately do NOT touch the changes -- they are purely the arrangement layer, which is exactly
the head/solos/out-head structure of a real chart: same tune throughout, different treatment.
Each section independently defines:

- **Tempo**: computed once per section (not continuously ramped -- a continuously moving tempo
  would shift the 16th-note grid under events already scheduled against the old grid). This is
  the layer that will eventually connect to real activity density once live sections exist:
  faster tempo during high span-rate stretches, slower during quiet ones. Note that tempo changes
  a bar's wall-clock length, so a chorus takes longer in a slow section -- the form index is the
  absolute bar count and never resets at a boundary, or choruses would be truncated mid-form and
  the recurrence would never register.
- **Texture (voice count)**: which agent voices are audible contracts and expands per section,
  down to just the two harmonic-rhythm voices (`ARCH_VOICES`, which are never section-gated) at
  the sparsest point, so the harmony always keeps a pulse. This is the layer with the
  most direct mapping to a real swarm's shape: fewer simultaneously active agents should sound
  like fewer simultaneously active voices, not like the full ensemble playing quietly.

Note that texture is *already* partly telemetry-driven and not only a section-table setting: a
chord voice joins the sustained comp only if its agent emitted a span recently, so the thickness
of the chord tracks how many agents are alive independently of the arrangement. A stalled agent's
tone disappears from a chord the listener is already hearing -- a more legible signal than the
absence of intermittent notes, because the reference is continuously present. The remaining
planned work (Section 9) is to let that same signal drive the section-level decisions too, so
"how full does the ensemble sound" is entirely a read off real swarm state rather than partly a
scripted demo arc.

**A design constraint worth stating explicitly**, because it was learned the expensive way: a
chord must be *spelled by whatever is actually sounding*, not by the full ensemble nominally.
Handing each of seven voices a different tone looks like good voicing until voices start dropping
out, at which point the survivors can be root/5th/9th/13th -- every note correct, no chord. Tones
are therefore handed out in priority order (bass tone, then the guide tones that define the
quality, then root and 5th, then extensions) to the voices that will be heard. This is the same
class of lesson as Section 3a: a mapping that is locally correct at every event can still fail to
communicate the thing it is supposed to communicate.

## 8. From live OTel to compositional decisions: the actual pipeline

This is the part most directly relevant to a paper methods section describing "how telemetry
becomes music," end to end, as it exists today (`live.py`):

1. An OTel SDK exports a span over OTLP/HTTP. Verified empirically (not assumed) that the
   default wire encoding is `application/x-protobuf`; decoded via `opentelemetry-proto`'s
   `ExportTraceServiceRequest`. Protobuf's `start_time_unix_nano`/`end_time_unix_nano` decode as
   plain Python ints (unlike OTLP/JSON, where the same fields arrive as strings).
2. `span_to_dict()` converts the decoded span into the engine's internal representation, anchoring
   the FIRST span's start as t=0 so all downstream timing math (built for a batch trace starting
   at zero) works unchanged for a live stream.
3. A single player thread (mido/MIDI ports aren't thread-safe) owns a `heapq` of due events.
   Receiver HTTP threads only ever touch a thread-safe `queue.Queue`; nothing else touches the
   heap or the MIDI port.
4. `emit_span_events()` -- the SAME function called by the batch path's precomputed timeline --
   converts the span into notes. This identity is a hard invariant, enforced by there being
   exactly one implementation: the batch and live paths must never be able to drift into mapping
   the same telemetry to different instruments, which would silently invalidate any claim that
   what a listener hears in a live session matches what was validated in the batch/study context.
   The span's PITCH comes from a `voicing` dict passed in (see below); everything else (velocity,
   duration, onset, tool-error/capture-spike signatures) is computed from the span itself,
   exactly as in Section 3.
5. A `LazyChordSchedule` extends the harmonic backbone incrementally as real time passes, using
   the identical seeded Markov-walk logic as the batch path's `generate_chord_schedule` -- a
   given seed produces the identical progression whether computed all at once or step-by-step
   live. In lockstep with it, `LivePlayer` advances a shared `jazz_chorale_voicing()` (Section 3)
   at every chord boundary the schedule reaches -- the same coordinated 7-voice voicing function
   the batch path uses, not a second implementation -- and articulates the two harmonic-rhythm
   voices on each new chord. Its one necessary difference from batch: the inversion-driving
   `activity_level` signal (Section 3's exception) can't look ahead into future spans live the
   way batch's window-based count can, so live substitutes a real-time proxy -- how many distinct
   agents have been seen in the last several seconds of wall-clock time.

What live mode does NOT yet do (honest gaps, not hidden ones): no solo melody line (the batch
melody generator assumes a known total piece length, which a live stream doesn't have) -- and
since the solo line is where activity-driven note density lives, live mode currently has no
density response either; no sections (fixed tempo, full ensemble always, no cadential
boundaries); always major; and no derived-tier anomaly detection (all five anomaly signatures
are currently scripted flags on hand-authored spans, not detected from real telemetry -- see
Section 2).

## 9. Open design question the paper should probably engage with directly

**Fixed vs. adaptive structure.** Every structural decision in the engine right now (movement
boundaries, tempo per section, when a cadence happens) is either fully scripted (`--demo`) or
fully absent (`live.py`). The next planned engineering step (see `BUILD_NOTES.md` "Open work")
is to derive these from real swarm shape instead: simultaneous active-agent count driving
ensemble size (one agent = solo piano, full swarm = full ensemble), subagent-spawn bursts as
high-intensity/fast sections, sequential/decomposed execution as low-intensity/slow sections, and
`stop_reason` values driving movement boundaries -- on a sliding scale reacting to actual
telemetry shape, not a fixed count of movements decided in advance. This is a genuinely open
design question, not yet decided: a sliding-scale/continuous version keeps the piece responsive
to whatever the swarm is actually doing, but continuous structural change is harder to make
perceptually legible than a small number of clearly-differentiated states (see Section 4's point
about anomalies needing a stable baseline to depart from -- the same tension applies to movement
boundaries: too much continuous change and there's no baseline "movement" to notice a boundary
crossing FROM). Worth stating explicitly in the paper as a tradeoff rather than resolving it
silently in the implementation.
