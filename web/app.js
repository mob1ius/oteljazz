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

// Corpus/sample loading (12 bass + 20 piano individual mp3s, plus the corpus JSON) runs silently
// in the background -- the terminal stays blank until the visitor actually presses play. Putting
// a loading animation in the terminal before that point put motion behind glass the visitor
// hasn't asked to look at yet, and on a fast connection it flashed by fast enough to read as a
// glitch instead of an animation. The animation moved to powerBtn.onclick's first-press warm-up
// instead (see BOOT_NOTES / startBootTicker below), where it always plays for a fixed, deliberate
// duration -- a real "power on" beat instead of an incidental loading side-effect.
const BOOT_NOTES = "♪♫♬♩";
let bootStatusLines = ['<span class="dim">&gt; connecting to swarm uplink...</span>'];
let bootTickerTimer = null;
let bootTickerFrame = 0;
function renderBoot() {
  const width = 22;
  const scroll = (BOOT_NOTES.repeat(6) + "  ").slice(bootTickerFrame % (BOOT_NOTES.length * 4));
  const ticker = scroll.slice(0, width);
  termEl.innerHTML = bootStatusLines.join("\n") + `\n<span class="dim">&gt; </span>${ticker}`;
  bootTickerFrame++;
}
function startBootTicker() {
  if (bootTickerTimer) return;
  bootTickerTimer = setInterval(renderBoot, 110);
  renderBoot();
}
function stopBootTicker() {
  clearInterval(bootTickerTimer);
  bootTickerTimer = null;
}
// 2100ms: 3x the original 700ms floor, tuned up once 700ms itself proved too brief to read
// clearly as a tube warming up rather than a flash.
const BOOT_WARMUP_MS = 2100;

