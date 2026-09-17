/*
 * engine.js -- an infinite, per-visit-unique client-side port of caidence.py's jazz-form +
 * chorale-voicing + walking-bass machinery, driving a continuously-generated mock swarm
 * (ported from swarm.py's pipeline phases) instead of a precomputed, finite trace.
 *
 * WHY THIS EXISTS: demo.html originally played back ONE precomputed piece (ab_test.json +
 * otel_trace_demo.json, --swarm --seed 42), which meant every visitor heard the identical
 * ~68s performance and the transport stopped needing a manual replay. The user wants a page
 * that can be left open indefinitely, generating fresh telemetry and music forever, different
 * every visit. That requires the GENERATION itself to move client-side and run continuously,
 * not just a longer pre-rendered file.
 *
 * WHAT'S A FAITHFUL PORT vs. WHAT'S SIMPLIFIED (be honest about this, it matters for anyone
 * reading this after the fact expecting engine-parity with caidence.py):
 *   FAITHFUL: JAZZ_CELLS vocabulary, JAZZ_CHORD_TONES, generate_jazz_form's corpus-weighted
 *   cell selection (using the SAME corpus_model_jazz.json, fetched at runtime -- this is not a
 *   reimplemented approximation of the corpus, it's the actual mined data), jazz_chorale_voicing
 *   (7-voice non-crossing/voice-led/parallel-avoiding chorale), the COMP liveness/retirement
 *   model (TERMINAL_STOP_REASONS, COMP_LIVE_WINDOW_S), bass_tone_choice/bass_target/
 *   walking_bass_bar, tone priority ordering (rootless comping), tokens->velocity and
 *   latency->duration mappings, and the swarm pipeline's phase structure (intake/decompose/
 *   fan-out/converge).
 *   The solo line is a port of generate_solo_melody (contour walk on rotating Weimar performer
 *   interval statistics, core-tone runs, motif stated/inverted/reversed, exact at chorus tops,
 *   activity-scaled phrases and rests), with four deliberate differences, each measured with
 *   scripts/melody_check.mjs: the motif is renewed whenever the key or mode changes (there is
 *   no "piece" to own it); motif notes are chosen to move in the shape's direction (Python's
 *   nearest-note snap kept the up/down shape only 51% of the time here, this keeps 86%); runs
 *   are moved by octaves to stay in the register; and every note sounds inside the bar whose
 *   chord it was chosen for (onsets and runs used to spill onto the next chord). Velocity keeps
 *   the browser's activity-driven formula rather than Python's fixed one.
 *   Tempo follows span throughput, as in caidence.py, but per chorus rather than per derived
 *   section, and relative to the session's own recent normal rather than the finished trace's
 *   min/max, which an endless stream doesn't have (director.js's TEMPO ARC block).
 *   SIMPLIFIED, deliberately, to ship this rather than stall on full parity: swing is a single
 *   global constant rather than per-section. See BUILD_NOTES.md for the full
 *   list and why each cut was made. (Comp push/anticipation was on this list originally; it has
 *   since been ported -- see director.js's COMP_PUSH_PROBABILITY and its pendingPush lookahead.)
 *   GOES FURTHER THAN caidence.py's DEFAULT, deliberately: goal-drift, collusion and the
 *   capture spike are not placed by hand or rolled. SwarmEngine injects a latency trend into one
 *   subagent (LATENCY_DRIFT_INJECT), makes another shadow its neighbour (COLLUSION_INJECT) and
 *   captures a third (CAPTURE_INJECT), and Director hears any of the three only when
 *   detectLatencyDrift / detectCollusion / detectCaptureSpike finds it -- the same detectors as
 *   drift_detect.detect_latency_drift, collusion_detect.detect_collusion and
 *   capture_detect.detect_capture_spike, which caidence.py runs only under --detect-drift=latency
 *   / --detect-collusion / --detect-capture. Only conflict is still rolled.
 *
 * MODULATION / "never the same song twice": each CHORUS (16 bars) is a freshly-drawn form --
 * generate_jazz_form is called again every time the bar cursor wraps, not just once for the
 * whole piece -- and the tonic pitch class and major/minor mode are both re-rolled at that
 * point too. This is a direct extension of the existing design (the corpus already decides cell
 * selection; this just re-draws instead of drawing once), not a bolted-on gimmick. The session
 * seed itself comes from crypto.getRandomValues, so it's a different draw every page load --
 * intentionally NOT reproducible the way synthetic_trace()'s seed=0 is, because reproducibility
 * is exactly what this feature is asked not to have. That is the DEFAULT, not the only mode: a
 * `?seed=N` URL (the model plate's copy link) passes N to Director in place of cryptoSeed(), and
 * the synthetic path then replays byte-for-byte (check with scripts/director_fingerprint.mjs).
 * Live mode's spans still arrive when they arrive, so a seed there only fixes the rng side.
 */

// ============================================================================================
// Seeded RNG -- mulberry32, seeded from real entropy so every page load differs. This is NOT
// the same determinism model as caidence.py's per-decision action_hash() seeding (which lets
// any single decision be independently reproduced regardless of call order); here one advancing
// stream is enough, since a whole session is only ever replayed from its seed, never one decision
// in isolation. The flip side: any new musical randomness must draw from this same stream (or
// one derived from the seed), or `?seed=` replay silently stops matching.
// ============================================================================================
function cryptoSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] || 1;
}

