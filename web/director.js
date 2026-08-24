/*
 * director.js -- the rolling, bar-by-bar generator that drives demo.html's infinite mode.
 * Ties together engine.js's ported harmony/voicing/bass functions and SwarmEngine into one
 * forward-only stream of scheduled Tone.js note events plus a parallel log of spans/chords for
 * the terminal/chord-readout UI. See engine.js's header comment for what's a faithful port of
 * caidence.py vs. what's simplified for this pass.
 *
 * DESIGN: everything (swarm spans, chord form, comp, bass, melody) shares ONE clock -- seconds
 * from Tone.Transport's start, exactly like the batch engine shares one clock across its whole
 * precomputed timeline. Generation happens well AHEAD of playback (a rolling lookahead window,
 * topped up on a timer) rather than being precomputed once for a fixed duration, which is what
 * makes this open-ended: there is no total_seconds anywhere in this file.
 */
import {
  Rng, cryptoSeed, SwarmEngine, FORM_BARS, JAZZ_CHORD_TONES, chordSymbol, generateJazzForm,
  VoicePool, resolveVoice,
  CHORD_VOICE_ORDER, CHORD_AGENT_VOICES, ARCH_VOICES, VOICE_RANGES,
  COMP_VELOCITY, COMP_SUSTAIN_FRAC, COMP_LIVE_WINDOW_S, COMP_ACCENT_FORM_TOP,
  COMP_ACCENT_CADENCE, TERMINAL_STOP_REASONS,
  jazzChoraleVoicing, BASS_RANGE, WALK_FOUR_FEEL_ACTIVITY, WALK_VELOCITY, WALK_NOTE_FRAC,
  bassToneChoice, bassTarget, walkingBassBar,
  tokensToVelocity, latencyToDuration, nearestChromaticOffsets, melodyToneIndex,
  ARPEGGIO_CORE_TONES,
} from "./engine.js";

const TEMPO_BPM = 96.0;
const BEAT_S = 60.0 / TEMPO_BPM;
const BAR_S = BEAT_S * 4;
const GRID_S = BEAT_S / 4;               // 16th note
const SWING_RATIO = 0.60;                // matches caidence.py's SWING_DEFAULT
const COMP_PUSH_PROBABILITY = 0.38;
const COMP_PUSH_ACCENT = 10;
const MODULATE_PROB = 0.40;              // chance a new chorus also shifts key
const MODE_FLIP_PROB = 0.25;             // chance a new chorus flips major/minor
const MOD_INTERVALS = [2, 5, 7, -5, -7, 1, -2]; // common jazz modulation relations (semitones)

// --- ANOMALY SIGNATURES -----------------------------------------------------------------
// Ported from caidence.py's demo-only anomaly mechanisms (DRIFT_TARGET/DRIFT_MAX_BEND,
// CONFLICT_BEND, capture_spike_cluster, collusion_unison -- see that file for the originals).
// Honest characterization, matching what the paper now says explicitly: these are INJECTED on a
// timer/probability, same as caidence.py's extended_demo_trace() hand-places them at fixed
// timestamps -- neither version DERIVES an anomaly from something structurally wrong in the
// swarm. This closes the gap where the browser demo had literally none of the five signatures
// Section 4 calls "the point" of the grammar (verified before this fix: zero occurrences of
// bend/detune/drift/collusion/capture in this file) -- it does not yet make them evidence-driven.
const ANOMALY_MIN_GAP_S = 30;            // cooldown floor between anomalies, any type
const ANOMALY_ROLL_PROB = 0.05;          // per-bar roll once the cooldown has elapsed
// The FIRST anomaly of a session is scheduled, not rolled for. Measured over 500 headless
// sessions with the pure 5%-per-bar roll: only 39.6% produced an anomaly inside the first 30s
// (median time-to-first 42.5s, p90 160s). Six in ten visitors heard a pleasant piano trio and
// nothing else, on a page whose whole claim is that you hear it go wrong. The roll governs
// everything AFTER the first one, so the long-run density (~2.9 per 5min) is unchanged -- this
// only removes the chance that a short first visit contains no signature at all.
const FIRST_ANOMALY_S = [12, 18];        // [min,max) forced window for the session's first
const DRIFT_WINDOW_S = [8, 16];          // [min,max) ramp duration
// Goal-drift's PRIMARY signature is the ONSET LAG, not the bend -- the drifting voice's comp
// attack ramps up to 45ms late while the other six stay locked to the shared grid. That is the
// cue the chorale's fusion actually depends on (shared timbre + shared onset grid + voice-led
// motion), so breaking it attacks fusion directly; a pitch bend alone likely isn't decodable
// per-voice once the chord is fusing on purpose. See caidence.py's DRIFT_MAX_ONSET_OFFSET_S and
// BUILD_NOTES.md. The bend below still fires but is a secondary micro-cue only.
// This file previously had the bend WITHOUT the lag, i.e. it implemented the mechanism the paper
// explicitly demotes and not the one it claims. Do not remove the lag to "simplify" scheduling.
const DRIFT_MAX_ONSET_OFFSET_S = 0.045;  // matches caidence.py's DRIFT_MAX_ONSET_OFFSET_S
const DRIFT_MAX_BEND_SEMITONES = -1.5;   // matches caidence.py's DRIFT_MAX_BEND at +/-2 range
const CONFLICT_WINDOW_S = [4, 9];
const CONFLICT_BEND_SEMITONES = 0.73;    // matches caidence.py's CONFLICT_BEND (3000/8192*2)
const CAPTURE_SPIKE_COUNT = 4;
const CAPTURE_SPIKE_GAP_S = 0.09;
const CAPTURE_SPIKE_NOTE_S = 0.07;
const CAPTURE_SPIKE_VELOCITY = 105;
const COLLUSION_COUNT = 3;
const COLLUSION_GAP_S = 0.5;
const COLLUSION_VELOCITY = 90;

