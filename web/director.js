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
  ORCHESTRATOR_AGENT_ID, detectLatencyDrift,
  MELODY_HOME, MELODY_REGISTER, MELODY_NOTE_GAP_BARS, MELODY_DENSITY_PER_AGENT,
  MELODY_NOTE_DURATION_FRAC, MELODY_ROTATION_BARS, MELODY_PHRASE_NOTES_IDLE,
  MELODY_PHRASE_NOTES_PER_ACTIVITY, MELODY_REST_BARS_IDLE, MELODY_REST_BARS_BUSY,
  MELODY_BUSY_ACTIVITY, MOTIF_CHORD_TONE_SEMITONES, MOTIF_PHRASE_WEIGHTS,
  noteNearStep, arpeggioNotes, generateMotif, motifVariant, performerStepTables, motifNote,
} from "./engine.js";

// The NOMINAL tempo: where every session starts, and the centre of the tempo arc (M3). Bars are
// no longer all this long -- see Director._setTempo -- so BAR_S is only a nominal length, for
// callers that need a rough bar (validation scripts). Timing inside Director uses this.beatS /
// this.barS / this.gridS, which belong to the bar being generated.
const TEMPO_BPM = 96.0;
const BEAT_S = 60.0 / TEMPO_BPM;
const BAR_S = BEAT_S * 4;
// --- TEMPO ARC (M3) ---------------------------------------------------------------------------
// Tempo is a telemetry (dynamics) channel: it follows span throughput, never harmony. It may
// change only where a chorus begins -- the same boundary where the form is redrawn and the key
// may move -- so no phrase ever changes speed halfway (the Python engine steps tempo at section
// boundaries for the same reason). The rate is judged against the session's OWN slowly moving
// normal, in log terms, so the rule works for a swarm doing one span a minute or a thousand a
// second: busier than usual speeds up, quieter than usual slows down, steady sits at 96.
// Only spans that had ENDED by the chorus start count, so live and synthetic read it the same way.
const TEMPO_MIN = 76;
const TEMPO_MAX = 120;
const TEMPO_MAX_STEP = 12;                   // BPM, per chorus
const TEMPO_RATE_WINDOW_S = 30;
const TEMPO_PER_LOG_RATE = 14 / Math.LN2;    // twice the usual throughput -> 14 BPM faster
const TEMPO_BASELINE_TAU_S = 300;            // how slowly "usual" moves
const SWING_RATIO = 0.60;                // matches caidence.py's SWING_DEFAULT
const COMP_PUSH_PROBABILITY = 0.38;
const COMP_PUSH_ACCENT = 10;
const MODULATE_PROB = 0.40;              // chance a new chorus also shifts key
const MODE_FLIP_PROB = 0.25;             // chance a new chorus flips major/minor
const MOD_INTERVALS = [2, 5, 7, -5, -7, 1, -2]; // common jazz modulation relations (semitones)
const MELODY_RNG_SALT = 0x3c6ef372;