class Rng {
  constructor(seed) { this.s = seed >>> 0; }
  next() {
    this.s |= 0; this.s = (this.s + 0x6D2B79F5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a, b) { return a + this.next() * (b - a); }
  int(n) { return Math.floor(this.next() * n); }
  choice(arr) { return arr[this.int(arr.length)]; }
  bool(p) { return this.next() < p; }
  gauss(mean, sd) {
    // Box-Muller
    const u1 = Math.max(1e-9, this.next()), u2 = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  weightedIndex(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return this.int(weights.length);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }
}

// ============================================================================================
// Harmony: JAZZ_CELLS, JAZZ_CHORD_TONES, form generation -- ported from caidence.py
// ============================================================================================
const FORM_BARS = 16;
const BARS_PER_CELL = 2;
const TONIC_CELL_IDX = 0, TURNAROUND_CELL_IDX = 1;

// (name, majorCell, minorCell) -- each cell is [[semitoneFromTonic, quality], ...]
const JAZZ_CELLS = [
  ["tonic",    [[0, "maj7"], [0, "maj7"]],  [[0, "min"],   [0, "min"]]],
  ["ii-V",     [[2, "min"],  [7, "dom7"]],  [[2, "m7b5"],  [7, "dom7"]]],
  ["iii-VI7",  [[4, "min"],  [9, "dom7"]],  [[3, "maj7"],  [8, "maj7"]]],
  ["IV-iv",    [[5, "maj7"], [5, "min"]],   [[5, "min"],   [5, "min"]]],
  ["IV-bVII7", [[5, "maj7"], [10, "dom7"]], [[5, "min"],   [10, "dom7"]]],
  ["vi-II7",   [[9, "min"],  [2, "dom7"]],  [[8, "maj7"],  [2, "dom7"]]],
  ["ii-bII7",  [[2, "min"],  [1, "dom7"]],  [[2, "m7b5"],  [1, "dom7"]]],
  ["I-I7",     [[0, "maj7"], [0, "dom7"]],  [[0, "min"],   [0, "dom7"]]],
  ["V-I",      [[7, "dom7"], [0, "maj7"]],  [[7, "dom7"],  [0, "min"]]],
];

const JAZZ_CHORD_TONES = {
  maj:  [0, 4, 7, 9, 2],
  maj7: [0, 4, 7, 11, 2, 6, 9],
  dom7: [0, 4, 7, 10, 2, 9],
  min:  [0, 3, 7, 10, 2, 5],
  m7b5: [0, 3, 6, 10, 2],
  dim7: [0, 3, 6, 9],
  aug:  [0, 4, 8],
  sus:  [0, 5, 7, 10, 2],
};
const ARPEGGIO_CORE_TONES = 4;

const NOTE_NAMES_FLAT = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const CHORD_SYMBOL_SUFFIX = { maj: "6", maj7: "maj7", dom7: "7", min: "m7", m7b5: "m7b5", dim7: "dim7", aug: "+7", sus: "7sus4" };
function chordSymbol(rootPc, quality, keyPc) {
  return NOTE_NAMES_FLAT[(rootPc + keyPc + 12) % 12] + (CHORD_SYMBOL_SUFFIX[quality] || quality);
}

function cellScore(prevRoot, cell, matrix) {
  let score = 1.0, prev = prevRoot;
  for (const [root, _q] of cell) {
    score *= matrix[((prev % 12) + 12) % 12][((root % 12) + 12) % 12];
    prev = root;
  }
  return score;
}

// generate one chorus: returns {majorForm, minorForm}, each FORM_BARS entries of {rootPc, quality}
function generateJazzForm(matrix, rng) {
  const nCells = FORM_BARS / BARS_PER_CELL;
  const indices = [TONIC_CELL_IDX];
  let prevRoot = JAZZ_CELLS[TONIC_CELL_IDX][1][JAZZ_CELLS[TONIC_CELL_IDX][1].length - 1][0];

  for (let slot = 1; slot < nCells - 1; slot++) {
    const weights = JAZZ_CELLS.map((_, i) => cellScore(prevRoot, JAZZ_CELLS[i][1], matrix));
    const idx = rng.weightedIndex(weights);
    indices.push(idx);
    const mc = JAZZ_CELLS[idx][1];
    prevRoot = mc[mc.length - 1][0];
  }
  indices.push(TURNAROUND_CELL_IDX);

  const majorForm = [], minorForm = [];
  for (const idx of indices) {
    const [, majorCell, minorCell] = JAZZ_CELLS[idx];
    for (const [r, q] of majorCell) majorForm.push({ rootPc: r, quality: q });
    for (const [r, q] of minorCell) minorForm.push({ rootPc: r, quality: q });
  }
  return { majorForm, minorForm };
}

// ============================================================================================
// Chorale voicing -- ported from jazz_chorale_voicing / _tone_priority_order / _avoid_parallels
// ============================================================================================
const CHORD_VOICE_ORDER = ["arch1", "planner", "worker2", "worker3", "tools", "worker1", "arch2"];
const CHORD_AGENT_VOICES = new Set(["planner", "worker1", "worker2", "worker3", "tools"]);
const ARCH_VOICES = new Set(["arch1", "arch2"]);
const VOICE_RANGES = {
  arch1: [48, 63], planner: [53, 68], worker2: [58, 73], worker3: [63, 78],
  tools: [68, 83], worker1: [73, 88], arch2: [78, 93],
};
const COMP_VELOCITY = 60;
const COMP_SUSTAIN_FRAC = 0.94;
const COMP_LIVE_WINDOW_S = 7.0;
const COMP_ACCENT_FORM_TOP = 22;
const COMP_ACCENT_CADENCE = 14;
const COMP_ACCENT_BASS_EXTRA = 8;
const TERMINAL_STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence"]);

function notesInRange(pitchClass, lo, hi) {
  const start = lo + (((pitchClass - lo) % 12) + 12) % 12;
  const out = [];
  for (let n = start; n <= hi; n += 12) out.push(n);
  return out;
}

function tonePriorityOrder(tones) {
  const order = [];
  for (const idx of [1, 3, 2]) if (idx < tones.length) order.push(idx);
  for (let idx = 0; idx < tones.length; idx++) if (!order.includes(idx) && idx !== 0) order.push(idx);
  if (tones.length > 0) order.push(0);
  return order;
}

function avoidParallels(prevVoicing, voicing, soundingSet) {
  const v = { ...voicing };
  const order = CHORD_VOICE_ORDER.filter(x => !soundingSet || soundingSet.has(x));
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const va = order[i], vb = order[j];
      if (!(va in prevVoicing) || !(vb in prevVoicing)) continue;
      const prevInterval = Math.abs(prevVoicing[va] - prevVoicing[vb]) % 12;
      const newInterval = Math.abs(v[va] - v[vb]) % 12;
      if (prevInterval !== 0 && prevInterval !== 7) continue;
      if (newInterval !== prevInterval) continue;
      const deltaA = v[va] - prevVoicing[va], deltaB = v[vb] - prevVoicing[vb];
      if (deltaA === 0 || deltaB === 0 || (deltaA > 0) !== (deltaB > 0)) continue;
      const idxB = order.indexOf(vb);
      const lowerBound = idxB > 0 ? v[order[idxB - 1]] : -1e9;
      const upperBound = idxB < order.length - 1 ? v[order[idxB + 1]] : 1e9;
      const [lo, hi] = VOICE_RANGES[vb];
      for (const cand of [v[vb] - 12, v[vb] + 12]) {
        if (cand >= lo && cand <= hi && cand >= lowerBound && cand <= upperBound) { v[vb] = cand; break; }
      }
    }
  }
  return v;
}

function jazzChoraleVoicing(prevVoicing, rootPc, quality, soundingVoices) {
  const tones = JAZZ_CHORD_TONES[quality];
  const order = tonePriorityOrder(tones);
  const soundingSet = soundingVoices ? new Set(soundingVoices) : null;
  const sounding = CHORD_VOICE_ORDER.filter(v => !soundingSet || soundingSet.has(v));
  const silent = CHORD_VOICE_ORDER.filter(v => !sounding.includes(v));
  const toneFor = {};
  [...sounding, ...silent].forEach((voice, i) => { toneFor[voice] = tones[order[i % order.length]]; });

  const voicing = {};
  let prevNoteBelow = null;
  for (const voice of CHORD_VOICE_ORDER) {
    const pitchClass = (((rootPc + toneFor[voice]) % 12) + 12) % 12;
    const [lo, hi] = VOICE_RANGES[voice];

    if (soundingSet && !soundingSet.has(voice)) {
      const near = notesInRange(pitchClass, lo, hi);
      voicing[voice] = near.length ? near.reduce((a, b) =>
        Math.abs(a - (lo + hi) / 2) <= Math.abs(b - (lo + hi) / 2) ? a : b) : lo;
      continue;
    }

    let candidates = notesInRange(pitchClass, lo, hi);
    if (!candidates.length) candidates = [lo];
    if (prevNoteBelow !== null) {
      let constrained = candidates.filter(c => c >= prevNoteBelow);
      if (!constrained.length) {
        constrained = notesInRange(pitchClass, prevNoteBelow, hi + 12).filter(c => c >= prevNoteBelow);
      }
      if (!constrained.length) {
        const base = prevNoteBelow + (((pitchClass - prevNoteBelow) % 12) + 12) % 12;
        constrained = [Math.max(0, Math.min(127, base))];
      }
      candidates = constrained;
    }
    const anchor = (prevVoicing && voice in prevVoicing) ? prevVoicing[voice] : (lo + hi) / 2;
    const best = candidates.reduce((a, b) => Math.abs(a - anchor) <= Math.abs(b - anchor) ? a : b);
    voicing[voice] = best;
    prevNoteBelow = best;
  }
  return prevVoicing ? avoidParallels(prevVoicing, voicing, soundingSet) : voicing;
}