function quantize(t) { return Math.round(t / GRID_S) * GRID_S; }
function applySwing(t) {
  if (SWING_RATIO <= 0.5) return t;
  const beatIdx = Math.floor(t / BEAT_S);
  const frac = (t - beatIdx * BEAT_S) / BEAT_S;
  let newFrac;
  if (frac < 0.5) newFrac = (frac / 0.5) * SWING_RATIO;
  else newFrac = SWING_RATIO + ((frac - 0.5) / 0.5) * (1 - SWING_RATIO);
  return beatIdx * BEAT_S + newFrac * BEAT_S;
}
function clampNote(n) { return Math.max(0, Math.min(127, Math.round(n))); }

export class Director {
  constructor(corpusMatrix) {
    this.rng = new Rng(cryptoSeed());
    this.matrix = corpusMatrix;
    this.swarm = new SwarmEngine(this.rng);

    this.keyPc = this.rng.int(12);                       // random starting key, not always Bb
    this.mode = this.rng.bool(0.7) ? "major" : "minor";   // mostly major, matches corpus skew
    this.chorusIndex = -1;
    this.form = null;                                     // {majorForm, minorForm} for current chorus
    this.absoluteBar = 0;
    this.prevVoicing = null;
    this.prevBassNote = null;
    this.pendingPush = 0;   // bar 0 never pushes -- see _generateBar's push comment
    this.generatedUntilS = 0;

    // True agent id -> physical chord voice, called once per span in the SAME time order bars
    // are generated in (see _generateBar) -- the browser-side counterpart of caidence.py's
    // VoicePool/pool_spans, previously missing here entirely (SwarmEngine used to pool identity
    // itself, before this class ever saw a span -- see engine.js's ORCHESTRATOR_AGENT_ID comment
    // for why that was wrong). `recentVoiceSeen` tracks the last time each PHYSICAL voice (not
    // true agent) was active, for comp liveness -- see _generateBar's liveVoices computation.
    this.voicePool = new VoicePool();
    this.recentVoiceSeen = {};   // physical voice -> last-seen bar-relative time

    // melody phrase state
    this.melodyRestUntil = 0;
    this.melodyNotesLeftInPhrase = 0;

    // anomaly signature state -- see the ANOMALY SIGNATURES block above
    this.activeDrift = null;      // {voice, startS, windowS}
    this.activeConflict = null;   // {voiceA, voiceB, startS, windowS}
    this.lastAnomalyEndS = -ANOMALY_MIN_GAP_S;
    this.firstAnomalyDueS = this.rng.uniform(...FIRST_ANOMALY_S);  // see FIRST_ANOMALY_S
    this.anomalyCount = 0;

    // callbacks the page wires up
    this.onScheduleNote = null;   // (voice, midiNote, velocity, durationS, atS)
    this.onSpanLine = null;       // ({t, service, line}) for the terminal
    this.onChordChange = null;    // ({t, symbol})
  }

