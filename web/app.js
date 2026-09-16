// Entry point for the demo page. Extracted verbatim from an inline
// <script type="module"> block in demo.html so the site can ship a Content-Security-Policy
// with script-src 'self' and no 'unsafe-inline': an inline script would be blocked by that
// policy, and allowing inline scripts would defeat most of the point of having the CSP.
// Behavior is unchanged -- this is a move, not a rewrite.

import { Director, BAR_S } from "./director.js";
import { Rng } from "./engine.js";

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
// Anomaly-replay recorder, created once Tone's context exists (see loadInstruments). Connected
// to Tone.Destination directly rather than any individual instrument node -- that's the one
// place the full final mix (chords, bass, melody, and the tuning-dial effects chain) actually
// converges, so this captures exactly what a listener hears regardless of internal routing.
let anomalyRecorder = null;
let anomalyRecordingActive = false;
let lastAnomalyReplayUrl = null;
const ANOMALY_CAPTURE_MS = 8000; // covers a typical anomaly window (drift/conflict run several seconds) plus its resolution
let vuNeedleEl = document.getElementById("vuNeedle");
// prefers-reduced-motion, for the two moving things CSS can't reach (demo.html's reduced-motion
// block covers the rest): the boot ticker and the VU needle. Read `.matches` at use time rather
// than caching it, so changing the OS setting mid-session takes effect without a reload.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let audioMeter = null;
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
// Empty = normal fused chord (default). Any voice names present = only those sound -- a mixer-
// style multi-toggle (pick any combination), not a single mutually-exclusive solo. See the
// voice-picker click handler further down and onScheduleNote's play-time check above.
const soloedVoices = new Set();
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
  // Still re-rendered on every tick (bootStatusLines can change underneath it), just not scrolled.
  if (!reducedMotion.matches) bootTickerFrame++;
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
      // Checked here, at the moment a note actually plays, not when it was scheduled: a note can
      // be queued up to LOOKAHEAD_S (24s synthetic, less live) before it sounds, so checking at
      // schedule time would mean toggling solo takes up to 24s to audibly take effect. Checked at
      // play time instead, so it's responsive from the very next note regardless of how far
      // ahead the engine had already queued. No new mapping logic -- this is a pure UI filter on
      // an event the SAME single onScheduleNote implementation already produces, not a second one.
      //
      // Called unconditionally, BEFORE the solo filter below, not after: the whole point of the
      // activity flicker is showing which voices are really sounding even while others are
      // isolated, so a voice silenced by solo still needs to flash -- only actual audio gets
      // filtered, not the visual read of what the mix would be doing unfiltered.
      // Birth takes precedence over the ordinary flicker for a voice's very first note: firing
      // both would just overwrite the slower swell with the faster flash.
      if (!noteVoiceSeen(voice)) flashVoiceActivity(voice);
      if (soloedVoices.size > 0 && !soloedVoices.has(voice)) return;
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
// A shared seed only reproduces the synthetic path faithfully (see Director's own comment on
// why), so this is read once, here, outside startLiveMode entirely -- a `?seed=` on a `?live=`
// URL would silently do nothing, which is worse than not supporting it there, so it simply isn't
// wired into that path at all rather than accepting a param it can't honor.
const requestedSeedRaw = new URLSearchParams(location.search).get("seed");
const requestedSeed = requestedSeedRaw ? Number(requestedSeedRaw) : undefined;

