# OtelJazz -- roadmap to a real streaming product

This document exists to carry intent across context windows. `BUILD_NOTES.md` records what was
built and why; this records **where it's going and what has to exist to get there**. Written at
the point where the engine sounds right and the mock swarm demonstrates the claim, and the next
question became "what does it take to point a real OTel stream at this."

---

## 1. Where things actually stand

Working today, locally:

- `caidence.py` renders a trace (hand-authored, mock-swarm, or JSON) to MIDI over the macOS IAC
  bus, and Logic Pro X plays it on 9 tracks (8 piano + 1 upright bass).
- `swarm.py` simulates a realistic pipeline and **derives the musical form from its own
  telemetry** -- movements from stop_reason weight and spawn bursts, tempo from span density,
  ensemble width from live agent count.
- `live.py` already accepts **real OTLP/HTTP protobuf** on :4318 and plays it in real time. This
  is not a mock: point any OTel SDK at it and it works.

The honest gap between that and a product is not the mapping. The mapping is done. The gap is
**everything between "a span arrived" and "a human hears it, anywhere, without Logic Pro."**

---

## 2. How the telemetry becomes music, in plain language

This is the section to reuse for site copy, the paper's overview, and explaining the tool to
anyone. Every row is something the engine actually does today.

### Read straight off each span

| What arrives in the JSON | What you hear |
|---|---|
| `gen_ai.agent.name` | **Which instrument plays.** Each agent owns one of five voices in the piano chord. More than five agents and they share slots (see the limitation below). |
| `gen_ai.operation.name` = `chat` | That agent's voice **re-strikes its note** in the current chord. |
| `gen_ai.operation.name` = `execute_tool` | A **separate "tools" voice** plays a short, clipped note -- tool calls sound like punctuation, not melody. |
| `gen_ai.operation.name` = `create_agent` | A **spawn**. Several close together force a new movement to begin (see below). |
| `gen_ai.usage.output_tokens` | **How hard the note is struck.** A 500-token response hits noticeably harder than a 50-token one. |
| Span duration (latency) | **How long the note is held.** Slow calls sustain; fast ones are short. Tool calls are always clipped. |
| Span start time | **When the note lands**, snapped to a sixteenth-note grid and then swung. |
| `status` = error | A **sour grace note**, deliberately outside the chord, on that agent's own voice. Errors are the only thing allowed to sound wrong. |
| `stop_reason` = `end_turn` / `max_tokens` / `stop_sequence` | That agent is **finished**, and its note leaves the chord -- the ensemble audibly thins. |
| `stop_reason` = `tool_use` | Almost nothing. The agent paused to call a tool; it's still working. |

### Computed from the stream as a whole

| Signal | What you hear |
|---|---|
| **How many agents are active right now** | **How many notes are in the chord.** One agent is close to a lone piano; a full fan-out is the full ensemble. This is the headline mapping. |
| Same signal | Whether the bass plays a relaxed **two-feel** (beats 1 and 3) or a driving **four-feel** (walking all four beats). |
| Same signal | How **dense the solo line** is -- long flurries when busy, a few sparse notes when quiet -- and how often the chord sits in an inversion. |
| **Span rate over a stretch** | The **tempo** of that movement, roughly 68-132 BPM, and how hard it swings. |
| **Accumulated `stop_reason` weight** | **When one movement ends and the next begins.** A routine `tool_use` barely counts; a `max_tokens` or a failed tool nearly closes a movement on its own. It's a sliding scale, not "every N events." |
| **A burst of spawns** | Forces a **new movement**, because the swarm just changed shape. |

### What is NOT telemetry-driven, on purpose

The chord progression, the voicings, and the melodic motif come from music theory and a corpus of
406 jazz recordings -- never from the data. This split is deliberate and load-bearing: if the
data could change the harmony, "louder" and "busier" would stop being readable, because
everything would be moving at once. The tune stays fixed so that changes in the *performance* of
it mean something. See `CONCEPTS.md` Sections 3 and 3a.

### The honest limitation to state up front

