// Entry point for the demo page. Extracted verbatim from an inline
// <script type="module"> block in demo.html so the site can ship a Content-Security-Policy
// with script-src 'self' and no 'unsafe-inline': an inline script would be blocked by that
// policy, and allowing inline scripts would defeat most of the point of having the CSP.
// Behavior is unchanged -- this is a move, not a rewrite.

import { Director, BAR_S } from "./director.js";

const PIZZ_BASS_BASE = "samples/pizz_bass/";
const SALAMANDER_BASE = "samples/salamander_piano/";
const CORPUS_URL = "corpus_model_jazz.json";

const PIZZ_MAP = {
  "E1": "E1", "F1": "F1", "Fs1": "F#1", "G1": "G1", "Gs1": "G#1", "A1": "A1", "As1": "A#1",
  "C2": "C2", "Cs2": "C#2", "D2": "D2", "Ds2": "D#2", "E2": "E2", "F2": "F2",
  "Fs2": "F#2", "G2": "G2", "Gs2": "G#2", "A2": "A2", "As2": "A#2", "B2": "B2"
};
const SALAMANDER_MAP = {};
for (const oct of [2, 3, 4, 5, 6]) {
  for (const [file, note] of [["A","A"], ["C","C"], ["Ds","D#"], ["Fs","F#"]]) {
    SALAMANDER_MAP[`${file}${oct}`] = `${note}${oct}`;
  }
}

let bassSampler, pianoSampler, director;
let vuBars = document.querySelectorAll("#vu i");
let statusEl = document.getElementById("statusText");
let termEl = document.getElementById("term");
let chordEl = document.getElementById("chordReadout");
// Mirror of the chord shown inside the radio dial on narrow screens, where the span terminal
// moves below the radio and the dial would otherwise sit dark and look switched off.
let chordDialEl = document.getElementById("chordDial");
let powerBtn = document.getElementById("powerBtn");
let playing = false;
let started = false;
let termLines = [];
// Module-scoped (not inside startEngine's closure) so a pause/resume cycle can reset the idle
// clock -- see the stall-watchdog comment further down for what these track and why.
let lastPushWallMs = performance.now();
let stalledSinceWallMs = null;

// Reveal queues: Director generates well AHEAD of playback (see LOOKAHEAD_S below), so audio
// scheduling (exact, via Tone.Transport.schedule) and on-screen reveal (cosmetic, time-gated by
// the poller) are handled separately -- same split demo.html used for the static file, just fed
// by a live, open-ended generator instead of two static JSON arrays.
let pendingNoteReveals = [];
let pendingSpanLines = [];
let pendingChords = [];
let noteCursor = 0, spanCursor = 0, chordCursor = 0;

// Loading real sample files (12 bass + 20 piano, individual mp3s) over the network on a cold
// cache genuinely takes a few seconds -- put that visibly IN the terminal, not just the status
// line below it, so the empty dial glass doesn't read as frozen/broken while it happens.
termEl.innerHTML = '<span class="dim">&gt; connecting to swarm uplink...</span>';