// --- ANOMALY SIGNATURES -----------------------------------------------------------------
// Ported from caidence.py's demo-only anomaly mechanisms (DRIFT_TARGET/DRIFT_MAX_BEND,
// CONFLICT_BEND, capture_spike_cluster, collusion_unison -- see that file for the originals).
// Honest characterization, per signature:
//   - GOAL-DRIFT is DETECTED, not rolled: engine.js's detectLatencyDrift reads this.swarm.spans
//     every bar, and only a finding starts one (_maybeDetectDrift). Synthetic mode has drift to
//     find because SwarmEngine injects a real latency trend into one subagent's spans; live mode
//     has it only if the real agents actually drift. Same detector, same spans array, no branch.
//     Validated on synthetic injection only (scripts/drift_validation.mjs), not on real drift.
//   - CONFLICT, CAPTURE-SPIKE and COLLUSION are still INJECTED on a timer/probability, the same
//     way caidence.py's extended_demo_trace() hand-places them. Nothing derives them from the swarm.
const ANOMALY_MIN_GAP_S = 30;            // cooldown floor between anomalies, any type
const ANOMALY_ROLL_PROB = 0.05;          // per-bar roll once the cooldown has elapsed
// The FIRST anomaly of a session is scheduled, not rolled for. Measured over 500 headless
// sessions with the pure 5%-per-bar roll: only 39.6% produced an anomaly inside the first 30s
// (median time-to-first 42.5s, p90 160s). Six in ten visitors heard a pleasant piano trio and
// nothing else, on a page whose whole claim is that you hear it go wrong. The roll governs
// everything AFTER the first one, so the long-run density (~2.9 per 5min) is unchanged -- this
// only removes the chance that a short first visit contains no signature at all.
const FIRST_ANOMALY_S = [12, 18];        // [min,max) forced window for the session's first
const DRIFT_WINDOW_S = [8, 16];          // [min,max] audible ramp, clamped from the detected trend's span
const DRIFT_REFLAG_S = 60;               // one agent can't start a second drift inside this
// Goal-drift's PRIMARY signature is the ONSET LAG, not the bend -- the drifting voice's comp
// attack ramps up to 45ms late while the other six stay locked to the shared grid. That is the
// cue the chorale's fusion actually depends on (shared timbre + shared onset grid + voice-led
// motion), so breaking it attacks fusion directly; a pitch bend alone likely isn't decodable
// per-voice once the chord is fusing on purpose. See caidence.py's DRIFT_MAX_ONSET_OFFSET_S and
// BUILD_NOTES.md. The bend below still fires but is a secondary micro-cue only.
// This file previously had the bend WITHOUT the lag, i.e. it implemented the demoted mechanism
// and not the load-bearing one. Do not remove the lag to "simplify" scheduling.
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

// Grid and swing are measured from the bar's own start with the bar's own beat, since beats are
// no longer the same length everywhere. At a constant tempo whose bars start on exact multiples
// of the beat this is the same arithmetic as the old global grid.
function quantize(t, origin, gridS) { return origin + Math.round((t - origin) / gridS) * gridS; }
function applySwing(t, origin, beatS) {
  if (SWING_RATIO <= 0.5) return t;
  const beatIdx = Math.floor((t - origin) / beatS);
  const frac = (t - origin - beatIdx * beatS) / beatS;
  let newFrac;
  if (frac < 0.5) newFrac = (frac / 0.5) * SWING_RATIO;
  else newFrac = SWING_RATIO + ((frac - 0.5) / 0.5) * (1 - SWING_RATIO);
  return origin + beatIdx * beatS + newFrac * beatS;
}
function clampNote(n) { return Math.max(0, Math.min(127, Math.round(n))); }

// Live-mode counterpart to SwarmEngine (engine.js), used when Director is constructed with
// {live: true}. Exposes the exact same three-method surface _generateBar actually calls
// (advanceUntil/spans/trimBefore -- see director.js's _generateBar body, which reads
// this.swarm.spans and calls this.swarm.advanceUntil/trimBefore and has NO other opinion about
// where spans come from). That's the whole point: _generateBar's per-span mapping logic is
// completely unaware whether spans are synthetic or real, so there is exactly one mapping
// implementation feeding on either one, matching CLAUDE.md's rule against a second per-span
// mapping for live-mode convenience -- this only swaps the POPULATOR of `spans`, never the
// consumer.
class LiveSwarmAdapter {
  constructor() {
    this.spans = [];
  }
  // No-op: a live adapter has no synthetic phases to advance. Real spans arrive via feed()
  // whenever the transport layer above (app.js's WebSocket handler) receives one, on their own
  // schedule, not this one.
  advanceUntil() {}
  // Identical to SwarmEngine.trimBefore -- bounds memory for a session left open indefinitely.
  trimBefore(before) {
    if (this.spans.length > 2000) {
      this.spans = this.spans.filter(s => s.start >= before);
    }
  }
  feed(span) { this.spans.push(span); }
}