fetch(CORPUS_URL).then(r => r.json()).then(corpus => {
  statusEl.textContent = "Loading instruments...";
  director = new Director(corpus.root_transition_matrix_major, { seed: requestedSeed });
  setupShareLink(director.seed);

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

    // Created here rather than at module scope: Tone.Recorder needs a running AudioContext,
    // which doesn't exist until Tone.start() has actually run (the first play click), and
    // loadInstruments() is already the point where every other audio node gets built.
    anomalyRecorder = new Tone.Recorder();
    Tone.Destination.connect(anomalyRecorder);

    // Master-output RMS, published to CSS as --audio-rms (0..1) once per animation frame. Drives
    // the glass's filament breathing and the speaker cone's motion -- both deliberately tiny, so
    // the cabinet is never perfectly static while it's playing without either effect being
    // consciously noticeable. Read on rAF rather than in the Transport loops: this is a display
    // concern at screen refresh rate, not a scheduling one, and it must keep running (decaying to
    // rest) while paused. Smoothed with an asymmetric follower -- fast attack so a chord lands
    // immediately, slow release so it settles like a real needle instead of strobing per note.

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

// Reveals the share row (hidden until a session exists) and wires it to copy a URL carrying this
// session's actual seed. Director.seed is the ONLY thing that needs to travel -- everything else
// about the session (key, mode, form, and every synthetic swarm event) is reconstructed from it
// deterministically on the other end (see Director's constructor comment), so the link itself is
// tiny regardless of how long or eventful the session gets.
function setupShareLink(seed) {
  // The cabinet's maker's badge IS the share control -- it replaced a separate "Copy link to this
  // exact session" button below the radio, which copied the identical URL. Base36 so the seed
  // reads like a plausible serial rather than a raw 32-bit integer.
  const plate = document.getElementById("modelPlate");
  const serial = document.getElementById("modelPlateSerial");
  if (!plate || !serial) return;
  const label = "OJ-" + Number(seed).toString(36).toUpperCase().padStart(7, "0");
  const url = `${location.origin}${location.pathname}?seed=${seed}`;
  serial.textContent = label;
  plate.setAttribute("aria-label", `Serial ${label}. Copy a link that replays this exact session`);
  plate.hidden = false;
  plate.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API needs a secure context and permission that isn't guaranteed everywhere
      // (older browsers, some embedded webviews) -- fall back to a selected textarea so the copy
      // still happens rather than the click doing nothing.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* nothing more to fall back to */ }
      document.body.removeChild(ta);
    }
    // Restores the fixed label, not whatever the text was at click time: an earlier version
    // captured the current text, so a second click inside the window saved "Copied" as the
    // thing to restore and the badge stayed stuck on it.
    serial.textContent = "Copied";
    clearTimeout(plate._restore);
    plate._restore = setTimeout(() => { serial.textContent = label; }, 1400);
  };
}

// Called from the span-reveal loop below the instant an anomaly line is actually shown to the
// listener (not when Director scheduled it, which can be up to LOOKAHEAD_S earlier) -- that's
// the moment worth capturing around. One recording at a time: if a second anomaly reveals while
// one is already being captured, it's skipped rather than restarting mid-recording, since
// ANOMALY_MIN_GAP_S (director.js) already keeps real overlaps rare and a torn/restarted
// recording would be worse than occasionally missing a replay of a second anomaly.
function startAnomalyRecording() {
  if (!anomalyRecorder || anomalyRecordingActive) return;
  anomalyRecordingActive = true;
  anomalyRecorder.start();
  setTimeout(async () => {
    let blob;
    try {
      blob = await anomalyRecorder.stop();
    } catch (err) {
      console.error("[oteljazz] anomaly recording failed:", err);
      anomalyRecordingActive = false;
      return;
    }
    anomalyRecordingActive = false;
    if (lastAnomalyReplayUrl) URL.revokeObjectURL(lastAnomalyReplayUrl); // don't leak the previous clip's memory
    lastAnomalyReplayUrl = URL.createObjectURL(blob);
    const row = document.getElementById("anomalyReplayRow");
    row.hidden = false;
  }, ANOMALY_CAPTURE_MS);
}

document.getElementById("anomalyReplayBtn").onclick = () => {
  if (!lastAnomalyReplayUrl) return;
  new Audio(lastAnomalyReplayUrl).play().catch((err) => {
    // Autoplay/decoding can fail depending on the browser's exact MediaRecorder output format
    // (Tone.Recorder's container varies by browser -- webm in Chrome/Firefox, mp4 in Safari);
    // logged rather than silently doing nothing, since there's no good in-page fallback UI for
    // "your browser recorded a format it then refused to play back."
    console.error("[oteljazz] anomaly replay failed to play:", err);
  });
};