// ============================================================================================
// Bass -- ported from bass_tone_choice / bass_target / walking_bass_bar
// ============================================================================================
const BASS_RANGE = [28, 50];
const BASS_ANCHOR = 38;
const BASS_TONE_CHOICES = [0, 2, 1];
const BASS_ROOT_WEIGHT_CALM = 0.88, BASS_ROOT_WEIGHT_BUSY = 0.66;
const WALK_FOUR_FEEL_ACTIVITY = 2;
const WALK_VELOCITY = 78;
const WALK_NOTE_FRAC = 0.92;

function bassToneChoice(activityLevel, rng) {
  const busy = Math.min(1.0, activityLevel / 4.0);
  const rootW = BASS_ROOT_WEIGHT_CALM + (BASS_ROOT_WEIGHT_BUSY - BASS_ROOT_WEIGHT_CALM) * busy;
  const rest = (1.0 - rootW) / 2.0;
  const idx = rng.weightedIndex([rootW, rest, rest]);
  return BASS_TONE_CHOICES[idx];
}

function bassTarget(rootPc, quality, toneIdx) {
  const tones = JAZZ_CHORD_TONES[quality];
  const pitchClass = (((rootPc + tones[toneIdx % tones.length]) % 12) + 12) % 12;
  const [lo, hi] = BASS_RANGE;
  const candidates = notesInRange(pitchClass, lo, hi);
  if (!candidates.length) return Math.max(lo, Math.min(hi, BASS_ANCHOR));
  return candidates.reduce((a, b) => Math.abs(a - BASS_ANCHOR) <= Math.abs(b - BASS_ANCHOR) ? a : b);
}

function walkingBassBar(target, nextTarget, rootPc, quality, fourFeel) {
  const [lo, hi] = BASS_RANGE;
  const tones = JAZZ_CHORD_TONES[quality].slice(0, ARPEGGIO_CORE_TONES);
  const poolSet = new Set();
  for (const tn of tones) for (const n of notesInRange((((rootPc + tn) % 12) + 12) % 12, lo, hi)) poolSet.add(n);
  const pool = [...poolSet].sort((a, b) => a - b);
  const nearestFrom = (p, ref) => p.length ? p.reduce((a, b) => Math.abs(a - ref) <= Math.abs(b - ref) ? a : b) : ref;

  if (!fourFeel) {
    const fifthCandidates = notesInRange((((rootPc + 7) % 12) + 12) % 12, lo, hi);
    let second = nearestFrom(fifthCandidates.length ? fifthCandidates : pool, target);
    if (second === target && pool.length) {
      const rest = pool.filter(n => n !== target);
      second = nearestFrom(rest.length ? rest : pool, target);
    }
    return [[0.0, target], [2.0, second]];
  }

  const below = nextTarget - 1, above = nextTarget + 1;
  let approach = Math.abs(below - target) <= Math.abs(above - target) ? below : above;
  approach = Math.max(lo, Math.min(hi, approach));
  const step = approach >= target ? 1 : -1;
  let between = pool.filter(n => (target < n && n < approach) || (approach < n && n < target));
  between.sort((a, b) => step < 0 ? b - a : a - b);
  let beat2, beat3;
  if (between.length >= 2) { beat2 = between[0]; beat3 = between[between.length - 1]; }
  else if (between.length === 1) { beat2 = between[0]; beat3 = Math.max(lo, Math.min(hi, approach - step)); }
  else { beat2 = Math.max(lo, Math.min(hi, target + step)); beat3 = Math.max(lo, Math.min(hi, target + 2 * step)); }
  if (beat3 === approach) beat3 = Math.max(lo, Math.min(hi, beat3 - step));
  return [[0.0, target], [1.0, beat2], [2.0, beat3], [3.0, approach]];
}

// ============================================================================================
// Span -> note mapping -- ported from tokens_to_velocity / latency_to_duration / emit_span_events
// ============================================================================================
function tokensToVelocity(tokens) {
  const v = 50 + Math.floor(Math.min(tokens, 500) / 500 * 60);
  return Math.max(1, Math.min(127, v));
}
function latencyToDuration(op, latency) {
  if (op === "execute_tool") return Math.max(0.12, Math.min(0.4, latency));
  return Math.max(0.25, Math.min(2.0, latency));
}
function nearestChromaticOffsets(diatonicPcs, count) {
  const offsets = [];
  let magnitude = 1;
  while (offsets.length < count && magnitude <= 6) {
    for (const off of [magnitude, -magnitude]) {
      if (!diatonicPcs.has((((off % 12) + 12) % 12))) offsets.push(off);
    }
    magnitude++;
  }
  return offsets.slice(0, count);
}

// guide-tone-weighted chord-tone choice for the solo line (root,3rd,5th,7th then extensions)
const MELODY_TONE_WEIGHTS = [0.20, 0.30, 0.10, 0.25];
const MELODY_EXTENSION_WEIGHT = 0.15;
function melodyToneIndex(tones, rng) {
  const weights = [];
  const nExt = Math.max(0, tones.length - MELODY_TONE_WEIGHTS.length);
  for (let i = 0; i < tones.length; i++) {
    weights.push(i < MELODY_TONE_WEIGHTS.length ? MELODY_TONE_WEIGHTS[i] : MELODY_EXTENSION_WEIGHT / nExt);
  }
  return rng.weightedIndex(weights);
}

// ============================================================================================
// Solo line: contour walk, core-tone runs, motif -- a port of caidence.py's
// generate_solo_melody and its helpers (note_near_step, jazz_arpeggio_notes, generate_motif,
// motif_variant). Pitch choices are corpus/contour-driven; only density and velocity follow the
// telemetry (activity), same split as the Python engine.
// ============================================================================================
const MELODY_HOME = 76;                  // caidence.py VOICES["melody"] home register
const MELODY_REGISTER_SPAN = 18;         // semitones the line may roam either side of home
const MELODY_REGISTER = [MELODY_HOME - MELODY_REGISTER_SPAN, MELODY_HOME + MELODY_REGISTER_SPAN];
const MELODY_NOTE_GAP_BARS = 0.5;        // a note every half bar at activity 0...
const MELODY_DENSITY_PER_AGENT = 0.35;   // ...divided by (1 + this x activity)
const MELODY_NOTE_DURATION_FRAC = 0.85;
const MELODY_ROTATION_BARS = 8;          // switch performer style every N bars
const MELODY_PHRASE_NOTES_IDLE = 2;
const MELODY_PHRASE_NOTES_PER_ACTIVITY = 3;
const MELODY_REST_BARS_IDLE = 1.5;
const MELODY_REST_BARS_BUSY = 0.25;
const MELODY_BUSY_ACTIVITY = 4.0;
const MOTIF_LEN = 4;
const MOTIF_CHORD_TONE_SEMITONES = 3.5;
const MOTIF_PHRASE_WEIGHTS = [["exact", 0.34], ["inverted", 0.20], ["retrograde", 0.16], ["free", 0.30]];