  _ensureChorus(chorusIdx) {
    if (this.chorusIndex === chorusIdx) return;
    if (this.chorusIndex >= 0) {
      // a NEW chorus starting: re-draw the form (always) and maybe modulate key/mode --
      // this is what keeps "always opens doors to move to different options of chords" true
      // chorus after chorus, not just once per page load.
      if (this.rng.bool(MODULATE_PROB)) {
        this.keyPc = (this.keyPc + this.rng.choice(MOD_INTERVALS) + 120) % 12;
      }
      if (this.rng.bool(MODE_FLIP_PROB)) {
        this.mode = this.mode === "major" ? "minor" : "major";
      }
    }
    this.form = generateJazzForm(this.matrix, this.rng);
    this.chorusIndex = chorusIdx;
  }

  _activeForm() { return this.mode === "major" ? this.form.majorForm : this.form.minorForm; }

  // The bend (in semitones) currently applied to `voice` at time `atS`, from either signature.
  // Drift is a linear ramp toward DRIFT_MAX_BEND_SEMITONES over its window (matching
  // caidence.py's linear pitchwheel ramp); conflict is a constant held bend, same as
  // caidence.py's CONFLICT_BEND being set once and held for the window rather than ramped.
  // Expired windows are cleared lazily here rather than on a separate timer, since this is
  // already called on every note this voice schedules.
  _activeBendFor(voice, atS) {
    let bend = 0;
    const d = this.activeDrift;
    if (d) {
      if (atS >= d.startS + d.windowS) { this.activeDrift = null; }
      else if (voice === d.voice && atS >= d.startS) {
        bend += DRIFT_MAX_BEND_SEMITONES * Math.min(1, (atS - d.startS) / d.windowS);
      }
    }
    const c = this.activeConflict;
    if (c) {
      if (atS >= c.startS + c.windowS) { this.activeConflict = null; }
      else if (voice === c.voiceB && atS >= c.startS) {
        bend += CONFLICT_BEND_SEMITONES;
      }
    }
    return bend;
  }

  // How late `voice`'s comp attack lands at grid time `atS`, in seconds: a linear ramp to
  // DRIFT_MAX_ONSET_OFFSET_S across the drift window, mirroring caidence.py's
  // drift_onset_delay_s. Unlike _activeBendFor this is deliberately READ-ONLY -- it never clears
  // an expired window, so it cannot race the lazy clear there depending on call order.
  _driftOnsetDelayFor(voice, atS) {
    const d = this.activeDrift;
    if (!d || voice !== d.voice) return 0;
    if (atS < d.startS || atS >= d.startS + d.windowS) return 0;
    return DRIFT_MAX_ONSET_OFFSET_S * Math.min(1, (atS - d.startS) / d.windowS);
  }