// ---------------------------------------------------------------------------------------------
// Cabinet effects. All of these are driven by events the engine ALREADY emits (anomaly reveal,
// error status, chord change, first-sight of a voice, audio RMS) -- none of them introduce a new
// signal or touch the mapping. Retriggering a CSS animation requires removing the class, forcing
// a reflow, and re-adding it; see flashVoiceActivity's comment for why. These fire at most a few
// times a second, well inside the budget measured for flashVoiceActivity (0.79 ms/sec at 10/sec).
// ---------------------------------------------------------------------------------------------
const dialGlassEl = document.querySelector(".dial-glass");
const seenVoices = new Set();

function retrigger(el, cls, ms) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

// The anomaly is the whole point of the grammar and was previously audio-only. Fired at REVEAL
// time so the tear lands with what the listener hears.
function crtGlitch() {
  retrigger(termEl, "glitch", 460);
  retrigger(dialGlassEl, "glitch", 460);
}

// An ERROR span warms the entire glass, not just the (already red) characters -- at any distance
// where individual characters aren't legible, a failure previously looked exactly like a success.
function errorBleed() { retrigger(dialGlassEl, "err-bleed", 900); }


// A voice's first appearance in a session reads differently from it merely being busy again.
function noteVoiceSeen(voice) {
  if (seenVoices.has(voice)) return false;
  seenVoices.add(voice);
  const sw = document.querySelector(`.voice-switch[data-voice="${voice}"]`);
  if (sw) retrigger(sw.querySelector(".voice-led"), "birth", 950);
  return true;
}

// Master-output RMS -> --audio-rms (0..1), published at 30Hz, driving the VU needle, the glass's
// filament breathing, and the speaker cone's motion.
//
// Started on the first play click, AFTER Tone.start(), not at page load with the other audio
// nodes. Measured, not assumed: a Meter constructed and connected while the AudioContext is
// still suspended reads a flat -Infinity forever even once the context resumes, while one
// created after Tone.start() on the very same graph reads correctly (-29..-43 dB on the same
// material). The rest of loadInstruments() gets away with pre-start construction because
// samplers and the recorder only need the context by the time they're USED; an analyser has to
// have been live at connect time.
function startAudioMeter() {
  if (audioMeter) return;
  audioMeter = new Tone.Meter({ smoothing: 0.2 });
  Tone.Destination.connect(audioMeter);
  let rms = 0;
  let tick = 0;
  // Transport.scheduleRepeat, NOT requestAnimationFrame -- and this is the same rule, for the
  // same reason, as the two loops further down. rAF does not fire at all in a hidden or occluded
  // page, and setInterval gets throttled there; an OBS Browser Source (how this demo is actually
  // captured) renders exactly that way. A first cut of this used rAF and silently published a
  // frozen 0.000 the entire time the pane wasn't visible -- caught because the meter itself read
  // a healthy -35 dB at the same instant the CSS variable said zero. scheduleRepeat rides the
  // AudioContext clock, which browsers deliberately exempt so audio doesn't glitch in the
  // background, so it keeps running when the page is not being looked at.
  //
  // 1/30s rather than every frame: this drives a needle and two sub-percent visual effects, and
  // 30Hz is well past the point where either reads as smooth. The follower is asymmetric -- fast
  // attack so a chord lands immediately, slow release so the needle settles like real meter
  // ballistics instead of strobing on every note.
  Tone.Transport.scheduleRepeat(() => {
    const db = audioMeter.getValue();
    const lin = Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 48) / 48)) : 0;
    rms += (lin - rms) * (lin > rms ? 0.5 : 0.12);
    // --audio-rms is always published: the pump itself must never stop (that is the v1.4.0
    // frozen-meter failure above), reduced motion only changes how the needle shows it.
    document.documentElement.style.setProperty("--audio-rms", rms.toFixed(3));
    if (!reducedMotion.matches) vuNeedleTo(rms);
    // Reduced motion: a meter that never moves would lie, so it still reads the level, but in
    // five fixed positions at ~4Hz instead of a continuously swinging needle.
    else if (tick % 8 === 0) vuNeedleTo(Math.round(rms * 4) / 4);
    tick++;
  }, 1 / 30);
}