export class Director {
  // performerIntervals: corpus_model_jazz.json's performer_interval_distributions, for the solo
  // line's contour walk. Without it the walk falls back to small stepwise motion.
  constructor(corpusMatrix, { live = false, seed, swarmOptions, performerIntervals } = {}) {
    // `seed`, when given, replaces the normal fresh-per-visit cryptoSeed() -- everything
    // downstream (key, mode, form, and in synthetic mode the swarm activity itself, since
    // SwarmEngine takes this SAME rng instance rather than seeding its own) derives from this
    // one stream (see cryptoSeed()'s own comment on why one stream is enough), so a shared seed
    // reproduces a session byte-for-byte in synthetic mode. Not meaningful for live mode's
    // actual span content, which is real external data, not generated -- only the harmonic
    // form/key/mode/anomaly-roll side of a live session is seed-reproducible, not what an agent
    // swarm actually did. This project's own Rng is a fully deterministic PRNG (see engine.js),
    // so there is no platform/browser-version dependence to worry about the way there would be
    // with a built-in Math.random().
    this.seed = seed || cryptoSeed();
    this.rng = new Rng(this.seed);
    // The solo line draws from its OWN stream, derived from the same seed, so melody changes can
    // never move anything else (and vice versa): a before/after comparison of the solo can hold
    // the comp, bass, spans and anomalies byte-identical. It reads shared state (key, mode, the
    // current chord) but never draws from this.rng.
    this.melodyRng = new Rng(((this.seed ^ MELODY_RNG_SALT) >>> 0) || 1);
    this.matrix = corpusMatrix;
    this.live = live;
    // swarmOptions is for scripts/drift_validation.mjs (injection on/off); the page never sets it.
    this.swarm = live ? new LiveSwarmAdapter() : new SwarmEngine(this.rng, swarmOptions);

    this.keyPc = this.rng.int(12);                       // random starting key, not always Bb
    this.mode = this.rng.bool(0.7) ? "major" : "minor";   // mostly major, matches corpus skew
    this.chorusIndex = -1;
    this.form = null;                                     // {majorForm, minorForm} for current chorus
    this.absoluteBar = 0;
    this.chorusStartS = 0;          // when the current chorus began (bars start from here)
    this._setTempo(TEMPO_BPM);
    this.tempoBaseline = null;      // log spans/s considered "usual" for this session
    this.tempoLog = [];             // {t, bpm, rate, usual}, for validation/debug
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

    // solo line state -- see _generateMelodyForBar. Draw order on melodyRng is part of the seed
    // contract: performer offset, then the first motif.
    this.performerTables = performerStepTables(performerIntervals);
    this.performerOffset = this.performerTables.length ? this.melodyRng.int(this.performerTables.length) : 0;
    this.motif = generateMotif(this.melodyRng);
    this.motifLog = [];               // phrase starts and motif renewals, for scripts/melody_check.mjs
    this.melodyNote = MELODY_HOME;    // the line's contour carries on from here
    this.melodyNextT = 0;             // when the next melody event is due (may lie in a later bar)
    this.phraseLeft = 0;
    this.phraseMotif = null;
    this.phrasePos = 0;
    this.phraseAnchor = MELODY_HOME;
    this.phraseBaseTone = 0;
    this.phraseIdx = 0;

    // anomaly signature state -- see the ANOMALY SIGNATURES block above
    this.activeDrift = null;      // {voice, startS, windowS}
    this.activeConflict = null;   // {voiceA, voiceB, startS, windowS}
    this.lastAnomalyEndS = -ANOMALY_MIN_GAP_S;
    this.firstAnomalyDueS = this.rng.uniform(...FIRST_ANOMALY_S);  // see FIRST_ANOMALY_S
    this.anomalyCount = 0;
    this.driftFlaggedAt = {};     // true agent id -> when it last started a drift (re-flag guard)
    this.lastVoiceOf = {};        // true agent id -> physical voice its latest span resolved to
    this.lastDetectedDriftEndS = -ANOMALY_MIN_GAP_S;
    this.driftLog = [];           // {t, agent, voice, ratio, growth, r, z}, for validation/debug
    this.driftSkips = {};         // reason -> bars where a finding was NOT rendered

    // callbacks the page wires up
    this.onScheduleNote = null;   // (voice, midiNote, velocity, durationS, atS)
    this.onSpanLine = null;       // ({t, service, line}) for the terminal
    this.onChordChange = null;    // ({t, symbol})
  }