  // Roll for a new anomaly once the cooldown has elapsed, pick a signature and target voice(s)
  // from whichever chord-agent voices are actually live right now (an anomaly needs someone to
  // happen to), and either start a continuous-deviation window (drift/conflict, resolved per
  // note by _activeBendFor) or fire a discrete cluster immediately (capture-spike/collusion).
  _maybeTriggerAnomaly(barStart, liveVoices, rootPc, quality, voicing) {
    if (this.activeDrift || this.activeConflict) return;
    if (barStart - this.lastAnomalyEndS < ANOMALY_MIN_GAP_S) return;
    // The session's first anomaly is due rather than rolled for (see FIRST_ANOMALY_S); it still
    // needs a live candidate voice below, so during a quiet intake it lands at the first bar
    // after the due time that actually has someone for it to happen to.
    const forced = this.anomalyCount === 0 && barStart >= this.firstAnomalyDueS;
    if (!forced && !this.rng.bool(ANOMALY_ROLL_PROB)) return;
    // "tools" is a voice, not an agent identity (see caidence.py's CHORD_AGENT_VOICES comment) --
    // excluded here since "tools's tone flattening" wouldn't read as an agent-behaviour signature.
    const candidates = [...CHORD_AGENT_VOICES].filter(v => v !== "tools" && liveVoices.has(v));
    if (candidates.length === 0) return;

    // `anomalyCount` gates `forced` above, so it MUST be maintained -- without it every bar past
    // firstAnomalyDueS fires (measured: 7.91 anomalies per 5min instead of ~3). It is counted
    // from whether the branch below actually committed one rather than incremented up front,
    // because the conflict/collusion branches fall through silently when fewer than two agent
    // voices are live -- which is common early on, exactly when the forced first is due. Every
    // firing branch advances lastAnomalyEndS; no non-firing path does.
    const anomalyEndBefore = this.lastAnomalyEndS;
    const kind = this.rng.choice(["drift", "conflict", "capture", "collusion"]);
    if (kind === "drift") {
      const voice = this.rng.choice(candidates);
      const windowS = this.rng.uniform(...DRIFT_WINDOW_S);
      this.activeDrift = { voice, startS: barStart, windowS };
      this.lastAnomalyEndS = barStart + windowS;
      this._logAnomaly(barStart, `goal-drift: ${voice} falling off the ensemble's shared attack over ${windowS.toFixed(1)}s`);
    } else if (kind === "conflict" && candidates.length >= 2) {
      const voiceA = this.rng.choice(candidates);
      const voiceB = this.rng.choice(candidates.filter(v => v !== voiceA));
      const windowS = this.rng.uniform(...CONFLICT_WINDOW_S);
      this.activeConflict = { voiceA, voiceB, startS: barStart, windowS };
      this.lastAnomalyEndS = barStart + windowS;
      this._logAnomaly(barStart, `conflict: ${voiceA} vs ${voiceB}, held sour for ${windowS.toFixed(1)}s`);
    } else if (kind === "capture") {
      const voice = this.rng.choice(candidates);
      const base = voicing[voice] !== undefined ? voicing[voice] : VOICE_RANGES[voice][0];
      const chordPcs = new Set(JAZZ_CHORD_TONES[quality].map(t => (((rootPc + t) % 12) + 12) % 12));
      const offsets = nearestChromaticOffsets(chordPcs, CAPTURE_SPIKE_COUNT);
      offsets.forEach((off, i) => {
        const t = barStart + i * CAPTURE_SPIKE_GAP_S;
        this._schedule(voice, clampNote(base + off), CAPTURE_SPIKE_VELOCITY, CAPTURE_SPIKE_NOTE_S, t);
      });
      this.lastAnomalyEndS = barStart + offsets.length * CAPTURE_SPIKE_GAP_S;
      this._logAnomaly(barStart, `capture-spike: ${voice} hit a chromatic wrong-note cluster`);
    } else if (kind === "collusion" && candidates.length >= 2) {
      const voiceA = this.rng.choice(candidates);
      const voiceB = this.rng.choice(candidates.filter(v => v !== voiceA));
      const note = 60;   // fixed unison pitch -- the signature IS two independent voices
                          // suddenly playing the identical note in lockstep, not which note
      for (let i = 0; i < COLLUSION_COUNT; i++) {
        const t = barStart + i * COLLUSION_GAP_S;
        this._schedule(voiceA, note, COLLUSION_VELOCITY, 0.15, t);
        this._schedule(voiceB, note, COLLUSION_VELOCITY, 0.15, t);
      }
      this.lastAnomalyEndS = barStart + COLLUSION_COUNT * COLLUSION_GAP_S;
      this._logAnomaly(barStart, `collusion: ${voiceA} and ${voiceB} synchronized on an identical pitch`);
    }
    if (this.lastAnomalyEndS !== anomalyEndBefore) this.anomalyCount++;
  }

  _logAnomaly(t, text) {
    this.onSpanLine && this.onSpanLine({
      t, service: "oversight-grammar",
      line: `<span class="err">anomaly</span>  ${text}`,
    });
  }