// Points the needle. Takes an already-smoothed 0..1 level (the follower lives in the meter pump
// above, so attack/release stay asymmetric like real meter ballistics). -42..+42 degrees matches
// the arc drawn in demo.html; the needle turns red past the hot arc's start.

// Transport loops don't tick while paused, so the needle would otherwise freeze wherever it was
// when playback stopped. Called from the pause branch to walk it back to rest instead.
function restAudioMeter() {
  document.documentElement.style.setProperty("--audio-rms", "0.000");
  vuNeedleTo(0);
}

function vuNeedleTo(level) {
  if (!vuNeedleEl) return;
  const deg = -42 + Math.max(0, Math.min(1, level)) * 84;
  vuNeedleEl.style.transform = `rotate(${deg.toFixed(2)}deg)`;
  vuNeedleEl.style.stroke = level > 0.82 ? "#ff7a4a" : "var(--dial-glow)";
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
    stationDrift: stationDriftLog,
  });
  window.__oteljazzDebug = debugSnapshot;
  startStationDrift(director.seed);

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
        // service === "oversight-grammar" is _logAnomaly's own marker (director.js) -- matched
        // here, at reveal time, not when Director scheduled the underlying event, which is what
        // actually lines the recording up with the moment a listener hears it.
        if (it.service === "oversight-grammar") { startAnomalyRecording(); crtGlitch(); }
        // The relay marks status on live spans; the synthetic path puts class="err" in the line.
        // Checking the rendered line covers both without either path needing a new field.
        else if (it.status === "error" || it.line.includes('class="err"')) errorBleed();
      } catch (err) {
        console.error("[oteljazz] dropped unrenderable span line, terminal would otherwise be stuck here:", it, err);
      }
      spanCursor++;
    }
    // VU is driven continuously by real output RMS now (see the meter pump), not by
    // this loop -- `bumped` stays as the note-reveal cursor advance it always was.

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
  startAudioMeter();   // needs a running context -- see its own comment

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
      // Valve heater coming up to temperature: the glass starts cold and dim and settles to
      // its normal amber across the warm-up, rather than snapping to full brightness.
      if (dialGlassEl) retrigger(dialGlassEl, "warming", BOOT_WARMUP_MS + 100);
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
    powerBtn.setAttribute("aria-label", "Pause");
    statusEl.textContent = "Playing...";
  } else {
    Tone.Transport.pause();
    playing = false;
    restAudioMeter();
    powerBtn.textContent = "▶";
    powerBtn.setAttribute("aria-label", "Play");
    statusEl.textContent = "Paused.";
  }
};


// Keyboard shortcuts: space toggles play/pause (the physical radio has one button, this is its
// keyboard equivalent, not a separate feature), left/right sweep the tuning dial the way turning
// it by hand does, up/down do the same for volume. Nudges go through the same setupKnob() handle
// a pointer drag uses, so a keyboard nudge and a mouse drag are indistinguishable to every
// downstream consumer (rampTo sweeps, current-draw dimming, jitter threshold, all of it).
// Global, not scoped to an element: the page has no text inputs to steal these keys from.
const KEY_NUDGE = 0.05;
window.addEventListener("keydown", (e) => {
  // The console owns the keyboard while open, so typing "b" doesn't fire a shortcut mid-word.
  // (The comment above about "no text inputs to steal these keys from" predates the console.)
  if (consoleActive) {
    if (e.key === "Escape") { consoleExit(); return; }
    if (e.key === "Enter") {
      const cmd = consoleBuf;
      consoleBuf = "";
      termLines.pop();
      pushTerm('<span class="dim">&gt;</span> ' + escapeHtml(cmd));
      consoleRun(cmd);
      if (consoleActive) consolePrompt();
      e.preventDefault();
      return;
    }
    if (e.key === "Backspace") { consoleBuf = consoleBuf.slice(0, -1); consoleRedraw(); e.preventDefault(); return; }
    if (e.key.length === 1 && consoleBuf.length < 48) { consoleBuf += e.key; consoleRedraw(); e.preventDefault(); return; }
    return;
  }
  konamiPos = e.code === KONAMI[konamiPos] ? konamiPos + 1 : (e.code === KONAMI[0] ? 1 : 0);
  if (konamiPos === KONAMI.length) { konamiPos = 0; toggleServiceMode(); e.preventDefault(); return; }
  if (e.key === "`") { consoleEnter(); e.preventDefault(); return; }
  if (e.code === "Space") {
    e.preventDefault(); // stop the page from scrolling on space
    powerBtn.click();
  } else if (e.code === "ArrowLeft" && tuneKnobHandle) {
    e.preventDefault();
    tuneKnobHandle.nudge(-KEY_NUDGE);
  } else if (e.code === "ArrowRight" && tuneKnobHandle) {
    e.preventDefault();
    tuneKnobHandle.nudge(KEY_NUDGE);
  } else if (e.code === "ArrowUp" && volKnobHandle) {
    e.preventDefault();
    volKnobHandle.nudge(KEY_NUDGE);
  } else if (e.code === "ArrowDown" && volKnobHandle) {
    e.preventDefault();
    volKnobHandle.nudge(-KEY_NUDGE);
  }
});