// The note nearest to (base + step) with the given pitch class; ties go upward, as in Python.
function noteNearStep(base, step, pitchClass) {
  const candidate = base + step;
  for (let delta = 0; delta <= 12; delta++) {
    for (const cand of [candidate + delta, candidate - delta]) {
      if ((((cand % 12) + 12) % 12) === pitchClass) return Math.max(0, Math.min(127, cand));
    }
  }
  return Math.max(0, Math.min(127, base));
}

// A 1-3-5-7 broken chord fanned out around `registerBase` (core tones only -- a run over the
// extensions is a scale, not an arpeggio; see caidence.py's jazz_arpeggio_notes).
function arpeggioNotes(rootPc, quality, registerBase, descending) {
  const tones = JAZZ_CHORD_TONES[quality].slice(0, ARPEGGIO_CORE_TONES);
  const nearest = (pc) => {
    const base = registerBase - (((registerBase % 12) + 12) % 12) + pc;
    return Math.max(0, Math.min(127, [base - 12, base, base + 12]
      .reduce((a, b) => (Math.abs(a - registerBase) <= Math.abs(b - registerBase) ? a : b))));
  };
  const notes = tones.map(t => nearest((((rootPc + t) % 12) + 12) % 12)).sort((a, b) => a - b);
  return descending ? notes.reverse() : notes;
}

// Realize one motif note: the in-register note of `pitchClass` nearest `aim` that moves in
// direction `dir` (+1 up, -1 down, 0 either) from `prev`. Falls back to the nearest in-register
// note if no candidate moves that way. caidence.py only snaps to the nearest note, and measured
// in this port that kept a statement's up/down shape only 51% of the time; choosing by direction
// is what makes a restatement recognisable.
function motifNote(prev, aim, pitchClass, dir, lo, hi) {
  const cands = [];
  for (let n = lo; n <= hi; n++) if ((((n % 12) + 12) % 12) === pitchClass) cands.push(n);
  const ok = prev === null || dir === 0 ? cands
    : cands.filter(n => (dir > 0 ? n > prev : n < prev));
  const pool = ok.length ? ok : cands;
  return pool.reduce((a, b) => (Math.abs(a - aim) <= Math.abs(b - aim) ? a : b));
}

// The line's melodic cell: MOTIF_LEN [cumulative chord-tone offset, duration multiplier] pairs.
function generateMotif(rng) {
  const offsets = [0];
  for (let i = 1; i < MOTIF_LEN; i++) offsets.push(offsets[i - 1] + rng.choice([-2, -1, -1, 1, 1, 2]));
  return offsets.map(off => [off, rng.choice([1.0, 1.0, 1.0, 0.5, 1.5])]);
}

// exact / inverted / retrograde; "free" -> null (the caller walks instead).
function motifVariant(motif, kind) {
  if (kind === "exact") return motif;
  if (kind === "inverted") return motif.map(([off, dur]) => [-off, dur]);
  if (kind === "retrograde") return [...motif].reverse();
  return null;
}

// corpus_model_jazz.json's performer_interval_distributions -> sorted [{name, steps, weights}],
// ready for rng.weightedIndex. Sorted by name so the rotation order doesn't depend on JSON order.
function performerStepTables(dists) {
  return Object.keys(dists || {}).sort().map(name => {
    const entries = Object.entries(dists[name]);
    return { name, steps: entries.map(([k]) => Number(k)), weights: entries.map(([, w]) => w) };
  });
}

// ============================================================================================
// SwarmEngine -- continuous port of swarm.py's SwarmSim. The Python version runs a fixed
// number of rounds then stops; this loops forever, generating a fresh intake/decompose/
// fan-out/converge cycle after each one completes, with a randomized fanout (2-5) per cycle so
// the ensemble width itself varies over the course of an open-ended session, not just the
// harmony. Produces the same flat span shape swarm.py does: {agent, op, start, duration,
// tokens, status, tool?, mcp_server?, stop_reason?} -- `agent` is the TRUE unpooled identity
// (see ORCHESTRATOR_AGENT_ID/VoicePool above), matching swarm.py exactly; there is no separate
// pooled-vs-true field anymore, on either side.
// ============================================================================================
// ORCHESTRATOR_AGENT_ID is the one identity that's never pooled -- there's only ever one
// orchestrator, so it maps 1:1 to the "planner" voice (see resolveVoice below). Every subagent
// gets its own TRUE, unbounded id (see _fanOut) -- SwarmEngine does NOT pool identity onto
// voices itself anymore; that used to be `_nextSlot()`'s job here, mirroring the same mistake
// caidence.py's swarm.py had (see its VOICE POOL comment for the full reasoning): pooling
// identity in the PRODUCER meant activity/saturation could never be measured past 4 agents, and
// it meant this browser engine's telemetry shape didn't match what real (never-pre-pooled) OTel
// would look like. Pooling now happens in VoicePool, called from director.js exactly like
// caidence.py's VoicePool is called from build_timeline/live.py -- one shared algorithm.
const ORCHESTRATOR_AGENT_ID = "orchestrator";
const POOL_SLOTS = ["worker1", "worker2", "worker3"];

// Causal (online) assignment of arbitrarily many true agent identities onto POOL_SLOTS -- a
// straight port of caidence.py's VoicePool. Never looks ahead, so calling it once per span as
// director.js generates bars in increasing time order produces the same assignment the batch
// Python path gets from one forward pass over a time-sorted span list. A true agent keeps its
// slot until its OWN most recent span is terminal (caller passes `terminal=true`); when every
// slot is full and a new identity needs one, the pool steals whichever slot's occupant has been
// quiet longest, and counts it (overflowEvents) -- the real, audible saturation ceiling.
class VoicePool {
  constructor(slots) {
    this.slots = slots ? [...slots] : [...POOL_SLOTS];
    this.occupant = Object.fromEntries(this.slots.map(s => [s, null]));
    this.slotOf = {};       // true agent id -> slot, only while it currently holds one
    this.lastActive = {};   // true agent id -> last time seen (for the steal heuristic)
    this._rr = 0;
    this.overflowEvents = 0;
    this.overflowLog = [];  // [[t, stolenFromAgentOrNull, givenToAgent], ...]
    this.leadAgent = null;  // holds "planner"; see resolveVoice's LEAD ASSIGNMENT comment
  }

  // Hand back a worker slot (used when an agent becomes the lead and no longer needs one).
  releaseSlot(agentId) {
    const slot = this.slotOf[agentId];
    if (slot === undefined) return;
    delete this.slotOf[agentId];
    this.occupant[slot] = null;
  }

  voiceFor(agentId, t, terminal = false) {
    this.lastActive[agentId] = t;
    if (!(agentId in this.slotOf)) {
      const free = this.slots.filter(s => this.occupant[s] === null);
      let slot;
      if (free.length) {
        slot = free[this._rr % free.length];
        this._rr++;
      } else {
        slot = this.slots.reduce((best, s) => {
          const bestLast = this.lastActive[this.occupant[best]] ?? -1;
          const sLast = this.lastActive[this.occupant[s]] ?? -1;
          return sLast < bestLast ? s : best;
        }, this.slots[0]);
        const stolenFrom = this.occupant[slot];
        this.overflowEvents++;
        this.overflowLog.push([t, stolenFrom, agentId]);
        if (stolenFrom !== null) delete this.slotOf[stolenFrom];
      }
      this.slotOf[agentId] = slot;
      this.occupant[slot] = agentId;
    }
    const slot = this.slotOf[agentId];
    if (terminal) {
      delete this.slotOf[agentId];
      this.occupant[slot] = null;
    }
    return slot;
  }
}