  // Generate and schedule exactly one bar's worth of everything, advancing all cursors.
  _generateBar() {
    const barStart = this.absoluteBar * BAR_S;
    const barEnd = barStart + BAR_S;
    const chorusIdx = Math.floor(this.absoluteBar / FORM_BARS);
    const barInChorus = this.absoluteBar % FORM_BARS;
    this._ensureChorus(chorusIdx);

    const activeForm = this._activeForm();
    const { rootPc, quality } = activeForm[barInChorus];

    this.swarm.advanceUntil(barEnd);

    const windowSpans = this.swarm.spans.filter(s => !s._scheduled && s.start >= barStart && s.start < barEnd);
    windowSpans.forEach(s => { s._scheduled = true; });
    // Sort defensively into true start-time order before resolving voices: VoicePool is causal
    // (its steal/retire decisions depend on being fed spans in the order they actually happen),
    // and while SwarmEngine's spans end up append-order = start-time order in practice, this
    // guarantees it rather than assuming it.
    windowSpans.sort((a, b) => a.start - b.start);

    // Resolve every span's TRUE agent id onto a physical chord voice, in time order, via the
    // shared VoicePool -- the browser counterpart of caidence.py's pool_spans, run per-bar
    // instead of once over a whole precomputed list (this generator has no "whole list", only
    // what's been generated so far). Each resolution updates recentVoiceSeen so THIS bar's own
    // activity counts toward THIS bar's own liveness, matching generate_voicing_schedule's
    // window semantics (a bar's live_voices includes spans starting inside that same window).
    for (const s of windowSpans) {
      const terminal = TERMINAL_STOP_REASONS.has(s.stop_reason);
      s._resolvedVoice = resolveVoice(this.voicePool, s.agent, s.start, terminal);
      this.recentVoiceSeen[s._resolvedVoice] = s.start;
    }

    // activityLevel is the TRUE distinct-agent count (unbounded, NOT capped at the 5 physical
    // voices) -- this is what caidence.py's fix made possible: before, activeAgents filtered by
    // CHORD_AGENT_VOICES membership, which capped it at 4 regardless of how many subagents were
    // actually spawned, because agent was already a pooled name by the time anything saw it.
    const activeAgents = new Set(windowSpans.map(s => s.agent));
    const activityLevel = activeAgents.size;

    // liveVoices: a pooled voice (worker1/2/3) is live iff its slot is CURRENTLY occupied (which
    // VoicePool already tracks precisely -- retirement frees the slot the instant it happens, no
    // separate "as of barStart" query needed the way the old mostRecentSpanBefore-based version
    // required) AND it's been active within COMP_LIVE_WINDOW_S. "planner" has no pool slot (it's
    // the one fixed, never-pooled identity -- see resolveVoice) so it's judged on recency alone.
    // "tools" is a SOUNDING-voice override applied per-span (see the DIRECT-tier loop below), not
    // an identity anything resolves to, so it never appears here -- matching caidence.py exactly
    // (voice_of(s) for a tool-call span resolves to the CALLING agent's voice, never "tools").
    const liveVoices = new Set(ARCH_VOICES);
    for (const voice of CHORD_AGENT_VOICES) {
      const lastSeen = this.recentVoiceSeen[voice];
      const recentEnough = lastSeen !== undefined && barStart - lastSeen <= COMP_LIVE_WINDOW_S;
      const occupied = voice === "planner" || voice === "tools" || this.voicePool.occupant[voice] !== null;
      if (recentEnough && occupied) liveVoices.add(voice);
    }

    const voicing = jazzChoraleVoicing(this.prevVoicing, rootPc, quality, liveVoices);
    const bassIdx = bassToneChoice(activityLevel, this.rng);
    const bassNote = bassTarget(rootPc, quality, bassIdx);

    this._maybeTriggerAnomaly(barStart, liveVoices, rootPc, quality, voicing);

    // --- push (anticipation): landing a chord an eighth early is THE characteristic jazz comp
    // gesture, but the comp note it replaces must be shortened to make room or the two clash --
    // caidence.py's build_timeline computes every bar's push BEFORE emitting any of them so each
    // bar's duration can reach exactly to the (possibly-early) next attack. This generator is
    // forward-only, so instead: `this.pendingPush` is decided one bar AHEAD of when it's used --
    // i.e. while generating bar N we both consume the push decided during bar N-1's generation
    // AND decide bar N+1's push right now, so by the time we compute bar N's duration we already
    // know exactly where bar N+1 will attack. (An earlier version used a fixed BAR_S duration
    // regardless of push, which meant a pushed bar's sustain ran past the nominal bar boundary
    // and directly overlapped/clashed with the next bar's comp chord -- audible as harmonic
    // mush, not swing. This is the fix for that.)
    const thisPush = this.pendingPush || 0;
    this.pendingPush = this.rng.bool(COMP_PUSH_PROBABILITY) ? BEAT_S * 0.5 : 0;

    const nextBarInChorus = (barInChorus + 1) % FORM_BARS;
    // the next bar's chord, for the cadence-accent lookahead only; if it crosses into a new
    // chorus, approximate with the turnaround->tonic relation, which is always what happens
    const nextRootPc = nextBarInChorus === 0 ? 0 : activeForm[nextBarInChorus].rootPc;

    const attack = barStart - thisPush;
    const nextAttack = barEnd - this.pendingPush;
    const dur = Math.min(nextAttack - attack, 6.0) * COMP_SUSTAIN_FRAC;

    let accent = 0;
    if (barInChorus === 0) accent += COMP_ACCENT_FORM_TOP;
    const prevRootPc = this.prevRootPc;
    if (prevRootPc === 7 && rootPc === 0) accent += COMP_ACCENT_CADENCE;
    if (thisPush > 0) accent += COMP_PUSH_ACCENT;

    // --- comp: sustained chord for every currently-live voice
    for (const voice of CHORD_VOICE_ORDER) {
      if (!liveVoices.has(voice)) continue;
      const note = voicing[voice];
      const vel = Math.max(1, Math.min(127, COMP_VELOCITY + accent));
      const bendAt = Math.max(0, attack);
      // Both the bend and the lag are evaluated at the GRID time, not the delayed one, so the
      // ramp position is identical for every voice; only this voice's attack moves. Duration is
      // deliberately NOT shortened, matching caidence.py (the note_off also shifts by the lag).
      const voiceAttack = bendAt + this._driftOnsetDelayFor(voice, bendAt);
      this._schedule(voice, note, vel, dur, voiceAttack, this._activeBendFor(voice, bendAt));
    }

    // --- walking bass
    const fourFeel = activityLevel >= WALK_FOUR_FEEL_ACTIVITY;
    const nextTarget = bassTarget(nextRootPc, activeForm[nextBarInChorus] ? activeForm[nextBarInChorus].quality : quality, 0);
    const bar = walkingBassBar(bassNote, nextTarget, rootPc, quality, fourFeel);
    for (const [beatOff, note] of bar) {
      const t0 = barStart + beatOff * BEAT_S;
      if (t0 >= barEnd) continue;
      const vel = Math.max(1, Math.min(127, WALK_VELOCITY + ((barInChorus === 0 && beatOff === 0) ? Math.floor(COMP_ACCENT_FORM_TOP / 2) : 0)));
      this._schedule("bass", clampNote(note), vel, BEAT_S * WALK_NOTE_FRAC, t0);
    }

    // --- DIRECT tier: one note per span, on that span's own voice, at the current chord's tone
    const chordPcs = new Set(JAZZ_CHORD_TONES[quality].map(t => (((rootPc + t) % 12) + 12) % 12));
    for (const s of windowSpans) {
      // DIRECT-tier notes are NEVER gated by comp liveness in the Python engine either -- a
      // span always plays its own voice's note; liveness/live_voices only controls whether the
      // SUSTAINED comp bed includes that voice. (Comp liveness is in fact DERIVED from spans
      // like this one, so gating them by it would be circular.) `s._resolvedVoice` was already
      // computed above (in time order, before liveVoices) by VoicePool -- s.agent itself is the
      // TRUE unbounded id now and is never a physical voice name directly (except "orchestrator",
      // which resolveVoice maps to "planner").
      const soundingVoice = s.op === "execute_tool" ? "tools" : s._resolvedVoice;
      const note = voicing[soundingVoice] !== undefined ? voicing[soundingVoice] : VOICE_RANGES[soundingVoice][0];
      const vel = tokensToVelocity(s.tokens);
      const dur2 = latencyToDuration(s.op, s.duration);
      const onset = applySwing(quantize(s.start));
      this._schedule(soundingVoice, note, vel, dur2, onset, this._activeBendFor(soundingVoice, onset));

      if (s.status === "error") {
        const graceOffset = nearestChromaticOffsets(chordPcs, 1)[0];
        this._schedule(soundingVoice, clampNote(note + graceOffset), 100, 0.18, onset);
      }

      this.onSpanLine && this.onSpanLine({
        t: onset, service: s.agent,   // s.agent is the true id now -- no separate swarm_agent field
        line: this._spanLineHtml(s),
      });
    }

    // --- melody: simplified phrase-gated, guide-tone-weighted line over this bar (see
    // engine.js's header for what this deliberately does NOT reproduce -- motif development)
    this._generateMelodyForBar(barStart, barEnd, rootPc, quality, activityLevel);

    this.onChordChange && this.onChordChange({ t: barStart, symbol: chordSymbol(rootPc, quality, this.keyPc) });

    this.prevVoicing = voicing;
    this.prevRootPc = rootPc;
    this.absoluteBar++;
    this.generatedUntilS = barEnd;
  }

