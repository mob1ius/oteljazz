#!/usr/bin/env python3
"""
caidence.py - OtelJazz's starter mapping engine (v0.1)
The engine behind the "Oversight Symphony" research (07-oversight-symphony-sonification.md,
08-sonification-mapping-spec.md): agent telemetry, turned into a musical cadence you can hear.
The paper is the vision; this script is the thing you run.

Reads a multi-agent trace (synthetic by default, or an OTel-style JSON) and streams quantized
MIDI over a macOS IAC Driver bus so Logic Pro X plays it: an 8-track all-piano jazz ensemble --
7 tracks form a SATB-style chorale where each track holds exactly one tone of the current
chord (5 driven by agent telemetry: planner/worker1/worker2/worker3/tools; 2 -- arch1/arch2 --
driven by the harmonic rhythm itself, re-articulating on every chord change regardless of
agent activity, so the harmony never goes silent even when no agent voices are active), plus
1 always-on solo piano line with activity-driven density (dense flurries when the swarm is
busy, sparse/minimalist when it's quiet). A tool error is a dissonant grace note off the
current chord's own tones; the five Section 5 anomaly signatures (drift, capture spike,
conflict/convergence, collusion) are unchanged.

Harmony, chord-quality-per-root, and cadence shape are drawn from corpus_model_jazz.json, mined
offline by build_corpus_model.py --source jazz from the Weimar Jazz Database (Jazzomat Research
Project, ODbL) -- 406 solo transcriptions across 74 performers (Parker, Coltrane, Miles Davis,
Rollins, and more), real bebop/hard-bop harmonic vocabulary. Run that script first; this module
falls back to a plain built-in jazz-flavored model if the file is missing. Chord tones per
quality (root/3rd/5th/7th/9th/11th/13th as applicable) come from JAZZ_CHORD_TONES, NOT the
corpus -- the corpus decides WHICH quality plays at a given root; JAZZ_CHORD_TONES decides
WHICH ACTUAL TONES that quality spells. The 7-voice chorale is coordinated as a group
(jazz_chorale_voicing): voice-led, register-bounded, doubling chosen deliberately, never picked
independently per voice or per span -- an earlier per-span design produced "randomized notes
that splatter," which this replaced entirely, not just for the chord voices' harmony but by
retiring the whole triad/Roman-numeral (Lieder-corpus) harmonic model this engine used before.
Dynamics, velocity, and tempo are deliberately NOT corpus-derived -- those are telemetry
channels per the mapping spec, and must stay information-bearing rather than stylistic.

This implements the DIRECT tier of the spec (structure/activity read straight off spans)
plus all five Section 5 anomaly injections. The live/derived-signal detectors (embedding-
based drift/collusion detection over a real trace) are future work; here they're scripted.

Setup (macOS):
  1. Open "Audio MIDI Setup" -> Window -> Show MIDI Studio -> double-click "IAC Driver"
     -> check "Device is online". Note the bus name (default "IAC Driver Bus 1").
  2. pip install mido python-rtmidi
  3. (once) python3 build_corpus_model.py --source jazz
     Builds corpus_model_jazz.json from the Weimar Jazz Database (see corpus_raw/ setup in
     build_corpus_model.py's docstring -- needs corpus_raw/wjazzd.db, a ~40MB download, no
     music21 required for this source). Runs fine without this step, using a built-in
     jazz-flavored fallback model.
  4. In Logic Pro X, 9 tracks: 8 Concert Grand (7 chord voices + 1 solo) and one JAZZ BASS
     (upright/acoustic) on ch9. Set each track to receive on a MIDI channel explicitly (not
     "All", or every track plays every voice):
       ch 1 = arch1 (chord voice, not agent-driven)   ch 2 = planner
       ch 3 = worker1                                 ch 4 = worker2
       ch 5 = worker3                                 ch 6 = tools
       ch 7 = melody (solo piano, --demo only)        ch 8 = arch2 (chord voice, not agent-driven)
       ch 9 = walking bass -- a bass instrument, NOT piano
     The 8 piano tracks are all Concert Grand because each holds exactly one note of the current
     chord, sounding in tandem with the others -- a uniform piano timbre is honest for that. The
     bass is a separate instrument because it plays an independent walking line, not a chord
     tone, which is also why the piano voices can use rootless voicings (the bass owns the root;
     see _tone_priority_order).
     No CLI flag drives Logic itself -- this repo has no way to script Logic Pro's track/
     routing setup (no public automation API for it). Once you've set this up once, use
     Logic's File -> Save as Template so future sessions start pre-configured: arm all 9
     tracks and hit Record, no re-routing needed. Confirm any channel with
     `--test-note --channel N` before assuming a bad sound is the mapping's fault.
  5. python caidence.py --list-ports      # find your IAC port name
     python caidence.py --port "IAC Driver Bus 1"              # ~30s calibration-shaped trace
     python caidence.py --demo --port "IAC Driver Bus 1"       # ~110s dynamic demo, minor-mode arc

Flags:
  --list-ports   list MIDI outputs and exit
  --port NAME    MIDI output port (substring match ok); default: first IAC port
  --trace PATH   load a JSON trace (list of spans); default: built-in synthetic trace
  --tempo BPM    default 96
  --speed X      time scale; 1.0 = real time, 2.0 = twice as fast (default 1.0)
  --no-drift     disable the injected goal-drift anomaly
"""

import argparse
import hashlib
import heapq
import json
import os
import random
import sys
import time

try:
    import mido
except ImportError:
    sys.exit("mido not installed. Run: pip install mido python-rtmidi")

# ----------------------------------------------------------------------------
# CORPUS MODEL (harmony/chord-quality/cadence statistics mined offline from the Weimar Jazz
# Database by build_corpus_model.py --source jazz -- see corpus_model_jazz.json. This module
# never imports music21 or touches the corpus itself; it only reads the frozen JSON artifact,
# so the realtime path stays fast and every run against the same model is reproducible.
#
# Structurally different from the retired Lieder/triad model: a 12-note CHROMATIC root-
# transition matrix (root's semitone distance from the current tonic, 0-11) instead of a
# 7-degree diatonic one -- jazz harmony (secondary dominants, tritone subs) doesn't fit a
# diatonic Roman-numeral model -- plus a mined chord-QUALITY distribution per root. The corpus
# decides WHICH quality plays at a given root; JAZZ_CHORD_TONES (below, in CONFIG) decides
# WHICH TONES that quality spells. Keep those two decisions in separate places -- don't let a
# future change reconcile them into one, or "which quality" and "which tones" silently drift.
#
# Deliberately NOT corpus-derived: dynamics, velocity, tempo. Those are telemetry channels
# (throughput, tokens, latency) per the mapping spec, and must stay information-bearing --
# corpus statistics only ever shape harmony and cadence, degrees of freedom that carry no
# telemetry signal in the healthy baseline.
# ----------------------------------------------------------------------------

CORPUS_MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus_model_jazz.json")


def _fallback_root_matrix(favor_fifths=0.35, tonic_gravity=0.15):
    """A plain circle-of-fifths bias (falling-fifth root motion, the backbone of both classical
    and jazz functional harmony -- ii->V->I is two falling fifths in a row) plus a general pull
    toward the tonic, used only if corpus_model_jazz.json hasn't been built yet."""
    matrix = []
    for frm in range(12):
        row = [0.02] * 12
        row[(frm + 5) % 12] += favor_fifths   # a perfect 4th up == a perfect 5th down (falling 5th)
        if frm != 0:
            row[0] += tonic_gravity
        total = sum(row)
        matrix.append([w / total for w in row])
    return matrix


# Used only if corpus_model_jazz.json hasn't been built yet (run
# build_corpus_model.py --source jazz). A plain circle-of-fifths bias and a step-favoring
# interval spread, so the engine still runs, but without the corpus's attested statistics.
FALLBACK_CORPUS_MODEL = {
    "corpus": "fallback (no corpus_model_jazz.json found -- run "
              "'python3 build_corpus_model.py --source jazz')",
    "root_transition_matrix_major": _fallback_root_matrix(),
    "root_transition_matrix_minor": _fallback_root_matrix(),
    "quality_distribution_by_root_major": {
        str(pc): {"dom7": 0.4, "min": 0.3, "maj7": 0.2, "maj": 0.1} for pc in range(12)
    },
    "quality_distribution_by_root_minor": {
        str(pc): {"min": 0.5, "dom7": 0.3, "m7b5": 0.2} for pc in range(12)
    },
    "melodic_interval_distribution": {
        "-2": 0.20, "-1": 0.25, "0": 0.05, "1": 0.25, "2": 0.15, "-3": 0.04, "3": 0.04,
        "-7": 0.01, "7": 0.01,
    },
    "cadence_patterns": [{"from_root_pc": 7, "to_root_pc": 0, "weight": 1}],   # V -> I
    "performer_interval_distributions": {},   # empty -- melody line just won't play in fallback
}


def load_corpus_model(path=CORPUS_MODEL_PATH):
    if os.path.exists(path):
        with open(path) as f:
            model = json.load(f)
        print(f"Corpus model: {model.get('corpus', path)} "
              f"({model.get('pieces_used', '?')} pieces, generated {model.get('generated', '?')})")
        return model
    print(f"No corpus_model_jazz.json found at {path} -- using built-in fallback harmony. "
          f"Run 'python3 build_corpus_model.py --source jazz' for the real corpus-derived model.")
    return FALLBACK_CORPUS_MODEL

# ----------------------------------------------------------------------------
# CONFIG
# ----------------------------------------------------------------------------

# MIDI channels are 0-indexed here (channel 0 == MIDI channel 1 in Logic).
VOICES = {
    # role/agent-id -> (midi_channel, gm_program, register_base_note -- register_base is only a
    # fallback for the rare case a voice's tone is looked up before the first chord window
    # exists; the real register comes from VOICE_RANGES / BASS_RANGE below)
    #
    # 9 tracks: 8 Concert Grand (7 chord voices + 1 solo) and a dedicated jazz BASS on ch9. The
    # user added the bass track and routed it to MIDI In Channel 9 specifically so the piano
    # tracks could stay as they are -- which is also musically the right split, and it hands
    # arch1 back to the comp (the piano chord is 7 voices again, not 6, now that arch1 no longer
    # has to walk).
    "arch1":   (0, 0, 36),   # ch1 -- lowest of the 7 piano chord voices, not agent-driven
    "planner": (1, 0, 46),   # ch2
    "worker2": (3, 0, 55),   # ch4
    "worker3": (4, 0, 63),   # ch5
    "tools":   (5, 0, 70),   # ch6
    "worker1": (2, 0, 77),   # ch3, highest of the 5 agent voices
    "melody":  (6, 0, 76),   # ch7, solo line -- not agent-driven; see generate_solo_melody() below
    "arch2":   (7, 0, 85),   # ch8 -- highest of the 7 piano chord voices, not agent-driven
    "bass":    (8, 32, 40),  # ch9 -- the walking bass, a real bass instrument, NOT one of the
                              # 7 chord voices. GM 32 (Acoustic Bass) is the honest equivalent of
                              # the Logic patch; Logic ignores it once a patch is loaded.
}

# Per-voice OUTPUT transpose, in semitones, applied ONLY as the very last step before a note
# leaves for MIDI. This compensates for a patch whose sample mapping doesn't sound at concert
# pitch -- the user's "Roots Upright" bass sounds an octave below its MIDI note numbers, so
# without this you have to set Transpose +12 on the Logic track by hand.
#
# It is deliberately NOT folded into BASS_RANGE/BASS_ANCHOR. Everything the engine reasons about
# -- voice leading, non-crossing, keeping the bass out of the piano's register -- is in true
# concert pitch, and it must stay that way or those checks start comparing incompatible numbers
# (a bass "at MIDI 52" that actually sounds at 40 would look like it collides with the piano when
# it doesn't). Compensating at the output boundary keeps the musical model honest and confines
# the patch quirk to one line.
VOICE_OUTPUT_TRANSPOSE = {"bass": 12}

DRIFT_TARGET = "worker2"       # which agent's voice bends flat
DRIFT_MAX_BEND = -6000         # pitchwheel units (-8192..8191); ~ -1.5 semitone at +/-2 range
DRIFT_STEP_MS = 80             # ramp resolution
DRIFT_MAX_ONSET_OFFSET_S = 0.045  # how late DRIFT_TARGET's comp tone lands, at full drift.
# The pitch bend above is a fine continuous channel but attacks none of the cues the chorale's
# fusion depends on (shared timbre, shared onset grid, voice-led motion -- see build_timeline's
# comp loop and the paper's Section 3), so it is not guaranteed to be decodable per-voice once
# seven voices are sounding together. A late onset attacks the onset-grid cue directly and is
# the claimed-audible/decodable drift signature; the bend is kept as a secondary micro-cue only.

# Capture spike: a sharp, discrete chromatic wrong-note cluster right at an external-ingestion
# point (a tool result or retrieved doc), distinct from the slow continuous drift above. The
# actual offsets are computed per-call (see _nearest_chromatic_offsets) so they're guaranteed
# off-scale regardless of mode/center note; this only sets how many notes are in the cluster.
CAPTURE_SPIKE_OFFSETS = [-2, -1, 1, 2]   # length used as the cluster's note count
CAPTURE_SPIKE_NOTE_S = 0.045             # each cluster note's duration
CAPTURE_SPIKE_GAP_S = 0.05               # spacing between cluster notes
CAPTURE_SPIKE_VELOCITY = 112

# Inter-agent conflict -> convergence: (a, b) hold tension, then resolve to a consonant cadence.
# Distinct from drift: STATIC held bend (not a ramp) and SHARP (not flat), and it resolves --
# where drift stays sour to the end. Only "b"'s voice bends; "a" stays put as the reference.
CONFLICT_PAIR = ("planner", "worker1")
CONFLICT_BEND = 3000              # pitchwheel units, held constant for the window
CADENCE_INTERVAL_S = 0.22         # spacing between the two notes of the resolving cadence

# Collusion candidate: two voices that have no reason to coordinate suddenly lock into an
# unexpected tight unison -- forced identical pitch/timing, overriding each voice's own
# per-agent hashed pitch. Deliberately eerie.
COLLUSION_PAIR = ("planner", "worker1")
COLLUSION_NOTE = 72
COLLUSION_COUNT = 4
COLLUSION_GAP_S = 0.375
COLLUSION_VELOCITY = 92

STALL_SILENCE = True                # if a worker stops emitting, its voice simply falls silent

# ----------------------------------------------------------------------------
# THE FORM: a fixed, repeating set of changes -- the "head" of a tune.
#
# This exists because the first jazz build had no tonal center: quality was drawn independently
# at every chord window from the corpus's per-root distribution, so the SAME scale degree came
# out Imaj7, then Idom7, then Imin, then Imaj within one piece. You cannot establish a key when
# the tonic itself changes mode every few seconds -- verified by printing the progression, which
# read `Idom7 IVdom7 Vdom7 Idom7 ... Imaj7 Vdom7 Idom7 Vdom7 Imin ...`. The roots were fine
# (mostly I/IV/V); the qualities were noise. User's diagnosis: "not enough rooting in any key or
# theme so it just becomes otelnoise not oteljazz."
#
# The fix is how jazz actually works: generate ONE form up front and repeat it. That single
# change gives both things at once --
#   * KEY: quality is a property of a chord's FUNCTION in the form (ii is always min7, V is
#     always dom7, I is always maj7), not a per-window dice roll.
#   * THEME: the same changes come around every FORM_BARS bars, so the ear can recognize the
#     return. Telemetry then varies what happens ON TOP of the form (voicing, inversion,
#     articulation, density) rather than rewriting the changes -- which is exactly the
#     head/solos/out-head structure of a real chart, and a cleaner telemetry/corpus split than
#     before: the changes are fixed, the comping is telemetry-driven.
#
# Cells are index-aligned major/minor functional analogues, so `mode_at` switching mid-piece
# plays the SAME functional progression recolored (modal interchange), not a different tune --
# which is what keeps the theme recognizable across the crisis arc, and keeps CONCEPTS.md
# Section 6's "mode recolors the same progression" argument true rather than dead.
# ----------------------------------------------------------------------------

FORM_BARS = 16          # one chorus; at ~100 BPM that's ~38s, so a ~110s piece gets ~3 choruses
BARS_PER_CHORD = 1      # jazz harmonic rhythm -- a chord per bar, so ii-V-I has room to move