// Voice narrowing: click a switch to add or remove that voice from the isolated set (see
// onScheduleNote's play-time check for the actual audio filtering). Any combination, not a
// single exclusive pick -- toggling every switch off returns to the normal fused chord. Delegated
// to the picker container rather than bound per-switch, so it works the same regardless of how
// many switches exist.
document.getElementById("voicePicker").addEventListener("click", (e) => {
  const sw = e.target.closest(".voice-switch");
  if (!sw) return;
  const voice = sw.dataset.voice;
  if (soloedVoices.has(voice)) soloedVoices.delete(voice);
  else soloedVoices.add(voice);
  sw.classList.toggle("on", soloedVoices.has(voice));
  sw.setAttribute("aria-pressed", String(soloedVoices.has(voice)));
});

// Cleaner operation: one click back to the default fused chord instead of having to remember
// and re-click every switch you turned on. The button itself only appears once something is
// soloed (CSS :has(), demo.html), so there's nothing to wire for "is there anything to clear."
document.getElementById("voiceClear").addEventListener("click", () => {
  soloedVoices.clear();
  for (const sw of document.querySelectorAll(".voice-switch")) {
    sw.classList.remove("on");
    sw.setAttribute("aria-pressed", "false");
  }
});

// Called from onScheduleNote for every voice on every note actually played, on or off, so the
// panel doubles as a real per-voice activity meter rather than a static solo toggle -- watch
// which voices are really sounding right now even with nothing isolated. Removing then re-adding
// the class (with a forced reflow between) is required to RESTART a CSS animation that's already
// playing or just finished; simply adding a class already present does nothing if the animation
// already ran to completion, which is exactly the common case here (the same voice sounds again
// a beat or two later, animation long since finished, needs to fire fresh each time).
function flashVoiceActivity(voice) {
  const sw = document.querySelector(`.voice-switch[data-voice="${voice}"]`);
  if (!sw) return; // "melody"/"bass"/every chord voice all have switches; anything else just no-ops
  const led = sw.querySelector(".voice-led");
  led.classList.remove("flicker");
  void led.offsetWidth; // force reflow -- see comment above
  led.classList.add("flicker");
}

// =============================================================================================
// Console: the dial glass is a convincing fake terminal, so let people actually touch it. Click
// the glass to take focus, type, Enter to run, Escape to leave. Deliberately a handful of
// in-fiction commands rather than a real shell -- nothing here reaches anything outside the page.
//
// SECURITY: whatever gets typed is echoed back through pushTerm(), which renders with innerHTML
// (the terminal needs its <span class="dim/ok/err"> markup). User input therefore MUST be escaped
// on the way in -- the same rule, and the same reason, as src/live-relay.js escaping OTLP
// attributes server-side before they reach this identical sink.
// =============================================================================================
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

let consoleActive = false;
let consoleBuf = "";

function consolePrompt() {
  pushTerm('<span class="dim">&gt;</span> ' + escapeHtml(consoleBuf) + '<span class="term-caret">_</span>');
}
// The prompt line is re-rendered in place as you type rather than appended, so a long command
// doesn't scroll the whole span feed away one keystroke at a time.
function consoleRedraw() { termLines.pop(); consolePrompt(); }