fetch(CORPUS_URL).then(r => r.json()).then(corpus => {
  statusEl.textContent = "Loading instruments...";
  termEl.innerHTML = '<span class="dim">&gt; connecting to swarm uplink...\n&gt; loading instrument samples...</span>';
  director = new Director(corpus.root_transition_matrix_major);

  director.onScheduleNote = (voice, note, vel, dur, atS, detuneSemitones) => {
    Tone.Transport.schedule((time) => {
      const sampler = voice === "bass" ? bassSampler : pianoSampler;
      // A continuous-deviation signature (drift/conflict -- see director.js's ANOMALY
      // SIGNATURES block) bends just ONE voice while its neighbors stay in tune. bassSampler/
      // pianoSampler are each shared across several voices (all 7 chord voices share one
      // pianoSampler instance), so there's no per-voice instrument-level detune parameter to
      // automate -- the bend has to be baked into THIS note's own pitch instead of the quantized
      // note name, which is exactly what Tone.Frequency(...).transpose() (fractional semitones,
      // not snapped to the nearest MIDI note) gives us.
      const pitch = detuneSemitones
        ? Tone.Frequency(note, "midi").transpose(detuneSemitones)
        : Tone.Frequency(note, "midi").toNote();
      sampler.triggerAttackRelease(pitch, dur, time, vel / 127);
    }, atS);
    pendingNoteReveals.push({ t: atS });
  };
  director.onSpanLine = (item) => { pendingSpanLines.push(item); };
  director.onChordChange = (item) => { pendingChords.push({ t: item.t, symbol: item.symbol }); };

  return loadInstruments();
}).then(() => {
  statusEl.textContent = "Ready.";
  termEl.innerHTML = '<span class="dim">&gt; ready. press play.</span>';
  powerBtn.disabled = false;
  setupKnobs(); // audio nodes (tuningFilter/staticGain) now exist -- safe to apply initial values
}).catch(err => {
  statusEl.textContent = "Error: " + err.message;
  console.error(err);
});

// Tuning knob's effect chain: a lowpass filter (muffles as you tune away from center) plus a
// pink-noise bed mixed in proportional to how far off-center the knob is (radio static). Both
// sit AFTER the reverb/eq/comp chain, right before the destination, so "detuning" affects the
// whole mix at once like a real radio's tuning dial rather than any one instrument.
let tuningFilter, staticNoise, staticGain;

function loadInstruments() {
  return new Promise((resolve, reject) => {
    let loaded = 0;
    const need = 2;
    function check() { loaded++; if (loaded === need) resolve(); }

    tuningFilter = new Tone.Filter({ frequency: 20000, type: "lowpass", rolloff: -12 }).toDestination();
    staticGain = new Tone.Gain(0).connect(tuningFilter);
    staticNoise = new Tone.Noise("pink").connect(staticGain).start();

    const reverb = new Tone.Reverb({ decay: 2.2, preDelay: 0.02, wet: 0.2 }).connect(tuningFilter);
    const eq = new Tone.EQ3({ low: 1, mid: 0, high: -1.5 }).connect(reverb);
    const comp = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.005, release: 0.15 }).connect(eq);

    const bassUrls = {};
    for (const [file, note] of Object.entries(PIZZ_MAP)) bassUrls[note] = PIZZ_BASS_BASE + file + ".mp3";
    bassSampler = new Tone.Sampler({ urls: bassUrls, baseUrl: "", release: 0.25, onload: check }).connect(comp);

    const pianoUrls = {};
    for (const [file, note] of Object.entries(SALAMANDER_MAP)) pianoUrls[note] = SALAMANDER_BASE + file + ".mp3";
    pianoSampler = new Tone.Sampler({ urls: pianoUrls, baseUrl: "", release: 0.6, onload: check }).connect(comp);

    setTimeout(() => reject(new Error("sample load timeout")), 25000);
  });
}

function pushTerm(line) {
  termLines.push(line);
  if (termLines.length > 14) termLines.shift();
  termEl.innerHTML = termLines.join("\n");
}

function bumpVU() {
  vuBars.forEach((bar) => {
    const h = 15 + Math.random() * 85;
    bar.style.height = h + "%";
    bar.style.background = h > 70 ? "#ff7a4a" : h > 40 ? "var(--dial-glow)" : "#5a4a2a";
  });
}
function decayVU() {
  vuBars.forEach(bar => { bar.style.height = "8%"; bar.style.background = "#3a3428"; });
}

// Fill lookahead: how far ahead of playback Director generates+schedules content. Bigger =
// fewer generation ticks but more up-front CPU per tick; smaller = smoother but more frequent.
// 24s (about half a chorus at 96bpm) is comfortably ahead of the ~1s tick interval below.
const LOOKAHEAD_S = 24;
const FILL_TICK_MS = 1500;