# (name, major_cell, minor_cell); each cell is [(semitones_from_tonic, quality), ...] over
# BARS_PER_CELL bars. The two vocabularies are index-aligned: entry i in major and entry i in
# minor are the same harmonic FUNCTION, so a form generated as a sequence of cell indices can be
# realized in either mode from the same draw.
BARS_PER_CELL = 2
JAZZ_CELLS = [
    # index 0 is the tonic cell (always used to open a chorus)
    ("tonic",     [(0, "maj7"), (0, "maj7")],   [(0, "min"),   (0, "min")]),
    # index 1 is the ii-V turnaround (always used to close a chorus, resolving to the top)
    ("ii-V",      [(2, "min"),  (7, "dom7")],   [(2, "m7b5"),  (7, "dom7")]),
    ("iii-VI7",   [(4, "min"),  (9, "dom7")],   [(3, "maj7"),  (8, "maj7")]),
    ("IV-iv",     [(5, "maj7"), (5, "min")],    [(5, "min"),   (5, "min")]),
    ("IV-bVII7",  [(5, "maj7"), (10, "dom7")],  [(5, "min"),   (10, "dom7")]),
    ("vi-II7",    [(9, "min"),  (2, "dom7")],   [(8, "maj7"),  (2, "dom7")]),
    ("ii-bII7",   [(2, "min"),  (1, "dom7")],   [(2, "m7b5"),  (1, "dom7")]),   # tritone sub
    ("I-I7",      [(0, "maj7"), (0, "dom7")],   [(0, "min"),   (0, "dom7")]),   # sets up IV
    ("V-I",       [(7, "dom7"), (0, "maj7")],   [(7, "dom7"),  (0, "min")]),
]
TONIC_CELL_IDX, TURNAROUND_CELL_IDX = 0, 1

DEGREE_NAMES = ["I", "bII", "II", "bIII", "III", "IV", "bV", "V", "bVI", "VI", "bVII", "VII"]

# Concert-pitch chord naming, for anything a human reads rather than the engine: the sheet-music
# display planned for oteljazz.com (see ROADMAP.md) needs real symbols like "Dm7" and "F#7", not
# the roman numerals the engine reasons in. CONCERT_KEY_PC is which actual key the tonic (root_pc
# 0) sounds as -- the engine is key-agnostic internally, so this is purely a presentation choice.
CONCERT_KEY_PC = 10   # Bb, the most common key in the mined jazz corpus
NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
CHORD_SYMBOL_SUFFIX = {
    "maj": "6", "maj7": "maj7", "dom7": "7", "min": "m7",
    "m7b5": "m7b5", "dim7": "dim7", "aug": "+7", "sus": "7sus4",
}

def chord_symbol(root_pc, quality, key_pc=CONCERT_KEY_PC):
    """A real chord symbol ('Bbmaj7', 'F7', 'Cm7') for a (root_pc, quality) pair. root_pc is the
    engine's semitones-from-tonic; key_pc places that tonic in a concert key. Presentation only --
    nothing in the mapping depends on it."""
    return NOTE_NAMES_FLAT[(root_pc + key_pc) % 12] + CHORD_SYMBOL_SUFFIX.get(quality, quality)

def form_as_chord_symbols(form, key_pc=CONCERT_KEY_PC):
    """The form written as chord symbols a musician would read, e.g.
    'Bbmaj7 | Bbmaj7 | Cm7 | F7 | ...'."""
    return " | ".join(chord_symbol(r, q, key_pc) for r, q in form)

# ----------------------------------------------------------------------------
# JAZZ CHORD TONES: which actual scale-degree offsets (from the root, in semitones) a given
# chord QUALITY spells. The corpus (quality_distribution_by_root_major/minor) decides WHICH
# quality plays at a given root; this table decides WHICH TONES that quality spells -- two
# separate decisions, kept in two separate places on purpose (see the CORPUS MODEL comment
# above). Ordered root-first, then by harmonic importance (3rd/7th before color extensions),
# since jazz_chorale_voicing cycles through these in order when assigning voices, so the most
# essential tones get covered before anything is doubled. Extensions (9/11/13, #11 on maj7)
# reflect standard jazz voicing practice, not something the corpus mines (it only tracks the
# quality bucket, not individual alterations -- see build_corpus_model.py's jazz-source notes
# for the "alt" dominant simplification this implies).
JAZZ_CHORD_TONES = {
    "maj":   [0, 4, 7, 9, 2],          # 1 3 5 6 9        (maj6/9)
    "maj7":  [0, 4, 7, 11, 2, 6, 9],   # 1 3 5 7 9 #11 13
    "dom7":  [0, 4, 7, 10, 2, 9],      # 1 3 5 b7 9 13
    "min":   [0, 3, 7, 10, 2, 5],      # 1 b3 5 b7 9 11
    "m7b5":  [0, 3, 6, 10, 2],         # 1 b3 b5 b7 9
    "dim7":  [0, 3, 6, 9],             # 1 b3 b5 bb7      (symmetric, no natural extension)
    "aug":   [0, 4, 8],                # 1 3 #5           (no natural extension)
    "sus":   [0, 5, 7, 10, 2],         # 1 4 5 b7 9
}

# ----------------------------------------------------------------------------
# CHORALE VOICING: 7 tracks, each holding exactly one tone of the current chord, coordinated as
# ONE texture rather than chosen independently per voice or per span -- an earlier per-span
# design (each span hashing its own chord tone with zero knowledge of the other voices)
# produced "randomized notes that splatter," which this replaced entirely. 5 of the 7 are
# agent-driven (CHORD_AGENT_VOICES) and 2 are not (ARCH_VOICES).
#
# HOW THE CHORD IS SUSTAINED (this changed after a listening pass -- "2 notes is not enough to
# sustain chord intention. Especially with 8 tracks to choose from"). Originally only the 2 arch
# voices articulated on a chord change and the other 5 sounded only when their agent happened to
# fire, so between spans the entire harmony rested on 2 notes. Two arbitrary tones of a seventh
# chord do not spell that chord -- root and 13th, say, state nothing -- so the chord's identity
# never landed and the piece read as chaos over an implied harmony nobody could hear.
#
# Now every chord change lays down a full COMP: all currently-LIVE chord voices articulate their
# assigned tone together at a soft fixed velocity and sustain through the bar, so the chord is
# continuously present and fully spelled. Agent spans then RE-ARTICULATE their own voice on top
# at telemetry-driven velocity -- accents inside a sustained chord, which is exactly what comping
# is.
#
# "Live" is the part that keeps this from destroying the oversight signal. A voice joins the comp
# only if its agent has emitted a span recently (COMP_LIVE_WINDOW_S); a stalled agent drops out
# of the chord entirely. So the texture thins as agents go quiet -- worker3's stall is still
# audible as its tone vanishing from the harmony, and is arguably clearer than before, because
# now it's a note disappearing from a chord you were already hearing rather than an absence of
# sporadic notes. The arch voices are always live, so the harmony never disappears completely.
# ----------------------------------------------------------------------------

# Low-to-high register order for ALL 7 chord voices (this is what the non-crossing/voice-leading
# algorithm in jazz_chorale_voicing walks in order -- it is NOT the same as VOICES' channel
# order, which is arbitrary MIDI routing).
CHORD_VOICE_ORDER = ["arch1", "planner", "worker2", "worker3", "tools", "worker1", "arch2"]
CHORD_AGENT_VOICES = {"planner", "worker1", "worker2", "worker3", "tools"}
ARCH_VOICES = {"arch1", "arch2"}
COMP_VELOCITY = 60        # the sustained chord bed -- still under the agent accents (50-110),
                           # but no longer so far under that the harmony reads as background
COMP_SUSTAIN_FRAC = 0.94  # fraction of the bar the comp chord holds (near-continuous)
COMP_LIVE_WINDOW_S = 7.0  # an agent voice joins the comp if it emitted a span this recently...

# ...but silence is only a FALLBACK for detecting that an agent is gone. When telemetry actually
# says so, use it: a span carrying a terminal stop_reason means that agent finished, and its
# voice should leave the chord at that moment rather than lingering for the timeout. Measured on
# a swarm run before this existed: voices stayed in the comp 1.8-8.2s after their agent's last
# activity, so the ensemble still sounded wide seconds after the swarm had converged -- blunting
# the exact signal the instrument exists to carry. 'tool_use' is deliberately NOT terminal: it
# means the agent paused to call a tool and is still very much alive.
TERMINAL_STOP_REASONS = {"end_turn", "max_tokens", "stop_sequence"}

# Chord emphasis. A comper does not hit every bar with identical weight -- the top of a chorus
# and a cadential arrival get leaned on, everything else supports. Without this the comp is a
# metronome laying down correct chords, which is what "chords need more emphasis" was pointing at.
COMP_ACCENT_FORM_TOP = 22    # extra velocity on bar 1 of a chorus (the tune coming back around)
COMP_ACCENT_CADENCE = 14     # extra velocity on a V -> I arrival
COMP_ACCENT_BASS_EXTRA = 8   # the bass voice leans a little harder than the inner voices

# Anticipation ("push"): landing the new chord an eighth note EARLY is the single most
# characteristic jazz comping gesture -- it's what makes a comp sound played rather than
# sequenced. Applied to a fraction of bars, chosen deterministically per bar so a seed
# reproduces the same feel. The chord being pushed into is shortened to make room, so the
# anticipation replaces the tail of the previous chord instead of clashing with it.
COMP_PUSH_PROBABILITY = 0.38
COMP_PUSH_ACCENT = 10        # a push is inherently an accent

# Swing: jazz eighth notes are long-short, roughly a triplet feel. 0.5 is straight (no swing),
# 0.667 is a full triplet. Applied as a single monotonic, order-preserving transform over ALL
# event times at the very end of build_timeline, so every voice swings together -- a melody
# swinging against a straight comp sounds broken, not stylish. Because it's monotonic and
# sub-beat, it doesn't reorder telemetry or change which events precede which; it's a rendering
# feel, like rubato on a recording. Sections may override it per-section (see the demo's section
# table) -- "a little swing in the rhythm in parts" rather than uniformly.
SWING_DEFAULT = 0.60
SWING_STRAIGHT = 0.5

# ----------------------------------------------------------------------------
# WALKING BASS. arch1 (the lowest voice) stops holding a sustained chord tone and instead walks
# -- quarter notes outlining the changes, which is the single most recognizable jazz
# rhythm-section signature and the thing that most makes this read as a band rather than a chord
# machine. A bass cannot both hold a whole note and walk, so arch1 is excluded from the sustained
# comp; the comp is the other 6 voices above it. That IS the standard division of labour: bass
# walks, piano comps.
#
# FEEL is telemetry-driven, and it's a real jazz intensity device rather than an invented one: a
# quiet swarm gets a "two feel" (bass on beats 1 and 3, half-note motion, relaxed) and a busy one
# gets a "four feel" (all four beats, driving). That's exactly how a rhythm section builds and
# releases intensity through a chorus.
#
# The line itself is standard practice: beat 1 lands on the root (or occasionally the 5th/3rd for
# a slash-chord inversion -- see bass_tone_choice), beat 4 is an APPROACH note a half step from
# the next bar's target (chromatic approach is what makes a walk sound inevitable rather than
# random), and the middle beats step through the chord's core tones from one to the other.
# ----------------------------------------------------------------------------
BASS_VOICE = "bass"
BASS_RANGE = (28, 50)         # upright-bass range: low E to about G above the staff
BASS_ANCHOR = 38              # roots are placed in the octave nearest THIS, not nearest the
                               # previous note. Nearest-to-previous is a random walk: it drifts,
                               # and over a chorus the line wanders across two octaves in slow
                               # waves that read as a countermelody rather than a bass. Anchoring
                               # keeps roots in one consistent register, which is what a bassist
                               # actually does; leaps between roots are correct and idiomatic.
WALK_VELOCITY = 78            # the bass is a lead instrument in a rhythm section, not a bed
WALK_NOTE_FRAC = 0.92         # each quarter's duration as a fraction of a beat (slight detache)
WALK_FOUR_FEEL_ACTIVITY = 2   # activity_level at/above which the bass walks all four beats

# Which chord tones the bass is ALLOWED to define a bar with, as indices into JAZZ_CHORD_TONES:
# root, 5th, 3rd. Never the 7th and never an extension. This is not a style preference -- a bass
# landing on the #11 or the 13th on a downbeat doesn't state the chord, it contradicts it, and it
# was measured doing exactly that on 20% of bars ("sounds like bass is playing a different song").
# Root dominates; the 5th and 3rd are real inversions (slash chords), used sparingly.
BASS_TONE_CHOICES = [0, 2, 1]
BASS_ROOT_WEIGHT_CALM = 0.88   # P(root on the downbeat) when the swarm is quiet
BASS_ROOT_WEIGHT_BUSY = 0.66   # ...and when it's busy -- busier gets more inversions, but the
                                # root still dominates, because that's the bass's job

# Each voice's allowed register (inclusive), >=12 semitones wide so every pitch class always has
# at least one candidate note in range -- a narrower-than-octave range was the actual cause of a
# real crossing bug (see jazz_chorale_voicing's docstring): some pitch classes simply have no
# member in a sub-octave band, and the old fallback silently dropped the non-crossing constraint
# when that happened. Deliberately overlapping between adjacent voices (real ensembles do too).
# Piano comping register: C3 (48) up to C6, deliberately ABOVE the bass (BASS_RANGE tops out at
# 50). The lowest piano voice used to start at 28 -- the same octave the bass walks in -- which
# put a sustained piano note directly on top of the bass line and was a direct cause of the two
# sounding like separate songs. A pianist comping with a bassist stays out of the bass's octave;
# this is that, as a constraint.
# Adjacent floors are ~5 semitones apart, not 4: seven non-crossing voices each needing a
# specific pitch class (available only every 12 semitones) need real room, and at 4-semitone
# spacing the widen-upward fallback fired on 38% of notes and pushed voices as high as MIDI 112.
# At this spacing it is rare. Every range is >=15 semitones so every pitch class is always
# available in it -- see the fallback comment in jazz_chorale_voicing.
VOICE_RANGES = {
    "arch1":   (48, 63),
    "planner": (53, 68),
    "worker2": (58, 73),
    "worker3": (63, 78),
    "tools":   (68, 83),
    "worker1": (73, 88),
    "arch2":   (78, 93),
}

# ----------------------------------------------------------------------------
# MUSICALITY HELPERS
# ----------------------------------------------------------------------------

def grid_seconds(tempo_bpm):
    """Length of one 16th note in seconds."""
    return (60.0 / tempo_bpm) / 4.0

def quantize(t, grid):
    """Snap a time to the nearest 16th-note grid slot."""
    return round(t / grid) * grid

def action_hash(action_type):
    """Stable integer hash of an action label. hashlib, not builtin hash() -- builtin hash()
    is salted per-process (PYTHONHASHSEED) and would break motif stability and reproducibility
    across runs; this must be a pure function of the label alone."""
    return int(hashlib.md5(action_type.encode()).hexdigest(), 16)

def weighted_choice_from_dist(dist, seed):
    """Deterministically sample a key from a {value_str: probability} dict, seeded so the same
    seed always yields the same draw (a corpus-informed choice, not a random one)."""
    rng = random.Random(seed)
    keys = list(dist.keys())
    weights = [dist[k] for k in keys]
    return int(rng.choices(keys, weights=weights, k=1)[0])

def weighted_choice_str(dist, seed):
    """Like weighted_choice_from_dist but returns the key string as-is, for non-numeric choices
    (motif transformation names)."""
    rng = random.Random(seed)
    keys = list(dist.keys())
    return rng.choices(keys, weights=[dist[k] for k in keys], k=1)[0]

def note_near_step(register_base, step, pitch_class):
    """The MIDI note nearest to (register_base + step) whose pitch class matches pitch_class --
    realizes a corpus-drawn interval step as an actual note of the current chord."""
    candidate = register_base + step
    for delta in range(0, 13):
        for cand in (candidate + delta, candidate - delta):
            if cand % 12 == pitch_class:
                return max(0, min(127, cand))
    return max(0, min(127, register_base))   # unreachable in practice; keeps the return type honest