// Shared by both boot paths (synthetic below, live in startLiveMode) so there is exactly one
// place wiring Director's output callbacks to Tone.js scheduling and the reveal queues -- a
// second copy here would be exactly the kind of drift CLAUDE.md's per-span-mapping rule warns
// about, even though that rule is written about the Python engine's batch/live split, not this.
function wireDirectorCallbacks(d) {
  d.onScheduleNote = (voice, note, vel, dur, atS, detuneSemitones) => {
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
  d.onSpanLine = (item) => { pendingSpanLines.push(item); };
  d.onChordChange = (item) => { pendingChords.push({ t: item.t, symbol: item.symbol }); };
}

// Live-OTLP mode (v1.3.0, docs/ROADMAP.md): ?live=<session> connects to the Durable Object relay
// in src/live-relay.js instead of running the synthetic demo. Real spans now drive real audio --
// director.js's Director.feedSpan() converts each incoming span into the exact shape
// SwarmEngine._add already produces, so _generateBar's chorale voicing/comp/anomaly logic runs
// unchanged on real data (see feedSpan's own comment). currentLookaheadS is set small (not the
// synthetic path's 24s) since live spans arrive in real time and there is nothing to pre-generate
// far ahead of; startEngine() itself is unchanged, just parametrized on that variable.
async function startLiveMode(session) {
  termEl.innerHTML = '<span class="dim">&gt; connecting to live session...</span>';
  statusEl.textContent = "Loading instruments...";

  try {
    const corpus = await fetch(CORPUS_URL).then(r => r.json());
    director = new Director(corpus.root_transition_matrix_major, { live: true });
    wireDirectorCallbacks(director);
    await loadInstruments();
    currentLookaheadS = LIVE_LOOKAHEAD_S;
    statusEl.textContent = "Ready. (live)";
    powerBtn.disabled = false;
    setupKnobs();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    console.error(err);
    return;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/live/${encodeURIComponent(session)}/ws`);

  ws.onopen = () => {
    termLines = [];
    pushTerm(`<span class="dim">&gt; live session "${session}" connected. waiting for spans...</span>`);
  };
  ws.onmessage = (ev) => {
    let msg;
    // The relay (src/live-relay.js) is the only sender, so a parse failure here means either a
    // bug on that side or genuine network corruption -- rare, but silent failure here reads
    // exactly like the terminal-freeze bug this whole session's stall-detector was built to
    // catch: new spans just stop appearing with zero clue why. Logged rather than swallowed.
    try { msg = JSON.parse(ev.data); } catch (err) {
      console.error("[oteljazz] live message failed to parse, dropped:", ev.data, err);
      return;
    }
    if (msg.type !== "spans") return;
    for (const span of msg.spans) {
      // span.line is already fully-formed, HTML-escaped HTML (including its own [service]
      // prefix) built server-side in src/live-relay.js's spanToLine -- do not interpolate any
      // raw span field into a template literal here. An earlier version did exactly that with
      // span.service, which is attacker-controlled (this relay has no auth) and was a stored
      // HTML-injection bug into this same innerHTML sink, found in a security pass.
      pushTerm(span.line);
      // + currentLookaheadS, not the bare transport time: _generateBar only ever processes each
      // bar once, advancing generatedUntilS monotonically, so a span stamped at exactly "now"
      // would target a bar already generated moments ago and never get re-checked. The frontier
      // bar the fill loop is about to generate next sits currentLookaheadS ahead of now -- that's
      // the only bar a freshly-arrived span can still land in.
      director.feedSpan(span, Tone.Transport.seconds + currentLookaheadS);
    }
  };
  ws.onerror = () => pushTerm('<span class="err">&gt; connection error</span>');
  ws.onclose = () => pushTerm('<span class="dim">&gt; disconnected</span>');
}

const liveSession = new URLSearchParams(location.search).get("live");
if (liveSession) {
  startLiveMode(liveSession);
} else {
fetch(CORPUS_URL).then(r => r.json()).then(corpus => {
  statusEl.textContent = "Loading instruments...";
  director = new Director(corpus.root_transition_matrix_major);

  wireDirectorCallbacks(director);

  return loadInstruments();
}).then(() => {
  statusEl.textContent = "Ready.";
  powerBtn.disabled = false;
  setupKnobs(); // audio nodes (tuningFilter/staticGain) now exist -- safe to apply initial values
}).catch(err => {
  statusEl.textContent = "Error: " + err.message;
  console.error(err);
});
}

// Tuning knob's effect chain: a lowpass filter (muffles as you tune away from center) plus a
// pink-noise bed mixed in proportional to how far off-center the knob is (radio static). Both
// sit AFTER the reverb/eq/comp chain, right before the destination, so "detuning" affects the
// whole mix at once like a real radio's tuning dial rather than any one instrument.
let tuningFilter, staticNoise, staticGain, staticColor, staticCrackle;

function loadInstruments() {
  return new Promise((resolve, reject) => {
    let loaded = 0;
    const need = 2;
    function check() { loaded++; if (loaded === need) resolve(); }

    tuningFilter = new Tone.Filter({ frequency: 20000, type: "lowpass", rolloff: -12 }).toDestination();
    // staticColor gives the two tuning directions distinct timbre instead of identical noise at
    // different volumes -- a real superhet dial doesn't sound the same tuning down past a station
    // as tuning up past it. Type/frequency are set per-direction in setupKnobs(); starts lowpass
    // (the below-center/rumble side) and gets swapped to highpass when the knob crosses center.
    staticColor = new Tone.Filter({ frequency: 20000, type: "lowpass", rolloff: -24 });
    // staticCrackle chops the static into a chattery squelch rather than a smooth hiss -- rate
    // scales with detune in setupKnobs() so it's calm near center and chattery at the extremes.
    staticCrackle = new Tone.Tremolo({ frequency: 6, depth: 0.7, spread: 0 }).connect(tuningFilter).start();
    staticGain = new Tone.Gain(0).connect(staticColor);
    staticColor.connect(staticCrackle);
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
// Live mode has nothing to pre-generate 24s ahead of -- a real span hasn't happened yet. Small
// and positive only so Tone.Transport.schedule always gets a moment of buffer, not scheduling
// into the past. currentLookaheadS is what startEngine() actually reads; the synthetic boot path
// leaves it at its default (LOOKAHEAD_S), startLiveMode sets it before enabling play.
const LIVE_LOOKAHEAD_S = 1.5;
let currentLookaheadS = LOOKAHEAD_S;
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
    director.fillUntil(Tone.Transport.seconds + currentLookaheadS);
  }, FILL_TICK_MS / 1000);
  director.fillUntil(currentLookaheadS); // prime the first window before playback starts (~6ms measured for the synthetic 24s case -- not the cause of any startup stall; see BUILD_NOTES)

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
    if (!started) {
      // First press only: the terminal has been blank since page load (see the fetch chain
      // above), so this is the visitor's first look at it. Play a fixed-length "power on" warm-up
      // -- the scrolling note ticker plus the tube-glow CSS class -- before any real span content
      // appears, then hand off to startEngine()'s normal reveal loop. The button stays disabled
      // for the warm-up's duration so a second click can't start the engine mid-animation.
      powerBtn.disabled = true;
      statusEl.textContent = "Powering on...";
      termEl.classList.add("booting");
      startBootTicker();
      await new Promise((resolve) => setTimeout(resolve, BOOT_WARMUP_MS));
      stopBootTicker();
      termEl.classList.remove("booting");
      powerBtn.disabled = false;
      startEngine();
      started = true;
    }
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

// Shared by both knobs' onChange callbacks below -- volLevel and tuneDetune are set
// independently but the "current draw" and jitter effects read from BOTH at once, since a real
// shared power supply doesn't care which control is pulling on it. Module-scoped rather than
// local to setupKnobs() so either callback can update the combined state without threading it
// through both closures.
let volLevel = 0.8, tuneDetune = 0;
function updatePowerLoad() {
  // Weighted average, not a simple max/sum: volume dominates (a real amp's rail sags mostly
  // with output level) while tuning-offset still visibly contributes, matching how the tuning
  // knob's own audio effects (staticGain etc.) are themselves detune-scaled elsewhere.
  const draw = Math.min(1, volLevel * 0.7 + tuneDetune * 0.5);
  chordEl.style.setProperty("--current-draw", draw.toFixed(3));
  if (chordDialEl) chordDialEl.style.setProperty("--current-draw", draw.toFixed(3));
  // Threshold, not continuous: jitter reads as something breaking loose at the extremes, not a
  // smooth effect, so it's a binary class flip rather than scaling with draw.
  termEl.classList.toggle("jitter", volLevel > 0.93 || tuneDetune > 0.85);
}

function setupKnobs() {
  // Volume: 0..1 -> -40dB (near-silent) .. 0dB (unity). Default 0.8 (-8dB) rather than full
  // unity, so the starting level has headroom instead of opening at the loudest possible setting.
  setupKnob(document.getElementById("volKnob"), 0.8, (v) => {
    Tone.Destination.volume.value = (v - 1) * 40;
    volLevel = v;
    updatePowerLoad();
  });

  // Tuning: 0..1, 0.5 = perfectly tuned (clean, matches the sound before this feature existed).
  // Moving either direction away from center muffles the whole mix (lowpass cutoff drops) and
  // brings in static, scaling with distance from center like before -- but now with two things a
  // flat linear .value= snap can't give: an audible SWEEP as the knob moves (rampTo, so tuning
  // glides through the muffle/static like a real dial's IF whine instead of jump-cutting to the
  // new setting), and a squelch CHARACTER that depends on which side of center you're on, not just
  // how far -- tuning below center colors the static into a dull lowpassed rumble, tuning above
  // colors it into a bright highpassed hiss/whine, so the two directions are distinguishable by
  // ear alone. RAMP_S is short enough to feel responsive to a drag, long enough to actually sweep.
  const RAMP_S = 0.12;
  setupKnob(document.getElementById("tuneKnob"), 0.5, (v) => {
    const detune = Math.abs(v - 0.5) * 2; // 0 at center, 1 at either extreme
    const below = v < 0.5;
    tuningFilter.frequency.rampTo(20000 - detune * 19000, RAMP_S); // 20000Hz..1000Hz
    staticGain.gain.rampTo(detune * 0.14, RAMP_S);
    staticColor.type = below ? "lowpass" : "highpass";
    staticColor.frequency.rampTo(
      below ? 2200 - detune * 1800 : 400 + detune * 5000, // below: 2200Hz..400Hz rumble; above: 400Hz..5400Hz whine
      RAMP_S
    );
    // Calm near center, chattery squelch bursts at the extremes -- 3Hz..14Hz, deeper too (more
    // fully gated) the further off station, so it reads as broken reception rather than a tremolo effect.
    staticCrackle.frequency.rampTo(3 + detune * 11, RAMP_S);
    staticCrackle.depth.rampTo(0.3 + detune * 0.6, RAMP_S);
    tuneDetune = detune;
    updatePowerLoad();
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