// Both loops below run via Tone.Transport.scheduleRepeat, not setInterval. That is not a style
// choice -- plain page-level setInterval/setTimeout is throttled by the browser once it decides
// a page is backgrounded/occluded, and that is exactly how an OBS Browser Source renders (and,
// it turns out, how at least one automated/headless tab driving this page also read to Chrome).
// Confirmed live: the terminal and lookahead generation would silently stall for several
// seconds -- audio and the transport clock kept running the whole time, since Tone's own
// scheduling rides the AudioContext clock, which browsers deliberately exempt from this
// throttling so audio apps don't glitch in a background tab -- then dump everything that had
// backed up in one burst once the timer resumed. scheduleRepeat's callbacks are driven by that
// same AudioContext clock, so they are exempt for the same reason audio itself never stalled.
// Both loops also now only run while the Transport is actually playing, which is strictly
// correct: there is nothing to generate or reveal while paused.
function startEngine() {
  Tone.Transport.scheduleRepeat(() => {
    director.fillUntil(Tone.Transport.seconds + LOOKAHEAD_S);
  }, FILL_TICK_MS / 1000);
  director.fillUntil(LOOKAHEAD_S); // prime the first window before playback starts (~6ms, measured -- not the cause of any startup stall; see BUILD_NOTES)

  // Temporary diagnostic: a CPU profile proved the render loop itself is ticking correctly from
  // ~3s in, and the queue-fill call completes in ~10ms, yet pushTerm doesn't fire until ~13s in
  // -- a profiler shows what CODE ran, not what the QUEUES held, so it can't distinguish "spans
  // never generated yet" from "spans generated but spanCursor stuck past them". This exposes
  // that state directly. Call window.__oteljazzDebug() in the console during a freeze. Remove
  // once root-caused.
  const debugSnapshot = () => ({
    transportS: Tone.Transport.seconds,
    spanCursor, spanQueueLen: pendingSpanLines.length,
    nextSpan: pendingSpanLines[spanCursor],
    firstSpan: pendingSpanLines[0], lastSpan: pendingSpanLines[pendingSpanLines.length - 1],
    chordCursor, chordQueueLen: pendingChords.length,
    nextChord: pendingChords[chordCursor],
  });
  window.__oteljazzDebug = debugSnapshot;

  // Every manual capture so far has caught the RECOVERED state, not the stall itself -- by the
  // time a person notices, reacts, and types a command, it has usually already resolved (matches
  // the "catches up in a burst" pattern seen in every recording). This removes the human from the
  // loop: logs automatically the instant pushTerm goes quiet for >1.5s while playing, and again
  // the instant it recovers, bracketing the stall with full state on both ends with zero reaction
  // time required. lastPushWallMs/stalledSinceWallMs live at module scope, not here, so a
  // pause/resume cycle can reset the idle clock instead of carrying stale idle time across it.
  // Remove once root-caused.

  Tone.Transport.scheduleRepeat(() => {
    const t = Tone.Transport.seconds;
    let bumped = false;
    while (noteCursor < pendingNoteReveals.length && pendingNoteReveals[noteCursor].t <= t) {
      bumped = true; noteCursor++;
    }
    while (chordCursor < pendingChords.length && pendingChords[chordCursor].t <= t) {
      try {
        chordEl.textContent = pendingChords[chordCursor].symbol;
        if (chordDialEl) chordDialEl.textContent = pendingChords[chordCursor].symbol;
      } catch (err) {
        console.error("[oteljazz] dropped unrenderable chord entry:", pendingChords[chordCursor], err);
      }
      chordCursor++;
    }
    while (spanCursor < pendingSpanLines.length && pendingSpanLines[spanCursor].t <= t) {
      const it = pendingSpanLines[spanCursor];
      // spanCursor advances even if rendering throws. Found via two screen recordings where the
      // terminal froze permanently mid-take (chord/VU kept updating -- proof it was this loop
      // specifically, since those run in the same tick but don't share a cursor with this one):
      // an unadvanced cursor means the SAME entry gets retried every tick forever, so one bad
      // line was permanently wedging the whole terminal. The entry is dropped and logged instead
      // of silently retried, so a real bug now surfaces in the console rather than reading as a
      // frozen demo on launch day.
      try {
        pushTerm(`<span class="dim">[${it.t.toFixed(2)}s ${it.service}]</span> ${it.line}`);
        lastPushWallMs = performance.now();
      } catch (err) {
        console.error("[oteljazz] dropped unrenderable span line, terminal would otherwise be stuck here:", it, err);
      }
      spanCursor++;
    }
    if (bumped) bumpVU(); else decayVU();

    // Auto-bracket a stall: fires the instant one starts and the instant it ends, no reaction
    // time needed. See the comment above lastPushWallMs's declaration for why this exists.
    // Gated on `playing`: pausing is a legitimate reason for no new pushes and must not read as
    // a stall (this loop only ticks while Transport is running anyway, but the guard costs
    // nothing and keeps the intent explicit).
    const idleMs = performance.now() - lastPushWallMs;
    // 5000ms, not 1500ms: a local instrumented run showed natural gaps up to ~1.6s between
    // consecutive span timestamps in the synthetic timeline (bursty pacing is intentional --
    // see director.js/engine.js), so 1500ms fired on normal quiet stretches with a healthy,
    // growing queue every time. 5000ms is well clear of that noise floor while still catching
    // the actual 10-20s freezes users have reported.
    if (playing && idleMs > 5000) {
      if (stalledSinceWallMs === null) {
        stalledSinceWallMs = performance.now();
        // Stringified inline rather than passed as an object: a log reader that only captures
        // rendered text (not a live console you can expand) shows an object argument as a bare
        // "Object" placeholder with no way to recover its fields afterward.
        console.warn(`[oteljazz-stall] START, idle for ${Math.round(idleMs)}ms ${JSON.stringify(debugSnapshot())}`);
      }
    } else if (stalledSinceWallMs !== null) {
      console.warn(
        `[oteljazz-stall] RECOVERED after ${Math.round(performance.now() - stalledSinceWallMs)}ms ${JSON.stringify(debugSnapshot())}`
      );
      stalledSinceWallMs = null;
    }

    // bound memory for an indefinitely-open tab: once a queue's consumed prefix gets large,
    // drop it and rebase the cursor -- nothing before "now" is ever read again.
    if (noteCursor > 800) { pendingNoteReveals.splice(0, noteCursor); noteCursor = 0; }
    if (spanCursor > 300) { pendingSpanLines.splice(0, spanCursor); spanCursor = 0; }
    if (chordCursor > 100) { pendingChords.splice(0, chordCursor); chordCursor = 0; }
  }, 0.09);
}