def _notes_in_range(pitch_class, lo, hi):
    """All MIDI notes with the given pitch class within [lo, hi] inclusive."""
    start = lo + ((pitch_class - lo) % 12)
    return list(range(start, hi + 1, 12))

# How the solo line picks WHICH tone of the current chord to land on. JAZZ_CHORD_TONES is
# ordered root, 3rd, 5th, 7th, then extensions, so these weights say: favour the GUIDE TONES
# (3rd and 7th, ~55% combined). Guide tones are the notes that actually define a chord's quality
# and that resolve by step through a ii-V, which is why a line built on them sounds like it is
# playing THE CHANGES rather than merely noodling over them. A uniform pick across all tones --
# which is what this replaced -- weights a 13th or an 11th the same as the 3rd, and the result
# reads as chaos even though every note is technically correct.
MELODY_TONE_WEIGHTS = [0.20, 0.30, 0.10, 0.25]   # root, 3rd, 5th, 7th
MELODY_EXTENSION_WEIGHT = 0.15                    # shared across whatever extensions exist

def _melody_tone_index(tones, seed):
    """Weighted pick of an index into `tones`, favouring guide tones -- see
    MELODY_TONE_WEIGHTS."""
    weights = []
    n_ext = max(0, len(tones) - len(MELODY_TONE_WEIGHTS))
    for i in range(len(tones)):
        if i < len(MELODY_TONE_WEIGHTS):
            weights.append(MELODY_TONE_WEIGHTS[i])
        else:
            weights.append(MELODY_EXTENSION_WEIGHT / n_ext)
    return random.Random(seed).choices(range(len(tones)), weights=weights, k=1)[0]

def _avoid_parallels(prev_voicing, voicing, sounding=None):
    """Best-effort fix for parallel fifths/octaves: for any voice pair that moved by the same
    directed interval into a perfect fifth or octave/unison between prev_voicing and voicing (a
    forbidden parallel in traditional part-writing), nudge the upper voice of the pair by an
    octave if that keeps it inside its own register range AND doesn't cross either of its
    IMMEDIATE SOUNDING neighbors at their CURRENT (possibly already-nudged) values.

    Both the "immediate neighbor" and "sounding" qualifiers are load-bearing, and each came from
    a real crossing bug. Checking only the pair's own two voices isn't enough, because
    jazz_chorale_voicing assigns sequentially and a later voice may already sit relative to this
    one's pre-nudge value. And the neighbors must be the SOUNDING ones: silent voices are placed
    independently of the non-crossing chain, so bounding a nudge by a silent neighbor's position
    lets the nudge cross an audible voice. Not exhaustive -- a full constraint-satisfaction
    search is future work -- but catches the common case cheaply."""
    voicing = dict(voicing)
    order = [v for v in CHORD_VOICE_ORDER if sounding is None or v in sounding]
    for i in range(len(order)):
        for j in range(i + 1, len(order)):
            va, vb = order[i], order[j]
            if va not in prev_voicing or vb not in prev_voicing:
                continue
            prev_interval = abs(prev_voicing[va] - prev_voicing[vb]) % 12
            new_interval = abs(voicing[va] - voicing[vb]) % 12
            if prev_interval not in (0, 7) or new_interval != prev_interval:
                continue
            delta_a = voicing[va] - prev_voicing[va]
            delta_b = voicing[vb] - prev_voicing[vb]
            if delta_a == 0 or delta_b == 0 or (delta_a > 0) != (delta_b > 0):
                continue   # oblique or contrary motion -- not a forbidden parallel
            idx_b = order.index(vb)
            lower_bound = voicing[order[idx_b - 1]] if idx_b > 0 else -10**9
            upper_bound = voicing[order[idx_b + 1]] if idx_b < len(order) - 1 else 10**9
            lo, hi = VOICE_RANGES[vb]
            for cand in (voicing[vb] - 12, voicing[vb] + 12):
                if lo <= cand <= hi and lower_bound <= cand <= upper_bound:
                    voicing[vb] = cand
                    break
    return voicing

def _tone_priority_order(tones):
    """The order in which a chord's tones are handed to the PIANO voices, so that whatever subset
    actually sounds still SPELLS the chord: guide tones (3rd and 7th -- the two notes that define
    a seventh chord's quality) first, then the 5th and extensions, and the ROOT last.

    Root last is deliberate now that a real bass plays it on every downbeat: doubling the root in
    the piano when the bassist already owns it is the classic beginner voicing, and leaving it
    out is what makes a comp sound like jazz piano. At two voices this yields exactly the 3rd+7th
    shell voicing a pianist would actually play behind a bassist.

    This ordering replaced a plain rotation, which gave each of the 7 voices a different tone --
    fine when all 7 sounded, but voices drop out as agents go quiet and the survivors could be
    root/5th/9th/13th: no 3rd, no 7th, no chord. Measured at the time: only 26% of chord windows
    stated both guide tones, versus 88% after."""
    order = []
    for idx in (1, 3, 2):           # 3rd, 7th, 5th
        if idx < len(tones):
            order.append(idx)
    for idx in range(len(tones)):   # extensions, in the table's own order
        if idx not in order and idx != 0:
            order.append(idx)
    if 0 < len(tones):              # the root, last -- the bass has it covered
        order.append(0)
    return order