// Role values that claim the lead ("planner") voice when a span declares one. Real systems don't
// agree on a word for the agent in charge, and OTel's GenAI conventions have no attribute for it,
// so this accepts the common ones (see LEAD ASSIGNMENT below).
const LEAD_ROLE_VALUES = new Set(["orchestrator", "planner", "supervisor", "coordinator", "lead", "root", "main"]);

// LEAD ASSIGNMENT: one agent holds the "planner" voice for the session and is never pooled;
// everyone else shares the three worker slots through the VoicePool.
//   1. A span whose `role` says so takes the lead, whenever it arrives.
//   2. Otherwise the FIRST agent seen in the session holds it -- in a real pipeline the thing
//      that speaks first is the thing that started the work, and in the synthetic swarm it is
//      "orchestrator", which is why this replaced a hardcoded check for that exact name without
//      changing a note of synthetic output.
// A former lead simply rejoins the pool; it gets a worker slot on its next span.
function resolveVoice(pool, agentId, t, terminal = false, role = null) {
  if (role && LEAD_ROLE_VALUES.has(String(role).toLowerCase())) pool.leadAgent = agentId;
  else if (pool.leadAgent === null) pool.leadAgent = agentId;
  if (agentId === pool.leadAgent) {
    pool.releaseSlot(agentId);
    return "planner";
  }
  return pool.voiceFor(agentId, t, terminal);
}

const MCP_SERVERS = {
  "mcp://filesystem": { tools: ["read_file", "write_file", "list_dir", "grep"], latency: [0.05, 0.15, 0.5], failureRate: 0.01 },
  "mcp://search": { tools: ["web_search", "fetch_page"], latency: [0.4, 1.2, 4.0], failureRate: 0.09 },
  "mcp://database": { tools: ["query", "schema", "explain"], latency: [0.1, 0.45, 2.0], failureRate: 0.04 },
  "mcp://github": { tools: ["list_issues", "read_pr", "search_code"], latency: [0.3, 0.8, 3.0], failureRate: 0.06 },
  "mcp://vector-store": { tools: ["embed", "similarity_search"], latency: [0.15, 0.35, 1.2], failureRate: 0.02 },
};
const MCP_SERVER_NAMES = Object.keys(MCP_SERVERS);

function latencyDraw(rng, [lo, typical, hi]) {
  if (rng.next() < 0.15) return rng.uniform(typical, hi);
  return Math.max(lo, rng.gauss(typical, typical * 0.35));
}

// ============================================================================================
// Goal-drift as a property of the telemetry: latency injection (synthetic) + latency detection
// (both modes). Mirrors engine/drift_detect.py's detect_latency_drift and swarm.py's opt-in
// injection -- change one, change the other.
//
// WHY LATENCY, NOT ONSET LAG: drift_detect.py's original detect_drift reads each voice's
// earliest span onset against the chord grid. Ported as-is onto this stream it detected nothing
// (noise floor 0.59s against the +-30ms it was validated at; see docs/ROADMAP.md, M1 findings),
// and live mode can't feed it at all: feedSpan stamps arrival time, and OTel SDKs batch-export
// spans when they END. Span DURATION survives both, and "one agent getting slower at the same
// kind of work its peers are doing" is a grid-free reading of an agent going off course. The
// onset-lag detector stays in Python untouched (the paper cites its curve); this is a second one.
//
// WHAT IT IS NOT: validated against real drift. It is validated only on injected synthetic
// trends (scripts/drift_validation.mjs). Keep public wording to that.
// ============================================================================================
const LATENCY_DRIFT_INJECT = {
  prob: 0.15,      // chance a fan-out round picks one of its subagents to drift
  maxMult: 3.0,    // that subagent's latencies ramp up to this multiple...
  rampS: 10.0,     // ...over this many seconds of its own run
};
// Collusion, injected the same way: two subagents that should be working independently fall into
// step, the follower repeating the leader's actions moments later. Like drift it is a property of
// the SPANS -- nothing downstream is told -- so Director only hears it if detectCollusion finds it.
const COLLUSION_INJECT = {
  prob: 0.15,      // chance a fan-out round (of 3+) makes one subagent shadow another
  windowS: 18.0,   // how long the follower shadows
  lagS: [0.05, 0.2], // how far behind the follower's copy lands
};
// Capture spike: an agent ingests something external and its own output balloons straight after.
// Injected as a token jump following one of the agent's tool calls; detected as exactly that.
const CAPTURE_INJECT = {
  prob: 0.15,      // chance a fan-out round picks a subagent to be captured
  mult: 3.0,       // its chat spans produce this many times the tokens...
  windowS: 18.0,   // ...for this long after the tool call that captured it
};
const CAPTURE_DETECT = {
  windowS: 40,     // look-back over finished spans
  afterS: 18,      // how long after the tool call counts as "straight after"
  minBefore: 3,    // chat spans needed to know what the agent was producing before
  minAfter: 2,     // ...and after (agents emit a chat only every few seconds)
  minRatio: 2.4,   // median tokens after / before
  zThresh: 3.0,    // ...and that jump in standard deviations of the agent's own log-token spread
  // Measured (scripts/capture_validation.mjs): 1.4% of 16-bar windows flagged with nothing
  // injected, 68.7% of injected captures found -- 87% of the ones whose agent keeps talking
  // long enough to measure. A captured agent that then goes quiet leaves nothing to compare.
};

const COLLUSION_DETECT = {
  windowS: 40,     // look-back over finished spans
  tolS: 0.25,      // two spans this close count as coinciding
  minSpansEach: 8, // each agent needs this many scored spans in the window
  zThresh: 5.0,    // coincidences, in standard deviations above what independence predicts
  minMatchFrac: 0.45,   // ...and this share of the quieter agent's spans must coincide
  minSameKindFrac: 0.6, // ...doing the same kind of work (same tool/op) when they do
};
const LATENCY_DRIFT_DETECT = {
  windowS: 40,     // look-back, in seconds of finished spans
  runGapS: 8,      // an agent's "current run" ends at a silence longer than this
  minSpans: 6,     // scored points needed in the agent's current run (detect_drift: min_windows=6)
  minPeers: 3,     // same-kind spans from OTHER agents needed to score a span
  rThresh: 0.5,    // trend correlation floor (detect_drift uses 0.6; see validation)
  zThresh: 3.5,    // later-half mean residual, in standard errors of the leave-one-out noise
  minGrowth: Math.log(1.8), // fitted log-latency growth across the run
};
const LATENCY_DRIFT_EXCLUDED_OPS = new Set(["create_agent"]); // a spawn marker, not work

function latencyDriftFactor(drift, at) {
  if (!drift) return 1;
  const frac = Math.max(0, Math.min(1, (at - drift.t0) / drift.rampS));
  return Math.pow(drift.maxMult, frac);
}