powerBtn.onclick = async () => {
  // iOS silently mutes Web Audio when the physical ring/silent switch is set to silent: the page
  // reports "Playing...", Safari shows its audio indicator, and no sound comes out -- which looks
  // like a broken demo rather than a muted phone. Declaring the session as "playback" opts into
  // the media category, which ignores that switch (the same category a music app uses).
  // Safari 16.4+; guarded because no other engine implements audioSession.
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
  } catch { /* non-fatal: worst case is the pre-existing silent-switch behavior */ }

  await Tone.start();
  if (!playing) {
    if (!started) { startEngine(); started = true; }
    lastPushWallMs = performance.now(); // don't count pause time as an idle stall on resume
    Tone.Transport.start();
    playing = true;
    powerBtn.textContent = "⏸";
    statusEl.textContent = "Playing...";
  } else {
    Tone.Transport.pause();
    playing = false;
    powerBtn.textContent = "▶";
    statusEl.textContent = "Paused.";
    decayVU();
  }
};

setInterval(() => { if (!playing) decayVU(); }, 200);

// --- Knob interaction: vertical drag (mouse or touch), like turning a real knob by dragging up/
// down rather than trying to trace a circular path -- the standard software-knob convention.
// Rotation range -135deg..+135deg (270 total), matching how these knobs are actually drawn.
function setupKnob(el, initial, onChange) {
  let value = initial;
  const indicator = el.querySelector(".knob-indicator");
  function render() {
    const deg = -135 + value * 270;
    indicator.style.transform = `translateX(-50%) rotate(${deg}deg)`;
  }
  render();
  onChange(value); // apply the initial value to audio immediately

  let dragging = false, startY = 0, startValue = 0;
  function pointerDown(e) {
    dragging = true;
    startY = e.clientY;
    startValue = value;
    el.classList.add("dragging");
    try { el.setPointerCapture && el.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer to capture -- harmless, drag still tracks via the move/up listeners below */ }
    e.preventDefault();
  }
  function pointerMove(e) {
    if (!dragging) return;
    const deltaY = startY - e.clientY;   // up = increase
    value = Math.max(0, Math.min(1, startValue + deltaY / 140));
    render();
    onChange(value);
  }
  function pointerUp(e) {
    dragging = false;
    el.classList.remove("dragging");
  }
  el.addEventListener("pointerdown", pointerDown);
  el.addEventListener("pointermove", pointerMove);
  el.addEventListener("pointerup", pointerUp);
  el.addEventListener("pointercancel", pointerUp);
}