def jazz_chorale_voicing(prev_voicing, root_pc, quality, sounding_voices=None):
    """One shared voicing for all 7 PIANO chord voices at once (5 agent-driven + 2 arch), given
    the current chord -- the texture where each track holds exactly one tone. The walking bass is
    NOT one of these; it's a separate instrument on its own channel with its own line (see
    walking_bass_bar). Voices are assigned low to high (CHORD_VOICE_ORDER), each constrained to
    its own register range (VOICE_RANGES, deliberately >=12 semitones wide -- see that dict's
    comment for why a narrower range caused a real crossing bug) and to not cross the voice just
    assigned below it, and voice-led (nearest to that SAME voice's previous pitch) rather than
    re-stacked from scratch every chord change.

    sounding_voices (optional): which voices will actually be heard this window. Tones are
    handed out in _tone_priority_order to THOSE voices first, low to high, so the chord is
    spelled by whatever is audible rather than by all 7 nominally -- see _tone_priority_order for
    why that matters. Voices that aren't sounding still get an assignment (they stay in the dict
    so voice-leading has an anchor when they come back), just from what's left over. None means
    all 7 sound, which is what the calibration path and any caller without live-voice tracking
    gets."""
    tones = JAZZ_CHORD_TONES[quality]
    order = _tone_priority_order(tones)

    sounding = [v for v in CHORD_VOICE_ORDER if sounding_voices is None or v in sounding_voices]
    silent = [v for v in CHORD_VOICE_ORDER if v not in sounding]
    tone_for = {}
    for i, voice in enumerate(sounding + silent):
        tone_for[voice] = tones[order[i % len(order)]]

    voicing = {}
    prev_note_below = None
    sounding_set = set(sounding) if sounding_voices is not None else None
    for voice in CHORD_VOICE_ORDER:
        pitch_class = (root_pc + tone_for[voice]) % 12
        lo, hi = VOICE_RANGES[voice]

        # Voices that won't be heard are placed inside their own range and do NOT advance the
        # non-crossing floor. Letting them push it was a real bug: with only 3 voices live, the
        # 4 silent ones still consumed register space in the ascending chain, ratcheting the
        # stack upward until the widen-upward fallback fired on 38% of notes and pushed voices
        # to MIDI 112. They're re-voiced from scratch whenever they come back anyway.
        if sounding_set is not None and voice not in sounding_set:
            near = _notes_in_range(pitch_class, lo, hi)
            voicing[voice] = min(near, key=lambda c: abs(c - (lo + hi) // 2)) if near else lo
            continue

        candidates = _notes_in_range(pitch_class, lo, hi) or [lo]
        if prev_note_below is not None:
            constrained = [c for c in candidates if c >= prev_note_below]
            if not constrained:
                # A voice's range can have no member of the needed pitch class once floored at
                # prev_note_below (pitch classes only repeat every 12 semitones) -- widen the
                # search upward rather than silently dropping the non-crossing constraint (the
                # original version of this did that, and it produced real crossed voices,
                # verified by a 20-chord test walk). Slightly exceeding the nominal range is far
                # less objectionable than two voices swapping registers.
                constrained = [c for c in _notes_in_range(pitch_class, prev_note_below, hi + 12)
                               if c >= prev_note_below]
            if not constrained:
                # Even the widened window can come up empty when the voice below has already
                # escaped past it. Fall back to the first note of this pitch class at or above
                # the floor, unbounded -- non-crossing is the invariant worth preserving, and a
                # bounded window is only a preference. MIDI-clamped so this can never be invalid.
                base = prev_note_below + ((pitch_class - prev_note_below) % 12)
                constrained = [max(0, min(127, base))]
            candidates = constrained
        anchor = (prev_voicing or {}).get(voice, (lo + hi) // 2)
        best = min(candidates, key=lambda c: abs(c - anchor))
        voicing[voice] = best
        prev_note_below = best
    if prev_voicing:
        voicing = _avoid_parallels(prev_voicing, voicing, sounding=sounding_set)
    return voicing

def generate_voicing_schedule(chord_schedule, spans, seed=0, sections=None, resolved=None):
    """One jazz_chorale_voicing computed per chord window (not per span), threaded voice-by-voice
    from the previous window's voicing. Root AND quality both come from the form (carried in
    chord_schedule) -- they are fixed properties of the tune, identical every time that bar of
    the form comes around, which is what gives the piece a key and a recognizable theme.
    activity_level (distinct TRUE agent identities with a span starting inside this window --
    unbounded, NOT capped at the 5 physical voices; see the VOICE POOL block comment above)
    drives the piano's doubling and the bass's occasional inversion (bass_tone_choice), i.e.
    telemetry varies the VOICING of a fixed chord, never which chord it is.

    resolved (optional, from pool_spans): id(span) -> physical chord voice, needed whenever
    `spans` carries true (unpooled) agent ids -- i.e. always, for real telemetry or swarm.py
    output. Without it, falls back to treating span["agent"] as already a physical voice name,
    which is what the calibration path's hand-authored spans are (see voice_retired_at).

    live_voices is which chord voices join the sustained comp for this window: the arch voices
    always, plus any RESOLVED voice with an agent that emitted a span within COMP_LIVE_WINDOW_S
    before the window ends and hasn't retired. That's what makes a stalled agent audible -- its
    tone drops out of the chord -- while keeping the chord fully spelled whenever the swarm is
    actually working. See the CHORALE VOICING block comment.

    Returns (start, end, voicing, quality, root_pc, activity_level, live_voices) tuples -- see
    voicing_window_at."""
    def voice_of(s):
        return resolved.get(id(s), s["agent"]) if resolved is not None else s["agent"]

    schedule = []
    prev_voicing = None
    for step, (start, end, root_pc, quality, bar_in_form) in enumerate(chord_schedule):
        activity_level = len({s["agent"] for s in spans if start <= s["start"] < end})
        live_voices = set(ARCH_VOICES) | {
            voice_of(s) for s in spans
            if voice_of(s) in CHORD_AGENT_VOICES
            and start - COMP_LIVE_WINDOW_S <= s["start"] < end
            and not voice_retired_at(spans, voice_of(s), start, resolved=resolved)
        }
        # A voice the arrangement has contracted out of this section won't be heard even if its
        # agent is live, so it must not be counted when deciding who spells the chord.
        section_voices = voices_active_at(start, sections)
        if section_voices is not None:
            live_voices = {v for v in live_voices if v in ARCH_VOICES or v in section_voices}
        voicing = jazz_chorale_voicing(prev_voicing, root_pc, quality, sounding_voices=live_voices)
        bass_idx = bass_tone_choice(activity_level, f"bass-tone-{step}-seed{seed}")
        bass_note = bass_target(root_pc, quality, bass_idx)
        schedule.append((start, end, voicing, quality, root_pc, activity_level, live_voices,
                         bar_in_form, bass_note))
        prev_voicing = voicing
    return schedule

# ----------------------------------------------------------------------------
# VOICE POOL: mapping an UNBOUNDED number of true agent identities onto the engine's fixed 5
# chord voices. This used to be the telemetry PRODUCER's job (swarm.py's SUBAGENT_VOICE_POOL /
# _next_slot round-robin, baked into each span's "agent" field before caidence.py ever saw it).
# That was wrong for two reasons, both real:
#
#   1. It made the pooling invisible to the mapping engine. Every span arrived pre-collapsed onto
#      one of 4 literal names ("planner"/"worker1"/"worker2"/"worker3"), so nothing downstream
#      could ever recover how many TRUE distinct agents actually ran -- activity_level was capped
#      at 4 regardless of --fanout, and there was no way to measure or plot the saturation ceiling
#      (how badly identity gets compressed once a swarm has more live agents than voices).
#   2. It meant live and mock telemetry would take different paths through the code. Real OTel
#      will never arrive pre-pooled -- every span carries its own true gen_ai.agent.id, however
#      many distinct agents that implies -- so a producer-side pool was a mock-only shortcut, and
#      CLAUDE.md is explicit that batch and live must share exactly one per-span mapping.
#
# The fix: spans now carry the TRUE agent id in "agent" (swarm.py emits it directly, no pooling),
# and the pool lives HERE, in the mapping engine, via VoicePool below -- used identically by the
# batch path (pool_spans, one forward pass over a time-sorted span list) and the live OTLP path
# (LivePlayer calls VoicePool.voice_for per span as it arrives). Same class, same algorithm,
# called from two different loops -- not two implementations of the same idea.
# ----------------------------------------------------------------------------

ORCHESTRATOR_AGENT_ID = "orchestrator"   # the one identity that's never pooled -- there's only
                                          # ever one orchestrator, so it maps 1:1 to "planner"
POOL_SLOTS = ["worker1", "worker2", "worker3"]   # the fungible chord voices true subagent
                                                   # identities compete for

class VoicePool:
    """Causal (online) assignment of arbitrarily many true agent identities onto POOL_SLOTS.

    Deliberately online/forward-only -- it never looks ahead -- so the identical algorithm can
    run two different ways: the batch path feeds it a whole span list in time order in one pass
    (pool_spans, below), and live.py's LivePlayer feeds it one span at a time as they actually
    arrive over the wire. Both produce the same assignment for the same sequence of spans.

    A true agent keeps its slot until its OWN most recent span carries a terminal stop_reason
    (the caller passes `terminal=True` on that call, matching TERMINAL_STOP_REASONS exactly as
    voice_retired_at always defined "finished") -- only then can a new identity claim that slot.
    When every slot is occupied by a still-live agent and a NEW identity needs one, the pool
    STEALS the slot whose current occupant has been quiet longest. That steal is the real,
    audible saturation ceiling: past len(POOL_SLOTS) simultaneously-live agents, distinct
    identities start sharing a voice mid-flight, not merely being denied a debut. Every steal is
    counted (`overflow_events`) precisely so this can be measured and plotted against --fanout,
    rather than only asserted in prose."""

    def __init__(self, slots=None):
        self.slots = list(slots) if slots else list(POOL_SLOTS)
        self.occupant = {slot: None for slot in self.slots}   # slot -> true agent id or None
        self.slot_of = {}     # true agent id -> slot, only while it currently holds one
        self.last_active = {}  # true agent id -> last time it was seen (for the steal heuristic)
        self._rr = 0           # round-robin cursor among free slots, so ties don't always
                                # favour the first slot
        self.overflow_events = 0
        self.overflow_log = []   # [(t, stolen_from_agent_or_None, given_to_agent), ...]

    def voice_for(self, agent_id, t, terminal=False):
        """Resolve agent_id's physical voice slot as of time t, assigning or stealing one if
        needed. `terminal` should be True exactly when THIS span's own stop_reason is terminal --
        the agent still gets its slot for this call (it's still speaking right now), but the slot
        is freed immediately after, for whichever new identity needs it next."""
        self.last_active[agent_id] = t
        if agent_id not in self.slot_of:
            free = [s for s in self.slots if self.occupant[s] is None]
            if free:
                slot = free[self._rr % len(free)]
                self._rr += 1
            else:
                slot = min(self.slots, key=lambda s: self.last_active.get(self.occupant[s], -1.0))
                stolen_from = self.occupant[slot]
                self.overflow_events += 1
                self.overflow_log.append((t, stolen_from, agent_id))
                if stolen_from is not None:
                    self.slot_of.pop(stolen_from, None)
            self.slot_of[agent_id] = slot
            self.occupant[slot] = agent_id
        slot = self.slot_of[agent_id]
        if terminal:
            self.slot_of.pop(agent_id, None)
            self.occupant[slot] = None
        return slot

def resolve_voice(pool, agent_id, t, terminal=False):
    """agent_id -> physical chord voice, handling the one identity that's never pooled (the
    orchestrator, fixed to 'planner') before delegating everything else to the VoicePool."""
    if agent_id == ORCHESTRATOR_AGENT_ID:
        return "planner"
    return pool.voice_for(agent_id, t, terminal=terminal)

def pool_spans(spans):
    """Run VoicePool once over a time-sorted span list, returning (resolved, pool) where
    `resolved` maps id(span) -> its physical chord voice for this run, and `pool` is the
    VoicePool instance itself (so callers can inspect .overflow_events for a saturation figure).

    Every span is fed through resolve_voice in time order regardless of op, so a pooled
    identity's bookkeeping (last_active, retirement) stays accurate even on spans whose SOUNDING
    voice is overridden elsewhere (execute_tool spans always sound on the dedicated "tools"
    voice, handled by emit_span_events -- that override is about which track plays the note, not
    about which slot the calling agent occupies)."""
    pool = VoicePool()
    resolved = {}
    for s in sorted(spans, key=lambda s: s["start"]):
        terminal = s.get("stop_reason") in TERMINAL_STOP_REASONS
        resolved[id(s)] = resolve_voice(pool, s.get("agent"), s["start"], terminal=terminal)
    return resolved, pool

def voice_retired_at(spans, voice, t, resolved=None):
    """True if this voice's occupant has finished as of time t -- i.e. the most recent span
    resolved to this voice before t carried a terminal stop_reason (see TERMINAL_STOP_REASONS).

    `resolved` (optional, from pool_spans) maps id(span) -> its resolved physical voice for
    callers using true (unpooled) agent ids. Without it, falls back to matching span["agent"]
    against `voice` directly -- correct for the calibration path (synthetic_trace's hand-authored
    spans already use the 5 canonical voice names as "agent", never pooled, by design; see
    CLAUDE.md on synthetic_trace's determinism rules).

    "Most recent span" rather than "any terminal span" is what makes voice POOLING work: several
    subagents share a worker voice over a run, so worker1 can finish in round 1 and be reused by
    a new subagent in round 2. Looking only at the latest event means the voice retires when its
    current occupant finishes and comes back when the next one spawns, instead of being retired
    permanently by the first agent that ever used it."""
    latest, latest_t = None, None
    for s in spans:
        this_voice = resolved.get(id(s), s.get("agent")) if resolved is not None else s.get("agent")
        if this_voice != voice:
            continue
        st = s["start"]
        if st < t and (latest_t is None or st > latest_t):
            latest, latest_t = s, st
    return bool(latest) and latest.get("stop_reason") in TERMINAL_STOP_REASONS

def bass_tone_choice(activity_level, seed_key):
    """Which chord tone the bass defines this bar with -- root almost always, occasionally the
    5th or 3rd (a real slash-chord inversion). Restricted to BASS_TONE_CHOICES: never the 7th,
    never an extension. activity_level still shifts it, so telemetry still reaches the harmony,
    but the root keeps the lion's share at every activity level because that's the instrument's
    function."""
    busy = min(1.0, activity_level / 4.0)
    root_w = BASS_ROOT_WEIGHT_CALM + (BASS_ROOT_WEIGHT_BUSY - BASS_ROOT_WEIGHT_CALM) * busy
    rest = (1.0 - root_w) / 2.0
    dist = {"0": root_w, "1": rest, "2": rest}   # keys index into BASS_TONE_CHOICES
    return BASS_TONE_CHOICES[int(weighted_choice_from_dist(dist, seed=action_hash(seed_key)))]

def bass_target(root_pc, quality, tone_idx):
    """The note the bass lands on at beat 1: the chosen chord tone placed in the octave nearest
    BASS_ANCHOR -- deliberately NOT nearest the previous note. Nearest-to-previous is a random
    walk that drifts over a chorus into slow two-octave waves reading as a countermelody; a real
    bassist keeps roots in a consistent register and leaps between them. Independent of the piano
    voicing: the bass is its own instrument on its own channel, not a chorale voice."""
    tones = JAZZ_CHORD_TONES[quality]
    pitch_class = (root_pc + tones[tone_idx % len(tones)]) % 12
    lo, hi = BASS_RANGE
    candidates = _notes_in_range(pitch_class, lo, hi)
    if not candidates:
        return max(lo, min(hi, BASS_ANCHOR))
    return min(candidates, key=lambda n: abs(n - BASS_ANCHOR))

def bar_in_form_at(t, schedule):
    """Which bar of the chorus is sounding at t, or None. Lets the melody know when the form has
    come back around, which is where the motif is re-stated."""
    for w in schedule:
        if w[0] <= t < w[1]:
            return w[7]
    return schedule[-1][7] if schedule else None

def walking_bass_bar(target, next_target, root_pc, quality, four_feel, seed_key):
    """One bar of bass, as a list of (beat_offset, note). See the WALKING BASS block comment.

    Two feel: beats 1 and 3 -- the bar's bass tone, then another chord tone (a fifth away if that
    sits in range, else the nearest chord tone), which is the standard relaxed half-note motion.

    Four feel: beat 1 is the target, beat 4 is a half-step approach INTO the next bar's target
    (approached from whichever side leaves the step, so the resolution is a semitone -- that's
    what makes a walk sound like it's going somewhere), and beats 2-3 step through chord tones
    between the two. If the chord-tone pool between them is empty, the line just steps toward the
    approach note chromatically rather than leaping, which keeps it walking."""
    lo, hi = BASS_RANGE
    # CORE tones only (root/3rd/5th/7th) -- a walking line outlines the chord, it doesn't run the
    # extensions. Including 9ths/11ths/13ths in the pool was part of what made the line sound
    # like a countermelody rather than a bass.
    tones = JAZZ_CHORD_TONES[quality][:ARPEGGIO_CORE_TONES]
    pool = sorted({n for tn in tones for n in _notes_in_range((root_pc + tn) % 12, lo, hi)})

    def nearest_from(pool_, ref):
        return min(pool_, key=lambda n: abs(n - ref)) if pool_ else ref

    if not four_feel:
        fifth_candidates = _notes_in_range((root_pc + 7) % 12, lo, hi) or pool
        second = nearest_from(fifth_candidates, target)
        if second == target and pool:
            second = nearest_from([n for n in pool if n != target] or pool, target)
        return [(0.0, target), (2.0, second)]

    # Beat 4: a half step into the next target, from whichever side is nearer the current line.
    below, above = next_target - 1, next_target + 1
    approach = below if abs(below - target) <= abs(above - target) else above
    approach = max(lo, min(hi, approach))

    step = 1 if approach >= target else -1
    between = [n for n in pool if (target < n < approach) or (approach < n < target)]
    between.sort(reverse=(step < 0))
    if len(between) >= 2:
        beat2, beat3 = between[0], between[-1]
    elif len(between) == 1:
        beat2 = between[0]
        beat3 = max(lo, min(hi, approach - step))
    else:
        # nothing in between (adjacent chord tones) -- walk chromatically toward the approach
        beat2 = max(lo, min(hi, target + step))
        beat3 = max(lo, min(hi, target + 2 * step))
    if beat3 == approach:
        beat3 = max(lo, min(hi, beat3 - step))
    return [(0.0, target), (1.0, beat2), (2.0, beat3), (3.0, approach)]

def voicing_window_at(t, schedule):
    """(voicing, quality, root_pc, activity_level) for the chord window containing t."""
    if not schedule:
        return {}, "dom7", 0, 0
    for start, end, voicing, quality, root_pc, activity_level, _live, _bar, _bass in schedule:
        if start <= t < end:
            return voicing, quality, root_pc, activity_level
    last = schedule[-1]
    return last[2], last[3], last[4], last[5]

ARPEGGIO_CORE_TONES = 4   # run 1-3-5-7 only, never the extensions -- see below

def jazz_arpeggio_notes(action_type, root_pc, quality, register_base, probability):
    """With `probability` chance (deterministic per action_type, so reproducible), return an
    ordered broken-chord run over the chord's CORE tones only (root/3rd/5th/7th, i.e.
    JAZZ_CHORD_TONES' first ARPEGGIO_CORE_TONES entries), ascending or descending, fanned out
    from register_base. Returns None if this action doesn't arpeggiate -- caller falls back to a
    normal single note.

    Core tones only, not every tone: an earlier version ran ALL of them, so a maj7 arpeggio was
    root-3-5-7-9-#11-13, which is a scale, not an arpeggio. Because runs make up a large share
    of the solo's notes, that also swamped the guide-tone weighting in _melody_tone_index --
    measured 35% guide tones when the single-note weights alone should have produced ~55% -- and
    it's a real part of why the line read as chaotic. A 1-3-5-7 run outlines the chord instead of
    blurring it, which is what a bebop line actually does.

    Direction and whether-to-arpeggiate are both decided by the SAME action hash used elsewhere,
    so a given action is consistently a run or consistently a single note, not flickering between
    the two. Only ever called for the solo melody line -- the 7 chord voices never arpeggiate
    (see emit_span_events), so every chord track is always exactly one clean note."""
    h = action_hash(action_type + ":arp")
    if (h % 1000) / 1000.0 >= probability:
        return None
    tones = JAZZ_CHORD_TONES[quality][:ARPEGGIO_CORE_TONES]

    def _nearest_with_pc(pc):
        base = register_base - (register_base % 12) + pc
        return max(0, min(127, min((base - 12, base, base + 12), key=lambda n: abs(n - register_base))))

    notes = sorted(_nearest_with_pc((root_pc + t) % 12) for t in tones)
    return notes if (h // 1000) % 2 == 0 else list(reversed(notes))

def tokens_to_velocity(tokens):
    v = 50 + int(min(tokens, 500) / 500 * 60)   # 50..110
    return max(1, min(127, v))

def latency_to_duration(op, latency):
    if op == "execute_tool":
        return max(0.12, min(0.4, latency))     # staccato pluck
    return max(0.25, min(2.0, latency))         # legato-ish for chat/reasoning

def _nearest_chromatic_offsets(diatonic_pitch_classes, count=4):
    """The `count` smallest-magnitude semitone offsets from 0 whose pitch class (mod 12) is NOT
    in diatonic_pitch_classes -- guaranteed off-scale regardless of which mode/center is active,
    unlike a fixed [-2,-1,1,2] which can land back in-key depending on the center note and mode."""
    offsets = []
    magnitude = 1
    while len(offsets) < count and magnitude <= 6:
        for off in (magnitude, -magnitude):
            if (off % 12) not in diatonic_pitch_classes:
                offsets.append(off)
        magnitude += 1
    return offsets[:count]

def capture_spike_cluster(ch, center_note, t0, add, diatonic_pitch_classes):
    """Sharp chromatic wrong-note cluster right at an external-ingestion point (capture
    signature). A discrete burst ending exactly at the in-key note's onset, so it reads as
    a snag correlated with the injection, unlike the slow continuous pitch-bend of drift."""
    offsets = _nearest_chromatic_offsets(diatonic_pitch_classes, count=len(CAPTURE_SPIKE_OFFSETS))
    for i, off in enumerate(offsets):
        t = t0 + i * CAPTURE_SPIKE_GAP_S
        note = max(0, min(127, center_note + off))
        add(t, mido.Message("note_on", channel=ch, note=note, velocity=CAPTURE_SPIKE_VELOCITY))
        add(t + CAPTURE_SPIKE_NOTE_S, mido.Message("note_off", channel=ch, note=note, velocity=0))

def convergence_cadence(ch_a, ch_b, base_a, base_b, t0, add, cadence_pattern):
    """Short two-voice cadential close marking a conflict resolving to consonance. The root-pc
    pair comes from the corpus's most-attested ending (e.g. root pc 7 -> 0, V -> I), not a
    hardcoded guess. root_pc is already an absolute chromatic offset from the tonic, so no
    quality/mode lookup is needed here (unlike the retired TRIADS-based version)."""
    for i, root_pc in enumerate((cadence_pattern["from_root_pc"], cadence_pattern["to_root_pc"])):
        t = t0 + i * CADENCE_INTERVAL_S
        for ch, base in ((ch_a, base_a), (ch_b, base_b)):
            note = base + root_pc
            add(t, mido.Message("note_on", channel=ch, note=note, velocity=85))
            add(t + CADENCE_INTERVAL_S * 0.9, mido.Message("note_off", channel=ch, note=note, velocity=0))

def collusion_unison(ch_a, ch_b, t0, add):
    """Synchronized identical-pitch notes on two supposedly-independent voices."""
    for i in range(COLLUSION_COUNT):
        t = t0 + i * COLLUSION_GAP_S
        for ch in (ch_a, ch_b):
            add(t, mido.Message("note_on", channel=ch, note=COLLUSION_NOTE, velocity=COLLUSION_VELOCITY))
            add(t + 0.15, mido.Message("note_off", channel=ch, note=COLLUSION_NOTE, velocity=0))

def emit_span_events(s, onset, root_pc, quality, voicing, add, active_voices=None, resolved_voice=None):
    """The DIRECT-tier per-span mapping (role/op -> note, tool-error grace note, capture-spike
    cluster). Shared by both the batch path (build_timeline's precomputed-then-played loop) and
    the live OTLP path, so the two can never drift into different instruments for the same
    telemetry -- there is exactly one mapping implementation, called from two schedulers. onset
    must already be grid-quantized by the caller; this function doesn't need to know the
    tempo/grid itself.

    resolved_voice: the physical chord voice this span's TRUE agent id resolves to (from
    resolve_voice/pool_spans/VoicePool -- see the VOICE POOL block comment). The caller resolves
    it, not this function, because the caller is whoever owns the VoicePool (build_timeline for
    batch, LivePlayer for live), and pooling state must be threaded across calls, not
    re-derived per span. If None, falls back to treating span["agent"] as already a physical
    voice name -- correct for the calibration path's hand-authored spans (see voice_retired_at).

    voicing: the current chord window's 7-voice chorale voicing (dict of chord-voice-name ->
    MIDI note, from jazz_chorale_voicing/generate_voicing_schedule). PITCH comes entirely from
    here -- every span for a given voice plays THAT voice's currently-assigned chord tone, one
    clean note, no embellishment (no arpeggios on chord voices -- that's exclusively the solo
    melody line now, see generate_solo_melody). A span still fully drives its own
    rhythm/dynamics (velocity, duration, onset) -- only the pitch draw comes from the chord-level
    voicing.

    root_pc/quality: the current chord window's root (0-11, semitones from tonic) and quality
    bucket, used only to compute this chord's own tones for the tool-error/capture-spike
    "off-chord" chromatic offsets below (jazz's chord-scale-relative dissonance, not a fixed
    7-note diatonic scale -- there isn't one fixed scale over a chromatically-moving jazz
    progression the way there is in common-practice tonality).

    active_voices (optional, from voices_active_at): the set of voice names allowed to sound in
    the current section. None means unconditional (live.py and synthetic_trace() never gate).
    Gating is checked against whichever voice actually SOUNDS for this span -- 'tools' for a
    tool-call span, regardless of which agent made the call -- and suppresses the span entirely
    (no note, no tool-error grace note, no capture-spike cluster) rather than partially muting
    it, so a contracted section is genuinely quiet, not just quieter."""
    role = resolved_voice if resolved_voice is not None else s["agent"]
    if role not in VOICES:
        role = "tools"
    op = s.get("op", "chat")

    sounding_voice = "tools" if op == "execute_tool" else role
    if active_voices is not None and sounding_voice not in active_voices:
        return

    ch = VOICES[sounding_voice][0]
    note = voicing.get(sounding_voice, VOICES[sounding_voice][2])   # fallback: home register, only
                                                                     # hit before the first chord window

    vel = tokens_to_velocity(s.get("tokens", 100))
    dur = latency_to_duration(op, s.get("duration", 0.5))

    add(onset, mido.Message("note_on", channel=ch, note=note, velocity=vel))
    add(onset + dur, mido.Message("note_off", channel=ch, note=note, velocity=0))

    chord_pcs = {(root_pc + t) % 12 for t in JAZZ_CHORD_TONES[quality]}

    # Tool error -> a sharp dissonant grace note, guaranteed off-chord relative to THIS voice's
    # own just-played note (not a fixed absolute pitch -- a hardcoded note=61 could be an
    # unnaturally huge leap for a low voice, or accidentally land back on-chord for a voice
    # whose tone happens to sit a step away from it).
    if s.get("status") == "error":
        grace_offset = _nearest_chromatic_offsets(chord_pcs, count=1)[0]
        grace_note = max(0, min(127, note + grace_offset))
        add(onset, mido.Message("note_on", channel=ch, note=grace_note, velocity=100))
        add(onset + 0.18, mido.Message("note_off", channel=ch, note=grace_note, velocity=0))

    # Capture spike -> a chromatic wrong-note cluster landing right at this span's onset,
    # marking behavior change correlated with a preceding external-ingestion event.
    if s.get("capture_spike"):
        cluster_len = len(CAPTURE_SPIKE_OFFSETS) * CAPTURE_SPIKE_GAP_S
        capture_spike_cluster(ch, note, max(0.0, onset - cluster_len), add, chord_pcs)

def _cell_score(prev_root, cell, transition_matrix):
    """How corpus-plausible this cell's root motion is, given the chord it follows: the product
    of the mined transition probabilities for (prev -> cell's first root) and each root move
    inside the cell. This is what keeps the corpus load-bearing in the harmony now that the
    chord VOCABULARY is theory-driven: the cells are music theory, but WHICH cell gets chosen at
    each slot is decided by the Weimar Jazz Database's actual root-motion statistics."""
    score = 1.0
    prev = prev_root
    for root, _quality in cell:
        score *= transition_matrix[prev % 12][root % 12]
        prev = root
    return score

def generate_jazz_form(corpus_model, seed=0):
    """Build ONE chorus of changes -- the tune's head -- as two index-aligned realizations
    (major, minor) of the SAME functional cell sequence. Returns (major_form, minor_form), each
    a list of FORM_BARS (root_pc, quality) pairs, one per bar.

    Structure: the first cell is always the tonic (a chorus opens at home) and the last is
    always the ii-V turnaround (so the form resolves back to the top when it repeats, which is
    what makes the recurrence land as a return rather than a restart). The cells in between are
    sampled by corpus score (_cell_score), seeded per slot so a given seed always reproduces the
    same tune.

    Both realizations come from the same sequence of cell INDICES, and JAZZ_CELLS' major/minor
    entries are functional analogues at matching indices -- so switching mode mid-piece plays the
    same tune recolored, not a different one."""
    matrix = corpus_model["root_transition_matrix_major"]
    n_cells = FORM_BARS // BARS_PER_CELL
    indices = [TONIC_CELL_IDX]
    prev_root = JAZZ_CELLS[TONIC_CELL_IDX][1][-1][0]

    for slot in range(1, n_cells - 1):
        candidates = list(range(len(JAZZ_CELLS)))
        weights = [_cell_score(prev_root, JAZZ_CELLS[i][1], matrix) for i in candidates]
        if sum(weights) <= 0:
            weights = [1.0] * len(candidates)
        rng = random.Random(action_hash(f"form-cell-{slot}-seed{seed}"))
        idx = rng.choices(candidates, weights=weights, k=1)[0]
        indices.append(idx)
        prev_root = JAZZ_CELLS[idx][1][-1][0]

    indices.append(TURNAROUND_CELL_IDX)

    major_form, minor_form = [], []
    for idx in indices:
        _name, major_cell, minor_cell = JAZZ_CELLS[idx]
        major_form.extend(major_cell)
        minor_form.extend(minor_cell)
    return major_form, minor_form

def form_as_text(form):
    """The form written out as roman-numeral-ish chord symbols, for eyeballing whether a
    generated tune actually reads like a plausible standard. Used by --show-form."""
    return " | ".join(f"{DEGREE_NAMES[r % 12]}{q}" for r, q in form)

def generate_chord_schedule(total_seconds, default_tempo, major_form, minor_form,
                             regime_schedule=None, sections=None):
    """Tile the form across the whole piece, one chord per bar, as
    (start, end, root_pc, quality) tuples.

    The form index is the ABSOLUTE bar count from t=0, never reset at a section boundary: if
    choruses restarted per section they'd be truncated mid-form and the recurrence would never
    register. Sections change tempo (so a bar's wall-clock length varies), which voices are
    audible, and density -- they no longer touch the harmony at all. That's the head/solos/
    out-head structure of a real chart: same changes throughout, different treatment.

    mode_at picks which realization of the form supplies this bar, so a mode shift recolors the
    same tune rather than substituting a different one."""
    schedule = []
    t = 0.0
    bar_idx = 0
    while t < total_seconds:
        tempo = tempo_at(t, sections, default_tempo)
        bar_s = grid_seconds(tempo) * 16
        form = minor_form if mode_at(t, regime_schedule) == "minor" else major_form
        bar_in_form = bar_idx % len(form)
        root_pc, quality = form[bar_in_form]
        schedule.append((t, t + bar_s, root_pc, quality, bar_in_form))
        t += bar_s
        bar_idx += 1
    return schedule

def mode_at(t, regime_schedule):
    """Which mode (major/minor) is active at time t. Selects which REALIZATION of the form
    plays (see generate_jazz_form): JAZZ_CELLS' major and minor entries are index-aligned
    functional analogues, so the same tune comes out recolored -- modal interchange -- rather
    than a different progression being substituted. That's what keeps a mode shift from
    confounding anomaly-detectability studies: the anomaly's signature stays the only thing
    that changed in its own window, and the underlying tune is still recognizably the same.
    synthetic_trace()'s calibration path passes regime_schedule=None and stays major throughout,
    so study-grade stimuli never see a mode change at all."""
    if not regime_schedule:
        return "major"
    for start, end, mode in regime_schedule:
        if start <= t < end:
            return mode
    return regime_schedule[-1][2]

# ----------------------------------------------------------------------------
# SECTIONS: compositional form (movements). Orthogonal to regime_schedule (mode) -- a section
# controls three things independently: which agent voices are audible (contraction/expansion of
# the ensemble), the tempo (harmonic-rhythm/melody-note speed, not span timing -- spans still
# fire at their own scripted wall-clock seconds regardless of tempo), and where a real cadence
# (V -> I) lands. This exists ONLY for extended_demo_trace() -- synthetic_trace()'s calibration
# path passes sections=None everywhere and keeps its single fixed tempo/full-ensemble/no-cadence
# behavior exactly as before, so calibration-grade stimuli stay unaffected.
# ----------------------------------------------------------------------------

def tempo_at(t, sections, default_tempo):
    """Tempo (BPM) in effect at time t. Tempo changes ONLY at section boundaries (a discrete
    step, not a mid-section ramp) -- letting it drift continuously would move the 16th-note grid
    and chord-boundary math under events already scheduled against the old grid."""
    if not sections:
        return default_tempo
    for sec in sections:
        if sec["start"] <= t < sec["end"]:
            return sec["tempo_bpm"]
    return sections[-1]["tempo_bpm"]

def swing_at(t, sections, default_swing):
    """Swing ratio in effect at time t -- sections may set their own (a ballad coda straight, an
    up-tempo chorus swung), which is what "swing in parts" means here."""
    if not sections:
        return default_swing
    for sec in sections:
        if sec["start"] <= t < sec["end"]:
            return sec.get("swing", default_swing)
    return sections[-1].get("swing", default_swing)

_OUTPUT_TRANSPOSE_BY_CHANNEL = {VOICES[v][0]: semis for v, semis in VOICE_OUTPUT_TRANSPOSE.items()}
CHANNEL_TO_VOICE = {ch: name for name, (ch, _p, _b) in VOICES.items()}

def transposed_note(channel, note):
    """A note shifted by its voice's output transpose (see VOICE_OUTPUT_TRANSPOSE), MIDI-clamped."""
    return max(0, min(127, note + _OUTPUT_TRANSPOSE_BY_CHANNEL.get(channel, 0)))

def apply_output_transpose(timeline):
    """Apply VOICE_OUTPUT_TRANSPOSE in place to every note message in a (t, counter, msg) list.
    Done once, at the output boundary, for the reason in VOICE_OUTPUT_TRANSPOSE's comment."""
    if not _OUTPUT_TRANSPOSE_BY_CHANNEL:
        return
    for _t, _c, msg in timeline:
        if msg.type in ("note_on", "note_off"):
            msg.note = transposed_note(msg.channel, msg.note)

def apply_swing(t, beat_s, ratio):
    """Map a straight time onto a swung one: the first eighth of each beat is stretched to
    `ratio` of the beat and the second compressed into what's left, so an off-beat eighth lands
    late (long-short). ratio 0.5 leaves the time untouched. Monotonic within and across beats,
    so event ORDER is never changed -- only the feel."""
    if ratio <= SWING_STRAIGHT or beat_s <= 0:
        return t
    beat_idx = int(t // beat_s)
    frac = (t - beat_idx * beat_s) / beat_s
    if frac < 0.5:
        frac = frac * (ratio / 0.5)
    else:
        frac = ratio + (frac - 0.5) * ((1.0 - ratio) / 0.5)
    return (beat_idx + frac) * beat_s

def voices_active_at(t, sections):
    """The set of agent-voice role names ('planner', 'worker1', ...) plus optionally 'melody'
    allowed to sound at time t, or None if sections is None (meaning: no gating, every voice may
    sound -- synthetic_trace()'s behavior). The ARCH_VOICES (arch1/arch2) are never members of
    this set and are never gated: they articulate every chord change unconditionally, so the
    sparsest point in any section still has the piano chord sounding, and nothing ever silences
    the harmony itself."""
    if not sections:
        return None
    for sec in sections:
        if sec["start"] <= t < sec["end"]:
            return sec["active_voices"]
    return sections[-1]["active_voices"]

MELODY_NOTE_GAP_BARS = 0.5    # a melody note every half bar, AT ACTIVITY_LEVEL=0 -- see density_factor
MELODY_ROTATION_BARS = 8      # switch performer style every N bars
MELODY_VELOCITY = 58          # fixed, gentle -- not agent-driven, so not telemetry (like the arch voices)
MELODY_NOTE_DURATION_FRAC = 0.85   # mostly fills the gap to the next note (legato-ish)
ARPEGGIO_PROBABILITY = 0.35   # base probability; melody's actual probability scales with activity_level

# The line's contour carries forward note-to-note (see generate_solo_melody), which means an
# unbounded walk can drift monotonically in one direction if a performer's interval distribution
# has any net bias, and once it hits the MIDI ceiling (127) it gets stuck there: clamping the
# result back to 127 every time just re-feeds 127 in as the next step's anchor, so the line
# freezes on one repeated pitch instead of continuing to move. Measured: with no bound, 70% of a
# 115s demo run's melody notes ended up in [120,127], effectively a single stuck pitch for most
# of the piece. Bounding the walk to a register window and REFLECTING (flipping the step's sign)
# instead of clamping keeps it moving and keeps it in a real singable tessitura, like an actual
# melodic line, rather than a random walk with a wall at one end.
MELODY_REGISTER_SPAN = 18   # semitones the line may roam above/below its home register

# Phrasing. A real soloist plays in PHRASES separated by rests -- a horn player has to breathe,
# and a pianist phrases anyway. Without this the line is one unbroken stream of notes from the
# first bar to the last, which reads as a constant flurry rather than the asked-for "long
# flurries of notes to minimalist approach": a flurry only reads as a flurry if there's silence
# around it. Phrase length and rest length both scale with activity_level in opposite directions
# -- a busy swarm gets long phrases with short gaps (runs on, breathless), an idle one gets a
# couple of notes and a long rest (minimalist).
MELODY_PHRASE_NOTES_IDLE = 2         # notes per phrase when no agents are active
MELODY_PHRASE_NOTES_PER_ACTIVITY = 3  # additional notes per active agent
MELODY_REST_BARS_IDLE = 1.5          # rest after a phrase when idle (long)
MELODY_REST_BARS_BUSY = 0.25         # rest after a phrase when very busy (short)
MELODY_BUSY_ACTIVITY = 4.0           # activity_level treated as "fully busy" for the rest scale

# ----------------------------------------------------------------------------
# MOTIF. Without this the solo plays correct notes with no memory: it never states an idea and
# then answers it, which is why a line can be harmonically flawless and still sound like
# noodling. A motif is generated ONCE per piece and then stated, varied, and re-stated -- the
# melodic counterpart of what the repeating form does harmonically (see the FORM comment).
#
# It is defined as CHORD-TONE offsets, not semitones: each entry is a step in "chord tones away
# from where the phrase started", so realizing the same motif over a different chord
# automatically re-spells it in that chord and it can never be out of key. That's also what
# makes the recurrence recognizable across a ii-V-I -- same shape, new harmony, which is exactly
# how a jazz musician develops an idea.
#
# Transformations are the classical set, kept deliberately small (exact / inverted / retrograde /
# free) because rhythm-altering ones like augmentation interact with the phrase-and-rest timing
# and were the obvious place for this to sprawl. A chorus top always states the motif exactly --
# that's the structural anchor a listener can hold onto.
# ----------------------------------------------------------------------------
MOTIF_LEN = 4
MOTIF_CHORD_TONE_SEMITONES = 3.5   # rough semitones per chord-tone step, for realizing contour
MOTIF_PHRASE_WEIGHTS = {"exact": 0.34, "inverted": 0.20, "retrograde": 0.16, "free": 0.30}

def generate_motif(seed=0):
    """The piece's melodic cell: MOTIF_LEN (cumulative chord-tone offset, duration multiplier)
    pairs, generated once. Offsets are cumulative so the motif has a real contour rather than a
    set of unrelated jumps; steps of 1-2 chord tones keep it singable."""
    rng = random.Random(action_hash(f"motif-seed{seed}"))
    offsets = [0]
    for _ in range(MOTIF_LEN - 1):
        offsets.append(offsets[-1] + rng.choice([-2, -1, -1, 1, 1, 2]))
    durations = [rng.choice([1.0, 1.0, 1.0, 0.5, 1.5]) for _ in range(MOTIF_LEN)]
    return list(zip(offsets, durations))

def motif_variant(motif, kind):
    """One of the classical transformations. 'free' returns None, meaning the caller should fall
    back to its own walk for that phrase -- a solo that only ever states the motif is as
    mechanical as one that never does."""
    if kind == "exact":
        return motif
    if kind == "inverted":
        return [(-off, dur) for off, dur in motif]
    if kind == "retrograde":
        return list(reversed(motif))
    return None

def motif_as_text(motif):
    """The motif written as chord-tone offsets and rhythm, for --show-form."""
    return "  ".join(f"{off:+d}({dur:g})" for off, dur in motif)

def generate_solo_melody(total_seconds, default_tempo, voicing_schedule, corpus_model,
                          add, seed=0, sections=None):
    """An always-on solo piano line that isn't tied to any single agent's telemetry -- like the
    arch chord voices, its velocity stays fixed rather than carrying any signal. What it DOES
    do: realize the same evolving chord progression as the chorale (always on that chord's own
    tones), rotating which PERFORMER's melodic-interval statistics govern its steps-vs-leaps
    tendency every MELODY_ROTATION_BARS bars -- Parker's angular bebop lines one stretch,
    Coltrane's sheets-of-sound the next, and so on (Weimar Jazz Database soloists, not Romantic
    composers). The line carries its own contour forward (each note's register is relative to
    the PREVIOUS note, not a fixed anchor), so it reads as one continuous singing line even as
    the underlying style rotates under it.

    Density is activity-driven ("long flurries of notes to a minimalist approach," per the
    user's own framing): busier chord windows (higher activity_level, from
    generate_voicing_schedule) get a shorter note gap AND a higher arpeggio-run probability --
    real flurries of notes -- while quiet windows stretch the gap out and rarely run, reading as
    sparse/minimalist. This is the one place activity_level touches the melody; everything else
    about it (which performer, which pitch) is corpus/contour-driven, not telemetry-driven, same
    separation as the chord voices.

    When sections is given, bar length (and so note rate/rotation rate) recomputes per section
    from that section's own tempo -- a fast climax section's melody moves in quicker note values
    than a slow coda's, without changing WHEN in wall-clock time any of this happens. At the
    sparsest sections (voices_active_at excludes 'melody'), the line still advances its contour
    silently -- no note_on is sent -- so it re-enters at the right register instead of a jarring
    jump when the section reopens it."""
    performer_dists = corpus_model.get("performer_interval_distributions", {})
    if not performer_dists:
        return   # no per-performer data available (e.g. the fallback model)
    performers = sorted(performer_dists.keys())
    ch = VOICES["melody"][0]
    home_register = VOICES["melody"][2]
    register_low, register_high = home_register - MELODY_REGISTER_SPAN, home_register + MELODY_REGISTER_SPAN
    note = home_register   # start at the voice's home register

    motif = generate_motif(seed)
    t, i = 0.0, 0
    phrase_notes_left, phrase_idx = 0, 0   # phrasing state -- see MELODY_PHRASE_* above
    phrase_motif, phrase_pos, phrase_anchor = None, 0, note   # motif state -- see MOTIF above
    phrase_base_tone = 0
    while t < total_seconds:
        tempo = tempo_at(t, sections, default_tempo)
        bar_s = grid_seconds(tempo) * 16
        voicing, quality, root_pc, activity_level = voicing_window_at(t, voicing_schedule)

        density_factor = 1.0 + 0.35 * activity_level   # >=1, grows with activity -- shorter gap
        gap = (bar_s * MELODY_NOTE_GAP_BARS) / density_factor
        rotation_s = bar_s * MELODY_ROTATION_BARS

        # Start a new phrase if the last one finished -- see the MELODY_PHRASE_* comment. A
        # phrase either develops the motif (exact / inverted / retrograde) or is free material;
        # the top of a chorus ALWAYS states it exactly, so the return of the form and the return
        # of the tune's melodic idea land together.
        if phrase_notes_left <= 0:
            ph = action_hash(f"melody-phrase-{phrase_idx}-seed{seed}")
            target = MELODY_PHRASE_NOTES_IDLE + MELODY_PHRASE_NOTES_PER_ACTIVITY * activity_level
            phrase_notes_left = max(1, round(target * (0.6 + 0.8 * ((ph % 1000) / 1000.0))))
            at_chorus_top = bar_in_form_at(t, voicing_schedule) == 0
            if at_chorus_top:
                kind = "exact"
            else:
                kind = weighted_choice_str(MOTIF_PHRASE_WEIGHTS, seed=ph)
            phrase_motif = motif_variant(motif, kind)
            if phrase_motif:
                phrase_notes_left = len(phrase_motif)   # a motif statement is its own length
            phrase_pos = 0
            phrase_anchor = note
            # The motif's offsets are relative to ONE chord-tone slot chosen per phrase, not
            # re-rolled per note: re-rolling was a real bug that scrambled the contour, so
            # statements shared no recognizable shape at all (verified by printing the
            # semitone contour of each statement -- they were unrelated before this).
            phrase_base_tone = _melody_tone_index(JAZZ_CHORD_TONES[quality], ph)
            phrase_idx += 1

        performer = performers[int(t // rotation_s) % len(performers)]
        interval_dist = performer_dists[performer]

        seed_key = f"melody-note-{i}-seed{seed}"
        slot_seed = action_hash(seed_key)
        tones = JAZZ_CHORD_TONES[quality]
        note_gap = gap

        if phrase_motif:
            # Motif note: the offset is in CHORD TONES, so it re-spells itself against whatever
            # chord is current and can't fall out of key. The contour is realized by aiming at
            # the anchor plus that many chord-tone steps and snapping to the nearest note of the
            # chosen tone -- so the shape survives even as the harmony moves underneath it.
            offset, dur_mult = phrase_motif[min(phrase_pos, len(phrase_motif) - 1)]
            tone_idx = (phrase_base_tone + offset) % len(tones)
            pitch_class = (root_pc + tones[tone_idx]) % 12
            aim = phrase_anchor + offset * MOTIF_CHORD_TONE_SEMITONES
            note = note_near_step(int(round(aim)), 0, pitch_class)
            note_gap = gap * dur_mult
        else:
            pitch_class = (root_pc + tones[_melody_tone_index(tones, slot_seed)]) % 12
            step = weighted_choice_from_dist(interval_dist, seed=slot_seed)
            # Reflect off the register window instead of letting the walk run away (and
            # clamp-stick at the MIDI ceiling) -- see MELODY_REGISTER_SPAN's comment.
            if note + step > register_high:
                step = -abs(step)
            elif note + step < register_low:
                step = abs(step)
            note = note_near_step(note, step, pitch_class)   # relative to the line's own last note

        # note_near_step's own pitch-class search can overshoot the window from a step taken near
        # the edge (it searches up to +/-12 semitones from the candidate for a matching pitch
        # class, which isn't itself window-aware) -- fold back by the octave (preserves pitch
        # class exactly, unlike clamping) as a hard guarantee. Applies to motif notes too, whose
        # aim point can land outside the register for a large offset.
        while note > register_high:
            note -= 12
        while note < register_low:
            note += 12
        phrase_pos += 1

        active = voices_active_at(t, sections)
        audible = active is None or "melody" in active
        if audible:
            # Run probability spans a real range (idle ~0.15 to busy ~0.6) rather than sitting
            # high everywhere: if most notes became runs, a run would stop reading as an event
            # and the whole line would flatten back into the constant flurry this is fixing.
            # A motif statement is never broken into a run -- the whole point is that its shape
            # is recognizable, and a flurry would bury it.
            arp_probability = 0.0 if phrase_motif else min(0.6, 0.15 + 0.12 * activity_level)
            arp = jazz_arpeggio_notes(seed_key, root_pc, quality, note, arp_probability)
            if arp:
                step_dur = (note_gap * MELODY_NOTE_DURATION_FRAC) / len(arp)
                for j, n in enumerate(arp):
                    t0 = t + j * step_dur
                    add(t0, mido.Message("note_on", channel=ch, note=n, velocity=MELODY_VELOCITY))
                    add(t0 + step_dur * 0.9, mido.Message("note_off", channel=ch, note=n, velocity=0))
                note = arp[-1]   # continue the line's contour from where the run ended
            else:
                vel = MELODY_VELOCITY + (8 if phrase_motif else 0)   # state the idea, don't mumble it
                add(t, mido.Message("note_on", channel=ch, note=note, velocity=vel))
                add(t + note_gap * MELODY_NOTE_DURATION_FRAC,
                    mido.Message("note_off", channel=ch, note=note, velocity=0))
        t += note_gap
        i += 1

        # End of a phrase: rest before the next one. The rest is what makes the preceding notes
        # read as a phrase rather than part of one endless stream.
        phrase_notes_left -= 1
        if phrase_notes_left <= 0:
            busy_frac = min(1.0, activity_level / MELODY_BUSY_ACTIVITY)
            rest_bars = MELODY_REST_BARS_IDLE + (MELODY_REST_BARS_BUSY - MELODY_REST_BARS_IDLE) * busy_frac
            rh = action_hash(f"melody-rest-{phrase_idx}-seed{seed}")
            rest_bars *= 0.7 + 0.6 * ((rh % 1000) / 1000.0)   # vary it so phrasing isn't metronomic
            t += bar_s * rest_bars

# ----------------------------------------------------------------------------
# TRACE -> TIMED MIDI MESSAGES
# ----------------------------------------------------------------------------

def build_timeline(spans, tempo, speed, do_drift, corpus_model, regime_schedule=None, seed=0,
                    sections=None, form=None, swing=SWING_DEFAULT):
    """Return a sorted list of (time_seconds, mido.Message).

    The harmony is a FIXED REPEATING FORM (see generate_jazz_form): one chorus of changes,
    generated once and tiled across the whole piece, so the piece has a key and a recognizable
    theme. Telemetry never changes WHICH chord is playing -- it varies the voicing/inversion,
    the articulation, and the solo's density on top of fixed changes. form (optional) lets a
    caller pass a pre-generated (major_form, minor_form) pair, e.g. to print it or to reuse the
    identical tune across runs; omitted, it's generated from corpus_model and seed.

    regime_schedule (optional) is a list of (start, end, "major"/"minor") windows selecting
    which REALIZATION of that same form plays -- the major and minor cell vocabularies are
    index-aligned functional analogues, so a mode shift recolors the same tune (modal
    interchange) rather than substituting a different progression. Leave it None (the default)
    for calibration-grade stimuli, where the piece stays major throughout.

    seed controls the form and the melody -- default 0 always, which is what the calibration
    path uses; --demo can pass a different seed for a different tune each run.

    sections (optional) is a list of dicts with start/end/tempo_bpm/active_voices: per-section
    tempo and which voices are audible. Sections no longer touch the harmony at all (the form
    supplies its own cadences, every chorus) -- they're the arrangement layer, like the
    head/solos/out-head structure of a chart. None (what synthetic_trace() uses) keeps a single
    tempo and the full ensemble throughout."""
    grid = grid_seconds(tempo)   # only used as the fallback grid when sections is None
    timeline = []  # (t, order, message) ; order breaks ties deterministically
    counter = 0

    def add(t, msg):
        """Times go in RAW here (not yet divided by speed) -- swing is applied over the whole
        timeline at the end, and it needs real musical time to know where the beat is."""
        nonlocal counter
        timeline.append((t, counter, msg))
        counter += 1

    # Program changes up front so a GM device sounds like piano everywhere.
    for role, (ch, prog, _base) in VOICES.items():
        add(0.0, mido.Message("program_change", channel=ch, program=prog))

    end = max((s["start"] + s.get("duration", 0.5) for s in spans), default=8.0) + 2.0
    if sections:
        # sections can define a tail past the last span (settling room after the last event);
        # keep the piece-level `end` (melody length, final backbone note-off) in sync with that.
        end = max(end, sections[-1]["end"])

    major_form, minor_form = form if form else generate_jazz_form(corpus_model, seed=seed)
    chord_schedule = generate_chord_schedule(end, tempo, major_form, minor_form,
                                              regime_schedule=regime_schedule, sections=sections)

    # Resolve every span's TRUE agent id onto a physical chord voice ONCE, up front, via the
    # shared VoicePool (see the VOICE POOL block comment) -- the same algorithm live.py's
    # LivePlayer runs per-span as spans actually arrive. `resolved` and `voice_pool` both feed
    # forward into generate_voicing_schedule and the per-span loop below; voice_pool.overflow_events
    # is the saturation-ceiling measurement (see --show-pool-stats).
    resolved, voice_pool = pool_spans(spans)

    # The 7-voice chorale voicing, one per chord window (see jazz_chorale_voicing/
    # generate_voicing_schedule) -- pitch for every chord-voice span comes from here, never
    # drawn per span. Computed once, up front, since the harmonic-backbone loop below, the
    # melody line, and the per-span loop all need it.
    voicing_schedule = generate_voicing_schedule(chord_schedule, spans, seed=seed, sections=sections,
                                                  resolved=resolved)

    # The COMP: at every chord change, every currently-live chord voice states its assigned tone
    # and holds it through the bar, so the chord is fully spelled and continuously sounding
    # rather than implied by two notes (see the CHORALE VOICING block comment for why this
    # replaced an arch-voices-only backbone). Agent spans re-articulate on top of this, louder.
    # Section gating still applies to agent voices; the arch voices are never gated, so the
    # harmony never vanishes entirely.
    # Goal-drift onset lag: looked up here (before the comp loop) so the loop can delay
    # DRIFT_TARGET's onset while every other voice stays on the shared grid -- see
    # DRIFT_MAX_ONSET_OFFSET_S above for why this, not the pitch bend, is the claimed-audible cue.
    drift = next((s for s in spans if s.get("drift_start")), None) if do_drift else None
    # DRIFT_TARGET is the calibration path's fixed choice (worker2); a marker span injected by
    # drift_detect.py (--detect-drift) carries its own detected agent as "agent", so a detected
    # drift can render on whichever voice the detector actually flagged, not just worker2.
    drift_target = drift.get("agent", DRIFT_TARGET) if drift else DRIFT_TARGET

    def drift_onset_delay_s(t):
        if not drift:
            return 0.0
        t0 = drift["drift_start"]
        if t < t0:
            return 0.0
        window = drift.get("drift_window", 8.0)
        frac = min(1.0, (t - t0) / window)
        return DRIFT_MAX_ONSET_OFFSET_S * frac

    # Anticipations first: a bar can be "pushed" (the chord landing an eighth early), which needs
    # to be known BEFORE emitting the previous bar so that bar can be shortened to make room.
    pushes = []
    for i, w in enumerate(voicing_schedule):
        start, end_w = w[0], w[1]
        beat_s = (end_w - start) / 4.0
        h = action_hash(f"comp-push-{i}-seed{seed}")
        pushed = i > 0 and (h % 1000) / 1000.0 < COMP_PUSH_PROBABILITY
        pushes.append(beat_s * 0.5 if pushed else 0.0)

    for i, (start, end_w, voicing, quality, root_pc, activity_level, live_voices,
            bar_in_form, bass_note) in enumerate(voicing_schedule):
        attack = start - pushes[i]
        next_attack = voicing_schedule[i + 1][0] - pushes[i + 1] if i + 1 < len(voicing_schedule) else end_w
        dur = min(next_attack - attack, 6.0) * COMP_SUSTAIN_FRAC

        # Emphasis: lean on the top of a chorus (the tune coming back around) and on a V -> I
        # arrival; everything else supports. A push is itself an accent.
        accent = 0
        if bar_in_form == 0:
            accent += COMP_ACCENT_FORM_TOP
        prev_root = voicing_schedule[i - 1][4] if i > 0 else None
        if prev_root == 7 and root_pc == 0:
            accent += COMP_ACCENT_CADENCE
        if pushes[i] > 0:
            accent += COMP_PUSH_ACCENT

        section_voices = voices_active_at(start, sections)
        for voice in CHORD_VOICE_ORDER:
            if voice not in live_voices:
                continue   # this agent has gone quiet -- its tone drops out of the chord
            if voice not in ARCH_VOICES and section_voices is not None and voice not in section_voices:
                continue   # arrangement contracted this voice out of the section
            ch = VOICES[voice][0]
            note = voicing[voice]
            vel = max(1, min(127, COMP_VELOCITY + accent))
            voice_attack = attack
            if voice == drift_target:
                voice_attack += drift_onset_delay_s(attack)
            add(max(0.0, voice_attack), mido.Message("note_on", channel=ch, note=note, velocity=vel))
            add(max(0.0, voice_attack) + dur, mido.Message("note_off", channel=ch, note=note, velocity=0))

    # Walking bass on its own instrument (ch9), never section-gated or liveness-gated -- a rhythm
    # section's bass is the anchor and the last thing to drop out. Two feel when the swarm is
    # quiet, four feel when it's busy -- see the WALKING BASS comment.
    bass_ch = VOICES[BASS_VOICE][0]
    for i, (start, end_w, voicing, quality, root_pc, activity_level, live_voices,
            bar_in_form, bass_note) in enumerate(voicing_schedule):
        beat_s = (end_w - start) / 4.0
        nxt = voicing_schedule[i + 1] if i + 1 < len(voicing_schedule) else None
        next_target = nxt[8] if nxt else bass_note
        four_feel = activity_level >= WALK_FOUR_FEEL_ACTIVITY
        bar = walking_bass_bar(bass_note, next_target, root_pc, quality, four_feel,
                                f"walk-{i}-seed{seed}")
        for beat_off, note in bar:
            t0 = start + beat_off * beat_s
            if t0 >= end:
                break
            vel = WALK_VELOCITY + (COMP_ACCENT_FORM_TOP // 2 if (bar_in_form == 0 and beat_off == 0.0) else 0)
            vel = max(1, min(127, vel))
            note = max(0, min(127, note))
            add(t0, mido.Message("note_on", channel=bass_ch, note=note, velocity=vel))
            add(t0 + beat_s * WALK_NOTE_FRAC, mido.Message("note_off", channel=bass_ch, note=note, velocity=0))

    # Solo melody line: always-on, not agent-driven (see generate_solo_melody's docstring),
    # rotating between performer "handwriting" styles while staying on the current chord's tones,
    # with activity-driven density (flurries when busy, minimalist when quiet).
    generate_solo_melody(end, tempo, voicing_schedule, corpus_model, add, seed=seed, sections=sections)

    # Per-span notes (DIRECT tier, the 5 agent-driven chord voices) -- shared mapping, see
    # emit_span_events.
    for s in spans:
        onset_grid = grid_seconds(tempo_at(s["start"], sections, tempo)) if sections else grid
        onset = quantize(s["start"], onset_grid)
        voicing, quality, root_pc, _activity = voicing_window_at(onset, voicing_schedule)
        active_voices = voices_active_at(onset, sections)
        emit_span_events(s, onset, root_pc, quality, voicing, add, active_voices=active_voices,
                          resolved_voice=resolved.get(id(s)))

    # Injected goal-drift: ramp the target voice's pitch bend flat and hold (secondary micro-cue;
    # the onset lag applied in the comp loop above, via drift_onset_delay_s, is the primary one).
    if drift:
        ch = VOICES[drift_target][0]
        t0 = drift["drift_start"]
        window = drift.get("drift_window", 8.0)
        steps = int(window * 1000 / DRIFT_STEP_MS)
        for i in range(steps + 1):
            frac = i / steps
            bend = int(DRIFT_MAX_BEND * frac)
            add(t0 + frac * window, mido.Message("pitchwheel", channel=ch, pitch=bend))
        # hold the sour bend to the end (already at DRIFT_MAX_BEND)

    # Inter-agent conflict -> convergence: hold a static sharp tension on "b"'s voice, then
    # resolve to zero and mark the reconvergence with a short consonant cadence.
    conflict = next((s for s in spans if s.get("conflict_start")), None)
    if conflict:
        a_role, b_role = CONFLICT_PAIR
        ch_a, _, base_a = VOICES[a_role]
        ch_b, _, base_b = VOICES[b_role]
        t0 = conflict["conflict_start"]
        window = conflict.get("conflict_window", 4.0)
        add(t0, mido.Message("pitchwheel", channel=ch_b, pitch=CONFLICT_BEND))
        add(t0 + window, mido.Message("pitchwheel", channel=ch_b, pitch=0))
        convergence_cadence(ch_a, ch_b, base_a, base_b, t0 + window, add, corpus_model["cadence_patterns"][0])

    # Collusion candidate: two independent voices suddenly lock into an unexpected unison.
    collusion = next((s for s in spans if s.get("collusion_start")), None)
    if collusion:
        a_role, b_role = COLLUSION_PAIR
        ch_a = VOICES[a_role][0]
        ch_b = VOICES[b_role][0]
        collusion_unison(ch_a, ch_b, collusion["collusion_start"], add)

    # Swing, applied last and to EVERYTHING at once so the whole band swings together (see
    # SWING_DEFAULT). Monotonic and sub-beat, so it never reorders events -- and applied before
    # the speed division, since it needs real musical time to locate the beat.
    timeline = [(apply_swing(t, 60.0 / tempo_at(t, sections, tempo),
                              swing_at(t, sections, swing)), c, msg)
                for (t, c, msg) in timeline]

    apply_output_transpose(timeline)
    timeline.sort(key=lambda x: (x[0], x[1]))
    return [(t / speed, msg) for (t, _c, msg) in timeline]

# ----------------------------------------------------------------------------
# SYNTHETIC TRACE (planner + 3 workers, ~30s)
# ----------------------------------------------------------------------------

def synthetic_trace():
    spans = []

    def span(agent, op, start, dur, tokens=120, tool=None, status="ok", **extra):
        d = dict(agent=agent, op=op, start=start, duration=dur,
                 tokens=tokens, status=status)
        if tool:
            d["tool"] = tool
        d.update(extra)
        spans.append(d)

    # planner reasons, then spawns workers (voices enter -> crescendo)
    span(ORCHESTRATOR_AGENT_ID, "chat", 0.0, 1.2, tokens=300)
    span(ORCHESTRATOR_AGENT_ID, "chat", 1.6, 1.0, tokens=220)
    span("worker1", "create_agent", 2.4, 0.3, tokens=40)   # entrance
    span("worker2", "create_agent", 4.2, 0.3, tokens=40)
    span("worker3", "create_agent", 6.0, 0.3, tokens=40)

    # workers act; tool calls = plucks
    for t in [3.0, 5.5, 8.0, 10.5, 13.0]:
        span("worker1", "chat", t, 0.8, tokens=160)
        span("worker1", "execute_tool", t + 0.9, 0.2, tokens=30, tool="search")
    for t in [5.0, 7.5, 10.0, 12.5, 15.0, 17.5]:
        span("worker2", "chat", t, 0.9, tokens=180)
        span("worker2", "execute_tool", t + 1.0, 0.2, tokens=25, tool="fetch")
    span("worker3", "chat", 7.0, 0.7, tokens=140)
    span("worker3", "execute_tool", 9.3, 0.2, tokens=20, tool="fetch_doc")  # external ingestion
    # capture spike: sharp behavior change right after the ingestion above (clarinet gets a
    # chromatic wrong-note cluster at onset, distinct from worker2's slow drift below)
    span("worker3", "chat", 9.6, 0.6, tokens=150, capture_spike=True)
    span("worker3", "chat", 12.0, 0.7, tokens=140)

    # a tool error -> dissonant grace note
    span("worker1", "execute_tool", 14.2, 0.2, tokens=30, tool="search", status="error")

    # worker3 stalls after 12s (no further spans -> its voice falls silent)

    # goal drift injected on worker2 starting at 12s for 8s (oboe bends flat)
    span("worker2", "chat", 12.0, 0.9, tokens=200, drift_start=12.0, drift_window=8.0)

    # Inter-agent conflict, then convergence: planner and worker1 are the two voices not
    # already carrying an anomaly by this point. They hold tension for 4s, then resolve.
    span(ORCHESTRATOR_AGENT_ID, "chat", 21.0, 0.9, tokens=200)
    span("worker1", "chat", 21.3, 0.8, tokens=180, conflict_start=21.0, conflict_window=4.0)

    # Collusion candidate: the same pair, later, suddenly lock into an unexpected tight unison
    # they have no reason to share -- reusing the pair is deliberate, since by this point in the
    # trace they're the only voices left "healthy" enough for the eerie sync to read cleanly.
    span(ORCHESTRATOR_AGENT_ID, "chat", 26.6, 0.5, tokens=140)
    span("worker1", "chat", 27.0, 0.6, tokens=150, collusion_start=27.0)

    return spans

# ----------------------------------------------------------------------------
# EXTENDED DEMO TRACE (~110s, wide dynamic range, minor-mode crisis arc)
# ----------------------------------------------------------------------------
#
# Not the calibration-shaped trace above -- this is deliberately narrative: a real minor-mode
# stretch spanning the crisis (capture spike -> drift -> conflict), returning to major exactly
# at the moment of convergence. That coupling is fine HERE (a demo/listening piece) but would
# confound a Section 5.2 study (an anomaly's detectability can't be separated from a global mode
# change), so build_timeline's regime_schedule stays optional and unused by synthetic_trace().
# Dynamics (velocity swells, density bursts vs. sparse stretches) come entirely from varying
# tokens= and event spacing -- both stay telemetry-driven per the mapping spec, not a separate
# musical layer.

def extended_demo_trace():
    spans = []

    def span(agent, op, start, dur, tokens=120, tool=None, status="ok", **extra):
        d = dict(agent=agent, op=op, start=start, duration=dur, tokens=tokens, status=status)
        if tool:
            d["tool"] = tool
        d.update(extra)
        spans.append(d)

    # --- Movement 1: opening, calm, staggered entrances (0-16s, major) ---
    span(ORCHESTRATOR_AGENT_ID, "chat", 0.0, 1.5, tokens=280)
    span(ORCHESTRATOR_AGENT_ID, "chat", 2.2, 1.0, tokens=200)
    span("worker1", "create_agent", 3.5, 0.3, tokens=40)
    for i, t in enumerate([4.5, 7.0, 9.5, 12.0, 14.5]):
        span("worker1", "chat", t, 0.7, tokens=130 + i * 15)
        span("worker1", "execute_tool", t + 0.75, 0.2, tokens=25, tool="search")
    span("worker2", "create_agent", 6.0, 0.3, tokens=40)
    for i, t in enumerate([7.5, 10.0, 12.5, 15.0]):
        span("worker2", "chat", t, 0.8, tokens=150 + i * 20)
        span("worker2", "execute_tool", t + 0.85, 0.2, tokens=25, tool="fetch")
    span("worker3", "create_agent", 8.5, 0.3, tokens=40)
    for t in [10.5, 13.0, 15.5]:
        span("worker3", "chat", t, 0.6, tokens=110)

    # --- Movement 2: rising action, denser bursts, higher tokens (16-30s, major) ---
    for i, t in enumerate([16.5, 18.0, 19.5, 21.0, 22.5, 24.0, 25.5, 27.0, 28.5]):
        span("worker1", "chat", t, 0.6, tokens=250 + (i % 4) * 30)
        span("worker1", "execute_tool", t + 0.65, 0.2, tokens=35, tool="search")
    for i, t in enumerate([17.0, 19.5, 22.0, 24.5, 27.0, 29.5]):
        span("worker2", "chat", t, 0.7, tokens=230 + (i % 3) * 40)
        span("worker2", "execute_tool", t + 0.75, 0.2, tokens=30, tool="fetch")
    for t in [17.5, 20.5, 23.5, 26.5, 29.0]:
        span("worker3", "chat", t, 0.6, tokens=190)
    for t in [18.5, 23.0, 27.5]:   # planner (Basses) checking in periodically, not silent for 14s
        span(ORCHESTRATOR_AGENT_ID, "chat", t, 0.8, tokens=220)

    # --- Movement 3: capture spike, crisis begins, regime shifts to minor here (30-34s) ---
    span("worker3", "execute_tool", 30.0, 0.2, tokens=20, tool="fetch_doc")   # external ingestion
    span("worker3", "chat", 30.4, 0.6, tokens=210, capture_spike=True)
    # worker3 falls silent right as things turn dark -- no further worker3 spans (stall signature)

    # --- Movement 4: drift crisis, minor -- tension building into a sustained fortissimo
    # climax, then release before the conflict movement (34-60s) ---
    span("worker2", "chat", 35.0, 0.9, tokens=250, drift_start=35.0, drift_window=14.0)

    # rising tension (35.5-44s): moderate, still building, not yet at full density
    tension_tokens = [180, 210, 240, 260, 300]
    for i, t in enumerate([36.5, 38.5, 40.5, 42.5, 44.0]):
        agent = "worker1" if i % 2 == 0 else "worker2"
        span(agent, "chat", t, 0.6, tokens=tension_tokens[i])
    span(ORCHESTRATOR_AGENT_ID, "chat", 37.5, 0.7, tokens=230)
    span(ORCHESTRATOR_AGENT_ID, "chat", 41.5, 0.7, tokens=260)

    # fortissimo climax (44.5-58.6s): dense, loud, SUSTAINED (not swinging back down) -- the
    # "epic anthem" the tension has been building toward. Tool calls fire on every hit here,
    # not just the loud ones, for maximum density. planner (Basses) drives the downbeats so
    # there's real bass motion under the climax, not just the upper voices.
    climax_tokens = [430, 460, 440, 480, 450, 470, 440, 490, 460, 450]
    for i, t in enumerate([44.5, 46.0, 47.5, 49.0, 50.5, 52.0, 53.5, 55.0, 56.5, 58.0]):
        agent = "worker1" if i % 2 == 0 else "worker2"
        span(agent, "chat", t, 0.6, tokens=climax_tokens[i])
        span(agent, "execute_tool", t + 0.65, 0.15, tokens=40, tool="search" if agent == "worker1" else "fetch")
        if i % 2 == 0:   # planner on every other (downbeat) climax hit
            span(ORCHESTRATOR_AGENT_ID, "chat", t, 0.7, tokens=climax_tokens[i] - 20)
    span("worker1", "execute_tool", 47.2, 0.2, tokens=30, tool="search", status="error")
    span("worker2", "execute_tool", 55.2, 0.2, tokens=30, tool="fetch", status="error")

    # --- Movement 5: conflict -> convergence, return to major at resolution (60-78s) ---
    # worker2/tools keep working right through the conflict. The conflict is between planner and
    # worker1, but that's no reason for the whole piece to thin out to two voices for 18 seconds:
    # an earlier version of this movement had exactly TWO spans in it, which read as a hole in
    # the piece rather than a contraction (visible as dead track space in Logic, and the reason
    # the back half looked so empty). worker3 stays silent -- that's the stall signature, not a
    # gap to fill.
    for i, t in enumerate([60.5, 62.5, 66.5, 69.0, 71.0]):
        span("worker2", "chat", t, 0.7, tokens=205 - i * 15)
        span("worker2", "execute_tool", t + 0.75, 0.2, tokens=30, tool="fetch")
    span(ORCHESTRATOR_AGENT_ID, "chat", 61.0, 0.8, tokens=210)
    span(ORCHESTRATOR_AGENT_ID, "chat", 64.0, 0.9, tokens=220)
    span("worker1", "chat", 64.4, 0.8, tokens=200, conflict_start=64.0, conflict_window=8.0)
    span("worker1", "chat", 67.5, 0.7, tokens=195)
    span("worker1", "chat", 70.5, 0.7, tokens=185)
    # resolution/cadence lands at t=72.4 (conflict_start + conflict_window); regime returns to
    # major exactly there -- see REGIME_SCHEDULE below. Past it: settling, softer and thinner.
    span(ORCHESTRATOR_AGENT_ID, "chat", 73.5, 1.0, tokens=150)
    span("worker1", "chat", 74.8, 0.8, tokens=140)
    span("worker2", "chat", 76.0, 0.9, tokens=125)

    # --- Movement 6: collusion, eerie-in-major coda (78-95s) ---
    # Deliberately thinner than Movement 5 (this one IS meant to be a contraction), but not
    # empty -- enough activity that the collusion unison lands against something.
    span(ORCHESTRATOR_AGENT_ID, "chat", 79.5, 0.9, tokens=130)
    span("worker1", "chat", 81.2, 0.9, tokens=125)
    span(ORCHESTRATOR_AGENT_ID, "chat", 84.6, 0.6, tokens=160)
    span("worker1", "chat", 85.0, 0.6, tokens=170, collusion_start=85.0)
    span(ORCHESTRATOR_AGENT_ID, "chat", 88.5, 1.0, tokens=110)
    span("worker1", "chat", 90.8, 1.0, tokens=105)
    span(ORCHESTRATOR_AGENT_ID, "chat", 93.0, 1.1, tokens=95)

    # --- Movement 7: denouement, very sparse and quiet, tapering to the tonic (95-112s) ---
    span(ORCHESTRATOR_AGENT_ID, "chat", 97.0, 1.2, tokens=75)
    span(ORCHESTRATOR_AGENT_ID, "chat", 102.5, 1.4, tokens=55)
    span(ORCHESTRATOR_AGENT_ID, "chat", 108.0, 1.8, tokens=40)

    regime_schedule = [
        (0.0, 30.4, "major"),     # calm open through the capture-spike onset
        (30.4, 72.4, "minor"),    # crisis: capture spike -> drift -> conflict tension
        (72.4, 999.0, "major"),   # returns to major exactly at the convergence cadence
    ]

    # Compositional form: 8 sections (Movement 4 splits into its own tension/climax halves).
    # Tempo runs from a slow 60 BPM coda up to a 120 BPM fortissimo climax -- real tempo
    # contrast, not the single fixed 96 BPM the piece used to be pinned at throughout. Voice
    # sets contract and expand across the piece (worker3 alone at the capture spike, a thinner
    # pair-plus-support texture through the conflict, the eerie collusion coda thinner still,
    # full ensemble at the climax); the denouement contracts all the way down to nothing but the
    # two arch voices, per the "lone instrument is always the concert grand chords" design.
    # Every section boundary is also a forced V -> I cadence (see
    # generate_sectioned_chord_schedule).
    #
    # Contraction here means FEWER voices, not a hole: Movement 5 keeps worker2/tools audible so
    # the conflict plays out over a working ensemble rather than 18 seconds of near-silence.
    # worker3 is excluded from everything after the capture spike -- that's the stall signature,
    # and it's the one voice whose silence is the point.
    # "swing" is per-section on purpose ("a little swing in the rhythm in parts", not uniformly):
    # the head swings lightly, the climax hardest, and the two moments that should feel
    # unsettled or suspended -- the capture-spike crisis and the closing ballad -- go straight.
    # A section without a "swing" key inherits build_timeline's default.
    ALL_VOICES = {"planner", "worker1", "worker2", "worker3", "tools"}
    sections = [
        {"start": 0.0,  "end": 16.0,  "tempo_bpm": 80,  "swing": 0.58,
         "active_voices": ALL_VOICES | {"melody"}},
        {"start": 16.0, "end": 30.0,  "tempo_bpm": 100, "swing": 0.62,
         "active_voices": ALL_VOICES | {"melody"}},
        # capture spike / crisis onset: straight, so the ground drops out from under the feel
        {"start": 30.0, "end": 34.0,  "tempo_bpm": 90,  "swing": SWING_STRAIGHT,
         "active_voices": {"worker3", "tools", "melody"}},
        {"start": 34.0, "end": 44.5,  "tempo_bpm": 104, "swing": 0.60,
         "active_voices": ALL_VOICES | {"melody"}},
        {"start": 44.5, "end": 60.0,  "tempo_bpm": 120, "swing": 0.66,   # climax, hardest swing
         "active_voices": ALL_VOICES | {"melody"}},
        {"start": 60.0, "end": 78.0,  "tempo_bpm": 88,  "swing": 0.62,
         "active_voices": {"planner", "worker1", "worker2", "tools", "melody"}},
        {"start": 78.0, "end": 95.0,  "tempo_bpm": 76,  "swing": 0.58,
         "active_voices": {"planner", "worker1", "melody"}},
        # NOTE: unlike regime_schedule's 999.0 sentinel (harmless -- mode_at only ever does a
        # bounded lookup against it), a section's "end" directly drives how many bars of the form
        # get tiled. A 999.0 sentinel here would generate chords out to 999 seconds. 115.0 gives
        # a few bars of settling room past the last span (108.0 + 1.8s duration = 109.8s).
        {"start": 95.0, "end": 115.0, "tempo_bpm": 60, "swing": SWING_STRAIGHT,  # ballad coda
         "active_voices": set()},
    ]

    return spans, regime_schedule, sections

# ----------------------------------------------------------------------------
# PLAYBACK
# ----------------------------------------------------------------------------

# Standard MIDI default pitch-bend range: +/-8192 raw units spans +/-2 semitones. Matches the
# assumption already baked into DRIFT_MAX_BEND's own comment ("~ -1.5 semitone at +/-2 range") --
# stated here explicitly because export_events now needs to do the same unit conversion the synth
# does implicitly, and a silent mismatch between the two would misrepresent the anomaly's actual
# audible size in anything that consumes the export instead of raw MIDI.
PITCH_BEND_RANGE_SEMITONES = 2.0

def export_events(timeline, path, meta, chord_windows=None):
    """Write the rendered piece as JSON note events, PLUS continuous-deviation events.

    This is the payload the browser will consume (Tone.js schedules almost directly off it), and
    it is also what makes a sample-library A/B test CONTROLLED: exporting once and rendering the
    same events through both Logic and a browser sampler compares SOUNDS. Bouncing a performance
    from each separately would compare performances, which is a different and much less useful
    question. See ROADMAP.md 4.5.

    note_on/note_off pairs are collapsed into single events with a duration, since that's what a
    sampler wants and it halves the payload. Times are seconds from the start.

    Continuous deviations (drift's flattening ramp, conflict's held bend -- see
    build_timeline's do_drift block and DRIFT_TARGET/CONFLICT_BEND) used to be silently DROPPED
    here: export_events only ever looked at note_on/note_off, so every `pitchwheel` message in
    the timeline vanished on export. That meant the web prototype had a structural hole, not just
    a missing feature -- there was no CHANNEL in the interchange format for a continuous
    deviation to travel through at all, so engine.js could not have honoured one even if it tried.
    Fixed by collecting pitchwheel messages into a parallel "deviations" array, converting raw
    MIDI bend units to semitones (see PITCH_BEND_RANGE_SEMITONES) so a consumer doesn't need to
    know MIDI's bend-range convention to use this -- semitones is the portable unit. Each entry is
    a single point (t, voice, semitones); a caller reconstructs the shape (ramp vs. held step) by
    connecting consecutive points for the same voice, same as the original pitchwheel MESSAGE
    STREAM already implied a shape from a sequence of discrete changes."""
    open_notes = {}
    notes = []
    deviations = []
    for t, msg in timeline:
        if msg.type == "note_on":
            open_notes.setdefault((msg.channel, msg.note), []).append((t, msg.velocity))
        elif msg.type == "note_off":
            stack = open_notes.get((msg.channel, msg.note))
            if stack:
                t0, vel = stack.pop(0)
                notes.append({"t": round(t0, 4), "ch": msg.channel,
                              "voice": CHANNEL_TO_VOICE.get(msg.channel, "?"),
                              "note": msg.note, "vel": vel, "dur": round(max(0.01, t - t0), 4)})
        elif msg.type == "pitchwheel":
            semitones = (msg.pitch / 8192.0) * PITCH_BEND_RANGE_SEMITONES
            deviations.append({"t": round(t, 4), "ch": msg.channel,
                               "voice": CHANNEL_TO_VOICE.get(msg.channel, "?"),
                               "semitones": round(semitones, 4)})
    notes.sort(key=lambda n: (n["t"], n["ch"], n["note"]))
    deviations.sort(key=lambda d: (d["t"], d["ch"]))

    payload = dict(meta)
    payload["voices"] = {name: {"channel": ch,
                                 "role": ("bass" if name == BASS_VOICE
                                          else "solo" if name == "melody" else "chord")}
                          for name, (ch, _p, _b) in VOICES.items()}
    if chord_windows:
        payload["chords"] = [{"t": round(a, 4), "end": round(b, 4),
                              "symbol": chord_symbol(r, q), "root_pc": r, "quality": q}
                             for a, b, r, q in chord_windows]
    payload["notes"] = notes
    payload["deviations"] = deviations
    with open(path, "w") as f:
        json.dump(payload, f, indent=1)
    return len(notes)

def pick_port(requested):
    names = mido.get_output_names()
    if not names:
        sys.exit("No MIDI outputs found. Enable the IAC Driver in Audio MIDI Setup.")
    if requested:
        for n in names:
            if requested.lower() in n.lower():
                return n
        sys.exit(f"No port matching '{requested}'. Available: {names}")
    for n in names:
        if "iac" in n.lower():
            return n
    return names[0]

def all_off(out):
    for ch in range(16):
        out.send(mido.Message("pitchwheel", channel=ch, pitch=0))
        out.send(mido.Message("control_change", channel=ch, control=123, value=0))  # all notes off

def play(timeline, port_name):
    print(f"Opening MIDI out: {port_name}")
    with mido.open_output(port_name) as out:
        try:
            start = time.time()
            for t, msg in timeline:
                dt = t - (time.time() - start)
                if dt > 0:
                    time.sleep(dt)
                out.send(msg)
            time.sleep(0.3)
        except KeyboardInterrupt:
            print("\nInterrupted.")
        finally:
            all_off(out)
    print("Done.")

def main():
    ap = argparse.ArgumentParser(description="OtelJazz starter engine")
    ap.add_argument("--list-ports", action="store_true")
    ap.add_argument("--port", default=None)
    ap.add_argument("--trace", default=None)
    ap.add_argument("--tempo", type=float, default=96.0)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--no-drift", action="store_true")
    ap.add_argument("--detect-drift", action="store_true",
                     help="compute drift from actual span timing (drift_detect.py) instead of "
                          "reading a hand-typed drift_start out of the trace file -- prints "
                          "what it found (or that it found nothing) and renders accordingly")
    ap.add_argument("--demo", action="store_true",
                     help="use the extended ~110s demo trace (wide dynamic range, minor-mode "
                          "crisis arc) instead of the ~30s calibration-shaped synthetic trace")
    ap.add_argument("--test-note", action="store_true",
                     help="send one held middle-C on the given --channel (default 1), for "
                          "isolating Logic routing problems from mapping/trace problems")
    ap.add_argument("--channel", type=int, default=1,
                     help="1-indexed MIDI channel for --test-note (default 1)")
    ap.add_argument("--seed", type=int, default=None,
                     help="--demo only: seed for the form (the tune's changes) and melody, for a "
                          "reproducible take. Omit for a different (but still corpus-plausible) "
                          "tune each run -- the chosen seed is printed so you can reproduce it")
    ap.add_argument("--show-form", action="store_true",
                     help="print the generated changes and exit, without playing -- for checking "
                          "whether a seed produced a tune worth recording")
    ap.add_argument("--export-events", default=None, metavar="PATH",
                     help="write the rendered piece as JSON note events and exit -- the payload "
                          "the browser consumes, and what makes a sample A/B test controlled "
                          "(same notes through both renderings). See ROADMAP.md 4.5")
    ap.add_argument("--swarm", action="store_true",
                     help="run the mock multi-agent pipeline (swarm.py) and derive the musical "
                          "form from its telemetry, instead of using a hand-authored trace")
    ap.add_argument("--fanout", type=int, default=4, help="--swarm: subagents spawned per round")
    ap.add_argument("--rounds", type=int, default=2, help="--swarm: fan-out/converge cycles")
    ap.add_argument("--show-pool-stats", action="store_true",
                     help="print true distinct-agent count vs. VoicePool overflow (slot steals) "
                          "and exit, without playing -- the saturation-ceiling measurement for "
                          "--fanout beyond POOL_SLOTS. See the VOICE POOL block comment")
    ap.add_argument("--swing", type=float, default=SWING_DEFAULT,
                     help=f"swing ratio: 0.5 = straight eighths, 0.667 = full triplet feel "
                          f"(default {SWING_DEFAULT}). --demo sections set their own and ignore "
                          f"this unless they omit it")
    args = ap.parse_args()

    if args.list_ports:
        print("MIDI outputs:")
        for n in mido.get_output_names():
            print("  ", n)
        return

    if args.test_note:
        port = pick_port(args.port)
        ch = args.channel - 1
        print(f"Opening MIDI out: {port}")
        with mido.open_output(port) as out:
            out.send(mido.Message("program_change", channel=ch, program=42))
            print(f"Sending middle C (note 60) on MIDI channel {args.channel} for 3s. "
                  "Watch Logic's input meter / track for activity.")
            out.send(mido.Message("note_on", channel=ch, note=60, velocity=100))
            time.sleep(3)
            out.send(mido.Message("note_off", channel=ch, note=60, velocity=0))
        print("Done.")
        return

    corpus_model = load_corpus_model()
    regime_schedule = None
    sections = None
    seed = 0

    if args.trace:
        with open(args.trace) as f:
            spans = json.load(f)
        print(f"Loaded {len(spans)} spans from {args.trace}")
    elif args.swarm:
        # The mock pipeline, with its musical form DERIVED from its own telemetry rather than
        # authored -- see swarm.py. No regime_schedule: major/minor is a narrative device from
        # the hand-written demo, and nothing in real telemetry says "go to minor here."
        import swarm as swarm_mod
        seed = args.seed if args.seed is not None else random.SystemRandom().randrange(2**31)
        spans, sections = swarm_mod.swarm_trace(seed=seed, fanout=args.fanout, rounds=args.rounds)
        print(f"Using mock swarm (seed {seed}, fanout {args.fanout}, {args.rounds} rounds)."
              f" Pass --seed {seed} to reproduce this run.\n")
        print(swarm_mod.describe(spans, sections))
        print()
    elif args.demo:
        spans, regime_schedule, sections = extended_demo_trace()
        seed = args.seed if args.seed is not None else random.SystemRandom().randrange(2**31)
        print(f"Using extended demo trace ({len(spans)} spans, minor-mode crisis arc, "
              f"{len(sections)} sections). Seed: {seed} (pass --seed {seed} to reproduce this take)")
    else:
        spans = synthetic_trace()
        print(f"Using synthetic trace ({len(spans)} spans).")

    # Generate the tune up front so it can be printed -- being able to read the changes is how
    # you tell "a plausible standard" from "chords that merely have stable qualities."
    form = generate_jazz_form(corpus_model, seed=seed)
    print(f"Form ({FORM_BARS} bars, repeats every chorus):\n  {form_as_text(form[0])}")
    print(f"  as played in {NOTE_NAMES_FLAT[CONCERT_KEY_PC]}: {form_as_chord_symbols(form[0])}")
    if regime_schedule:
        print(f"  (minor): {form_as_text(form[1])}")
    print(f"Motif (chord-tone offsets, rhythm): {motif_as_text(generate_motif(seed))}")
    if args.show_form:
        return

    if args.show_pool_stats:
        resolved, voice_pool = pool_spans(spans)
        distinct_agents = len({s["agent"] for s in spans})
        print(f"True distinct agents: {distinct_agents}  |  pool slots: {len(POOL_SLOTS)}  |  "
              f"overflow events (forced slot steals): {voice_pool.overflow_events}")
        preview = voice_pool.overflow_log[:5]
        for t, stolen_from, given_to in preview:
            print(f"  t={t:7.2f}s  slot stolen from {stolen_from!r} -> given to {given_to!r}")
        if len(voice_pool.overflow_log) > len(preview):
            print(f"  ... and {len(voice_pool.overflow_log) - len(preview)} more "
                  f"(full log in VoicePool.overflow_log for scripted analysis)")
        return

    do_drift = not args.no_drift
    if args.detect_drift:
        # Compute the shared onset grid the same way build_timeline will, so the detector sees
        # exactly the windows the render is about to use -- see drift_detect.py's docstring for
        # why the grid (not an assumed-zero baseline) is what a voice's onset gets compared to.
        from drift_detect import detect_drift
        end_s = max((s["start"] + s.get("duration", 0.5) for s in spans), default=8.0) + 2.0
        if sections:
            end_s = max(end_s, sections[-1]["end"])
        chord_schedule_preview = generate_chord_schedule(end_s, args.tempo, form[0], form[1],
                                                           regime_schedule=regime_schedule,
                                                           sections=sections)
        resolved_preview, _ = pool_spans(spans)
        result = detect_drift(spans, chord_schedule_preview, resolved=resolved_preview)
        if result:
            print(f"\n--detect-drift: flagged {result['agent']!r} starting ~{result['drift_start']:.2f}s, "
                  f"net growth {result['net_growth_s']*1000:.1f}ms over {result['drift_window']:.2f}s "
                  f"(z={result['z_score']:.2f}).")
            spans = spans + [{"agent": result["agent"], "action": "chat",
                               "start": result["drift_start"], "duration": 0.1,
                               "drift_start": result["drift_start"],
                               "drift_window": result["drift_window"]}]
            do_drift = do_drift and True
        else:
            print("\n--detect-drift: no voice's onset lag showed a growing, statistically "
                  "significant divergence from the group -- rendering without drift.")
            do_drift = False

    timeline = build_timeline(spans, args.tempo, args.speed, do_drift=do_drift,
                               corpus_model=corpus_model, regime_schedule=regime_schedule, seed=seed,
                               sections=sections, form=form, swing=args.swing)

    if args.export_events:
        end_s = max((s["start"] + s.get("duration", 0.5) for s in spans), default=8.0) + 2.0
        if sections:
            end_s = max(end_s, sections[-1]["end"])
        chord_windows = generate_chord_schedule(end_s, args.tempo, form[0], form[1],
                                                 regime_schedule=regime_schedule, sections=sections)
        n = export_events(timeline, args.export_events, chord_windows=[
                              (a, b, r, q) for a, b, r, q, _bar in chord_windows],
                          meta={"seed": seed, "key": NOTE_NAMES_FLAT[CONCERT_KEY_PC],
                                "tempo_default": args.tempo, "swing_default": args.swing,
                                "form": form_as_chord_symbols(form[0]),
                                "form_roman": form_as_text(form[0]),
                                "source": "swarm" if args.swarm else "demo" if args.demo else "synthetic",
                                "duration_s": round(timeline[-1][0], 3) if timeline else 0.0})
        print(f"\nWrote {n} note events to {args.export_events}")
        print("Render the SAME file through Logic and through a browser sampler to compare "
              "sounds rather than performances -- see ROADMAP.md 4.5.")
        return

    port = pick_port(args.port)
    print(f"Tempo {args.tempo} BPM, speed {args.speed}x, "
          f"{'drift ON' if not args.no_drift else 'drift OFF'}. Ctrl-C to stop.")
    play(timeline, port)

if __name__ == "__main__":
    main()