function consoleRun(raw) {
  const cmd = raw.trim();
  const [verb, ...rest] = cmd.split(/\s+/);
  switch (verb.toLowerCase()) {
    case "": break;
    case "help":
      pushTerm('<span class="dim">available: help, whoami, ls, seed, chord, voices, about, clear, exit</span>');
      break;
    case "whoami":
      pushTerm('<span class="ok">overseer</span> <span class="dim">-- you are listening, not driving. the swarm does not know you are here.</span>');
      break;
    case "ls":
      pushTerm('<span class="dim">orchestrator/  subagents/  corpus_model_jazz.json  robots.txt  ai.txt</span>');
      break;
    case "seed":
      pushTerm('<span class="dim">session seed:</span> <span class="ok">' + escapeHtml(String(director && director.seed)) + '</span>');
      break;
    case "chord":
      pushTerm('<span class="dim">sounding:</span> <span class="ok">' + escapeHtml(chordEl.textContent || "--") + '</span>');
      break;
    case "voices":
      pushTerm('<span class="dim">' + escapeHtml(soloedVoices.size ? [...soloedVoices].join(" ") : "all nine, fused") + '</span>');
      break;
    case "about":
      pushTerm('<span class="dim">OtelJazz -- OpenTelemetry spans from a multi-agent system, played by a jazz combo.</span>');
      pushTerm('<span class="dim">harmony mined from 406 transcribed solos. telemetry drives dynamics only.</span>');
      break;
    case "clear": termLines = []; break;
    case "exit": consoleExit(); return;
    default:
      pushTerm('<span class="err">?</span> <span class="dim">' + escapeHtml(verb) + ': not a command. try help</span>');
  }
}

function consoleEnter() {
  if (consoleActive) return;
  consoleActive = true;
  termEl.classList.add("console-live");
  consoleBuf = "";
  pushTerm('<span class="dim">&gt; console. type help, or esc to leave.</span>');
  consolePrompt();
}
function consoleExit() {
  if (!consoleActive) return;
  consoleActive = false;
  consoleBuf = "";
  termEl.classList.remove("console-live");
  termLines.pop();
  pushTerm('<span class="dim">&gt; console closed.</span>');
}

const dialGlassTarget = document.querySelector(".dial-glass");
dialGlassTarget.addEventListener("click", () => {
  if (!consoleActive) consoleEnter();
});
// Keyboard route in. Click was the only way to open the console, which left keyboard-only
// visitors with no path to it at all. Enter (not Space) on the focused glass, because Space is
// already bound globally to play/pause and would fire both. Backtick works from anywhere, the
// way it does in most consoles.
dialGlassTarget.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !consoleActive) { consoleEnter(); e.preventDefault(); }
});

// =============================================================================================
// Konami -> service mode. Exposes the engine internals window.__oteljazzDebug() already returns,
// which until now were console-only: transport time, queue depths, cursors. An engineer's panel
// on an engineer's radio. The arrow keys in the sequence also nudge the knobs (they share the
// handler below), but up-up-down-down and left-right-left-right each net to zero, so the dial
// lands exactly where it started -- no cleanup needed.
// =============================================================================================
const KONAMI = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","KeyB","KeyA"];
let konamiPos = 0;
let serviceTimer = null;

function toggleServiceMode() {
  const el = document.getElementById("servicePanel");
  if (!el) return;
  const turningOn = el.hidden;
  el.hidden = !turningOn;
  clearInterval(serviceTimer);
  if (turningOn) {
    const tick = () => {
      const d = window.__oteljazzDebug ? window.__oteljazzDebug() : null;
      el.textContent = d
        ? `transport ${d.transportS.toFixed(2)}s | spans ${d.spanCursor}/${d.spanQueueLen} | chords ${d.chordCursor}/${d.chordQueueLen} | seed ${director ? director.seed : "-"}`
        : "engine not started -- press play";
    };
    tick();
    serviceTimer = setInterval(tick, 500);
  }
}