// What "the same kind of work" means: the MCP server for a tool call (synthetic spans carry it;
// live spans only have the tool name, which is the next best thing), otherwise the op itself.
function latencyKey(s) {
  if (s.op === "execute_tool") return "tool:" + (s.mcp_server || s.tool || "");
  return "op:" + s.op;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// An agent whose output jumps right after it ingests a tool result. For each of an agent's tool
// calls, compare the tokens of its chat spans in the window before with the window after: a
// capture shows up as a step, not as the ordinary spread of its own output (measured: an agent's
// chat tokens normally vary by about 1.5x between quartiles). Returns
// {agent, atS, before, after, ratio, z} or null; ties broken by larger ratio, then agent id.
function detectCaptureSpike(spans, nowS, opts = CAPTURE_DETECT) {
  const o = { ...CAPTURE_DETECT, ...opts };
  const lo = nowS - o.windowS;
  const win = spans.filter(s => s.start >= lo && s.start + (s.duration || 0) <= nowS);
  const byAgent = {};
  for (const s of win) (byAgent[s.agent] ||= []).push(s);

  let best = null;
  for (const agent of Object.keys(byAgent).sort()) {
    const mine = byAgent[agent].sort((a, b) => a.start - b.start);
    const chats = mine.filter(s => s.op === "chat" && s.tokens > 0);
    if (chats.length < o.minBefore + o.minAfter) continue;
    for (const tool of mine.filter(s => s.op === "execute_tool")) {
      const at = tool.start + (tool.duration || 0);
      // baseline: what this agent was producing before the tool call, over the whole look-back
      // (not just the matching half-window, which is often too short to have enough spans)
      const before = chats.filter(s => s.start < tool.start && s.start >= at - o.windowS);
      const after = chats.filter(s => s.start >= at && s.start <= at + o.afterS);
      if (before.length < o.minBefore || after.length < o.minAfter) continue;
      const mb = median(before.map(s => s.tokens)), ma = median(after.map(s => s.tokens));
      const ratio = ma / mb;
      if (ratio < o.minRatio) continue;
      // the agent's own spread, from the BEFORE spans only: measuring it over the whole window
      // lets the captured spans inflate the very noise floor they are judged against (the same
      // trap as detectLatencyDrift's pooled noise -- measured, it cost about a third of recall)
      const logs = before.map(s => Math.log(s.tokens));
      const mid = median(logs);
      const sigma = 1.4826 * median(logs.map(x => Math.abs(x - mid)));
      const z = sigma > 1e-6
        ? Math.log(ratio) / (sigma * Math.sqrt(1 / before.length + 1 / after.length))
        : Infinity;
      if (z < o.zThresh) continue;
      if (!best || ratio > best.ratio) best = { agent, atS: at, before: mb, after: ma, ratio, z };
    }
  }
  return best;
}

// Two agents in lockstep. For each pair, count how many of the quieter agent's spans have one of
// the other's within `tolS`, and compare with what independence predicts from the two rates
// (expected = nA x nB x 2 x tol / window). A pair is flagged only if the coincidences are far
// above that, cover much of the quieter agent's activity, and are mostly the SAME kind of work --
// two busy agents in the same fan-out overlap by chance, but they don't shadow each other's tools.
// Returns {agentA, agentB, matches, expected, z, matchFrac, sameKindFrac} or null.
function detectCollusion(spans, nowS, opts = COLLUSION_DETECT) {
  const o = { ...COLLUSION_DETECT, ...opts };
  const lo = nowS - o.windowS;
  const win = spans.filter(s => !LATENCY_DRIFT_EXCLUDED_OPS.has(s.op)
    && s.start >= lo && s.start + (s.duration || 0) <= nowS);
  const byAgent = {};
  for (const s of win) (byAgent[s.agent] ||= []).push(s);
  const agents = Object.keys(byAgent).sort().filter(a => byAgent[a].length >= o.minSpansEach);
  for (const a of agents) byAgent[a].sort((x, y) => x.start - y.start);

  let best = null;
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const A = byAgent[agents[i]], B = byAgent[agents[j]];
      const [small, large] = A.length <= B.length ? [A, B] : [B, A];
      const used = new Set();
      let matches = 0, sameKind = 0;
      for (const s of small) {
        let hit = -1;
        for (let k = 0; k < large.length; k++) {
          if (used.has(k)) continue;
          const dt = Math.abs(large[k].start - s.start);
          if (dt <= o.tolS) { hit = k; break; }
          if (large[k].start - s.start > o.tolS) break;
        }
        if (hit < 0) continue;
        used.add(hit);
        matches++;
        if (latencyKey(large[hit]) === latencyKey(s)) sameKind++;
      }
      if (!matches) continue;
      const expected = (A.length * B.length * 2 * o.tolS) / o.windowS;
      const z = (matches - expected) / Math.sqrt(Math.max(expected, 1));
      const matchFrac = matches / small.length;
      const sameKindFrac = sameKind / matches;
      if (z < o.zThresh || matchFrac < o.minMatchFrac || sameKindFrac < o.minSameKindFrac) continue;
      if (!best || z > best.z) {
        best = { agentA: agents[i], agentB: agents[j], matches, expected, z, matchFrac, sameKindFrac };
      }
    }
  }
  return best;
}

// Pure: spans in, at most one finding out. Only spans that have ENDED by nowS count, so the
// result never depends on anything a live stream couldn't have told us yet. Returns
// {agent, startS, endS, growth, r, z} or null; ties broken by larger growth, then agent id, so
// the answer never depends on span order. Pass `explain: []` in opts to collect every
// candidate's numbers, passing or not (validation/diagnostics only).
function detectLatencyDrift(spans, nowS, opts = LATENCY_DRIFT_DETECT) {
  const o = { ...LATENCY_DRIFT_DETECT, ...opts };
  const lo = nowS - o.windowS;
  const win = spans.filter(s => s.duration > 0 && !LATENCY_DRIFT_EXCLUDED_OPS.has(s.op)
    && s.start >= lo && s.start + s.duration <= nowS);
  const byKey = {};
  for (const s of win) (byKey[latencyKey(s)] ||= []).push(s);

  const byAgent = {};
  const all = [];
  for (const s of win) {
    const peers = byKey[latencyKey(s)].filter(p => p.agent !== s.agent);
    if (peers.length < o.minPeers) continue;
    const y = Math.log(s.duration) - Math.log(median(peers.map(p => p.duration)));
    (byAgent[s.agent] ||= []).push([s.start, y]);
    all.push(y);
  }
  if (all.length < 2) return null;
  // Noise floor per candidate, from the OTHER agents' residuals only, as a robust spread
  // (1.4826 x MAD). drift_detect.py's onset detector pools everyone with pstdev; this one
  // deliberately doesn't. Measured: pooling let the drifting agent inflate the very noise it is
  // judged against (0.65 vs 0.42 on clean streams) and that alone rejected most injected drifts.
  const noiseExcluding = (agent) => {
    const ys = [];
    for (const [a, pts] of Object.entries(byAgent)) if (a !== agent) for (const p of pts) ys.push(p[1]);
    if (ys.length < 2) return 0;
    const mid = median(ys);
    return 1.4826 * median(ys.map(y => Math.abs(y - mid)));
  };

  let best = null;
  for (const agent of Object.keys(byAgent).sort()) {
    const pts = byAgent[agent].sort((a, b) => a[0] - b[0]);
    let first = pts.length - 1;
    while (first > 0 && pts[first][0] - pts[first - 1][0] <= o.runGapS) first--;
    const run = pts.slice(first);
    const row = { agent, n: run.length, startS: run[0][0], endS: run[run.length - 1][0] };
    if (o.explain) o.explain.push(row);
    if (run.length < o.minSpans) continue;
    const xs = run.map(p => p[0]), ys = run.map(p => p[1]);
    const n = run.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2;
    }
    if (sxx <= 0 || syy <= 0) continue;
    const slope = sxy / sxx, r = sxy / Math.sqrt(sxx * syy);
    const growth = slope * (xs[n - 1] - xs[0]);
    // "Is it still off NOW": the later half of the run (at least 3 points), tested as a mean
    // against its own standard error, not against a single point's spread.
    const k = Math.max(3, Math.ceil(n / 2));
    const noise = noiseExcluding(agent);
    const recent = ys.slice(-k).reduce((a, b) => a + b, 0) / k;
    const z = noise > 1e-6 ? recent / (noise / Math.sqrt(k)) : Infinity;
    Object.assign(row, { r, growth, z, recent, noise });
    if (!(slope > 0) || r < o.rThresh || growth < o.minGrowth || z < o.zThresh) continue;
    if (!best || growth > best.growth) best = { ...row };
  }
  return best;
}