function setupKnobs() {
  // Volume: 0..1 -> -40dB (near-silent) .. 0dB (unity). Default 0.8 (-8dB) rather than full
  // unity, so the starting level has headroom instead of opening at the loudest possible setting.
  setupKnob(document.getElementById("volKnob"), 0.8, (v) => {
    Tone.Destination.volume.value = (v - 1) * 40;
  });

  // Tuning: 0..1, 0.5 = perfectly tuned (clean, matches the sound before this feature existed).
  // Moving either direction away from center simultaneously muffles (lowpass cutoff drops) and
  // introduces static (pink noise mixed in) -- both effects scale with distance from center, not
  // direction, since a real dial sounds equally "off" tuned too far either way.
  setupKnob(document.getElementById("tuneKnob"), 0.5, (v) => {
    const detune = Math.abs(v - 0.5) * 2; // 0 at center, 1 at either extreme
    tuningFilter.frequency.value = 20000 - detune * 19000; // 20000Hz..1000Hz
    staticGain.gain.value = detune * 0.12;
  });
}

// Temporary diagnostic: a foreground, focused tab froze for ~20s with no console error, which
// the earlier scheduleRepeat fix does not explain (that fix was confirmed holding under real
// backgrounding -- 70s clean, drift <2s, visibilityState genuinely "hidden" -- so a focused tab
// stalling is a different bug). Audio never glitched in any report; LOOKAHEAD_S schedules audio
// ~24s into Tone's own Web Audio graph, sample-accurate and independent of the JS main thread
// from that point on, so a true synchronous main-thread block would look exactly like this:
// audio keeps playing from what's already committed, every JS-driven visual update freezes,
// then bursts once the thread frees up.
// requestAnimationFrame is the cleanest available signal for "is the main thread actually
// blocked": rAF cannot fire while the thread is busy, so a real block shows up here as a rAF gap
// at the exact same time, whatever else is happening. If rAF stays healthy while rendering
// stalls, the block theory is wrong and the real cause is somewhere more specific -- that
// result would matter as much as confirming it. Remove once this is root-caused.
(function watchdog() {
  let last = performance.now();
  function tick() {
    const now = performance.now();
    const gap = now - last;
    if (gap > 500) {
      console.warn(
        `[oteljazz-watchdog] main thread gap: ${gap.toFixed(0)}ms` +
        (typeof Tone !== "undefined" && Tone.getContext
          ? ` | transportS=${Tone.Transport.seconds.toFixed(2)} audioCtxState=${Tone.getContext().state}`
          : ""),
        { atWallClock: new Date().toISOString(), visible: document.visibilityState, focused: document.hasFocus() }
      );
    }
    last = now;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