  // Live mode only: called by app.js's WebSocket handler for every real span the relay
  // broadcasts (see src/live-relay.js's spanToLine -- op/tool/tokens/status/service match its
  // output shape). Converts to the exact object shape SwarmEngine._add already produces
  // ({agent, op, start, duration, tokens, status, tool}), so _generateBar's window filter
  // (`this.swarm.spans.filter(...)`) treats a real span identically to a synthetic one -- it has
  // no branch for live vs. synthetic because the shape is the same either way.
  //
  // `nowS` is the caller's current position on the SAME clock _generateBar's barStart/barEnd
  // already use (Tone.Transport.seconds -- see this file's own header: "everything shares ONE
  // clock"). Director stays Tone-agnostic by design (grep this file for "Tone." -- it never
  // imports it), so app.js passes the transport time in rather than Director guessing one of
  // its own; an earlier version stamped performance.now() since construction instead, which runs
  // on a different origin than Transport.seconds (construction happens well before Transport
  // ever starts) and silently starved every bar's window filter -- spans arrived timestamped
  // later than any bar the fill loop had actually reached, so `s.start < barEnd` never matched
  // and nothing was ever consumed despite feed() genuinely being called. Caught via
  // window.__oteljazzDebug(): chordQueueLen was advancing normally while spanQueueLen sat at 0.
  //
  // Bars are generated whole and never revisited, so `nowS` usually falls inside a bar the fill
  // loop has ALREADY generated (generatedUntilS runs up to a bar ahead of it). A span stamped
  // there was never picked up by any bar -- measured: 50 of 286 simulated spans reached the
  // music, and 40 of 143 in a real local relay run. So a stamp behind the frontier moves forward
  // by whole bars: it keeps its position inside the bar (arrival spacing survives) and costs at
  // most one extra bar of delay. This only changes WHERE the populator puts a span; _generateBar
  // reads it exactly as before.
  feedSpan(span, nowS) {
    if (!this.live) return;
    let start = nowS;
    if (start < this.generatedUntilS) {
      start += this.barS * Math.ceil((this.generatedUntilS - start) / this.barS);
    }
    this.swarm.feed({
      agent: span.service,
      op: span.op || "chat",
      start,
      duration: Math.max(0.05, span.durS || 0.3),
      tokens: Math.round(span.tokens || 50),
      status: span.status === "error" ? "error" : "ok",
      ...(span.tool ? { tool: span.tool } : {}),
    });
  }

  _setTempo(bpm) {
    this.tempoBpm = bpm;
    this.beatS = 60.0 / bpm;
    this.barS = this.beatS * 4;
    this.gridS = this.beatS / 4;   // 16th note
  }