  _generateMelodyForBar(barStart, barEnd, rootPc, quality, activityLevel) {
    const tones = JAZZ_CHORD_TONES[quality];
    let t = Math.max(barStart, this.melodyRestUntil);
    const density = Math.min(4, activityLevel);            // 0..4
    const gapS = Math.max(0.18, 0.55 - density * 0.09);
    while (t < barEnd) {
      if (this.melodyNotesLeftInPhrase <= 0) {
        // decide a new phrase or a rest
        const phraseLen = 2 + density * 2 + this.rng.int(3);
        const restBars = Math.max(0.15, 1.4 - density * 0.3);
        if (this.rng.bool(0.15 + 0.05 * (4 - density))) {
          this.melodyRestUntil = t + restBars * BEAT_S;
          t = this.melodyRestUntil;
          this.melodyNotesLeftInPhrase = 0;
          continue;
        }
        this.melodyNotesLeftInPhrase = phraseLen;
      }
      if (t >= barEnd) break;
      const idx = melodyToneIndex(tones, this.rng);
      const registerBase = 60 + this.rng.int(24) - 12;
      const base = registerBase - (registerBase % 12) + (((rootPc + tones[idx]) % 12) + 12) % 12;
      let note = clampNote([base - 12, base, base + 12].reduce((a, b) =>
        Math.abs(a - registerBase) <= Math.abs(b - registerBase) ? a : b));
      const vel = 55 + this.rng.int(30) + density * 5;
      const dur = gapS * 0.85;
      this._schedule("melody", note, Math.min(110, vel), dur, applySwing(quantize(t)));
      this.melodyNotesLeftInPhrase--;
      t += gapS;
    }
  }