Five agent voices, arbitrarily many agents. Subagents are pooled round-robin onto voices, so a
voice means "whichever agent holds that slot right now," not one fixed agent. Identity resolution
above five concurrent agents is genuinely lost. This is an open problem, not a bug to fix quietly.

---

## 3. What has to exist for a real stream

### 3.1 The blocker: sound without Logic Pro

Everything today ends at "MIDI into Logic." That cannot ship. Two options:

- **Render audio server-side** (FluidSynth/SoundFont, or a sampler). Straightforward, and
  expensive at scale: every listener needs their own audio stream, encoded and delivered.
- **Send note events to the browser and synthesize there** (Web Audio / Tone.js with piano and
  bass samples). **This is the recommendation.**

The second option is better on every axis that matters, and the reason is worth internalizing:
the engine's output is already tiny. A note event is about 40 bytes. Even at 20 notes/second
that's under 1 KB/s per listener -- versus ~16 KB/s for compressed audio, plus encoding CPU per
listener. Synthesizing in the browser makes the "lots of traffic" question almost disappear, and
it gives the sheet-music display the exact same event stream for free.

### 3.2 Statefulness (the part that constrains the architecture)

The engine is **not** a pure function of the current span. It holds, per stream: the generated
form and where in it you are, the current voicing, the bass's position, the motif and phrase
state, live-agent tracking, and section history. So:

- One engine instance per active listening session.
- Sticky routing (session affinity), or externalized state in Redis if instances must be
  interchangeable.
- A long-running stream needs windowing/re-anchoring. `live.py` currently anchors t=0 at the
  first span forever; over hours that drifts and the bar index grows unboundedly. **This is a
  known defect to fix before any long-running deployment.**

### 3.3 Ingest

- OTLP/HTTP already parses correctly (protobuf, verified against the real SDK). OTLP/gRPC is not
  implemented and probably should be, since most production collectors default to it.
- Needs: per-tenant API keys, TLS, rate limiting, backpressure (drop-oldest rather than queue
  without bound -- a music stream must stay in the present; falling behind is worse than
  dropping).
- The customer points an OTel Collector exporter at the endpoint. That's the whole integration,
  and it's a genuinely low-friction sell.

### 3.4 Recommended shape

```
  customer's OTel Collector
        | OTLP (gRPC or HTTP)
        v
  [ ingest edge ]  stateless, horizontally scalable, authenticates tenant
        |
        v
  [ session engine ]  one per listening session; holds form/voicing/motif state
        |  note events over WebSocket (tiny JSON)
        v
  [ browser ]  Tone.js synthesizes audio + VexFlow draws the score
```

**The scaling insight:** most visitors to a public site will never connect their own telemetry.
Split the two paths explicitly:

- **Demo listener** (the overwhelming majority of traffic): the swarm simulation and the whole
  engine run **client-side**, or serve a pre-generated event stream from a CDN. No backend, no
  per-visitor compute, scales to whatever the CDN handles.