class SwarmEngine {
  // `latencyDrift` overrides LATENCY_DRIFT_INJECT (scripts/drift_validation.mjs uses prob 0 for
  // clean streams and prob 1 for recall); the page always uses the defaults.
  constructor(rng, { latencyDrift, collusion, capture } = {}) {
    this.rng = rng;
    this.latencyDrift = { ...LATENCY_DRIFT_INJECT, ...latencyDrift };
    this.collusion = { ...COLLUSION_INJECT, ...collusion };
    this.capture = { ...CAPTURE_INJECT, ...capture };
    this.injectedDrifts = [];      // ground truth for validation only: {agent, t0}
    this.injectedCollusions = [];  // {leader, follower, t0, endS}
    this.injectedCaptures = [];    // {agent, t0, endS}
    this.t = 0.0;
    this.spans = [];          // display/debug buffer, trimmed periodically -- see trim()
    this._phaseQueue = [];    // generator-style queue of phase functions to run in order, forever
    this._enqueueCycle();
  }

  // agentId is the TRUE identity ("orchestrator" or "subagent-r2-5") -- unpooled. See
  // ORCHESTRATOR_AGENT_ID/VoicePool above for where pooling actually happens now (director.js,
  // not here).
  _add(agentId, op, start, duration, tokens, extra) {
    const span = { agent: agentId, op, start: round3(start), duration: round3(duration),
                    tokens: Math.round(tokens), status: "ok", ...extra };
    this.spans.push(span);
    return span;
  }


  _toolCall(agentId, at, drift = null) {
    const server = this.rng.choice(MCP_SERVER_NAMES);
    const spec = MCP_SERVERS[server];
    const tool = this.rng.choice(spec.tools);
    const dur = latencyDraw(this.rng, spec.latency) * latencyDriftFactor(drift, at);
    const failed = this.rng.next() < spec.failureRate;
    this._add(agentId, "execute_tool", at, dur, this.rng.int(46) + 15,
      { tool: `${server}/${tool}`, mcp_server: server,
        status: failed ? "error" : "ok", stop_reason: "tool_use" });
    return at + dur;
  }

  _reason(agentId, at, tokens, stopReason, drift = null, capture = null) {
    if (capture && at >= capture.t0 && at < capture.t0 + capture.windowS) tokens *= capture.mult;
    const dur = Math.max(0.25, this.rng.gauss(0.8, 0.3)) * latencyDriftFactor(drift, at);
    const extra = {};
    if (stopReason) extra.stop_reason = stopReason;
    this._add(agentId, "chat", at, dur, tokens, extra);
    return at + dur;
  }

  // Each of these is a generator-ish step: advances this.t and returns the next phase fn.
  _intake() {
    let t = this.t;
    // Gaps between these _reason calls are themselves random (dur ~0.25-1.7s from a gaussian,
    // PLUS a 0.4-1.1s pause) and independent, so on an unlucky draw two of them stack into a
    // 2.5-3s silent stretch. That's faithful "one agent thinking, sparse by construction" once a
    // listener already trusts the page is alive -- but for the VERY FIRST intake of a session, a
    // first-time visitor has no way to know a multi-second terminal silence right after pressing
    // play is the swarm being sparse rather than the page being broken (reported directly: "the
    // terminal filled after two events then took 3-4 seconds to start flowing"). Tighter gaps
    // only here, only once -- every later cycle (and every later intake) keeps the real pacing.
    const first = !this._hasIntaken;
    this._hasIntaken = true;
    const gapLo = first ? 0.15 : 0.4, gapHi = first ? 0.45 : 1.1;
    for (let i = 0; i < 3; i++) {
      t = this._reason(ORCHESTRATOR_AGENT_ID, t, 240 + i * 40);
      t += this.rng.uniform(gapLo, gapHi);
    }
    t = this._toolCall(ORCHESTRATOR_AGENT_ID, t);
    this.t = t + 0.6;
  }

  _decompose(fanout) {
    let t = this.t;
    for (let i = 0; i < fanout; i++) {
      t = this._reason(ORCHESTRATOR_AGENT_ID, t, 180 + i * 25);
      if (this.rng.next() < 0.5) t = this._toolCall(ORCHESTRATOR_AGENT_ID, t);
      t += this.rng.uniform(0.3, 0.8);
    }
    t = this._reason(ORCHESTRATOR_AGENT_ID, t, 300, "end_turn");
    this.t = t + 0.5;
  }