  // Decide the tempo for the chorus starting at `atS`. The first measurement only sets the
  // baseline (there is nothing to compare it with yet), so the earliest change is at chorus 3.
  _chooseTempo(atS, prevChorusS) {
    const lo = atS - TEMPO_RATE_WINDOW_S;
    let n = 0;
    for (const s of this.swarm.spans) {
      const end = s.start + s.duration;
      if (end <= atS && end > lo) n++;
    }
    const x = Math.log((n + 0.5) / TEMPO_RATE_WINDOW_S);   // +0.5: a silent window still has a log
    if (this.tempoBaseline === null) { this.tempoBaseline = x; return; }
    const target = TEMPO_BPM + TEMPO_PER_LOG_RATE * (x - this.tempoBaseline);
    const stepped = Math.max(this.tempoBpm - TEMPO_MAX_STEP, Math.min(this.tempoBpm + TEMPO_MAX_STEP, target));
    const bpm = Math.round(Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, stepped)));
    const usual = Math.exp(this.tempoBaseline);
    this.tempoBaseline += (1 - Math.exp(-prevChorusS / TEMPO_BASELINE_TAU_S)) * (x - this.tempoBaseline);
    this.tempoLog.push({ t: atS, bpm, rate: Math.exp(x), usual });
    if (this.tempoLog.length > 200) this.tempoLog.shift();
    if (bpm === this.tempoBpm) return;
    this._setTempo(bpm);
    this.onSpanLine && this.onSpanLine({
      t: atS, service: "tempo",
      line: `<span class="dim">tempo</span> ${bpm} bpm  <span class="dim">throughput ` +
        `${Math.exp(x).toFixed(1)}/s, usually ${usual.toFixed(1)}/s</span>`,
    });
  }

  _ensureChorus(chorusIdx) {
    if (this.chorusIndex === chorusIdx) return;
    const keyBefore = this.keyPc, modeBefore = this.mode;
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
    // A new tonal region gets a new tune: the motif lives as long as the key and mode hold
    // (user decision, docs/ROADMAP.md M2). Drawn from melodyRng, so it moves nothing else.
    if (this.keyPc !== keyBefore || this.mode !== modeBefore) {
      this.motif = generateMotif(this.melodyRng);
      this.motifLog.push({ event: "renew", t: this.chorusStartS, chorus: chorusIdx });
      if (this.motifLog.length > 400) this.motifLog.shift();
    }
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

  // Goal-drift from the telemetry itself. Reads only spans that had ENDED by barStart, so the
  // answer is the same whether this bar is being generated 24s ahead (synthetic) or 1.5s ahead
  // (live). Returns whether there is a finding at all (rendered or not), so the roll can stand
  // down. Rendering rules (user decisions, docs/ROADMAP.md M1):
  //   - never overlaps an active drift or conflict;
  //   - a ROLLED anomaly only has to have ended -- its 30s cooldown doesn't block evidence --
  //     but two DETECTED drifts keep ANOMALY_MIN_GAP_S between them;
  //   - it sounds on the voice the agent holds now, or, if it has lost its pooled slot, on the
  //     voice it last held, as long as that voice is still live. Pooling already puts several
  //     agents on one voice, so this is no new kind of ambiguity.
  // The finding is per TRUE agent. Counts of why a finding wasn't rendered go in driftSkips.
  _maybeDetectDrift(barStart, liveVoices) {
    const found = detectLatencyDrift(this.swarm.spans, barStart);
    if (!found) return false;
    const skip = (why) => { this.driftSkips[why] = (this.driftSkips[why] || 0) + 1; };
    const last = this.driftFlaggedAt[found.agent];
    if (last !== undefined && barStart - last < DRIFT_REFLAG_S) { skip("alreadyRendered"); return false; }
    if (this.activeDrift || this.activeConflict) { skip("busy"); return true; }
    if (barStart < this.lastAnomalyEndS) { skip("busy"); return true; }
    if (barStart - this.lastDetectedDriftEndS < ANOMALY_MIN_GAP_S) { skip("cooldown"); return true; }
    const voice = found.agent === ORCHESTRATOR_AGENT_ID ? "planner"
      : (this.voicePool.slotOf[found.agent] || this.lastVoiceOf[found.agent]);
    if (!voice || voice === "tools") { skip("noVoice"); return true; }
    if (!liveVoices.has(voice)) { skip("voiceNotLive"); return true; }
    const windowS = Math.max(DRIFT_WINDOW_S[0], Math.min(DRIFT_WINDOW_S[1], found.endS - found.startS));
    this.activeDrift = { voice, startS: barStart, windowS };
    this.lastAnomalyEndS = barStart + windowS;
    this.lastDetectedDriftEndS = barStart + windowS;
    this.driftFlaggedAt[found.agent] = barStart;
    this.anomalyCount++;
    // exp(recent): how many times slower than its peers the agent is running NOW. Not
    // exp(growth), which is a fitted trend extrapolated across the run and overstates it.
    const ratio = Math.exp(found.recent);
    this.driftLog.push({ t: barStart, agent: found.agent, voice, ratio, growth: found.growth, r: found.r, z: found.z });
    if (this.driftLog.length > 50) this.driftLog.shift();
    this._logAnomaly(barStart, `goal-drift: ${voice} (${found.agent}) at x${ratio.toFixed(1)} ` +
      `its peers' latency, falling off the shared attack`);
    return true;
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
    // excluded here since "tools's tone flattening" wouldn't read as an agent-behavior signature.
    const candidates = [...CHORD_AGENT_VOICES].filter(v => v !== "tools" && liveVoices.has(v));
    if (candidates.length === 0) return;

    // `anomalyCount` gates `forced` above, so it MUST be maintained -- without it every bar past
    // firstAnomalyDueS fires (measured: 7.91 anomalies per 5min instead of ~3). It is counted
    // from whether the branch below actually committed one rather than incremented up front,
    // because the conflict/collusion branches fall through silently when fewer than two agent
    // voices are live -- which is common early on, exactly when the forced first is due. Every
    // firing branch advances lastAnomalyEndS; no non-firing path does.
    const anomalyEndBefore = this.lastAnomalyEndS;
    // No "drift" here any more: it only ever comes from _maybeDetectDrift.
    const kind = this.rng.choice(["conflict", "capture", "collusion"]);
    if (kind === "conflict" && candidates.length >= 2) {
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
    const chorusIdx = Math.floor(this.absoluteBar / FORM_BARS);
    const barInChorus = this.absoluteBar % FORM_BARS;
    if (barInChorus === 0 && this.absoluteBar > 0) {
      // the previous chorus ends where its last bar did; tempo may change only here
      const prevChorusS = this.generatedUntilS - this.chorusStartS;
      this.chorusStartS = this.generatedUntilS;
      this.swarm.advanceUntil(this.chorusStartS);
      this._chooseTempo(this.chorusStartS, prevChorusS);
    }
    this._ensureChorus(chorusIdx);
    const barStart = this.chorusStartS + barInChorus * this.barS;
    const barEnd = barStart + this.barS;
    const { beatS, gridS } = this;

    const activeForm = this._activeForm();
    const { rootPc, quality } = activeForm[barInChorus];
    // The form is written relative to the tonic; `soundRoot` is the same chord in the current
    // key. Everything that produces PITCH uses soundRoot. Only harmonic-function checks (the
    // V->I cadence accent) stay tonic-relative. Before this, nothing added keyPc except the
    // chord readout: every session sounded in C while the dial showed another key, and key
    // changes were silent (measured: the comp fitted the displayed chord in 257 of 1600 bars).
    const soundRoot = (rootPc + this.keyPc) % 12;

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
      this.lastVoiceOf[s.agent] = s._resolvedVoice;
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

    const voicing = jazzChoraleVoicing(this.prevVoicing, soundRoot, quality, liveVoices);
    const bassIdx = bassToneChoice(activityLevel, this.rng);
    const bassNote = bassTarget(soundRoot, quality, bassIdx);

    // Detection first. Evidence outranks decoration: while the detector has a finding (rendered
    // or still waiting for a voice), the decoy roll stands down for this bar.
    const driftPending = this._maybeDetectDrift(barStart, liveVoices);
    if (!driftPending) this._maybeTriggerAnomaly(barStart, liveVoices, soundRoot, quality, voicing);

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
    this.pendingPush = this.rng.bool(COMP_PUSH_PROBABILITY) ? beatS * 0.5 : 0;

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
    // (a new chorus may still modulate; the approach note assumes the key holds, as the
    // nextRootPc approximation above already assumes the tonic)
    const nextTarget = bassTarget((nextRootPc + this.keyPc) % 12, activeForm[nextBarInChorus] ? activeForm[nextBarInChorus].quality : quality, 0);
    const bar = walkingBassBar(bassNote, nextTarget, soundRoot, quality, fourFeel);
    for (const [beatOff, note] of bar) {
      const t0 = barStart + beatOff * beatS;
      if (t0 >= barEnd) continue;
      const vel = Math.max(1, Math.min(127, WALK_VELOCITY + ((barInChorus === 0 && beatOff === 0) ? Math.floor(COMP_ACCENT_FORM_TOP / 2) : 0)));
      this._schedule("bass", clampNote(note), vel, beatS * WALK_NOTE_FRAC, t0);
    }

    // --- DIRECT tier: one note per span, on that span's own voice, at the current chord's tone
    const chordPcs = new Set(JAZZ_CHORD_TONES[quality].map(t => (((soundRoot + t) % 12) + 12) % 12));
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
      const onset = applySwing(quantize(s.start, barStart, gridS), barStart, beatS);
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

    // --- melody: the solo line over this bar (see _generateMelodyForBar)
    this._generateMelodyForBar(barStart, barEnd, soundRoot, quality, activityLevel, barInChorus);

    this.onChordChange && this.onChordChange({ t: barStart, symbol: chordSymbol(rootPc, quality, this.keyPc) });

    this.prevVoicing = voicing;
    this.prevRootPc = rootPc;
    this.absoluteBar++;
    this.generatedUntilS = barEnd;
  }

  // The solo line, ported from caidence.py's generate_solo_melody:
  //   - a contour walk: each note is a step from the PREVIOUS note, drawn from one Weimar
  //     performer's interval distribution (rotating every MELODY_ROTATION_BARS), snapped to a
  //     tone of the current chord (guide tones favoured), reflected off the register edges;
  //   - core-tone (1-3-5-7) runs, more likely the busier the swarm;
  //   - a motif (see generateMotif) stated, inverted or played backwards as whole phrases, and
  //     always stated exactly when a phrase starts at the top of a chorus;
  //   - phrases that lengthen with activity, each followed by a rest that shortens with it.
  // Pitch is corpus- and contour-driven only. Activity (the telemetry) sets note gap, phrase
  // length, rest length, run probability and velocity -- nothing else. All draws are melodyRng.
  _generateMelodyForBar(barStart, barEnd, rootPc, quality, activityLevel, barInChorus) {
    const rng = this.melodyRng;
    const tones = JAZZ_CHORD_TONES[quality];
    const [lo, hi] = MELODY_REGISTER;
    const { barS, beatS, gridS } = this;
    const gapS = (barS * MELODY_NOTE_GAP_BARS) / (1 + MELODY_DENSITY_PER_AGENT * activityLevel);
    const density = Math.min(4, activityLevel);
    const table = this.performerTables.length
      ? this.performerTables[(Math.floor(this.absoluteBar / MELODY_ROTATION_BARS) + this.performerOffset) % this.performerTables.length]
      : null;
    let t = Math.max(barStart, this.melodyNextT);
    while (t < barEnd) {
      if (this.phraseLeft <= 0) {
        const chorusTop = barInChorus === 0;
        const kind = chorusTop ? "exact"
          : MOTIF_PHRASE_WEIGHTS[rng.weightedIndex(MOTIF_PHRASE_WEIGHTS.map(([, w]) => w))][0];
        this.phraseMotif = motifVariant(this.motif, kind);
        const target = MELODY_PHRASE_NOTES_IDLE + MELODY_PHRASE_NOTES_PER_ACTIVITY * activityLevel;
        this.phraseLeft = this.phraseMotif
          ? this.phraseMotif.length   // a statement is its own length
          : Math.max(1, Math.round(target * (0.6 + 0.8 * rng.next())));
        this.phrasePos = 0;
        this.phraseAnchor = this.melodyNote;
        // Move the anchor by octaves until the whole shape's aim points fit the register, so the
        // statement doesn't have to fold (and so reverse) partway through.
        if (this.phraseMotif) {
          const offs = this.phraseMotif.map(([off]) => off * MOTIF_CHORD_TONE_SEMITONES);
          while (this.phraseAnchor + Math.max(...offs) > hi && this.phraseAnchor - 12 + Math.min(...offs) >= lo) this.phraseAnchor -= 12;
          while (this.phraseAnchor + Math.min(...offs) < lo && this.phraseAnchor + 12 + Math.max(...offs) <= hi) this.phraseAnchor += 12;
        }
        // One chord-tone slot per phrase, not per note -- re-rolling it scrambled the contour
        // in the Python engine (see its comment), so statements stopped sharing a shape.
        this.phraseBaseTone = melodyToneIndex(tones, rng);
        this.motifLog.push({ event: "phrase", t, kind, chorusTop, idx: this.phraseIdx++,
          shape: this.phraseMotif ? this.phraseMotif.map(([off]) => off) : null });
        if (this.motifLog.length > 400) this.motifLog.shift();
      }

      let note, noteGap = gapS;
      const isMotif = !!this.phraseMotif;
      if (isMotif) {
        const pos = Math.min(this.phrasePos, this.phraseMotif.length - 1);
        const [off, durMult] = this.phraseMotif[pos];
        const toneIdx = (((this.phraseBaseTone + off) % tones.length) + tones.length) % tones.length;
        const pc = (((rootPc + tones[toneIdx]) % 12) + 12) % 12;
        const dir = pos === 0 ? 0 : Math.sign(off - this.phraseMotif[pos - 1][0]);
        note = motifNote(pos === 0 ? null : this.melodyNote,
          Math.round(this.phraseAnchor + off * MOTIF_CHORD_TONE_SEMITONES), pc, dir, lo, hi);
        noteGap = gapS * durMult;
      } else {
        const pc = (((rootPc + tones[melodyToneIndex(tones, rng)]) % 12) + 12) % 12;
        let step = table ? table.steps[rng.weightedIndex(table.weights)] : rng.choice([-2, -1, 1, 2]);
        if (this.melodyNote + step > hi) step = -Math.abs(step);
        else if (this.melodyNote + step < lo) step = Math.abs(step);
        note = noteNearStep(this.melodyNote, step, pc);
      }
      // noteNearStep can overshoot the window by up to 12; fold by octaves (keeps pitch class).
      while (note > hi) note -= 12;
      while (note < lo) note += 12;
      this.phrasePos++;

      // A note belongs to THIS bar's chord, so it must also sound inside this bar: rounding to
      // the 16th grid can land exactly on the next bar line, and a run can spill past it (both
      // measured: every out-of-chord solo note was the previous bar's chord sounding late).
      let onset = applySwing(quantize(t, barStart, gridS), barStart, beatS);
      if (onset >= barEnd - 1e-9) onset = applySwing(quantize(t, barStart, gridS) - gridS, barStart, beatS);
      const vel = Math.min(110, 55 + rng.int(30) + density * 5 + (isMotif ? 8 : 0));
      const runProb = isMotif ? 0 : Math.min(0.6, 0.15 + 0.12 * activityLevel);
      if (runProb > 0 && rng.next() < runProb) {
        const run = arpeggioNotes(rootPc, quality, note, rng.bool(0.5));
        // Keep the whole run inside the register by moving it in octaves, which keeps its shape.
        // (caidence.py doesn't fold runs; its runs can leave the window by up to a sixth.)
        while (Math.max(...run) > hi) for (let j = 0; j < run.length; j++) run[j] -= 12;
        while (Math.min(...run) < lo) for (let j = 0; j < run.length; j++) run[j] += 12;
        const stepDur = (noteGap * MELODY_NOTE_DURATION_FRAC) / run.length;
        const fits = run.filter((_, j) => onset + j * stepDur < barEnd - 1e-9);
        fits.forEach((n, j) => this._schedule("melody", clampNote(n), vel, stepDur * 0.9, onset + j * stepDur));
        note = fits[fits.length - 1];
      } else {
        this._schedule("melody", clampNote(note), vel, noteGap * MELODY_NOTE_DURATION_FRAC, onset);
      }
      this.melodyNote = note;
      t += noteGap;

      this.phraseLeft--;
      if (this.phraseLeft <= 0) {
        const busy = Math.min(1, activityLevel / MELODY_BUSY_ACTIVITY);
        const restBars = (MELODY_REST_BARS_IDLE + (MELODY_REST_BARS_BUSY - MELODY_REST_BARS_IDLE) * busy)
          * (0.7 + 0.6 * rng.next());
        t += barS * restBars;
      }
    }
    this.melodyNextT = t;
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