- **Connected stream** (few, and they're the customers): the stateful path above.

Getting this split right is the difference between a site that costs nothing at idle and one that
falls over on a front-page day.

---

## 4. The website

### 4.1 Concept

An old-timey radio as a full-bleed overlay image, with a rectangular cutout where the dials would
be. Beneath the cutout, layered so it shows through:

1. A terminal-style pane showing the **live OTel stream** scrolling past.
2. Below it, a **running sheet-music score** -- staff lines, actual noteheads, and chord symbols
   above the staff (`Am7`, `F#7alt`, `Cmaj7`).

Knobs and dials for settings: to be decided, but the natural candidates map to things the engine
already exposes -- swing amount, tempo range, fan-out sensitivity, which anomalies are armed.

### 4.2 What's needed to build it

- **Overlay art**: an image generator can produce the radio; the cutout needs a transparent PNG
  (or CSS mask) with the rectangle knocked out so the layer beneath shows through. Keep the
  cutout a fixed aspect ratio and let the layers beneath scale to it.
- **Audio**: Tone.js + sampled piano and upright bass. The engine's note events map almost
  directly to Tone.js scheduling.
- **Notation**: VexFlow (most control) or abcjs (faster to stand up). Real work involved --
  rendering *streaming* notation means deciding note values from event times, beaming, and
  scrolling/page-turning. Budget for this properly; it is the hardest UI piece.
- **Chord symbols**: needs a small addition to the engine -- it currently prints roman numerals
  (`IImin`, `Vdom7`). Converting to real names (`Dm7`, `G7`) is easy: pick a concert key, add
  `root_pc` semitones, map quality to a suffix. **Small, well-defined, do it early** since both
  the score display and `--show-form` readability want it.
- **Transport**: WebSocket for connected streams; for the demo path, just run it locally in the
  page.

### 4.3 Sequencing suggestion

1. ~~Chord-symbol naming in the engine~~ **DONE** (`chord_symbol`, `form_as_chord_symbols`).
2. ~~JSON event export~~ **DONE** (`caidence.py --export-events PATH`). Payload is
   `{t, ch, voice, note, vel, dur}` plus chord windows with real symbols. 416 events / 46 KB for
   67 seconds -- roughly 20x cheaper than the equivalent audio, with no encoding CPU.
3. ~~Sample-library A/B~~ **DONE, both instruments decided**: bass is real pizzicato upright
   (Univ. of Iowa MIS 2012, hand-sliced and pitch-verified, user-approved by ear); piano is
   Salamander Grand (CC-BY 3.0), rendered on all 330 non-bass notes and sent for approval. The
   bass's low-end gap (this piece's register needs down to G1, and the first verified take only
   covered C2-B2) is closed too: a second Iowa take (sulE, E1-A#1) sliced and pitch-verified the
   same way, leaving exactly ONE note (B1) pitch-shifted, from its real neighbor A#1 one semitone
   away -- down from the original multi-octave extrapolation. Sample sources: `samples/pizz_bass/`
   (19 real notes, E1-B2 with the one B1 exception), `samples/salamander_piano/`,
   `samples/arco_bass/` (kept as the deliberate negative-control candidate). See BUILD_NOTES for
   the full trail -- a genuine silent-sample ffmpeg bug, an autocorrelation decay-bias bug in the
   verification script, and an octave-transpose bug (VOICE_OUTPUT_TRANSPOSE leaking into exported
   JSON) were all found and fixed along the way, and are worth reading before touching this again.
   **Still open**: a matched Logic-processing chain (reverb/compressor/EQ) hasn't been attempted --
   every render so far is dry/loudness-normalized only.
4. ~~Static page: radio overlay + Tone.js playing an exported event file~~ **FIRST VERSION DONE**
   (`demo.html`) -- CSS radio, chord-symbol readout, note-event terminal log, VU meter, playing
   through the two decided samples. See BUILD_NOTES for a real `Tone.Draw`/rAF bug found and fixed
   along the way (switched UI updates to polling `Tone.Transport.seconds` instead -- more robust
   for an unattended/backgrounded tab regardless). Still needs: a real (non-placeholder) terminal
   pane once there's a raw span log to show, knobs wired to something, and the matched-processing
   chain that's been deferred through every render so far.
5. ~~Add the scrolling OTel terminal pane~~ **DONE**: `demo.html`'s terminal now shows real
   OTLP/JSON spans + logs (`otel_trace_demo.json`, generated by `export_otel_trace.py` from
   `swarm.py`'s actual simulated pipeline at the same seed/params that produced the audio) instead
   of the earlier per-note placeholder line. Real trace/span IDs, parent/child links, `gen_ai.*`
   attributes matching what `live.py` actually reads, real tool-call successes AND failures. See
   BUILD_NOTES for why the attribute convention matters (the user's own pasted example used a
   different, non-GenAI convention) and how event timing is kept in sync with the tempo/swing-
   adjusted audio despite the sim's own clock running on a different scale.
6. Add notation.
7. **Partially pulled forward, client-side**: the demo page no longer plays back one precomputed
   file -- `engine.js`/`director.js` port the harmony/voicing/bass/swarm machinery to run
   in-browser, generating and scheduling forever (see BUILD_NOTES for what's a faithful port vs.
   simplified). This is NOT the real live path -- there's still no actual OTLP ingest here, it's
   a client-side MOCK swarm generating indefinitely, same category as `swarm.py` always was, just
   moved to JS and made open-ended. The still-real remaining work for an actual connected stream
   is unchanged: WebSocket, a session engine per real listener, real ingest, plus the two gaps in
   Section 5 (no completion signal, no re-anchoring for long streams) that only matter once
   telemetry is coming from an actual customer rather than a generator.

Steps 1-3 produce something demoable and cost nothing to host. Resist doing 7 first.

---

## 4.5 DECIDED: where the browser's sounds come from

This is not a detail. The timbre is the entire audience-facing surface of the project, and the
user's framing was right: subtlety here decides whether it lands.

### The constraint, settled

**Logic's own samples cannot be served from the site.** Logic's license permits using the sounds
in your musical *productions* -- the audio you make -- not redistributing the sample content.
Shipping those files to visitors' browsers is redistribution. Bouncing chromatic one-shots out of
Logic to build a browser sampler is the same thing with extra steps: that constructs a derivative
sample library, which is precisely what's prohibited. This path is closed, deliberately, and not
to be reopened by a later session looking for a shortcut.

**A second constraint bites before licensing does anyway.** The local `EXS Factory Samples`
directory is **48 GB**. A browser sampler's realistic budget is **5-15 MB** -- roughly 15-30
sampled pitches at 2-3 velocity layers. That is a ~4000x reduction. Even with unlimited rights
you could not ship Concert Grand to a browser; every web instrument is a drastic reduction of
something. **The fidelity gap is dominated by the browser's size budget, not by which library you
start from**, which is the main reason starting from Logic wouldn't buy what it appears to.

### The split that preserves the good sound

- **Demo / marketing / paper audio -> real Logic bounces.** Rendering audio from Logic is exactly
  what it's licensed for. This path is already meant to be static/CDN (Section 3.4), it carries
  most traffic, and it costs nothing in fidelity: the user's own Concert Grand, Roots Upright,
  ChromaVerb, exactly as tuned.
- **Live connected streams -> permissively-licensed samples**, synthesized in-browser. Only real
  customer streams need this, and it's the small path.

### Honest read on whether the free options actually sound good

The answer differs by instrument, and the risk is not where you'd assume.

**Piano: likely fine.** *Salamander Grand* (Yamaha C5, CC-BY 3.0, 16 velocity layers, sampled
every 3 semitones) is the de facto web piano -- Tone.js ships examples against it and it's used in
shipping products. It is not Logic's Concert Grand, but it is a genuinely well-recorded
instrument. CC-BY means attribution, which is a footer credit line, not a constraint on use.
*VSCO 2 Community Edition* and *VCSL* are CC0 (no attribution at all) but their pianos are weaker.

**Upright bass: this is the actual risk, and it should be tested first.** CC0 jazz pizzicato
upright is thin territory -- VCSL and VSCO 2 CE both have contrabass, but community-edition
libraries tend to be broad and shallow. The bass is also the most exposed voice in this
arrangement: it plays four quarter notes per bar, continuously, with nothing to hide behind.
Specific failure modes to listen for, in order of likelihood:

1. **Machine-gunning.** One sample per pitch with no round-robin means every repeated note is
   bit-identical, which a walking line exposes immediately. Mitigable without new samples:
   randomize sample start offset by a few milliseconds, plus small velocity and timing jitter.
2. **Wrong attack transient.** Jazz pizzicato has a specific finger/string snap. Arco (bowed)
   samples mislabelled or substituted will sound wrong instantly and cannot be fixed by processing.
3. **Bad loop points / unnatural decay** on longer notes.

**The thing that may matter more than the samples.** The user's Logic tracks carry ChromaVerb, a
Compressor, and Channel EQ. A large share of the character they responded to is plausibly
*processing*, not raw samples -- and all of it is reproducible in Web Audio: convolution reverb
with an impulse response, a `DynamicsCompressorNode`, a biquad EQ chain. Matching the chain will
likely close more of the gap than swapping libraries will. Test processing-matched, not raw.

### The test protocol (do this before committing to any library)

The user is the ear that matters; this exists to let them judge on controlled evidence rather
than impressions.

1. **Export a fixed passage** from the engine as a JSON event file (`--export-events`, already
   implemented). Same notes, same timing, both renderings -- otherwise you're comparing
   performances, not sounds.
2. **Render the reference in Logic** from that exact passage, with the user's current patches and
   FX. This is the target.
3. **Render the same passage in-browser** with candidate samples, *with a matched processing
   chain* (reverb IR, compression, EQ). Unprocessed comparisons will fail for the wrong reason.
4. **A/B, bass first.** Bass is the likely failure point and the cheapest to falsify. If the bass
   can't be made acceptable, that's a real finding, and the fallback is pre-rendering more of the
   experience rather than shipping a sound the user doesn't stand behind.
5. Only after the user signs off does the sample choice get baked into the site.

Candidate sources to fetch for the test:

| Library | License | Use for | Note |
|---|---|---|---|
| Salamander Grand | CC-BY 3.0 | piano | strongest candidate; attribution = footer credit |
| VSCO 2 Community Edition | CC0 | piano, contrabass | no attribution required |
| Versilian VCSL | CC0 | upright bass | broad/shallow; check pizz vs arco carefully |
| Univ. of Iowa EMS | free | piano, double bass | dry and clean -- good raw material since we add our own reverb |

**Non-negotiable:** whatever is chosen must be verifiably CC0 / CC-BY / public domain, with the
license recorded in the repo next to the samples. No "probably fine" sources.

## 4.6 Checked: the "just point a standard OTel demo at it" shortcut doesn't work

Investigated whether any of the well-known synthetic-OTLP generators (the official OTel Demo
App's load generator, OpenObserve's OTel demo dataset, `otelgen`) could feed `live.py` directly
for testing/demo purposes, since all three are real OTLP/HTTP or gRPC producers and `live.py`
already parses real OTLP. **They don't, and it's not a protocol problem.**

`live.py`'s span-to-music mapping (`span_to_dict`) reads exactly five attributes:
`gen_ai.agent.name`, `gen_ai.operation.name`, `gen_ai.usage.output_tokens` /
`gen_ai.usage.input_tokens`, `gen_ai.tool.name`, plus the span's own status code. These are the
OTel **GenAI semantic conventions** -- attributes an LLM/agent framework's instrumentation emits.
All three candidate generators simulate a generic e-commerce microservice stack (HTTP handlers,
DB queries, cart/checkout flows, host metrics) and carry none of them. Pointed at `live.py`'s
`:4318`, every span would silently fall through to the hardcoded defaults
(`agent="worker1"`, `op="chat"`, `tokens=100`) -- it would play, at the wire level, but as one
undifferentiated voice chatting at a constant rate for the whole stream. Not broken, just
semantically empty: it would validate the receiver survives real OTLP traffic and nothing else.
Noted here mainly so a later session doesn't spend time wiring one of these up expecting a
meaningful demo out of it -- for **load/parser testing** of the ingest edge (Section 3.3) they'd
still be legitimately useful, that's a different question than sonification fidelity.

**What would actually work**: real GenAI-instrumented traces, i.e. an OTel SDK with GenAI
semantic-convention instrumentation attached to an actual LLM call or agent framework --
OpenLLMetry (Traceloop), OpenInference (Arize), or a multi-agent framework (LangGraph, CrewAI,
AutoGen) with OTel instrumentation enabled. That's real work (standing up an actual agent run,
not downloading a generator), but it's the only thing that would exercise the live path with
data resembling what a real customer's collector would send -- which is the actual target per
Section 3. `live_producer.py` remains the right tool for synthetic testing until that happens: it
uses the real OTel SDK to emit spans with the correct `gen_ai.*` attributes already, which is the
property these three generators lack.

## 4.7 Hosting/scale plan for the current demo, and its security review

Written when `demo.html` + `engine.js` + `director.js` (the infinite, client-side-generated demo)
were considered ready to actually deploy somewhere. Scope is the DEMO path only -- the real
connected-stream path (Section 3/6) is still unbuilt and needs its own infra planning later.

**Hosting**: this is now a 100%-client-side, zero-backend page (generation moved into the browser
this session -- see BUILD_NOTES), which means the plan is genuinely just "static hosting, done."
Total deploy footprint is ~3.7MB (`demo.html` 20K, `engine.js` 28K, `director.js` 16K,
`assets/radio_overlay.png` 1.5M, `samples/pizz_bass/` 832K, `samples/salamander_piano/` 1.3M,
`corpus_model_jazz.json` 60K), loaded once per visitor and cached by the browser after --
no ongoing per-second bandwidth, since there's no polling or websocket. Recommend Cloudflare
Pages (free tier, no bandwidth cap as of writing, trivial `_headers` file for caching/CSP) or any
comparable static host (Netlify/Vercel/GitHub Pages) -- doesn't matter much which, since there's
no backend to differentiate them. Cache `assets/`/`samples/`/`corpus_model_jazz.json` as
`public, max-age=31536000, immutable`; keep `demo.html`/`engine.js`/`director.js` short-cached
(they'll change) unless the host fingerprints filenames on deploy. At 3.7MB/visitor, even 100k
visitors in a day is ~370GB one-time transfer -- trivial for any CDN's free/cheap tier, matching
ROADMAP 3.4's original "free at idle" goal.

**Deploy scope -- do NOT deploy the project directory as-is.** It currently holds ~430MB that must
never ship: `.venv` (256MB), `corpus_raw/` (93MB, including `wjazzd.db` -- the raw Weimar Jazz
Database; ODbL licensing was noted early on as "not urgent, nothing published" and that's no
longer true once hosting is real, so this must be excluded, not just unlinked),
`otelljazztesting.logicx` (39MB Logic project), a stray `path/to/venv` (22MB), `__pycache__`, and
all the `.py` engine source. There's no `.gitignore` yet because this has never been a git repo.
**Action**: deploy from an explicit allowlist (the 7 items in the footprint above), not a
directory copy -- a naive `rsync -a .` or a host with directory listing enabled would otherwise
expose a licensing-encumbered database and unrelated personal project files.

**Security review** (manual -- the automated `/security-review` skill needs a git repo, which this
project isn't yet; offered to `git init` first, not done this pass). Scope: the actual shipped
client-side code.

- **Fixed this session**: Tone.js was loaded from `cdnjs.cloudflare.com` with no Subresource
  Integrity -- a CDN compromise or MITM could have injected arbitrary JS into every visitor's
  page. Added a real SRI hash (computed directly, `sha384-c6Uo4N9...`) plus `crossorigin`.
  Verified it doesn't break loading.
- **No action needed now, but a real forward-looking flag**: the terminal renders span/log lines
  via `innerHTML`, built from data that today comes ENTIRELY from the client-side `SwarmEngine` --
  every value (agent name, tool name, stop_reason) is drawn from a fixed internal vocabulary
  (`MCP_SERVERS`, hardcoded op/reason strings), never from user input, a URL parameter, or
  external network data. No XSS vector exists today, checked directly (no `eval`, no
  `document.write`, no dynamic script injection anywhere in `demo.html`/`engine.js`/`director.js`,
  no user input surface at all -- no forms, no query-string parsing, no `postMessage` listener).
  **But this is exactly the rendering path that would carry real OTLP data once ROADMAP's actual
  live-ingest path ships** -- at that point span attribute values become externally-controlled,
  attacker-influenced strings (a malicious or compromised agent could name itself with an HTML
  payload), and rendering them via `innerHTML` unescaped becomes a real stored-XSS vector. Fix
  before wiring real ingest: escape span-derived strings before interpolating into `innerHTML`,
  or switch that rendering to `textContent` plus separate styling.
- No secrets/credentials/API keys/env files anywhere in scope, confirmed by direct search.
- No cookies, `localStorage`, `sessionStorage`, or any persistence at all -- the page collects and
  stores nothing about visitors. `crypto.getRandomValues` is used correctly (session variety only,
  not for anything security-sensitive).
- Only fetches are same-origin (`corpus_model_jazz.json`, sample mp3s) -- no CORS
  misconfiguration risk.
- Recommend a baseline CSP once hosted, e.g. via Cloudflare Pages' `_headers`:
  `default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; media-src 'self';
  style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'` (inline styles are used
  throughout, hence `unsafe-inline` on style-src specifically, not script-src). Costs nothing and
  raises the bar against any future XSS, including a missed case of the innerHTML flag above.

**Verdict**: low risk today -- static, no input surface, no secrets, no persistence. One real fix
already applied (SRI). One forward-looking fix required before real telemetry ingest ships
(escape/avoid innerHTML for span-derived data). One deploy-hygiene action required before hosting
anything at all (explicit file allowlist, never the whole project directory).

## 5. Known defects and gaps to carry forward

- **Live mode has no completion signal.** Batch's `voice_retired_at()` (a voice leaves the chord
  when its agent's most recent span carries a terminal `stop_reason`) has no live counterpart --
  `live.py`'s `span_to_dict` doesn't read `gen_ai.response.finish_reasons` or any stop-reason
  attribute at all, so live mode can only infer agent departure from the `ACTIVITY_WINDOW_S`
  silence timeout, which BUILD_NOTES already measured as a real lagging signal (1.8-8.2s stale)
  when it was the ONLY signal in batch, before `voice_retired_at` fixed it there. Live never got
  the equivalent fix. Worth doing before a live demo leans on ensemble-thinning as a legible cue.
- **Live mode has no solo line.** `generate_solo_melody` assumes it can walk from t=0 to a known
  end. Live therefore also has **no activity-driven note density**, which is one of the better
  mappings. This is the biggest functional gap between batch and live.
- **Live mode has no sections** -- fixed tempo, no derived movements. `derive_sections` is
  batch-only because it looks at the whole trace. A streaming version needs to decide boundaries
  from history only, without lookahead.
- **No re-anchoring for long streams** (see 3.2).
- **OTLP/gRPC not implemented.**
- **Anomaly detection is still scripted, but at least it's present everywhere now.** The browser
  demo (`director.js`) previously had ZERO anomaly signatures at all -- a real gap, since the
  paper calls the five signatures (drift/conflict/capture-spike/collusion/tool-error) the point of
  the grammar, and a public launch couldn't demonstrate the oversight claim from the browser demo.
  Fixed: `director.js` now ports the same five mechanisms (continuous pitch-deviation for
  drift/conflict via a per-note bend resolved against an active-window state, discrete clusters
  for capture-spike/collusion), randomly triggered on a cooldown+roll rather than derived from
  structural telemetry. That "randomly triggered rather than derived" part is still the real
  remaining gap and the spec's own "ambitious tier" -- deriving these from what the telemetry
  actually says (a real drift in behavior, a real disagreement between agents) rather than a dice
  roll remains future work, and the paper should say so precisely, because it's the difference
  between "sonifies telemetry" and "detects problems."
- **The 5-voice pooling ceiling is now measured, not just asserted, on BOTH the Python and
  browser paths** (Section 2). Was: swarm.py (and separately, engine.js's browser mirror) pooled
  agent identity itself before the mapping engine ever saw it, so the saturation ceiling couldn't
  be measured -- activity/activityLevel was silently capped at 4 regardless of fanout, and live
  OTel (which never arrives pre-pooled) would have diverged from the mock path. Fixed on both
  sides: swarm.py/engine.js now emit every agent's true, unbounded identity; pooling moved into
  a shared `VoicePool` (causal -- caidence.py's is used identically by the batch path and
  `live.py`; engine.js's identical port is used by `director.js`). `caidence.py --show-pool-stats`
  measures it directly on the Python side (17 true distinct agents against 3 pool slots produced
  149 forced slot steals at fanout 8); the browser side was verified the same way via direct
  instrumentation (11 true distinct agents, 24 overflow events over a 120s run). See BUILD_NOTES
  for both trails. There is no longer a producer-side pooling shortcut anywhere in the codebase.

---

## 6. Where a new session should start

Read `BUILD_NOTES.md` first (it's the running log and has the reasoning behind non-obvious
decisions), then this file for direction. `CONCEPTS.md` is the design rationale, written for the
parallel paper session.

If picking up the product thread: start at Section 4.3 step 1. It's small, it unblocks the score,
and it's the natural first thing that isn't already done.