// =============================================================================================
// Station drift: rarely, the dial wanders off station on its own and the signal degrades before
// settling back. A real superhet does this; a web page never does, which is exactly why it is
// worth doing. Goes through the tuning knob's own programmatic handle, so the audible result is
// identical to a listener having nudged it themselves -- no second audio path.
//
// Seeded and on the Transport clock, because it moves the AUDIO path (tuningFilter, staticGain),
// not just the picture: with Math.random() and page timers, two sessions from the same `?seed=`
// link could sound different. Two rules keep it reproducible:
//   - Its own Rng, derived from the session seed, NEVER director.rng. Director's stream must
//     depend only on the seed; if drift drew from it, the music would depend on how many drift
//     checks had run by the time a bar was generated, and seeded replay would break.
//   - Every check draws all three values whether or not it fires, so the stream's position
//     depends only on how many checks have happened.
// Transport, not setInterval: the check and all 28 steps are placed at transport times, so they
// land at the same musical moment in every run and keep running in a hidden page (the same
// reason as the fill and reveal loops). Pausing pauses a drift in progress with the music.
// Assumes nobody touches the tuning knob mid-run; a listener's own nudges are not seeded.
// =============================================================================================
const DRIFT_CHANCE = 0.06;
const DRIFT_CHECK_S = 45;
const DRIFT_STEPS = 14;
const DRIFT_STEP_S = 0.09;
const DRIFT_HOLD_S = 1.6;
const DRIFT_RNG_SALT = 0x5d7a1f3b;
const stationDriftLog = []; // {t, dir, depth} per drift, for __oteljazzDebug() comparisons
function startStationDrift(seed) {
  const rng = new Rng(((seed ^ DRIFT_RNG_SALT) >>> 0) || 1);
  Tone.Transport.scheduleRepeat((time) => {
    const fire = rng.bool(DRIFT_CHANCE);
    const dir = rng.bool(0.5) ? -1 : 1;
    const depth = rng.uniform(0.10, 0.20);
    if (!fire || !tuneKnobHandle) return;
    const t0 = Tone.Transport.getSecondsAtTime(time);
    stationDriftLog.push({ t: +t0.toFixed(3), dir, depth: +depth.toFixed(6) });
    if (stationDriftLog.length > 20) stationDriftLog.shift();
    pushTerm('<span class="dim">&gt; signal drifting...</span>');
    const step = (dir * depth) / DRIFT_STEPS;
    const backStart = t0 + DRIFT_STEPS * DRIFT_STEP_S + DRIFT_HOLD_S;
    for (let i = 1; i <= DRIFT_STEPS; i++) {
      Tone.Transport.scheduleOnce(() => tuneKnobHandle.nudge(step), t0 + i * DRIFT_STEP_S);
      Tone.Transport.scheduleOnce(() => {
        tuneKnobHandle.nudge(-step);
        if (i === DRIFT_STEPS) pushTerm('<span class="dim">&gt; ...station recovered.</span>');
      }, backStart + i * DRIFT_STEP_S);
    }
  }, DRIFT_CHECK_S, DRIFT_CHECK_S);
}

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

  // Programmatic handle for keyboard control -- `value` above is otherwise a closure variable
  // with no way in except a real pointer drag. Reuses render()/onChange() so a keyboard nudge is
  // indistinguishable downstream from a mouse drag ending at the same value.
  return {
    nudge(delta) {
      value = Math.max(0, Math.min(1, value + delta));
      render();
      onChange(value);
    },
  };
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

// Populated by setupKnobs() below; module-scoped so the keyboard handler (wired once, at load
// time, before any knob exists) can reach whichever knob is live once it does.
let volKnobHandle = null, tuneKnobHandle = null;

function setupKnobs() {
  // Volume: 0..1 -> -40dB (near-silent) .. 0dB (unity). Default 0.8 (-8dB) rather than full
  // unity, so the starting level has headroom instead of opening at the loudest possible setting.
  volKnobHandle = setupKnob(document.getElementById("volKnob"), 0.8, (v) => {
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
  tuneKnobHandle = setupKnob(document.getElementById("tuneKnob"), 0.5, (v) => {
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
