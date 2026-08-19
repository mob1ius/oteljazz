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
 *   SIMPLIFIED, deliberately, to ship this rather than stall on full parity: no motif
 *   generation/development (the solo line uses guide-tone-weighted chord-tone choice + core-
 *   tone arpeggio runs, phrased/rested by activity level, which is faithful to the SOUND
 *   character but not to caidence.py's specific motif-recurrence mechanic); no comp push/
 *   anticipation; no per-section tempo arc (tempo is fixed, since retrofitting a tempo curve
 *   onto an open-ended stream is a different and harder problem than this pass is scoped for);
 *   swing is a single global constant rather than per-section. See BUILD_NOTES.md for the full
 *   list and why each cut was made.
 *
 * MODULATION / "never the same song twice": each CHORUS (16 bars) is a freshly-drawn form --
 * generate_jazz_form is called again every time the bar cursor wraps, not just once for the
 * whole piece -- and the tonic pitch class and major/minor mode are both re-rolled at that
 * point too. This is a direct extension of the existing design (the corpus already decides cell
 * selection; this just re-draws instead of drawing once), not a bolted-on gimmick. The session
 * seed itself comes from crypto.getRandomValues, so it's a different draw every page load --
 * intentionally NOT reproducible the way synthetic_trace()'s seed=0 is, because reproducibility
 * is exactly what this feature is asked not to have.
 */

// ============================================================================================
// Seeded RNG -- mulberry32, seeded from real entropy so every page load differs. This is NOT
// the same determinism model as caidence.py's per-decision action_hash() seeding (which lets
// any single decision be independently reproduced regardless of call order); here one advancing
// stream is enough, since nothing about this needs to be reproducible run-to-run.
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

// agentId -> physical chord voice, handling the one identity that's never pooled before
// delegating everything else to the VoicePool.
function resolveVoice(pool, agentId, t, terminal = false) {
  if (agentId === ORCHESTRATOR_AGENT_ID) return "planner";
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

class SwarmEngine {
  constructor(rng) {
    this.rng = rng;
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

  // Most recent span for `agent` with start < t, or null. Deliberately a scan over `this.spans`
  // rather than a "last write wins" pointer updated as spans are generated: advanceUntil(barEnd)
  // runs whole PHASES atomically (a single _fanOut call can generate 10-20+ seconds of spans in
  // one shot), so a last-write-wins pointer ends up holding a span from WAY past `t` by the time
  // a caller checks it -- confirmed by direct instrumentation: a bar at t=7.5 saw worker2's
  // "last" span sitting at t=31.85, 24s in the future relative to that bar. That made every busy
  // agent look NOT live (its one remembered span was always past barEnd), which silently starved
  // both the comp (chord thickness never reflected real swarm activity) and anomaly-signature
  // targeting (no candidates were ever found). This is the fix: ask for the state as of a
  // specific time, don't cache a single "current" span that a fast-forwarding generator outruns.
  mostRecentSpanBefore(agent, t) {
    let best = null;
    for (const s of this.spans) {
      if (s.agent === agent && s.start < t && (!best || s.start > best.start)) best = s;
    }
    return best;
  }

  _toolCall(agentId, at) {
    const server = this.rng.choice(MCP_SERVER_NAMES);
    const spec = MCP_SERVERS[server];
    const tool = this.rng.choice(spec.tools);
    const dur = latencyDraw(this.rng, spec.latency);
    const failed = this.rng.next() < spec.failureRate;
    this._add(agentId, "execute_tool", at, dur, this.rng.int(46) + 15,
      { tool: `${server}/${tool}`, mcp_server: server,
        status: failed ? "error" : "ok", stop_reason: "tool_use" });
    return at + dur;
  }

  _reason(agentId, at, tokens, stopReason) {
    const dur = Math.max(0.25, this.rng.gauss(0.8, 0.3));
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
    let maxFinish = this.t;
    for (const [agentId, start] of agents) {
      let t = start;
      const steps = 3 + this.rng.int(4);
      for (let step = 0; step < steps; step++) {
        t = this._reason(agentId, t, 160 + this.rng.int(261));
        const nTools = 1 + this.rng.int(3);
        for (let k = 0; k < nTools; k++) {
          t = this._toolCall(agentId, t);
          t += this.rng.uniform(0.05, 0.3);
        }
        t += this.rng.uniform(0.1, 0.5);
      }
      const reason = this.rng.choice(["end_turn", "end_turn", "end_turn", "max_tokens", "stop_sequence"]);
      t = this._reason(agentId, t, 200 + this.rng.int(301), reason);
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
  Rng, cryptoSeed, SwarmEngine, FORM_BARS, JAZZ_CHORD_TONES, chordSymbol, generateJazzForm,
  VoicePool, resolveVoice, ORCHESTRATOR_AGENT_ID, POOL_SLOTS,
  CHORD_VOICE_ORDER, CHORD_AGENT_VOICES, ARCH_VOICES, VOICE_RANGES,
  COMP_VELOCITY, COMP_SUSTAIN_FRAC, COMP_LIVE_WINDOW_S, COMP_ACCENT_FORM_TOP,
  COMP_ACCENT_CADENCE, COMP_ACCENT_BASS_EXTRA, TERMINAL_STOP_REASONS,
  jazzChoraleVoicing, notesInRange,
  BASS_RANGE, BASS_ANCHOR, WALK_FOUR_FEEL_ACTIVITY, WALK_VELOCITY, WALK_NOTE_FRAC,
  bassToneChoice, bassTarget, walkingBassBar,
  tokensToVelocity, latencyToDuration, nearestChromaticOffsets,
  ARPEGGIO_CORE_TONES, melodyToneIndex,
};