  // Each subagent's id (`subagent-r${roundIdx}-${i}`) is TRUE and unbounded -- at fanout 8 this
  // emits 8 distinct identities in one burst, exactly as many as actually spawned. VoicePool
  // (called from director.js) is what compresses that onto the 3 physical worker voices; this
  // method has no opinion about voices at all anymore.
  _fanOut(roundIdx, fanout) {
    const spawnT = this.t;
    const agents = [];
    for (let i = 0; i < fanout; i++) {
      const agentId = `subagent-r${roundIdx}-${i}`;
      this._add(agentId, "create_agent", spawnT + i * 0.18, 0.25, 40, {});
      agents.push([agentId, spawnT + i * 0.18 + 0.3]);
    }
    // Goal-drift, injected as behaviour: one subagent of this round gets slower at its own work
    // as it goes. Nothing downstream is told -- Director has to notice it from the durations.
    // Needs a peer in the same round, or there is nothing to be slower than.
    const inj = this.latencyDrift;
    const driftIdx = fanout >= 2 && this.rng.bool(inj.prob) ? this.rng.int(fanout) : -1;
    // Collusion: one subagent shadows another for a window. The follower must come later in this
    // loop than its leader, since it copies spans the leader has already emitted.
    // Capture: one subagent's output balloons after one of its own tool calls.
    const cap = this.capture;
    const captureIdx = this.rng.bool(cap.prob) ? this.rng.int(fanout) : -1;
    const col = this.collusion;
    let leadIdx = -1, followIdx = -1;
    if (fanout >= 3 && this.rng.bool(col.prob)) {
      leadIdx = this.rng.int(fanout - 1);
      followIdx = leadIdx + 1 + this.rng.int(fanout - leadIdx - 1);
    }
    let leaderSpans = null;
    let maxFinish = this.t;
    for (let i = 0; i < agents.length; i++) {
      const [agentId, start] = agents[i];
      const drift = i === driftIdx ? { t0: start, maxMult: inj.maxMult, rampS: inj.rampS } : null;
      if (drift) {
        this.injectedDrifts.push({ agent: agentId, t0: start });
        if (this.injectedDrifts.length > 200) this.injectedDrifts.shift();
      }
      let t = start;
      let capture = null;   // set on this agent's first tool call, if it is the captured one
      const spansBefore = this.spans.length;
      if (i === followIdx && leaderSpans && leaderSpans.length) {
        // shadow the leader: same kind of work, moments later, for one window
        const colStart = leaderSpans[0].start;
        const mirrored = leaderSpans.filter(x => x.start >= colStart && x.start < colStart + col.windowS);
        for (const x of mirrored) {
          const at = x.start + this.rng.uniform(col.lagS[0], col.lagS[1]);
          const extra = x.op === "execute_tool"
            ? { tool: x.tool, mcp_server: x.mcp_server, status: x.status, stop_reason: "tool_use" }
            : {};
          this._add(agentId, x.op, at, x.duration, x.tokens, extra);
          t = Math.max(t, at + x.duration);
        }
        if (mirrored.length) {
          this.injectedCollusions.push({ leader: agents[leadIdx][0], follower: agentId,
            t0: mirrored[0].start, endS: t });
          if (this.injectedCollusions.length > 200) this.injectedCollusions.shift();
        }
      }
      const steps = 3 + this.rng.int(4);
      for (let step = 0; step < steps; step++) {
        t = this._reason(agentId, t, 160 + this.rng.int(261), undefined, drift, capture);
        const nTools = 1 + this.rng.int(3);
        for (let k = 0; k < nTools; k++) {
          t = this._toolCall(agentId, t, drift);
          // captured by what that tool call returned: from here its own output balloons
          // not the agent's very first tool call: a capture is only visible against what that
          // agent was producing beforehand, so it needs a little history first
          if (i === captureIdx && !capture && step >= 2) {
            capture = { t0: t, mult: cap.mult, windowS: cap.windowS };
            this.injectedCaptures.push({ agent: agentId, t0: t, endS: t + cap.windowS });
            if (this.injectedCaptures.length > 200) this.injectedCaptures.shift();
          }
          t += this.rng.uniform(0.05, 0.3);
        }
        t += this.rng.uniform(0.1, 0.5);
      }
      const reason = this.rng.choice(["end_turn", "end_turn", "end_turn", "max_tokens", "stop_sequence"]);
      t = this._reason(agentId, t, 200 + this.rng.int(301), reason, drift, capture);
      if (i === leadIdx) leaderSpans = this.spans.slice(spansBefore);
      maxFinish = Math.max(maxFinish, t);
    }
    this.t = maxFinish + 0.4;
  }

  _converge(final) {
    let t = this.t;
    for (let i = 0; i < 2; i++) {
      t = this._reason(ORCHESTRATOR_AGENT_ID, t, 260 - i * 60);
      if (this.rng.next() < 0.4) t = this._toolCall(ORCHESTRATOR_AGENT_ID, t);
      t += this.rng.uniform(0.5, 1.2);
    }
    const reason = final ? "stop_sequence" : "end_turn";
    t = this._reason(ORCHESTRATOR_AGENT_ID, t, 150, reason);
    this.t = t + (final ? 0.8 : 1.4);
  }

  // Builds one full task cycle's phase list: intake -> decompose -> N x (fan-out -> converge).
  // Randomized fanout/rounds per cycle so the ensemble width varies session to session AND
  // cycle to cycle within one session -- ROADMAP's "no two users get the same songs" extended
  // to "no two cycles in the same session look the same" either.
  _enqueueCycle() {
    const fanout = 2 + this.rng.int(4);   // 2..5
    const rounds = 1 + this.rng.int(3);   // 1..3
    this._phaseQueue.push(() => this._intake());
    this._phaseQueue.push(() => this._decompose(fanout));
    for (let r = 0; r < rounds; r++) {
      const isFinal = r === rounds - 1;
      this._phaseQueue.push(() => this._fanOut(r, fanout));
      this._phaseQueue.push(() => this._converge(isFinal));
    }
    // loop forever: queue the NEXT cycle's phases right after this one's
    this._phaseQueue.push(() => this._enqueueCycle());
  }

  // Advance the simulation until this.t reaches `until` (seconds), running as many queued
  // phases as needed. Never runs out: _enqueueCycle re-queues itself as the last phase of
  // every cycle.
  advanceUntil(until) {
    let guard = 0;
    while (this.t < until && guard++ < 10000) {
      const phase = this._phaseQueue.shift();
      phase();
    }
  }

  // Bound memory for a session left open indefinitely: drop spans older than `before` seconds
  // once nothing still needs them (caller is responsible for having already consumed/displayed
  // them -- see engine tick's trim call).
  trimBefore(before) {
    if (this.spans.length > 2000) {
      this.spans = this.spans.filter(s => s.start >= before);
    }
  }
}

function round3(x) { return Math.round(x * 1000) / 1000; }

export {
  LATENCY_DRIFT_INJECT, LATENCY_DRIFT_DETECT, detectLatencyDrift, latencyKey,
  COLLUSION_INJECT, COLLUSION_DETECT, detectCollusion,
  CAPTURE_INJECT, CAPTURE_DETECT, detectCaptureSpike,
  Rng, cryptoSeed, SwarmEngine, FORM_BARS, JAZZ_CHORD_TONES, chordSymbol, generateJazzForm,
  VoicePool, resolveVoice, ORCHESTRATOR_AGENT_ID, POOL_SLOTS, LEAD_ROLE_VALUES,
  CHORD_VOICE_ORDER, CHORD_AGENT_VOICES, ARCH_VOICES, VOICE_RANGES,
  COMP_VELOCITY, COMP_SUSTAIN_FRAC, COMP_LIVE_WINDOW_S, COMP_ACCENT_FORM_TOP,
  COMP_ACCENT_CADENCE, COMP_ACCENT_BASS_EXTRA, TERMINAL_STOP_REASONS,
  jazzChoraleVoicing, notesInRange,
  BASS_RANGE, BASS_ANCHOR, WALK_FOUR_FEEL_ACTIVITY, WALK_VELOCITY, WALK_NOTE_FRAC,
  bassToneChoice, bassTarget, walkingBassBar,
  tokensToVelocity, latencyToDuration, nearestChromaticOffsets,
  ARPEGGIO_CORE_TONES, melodyToneIndex,
  MELODY_HOME, MELODY_REGISTER, MELODY_NOTE_GAP_BARS, MELODY_DENSITY_PER_AGENT,
  MELODY_NOTE_DURATION_FRAC, MELODY_ROTATION_BARS, MELODY_PHRASE_NOTES_IDLE,
  MELODY_PHRASE_NOTES_PER_ACTIVITY, MELODY_REST_BARS_IDLE, MELODY_REST_BARS_BUSY,
  MELODY_BUSY_ACTIVITY, MOTIF_CHORD_TONE_SEMITONES, MOTIF_PHRASE_WEIGHTS,
  noteNearStep, arpeggioNotes, generateMotif, motifVariant, performerStepTables, motifNote,
};