  _spanLineHtml(s) {
    const ok = s.status !== "error";
    // Operation only, no agent prefix: app.js already renders "[12.34s <agent>]" ahead of this,
    // so including it here printed the agent name twice and burned ~20 characters of line width --
    // which is most of the budget on a phone, where the terminal is ~250px wide.
    let line = `<span class="dim">span</span> ${s.op}`
      + (s.tool ? ` <span class="dim">tool=</span>${s.tool}` : "")
      + ` <span class="dim">tokens=</span>${s.tokens}`
      + (s.stop_reason ? ` <span class="dim">finish=</span>${s.stop_reason}` : "")
      + `  ${ok ? '<span class="ok">OK</span>' : '<span class="err">ERROR</span>'}`;
    return line;
  }

  _schedule(voice, note, vel, dur, atS, detuneSemitones = 0) {
    // detuneSemitones: continuous-deviation signature (drift/conflict) currently affecting this
    // voice, if any -- see _activeBendFor. Resolved to a bent Hz frequency by demo.html's
    // onScheduleNote handler rather than here, since a shared Tone.Sampler instrument (one for
    // all 7 piano voices) has no per-voice detune parameter to automate; a per-NOTE frequency
    // override is what actually makes ONE voice audibly bend while its neighbors stay in tune.
    this.onScheduleNote && this.onScheduleNote(voice, note, vel, dur, Math.max(0, atS), detuneSemitones);
  }

  // Generate+schedule bars until generatedUntilS reaches `untilS`. Call this from a periodic
  // tick while playing; never returns "done" because _enqueueCycle keeps the swarm (and
  // therefore the whole stream) going forever.
  fillUntil(untilS) {
    let guard = 0;
    while (this.generatedUntilS < untilS && guard++ < 2000) {
      this._generateBar();
    }
    this.swarm.trimBefore(this.generatedUntilS - 120);
  }
}

export { BAR_S, TEMPO_BPM };
