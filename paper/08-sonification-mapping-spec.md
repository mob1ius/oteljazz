# Sonification Mapping Spec (v0.1)

Implementation companion to `07-oversight-ensemble-sonification.md`. Defines how agent state (OpenTelemetry GenAI spans) becomes musical events, and the musicality rules that keep it music rather than noise. Target output: MIDI into Logic Pro X (or MainStage) via the macOS IAC Driver, real orchestral samples. Goal of v0.1: hear the first bars from a real or synthetic trace, and produce the controlled stimuli for the Section 5.2 study.

## 0. The one honest caveat: two tiers of signal

Not everything interesting is in the raw telemetry. Split the mapping into two tiers and be explicit about which is which, because it is also part of the research contribution.

- Tier 1, DIRECT: read straight off spans. Structure and activity, who acted, when, how long, how much, spawn tree, tool calls, errors, handoffs. Trivially available from OTel.
- Tier 2, DERIVED: computed by a thin analysis layer over the span stream. The adversarial and coordinative signatures, goal drift, collusion, capture, thrash. OTel does not emit "this agent was manipulated." Defining these derived signals is a real part of the paper, not a given. Section 6 below specifies how to compute each.

Design principle running through everything: CONSONANCE IS THE DEFAULT. A healthy system sounds pleasant. Dissonance, wrong notes, silence, and detuning are reserved almost entirely for anomalies, so a listener learns "wrong sound means wrong state." Spend the ugliness budget only on things an overseer must catch.

## 1. Input model: OTel GenAI spans

Verify exact attribute names against the current OpenTelemetry GenAI semantic conventions before coding; the SIG is still moving. Working set:

- Span kinds / operations (`gen_ai.operation.name`): `invoke_agent`, `create_agent`, `chat` (an LLM call), `execute_tool`, `embeddings`.
- Identity: `gen_ai.agent.id` / `gen_ai.agent.name` / `gen_ai.agent.description`; `gen_ai.conversation.id`; `gen_ai.request.model`.
- Tools: `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`.
- Usage: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`.
- Structure: span parent/child = delegation/spawn tree; span links = handoffs; span duration = latency; span status = ok/error.
- Agentic composition (SIG issue #35): tasks, actions, agents, teams, artifacts, memory, and their relationships.

The mapping engine consumes this as a live event stream (or a replayed recording for the study).

## 2. Global / orchestration mappings (the conductor layer)

- Tempo (BPM): global throughput = span-start rate (spans/sec), smoothed, mapped to a bounded range (e.g., 60-160 BPM). Idle system = slow; busy = fast. Hysteresis so it does not jitter.
- Overall dynamics: aggregate token throughput (input+output tokens/sec) mapped to ensemble loudness, smoothed.
- Key and mode: system regime/phase. Major = nominal. A shift to minor or a darker mode = degraded/escalated global state. A deliberate key change marks a phase transition (planning -> execution, or an escalation event).
- Harmonic backbone: a slow-moving pad (strings/choir) sustaining the current key's tonic-ish harmony. Everything else is voiced consonant against it unless an anomaly says otherwise. This pad is what makes the whole thing cohere.
- Meter: fixed simple meter (4/4) in v0.1; reserve meter changes for later.

## 3. Per-agent voice mappings (each agent is an instrument)

- Instrument family by role: planner/orchestrator = low strings (cello/bass) or a horn for authority; worker agents = woodwinds; tool-executor/utility = pizzicato/harp/mallets; memory ops = harp or celesta. A sub-agent inherits its parent's family (a section), so a swarm sounds like sections.
- Instrument instance: assign a specific patch per agent instance, cycling within the family (worker 1 = flute, worker 2 = oboe, worker 3 = clarinet).
- Register by depth: depth in the delegation tree sets octave. Root agent low and central; deeper sub-agents higher. Keeps hierarchy audible.
- One MIDI channel per agent (see Section 7 for the >16 case).

Per-action note (a span start = a note on that agent's instrument):
- Pitch: scale degree from a stable hash of the action type / tool name, quantized to the current mode (so it is always in-key). Same action = same pitch, so recurring actions are recognizable motifs.
- Duration: span duration (latency). Long-running call = a sustained note; fast = staccato.
- Velocity: importance proxy = tokens used, or a fixed weighting by operation type.
- Articulation by operation: `chat`/reasoning = legato/sustained; `execute_tool` = staccato/plucked; `embeddings`/memory = soft short.

## 4. Discrete event mappings (the salient gestures)

- Agent spawn (`create_agent` / new `invoke_agent`): a new voice enters, on the next beat, in the parent's section. Many rapid spawns = crescendo and thickening texture. This is the "crescendo = spawning" from the paper, made concrete.
- Agent completion: a short cadential figure, then the voice rests and exits cleanly.
- Agent stall or death (no spans for T seconds, or terminal error): the voice cuts out mid-phrase = sudden silence in that instrument. Designed to be maximally noticeable. (T is a calibration parameter, tie to the study.)
- Tool call (`execute_tool`): a distinct short pluck/mallet hit; tool type sets its timbre/pitch. Tool ERROR (span status error): a sharp dissonant grace note against the backbone, the audible "something snagged."
- Handoff / delegation (span link A->B): a motif migrates from instrument A to instrument B, the baton audibly passed.
- Retry / loop (same tool.name + args repeated): a repeating rhythmic ostinato that will not resolve = the thrash signature.

## 5. Coordination and anomaly signals (Tier 2, derived)

Each needs a computed signal feeding a musical deviation. Default state contributes nothing (consonant); the signal grows the deviation.

- Goal drift / capture: cosine distance between an agent's declared goal/system-prompt embedding and a rolling embedding of its recent actions/outputs. Rising distance -> that agent's voice detunes progressively flat (pitch-bend / CC), bending out of the shared key. Fully diverged = clearly sour. This is "an agent slipping its leash = a voice going out of tune."
- Capture spike: a sharp drift onset immediately AFTER an external ingestion (a tool result or retrieved doc), i.e., behavior change correlated with an injection point -> a chromatic "wrong-note" cluster on that voice right at the injection, distinct from slow drift.
- Inter-agent conflict/divergence: contradiction or goal-distance between two agents -> harmonic tension (dissonant interval) held between their two voices; resolved when they reconverge (H-> consonance).
- Consensus / convergence: agents' goals/outputs aligning -> harmonic resolution, voices settle to consonance, a small cadence.
- Collusion candidate: unexpected temporal/behavioral correlation between agents that are not supposed to be coordinating (e.g., synchronized action timing or mirrored outputs beyond a baseline) -> an unexpected unison or tight rhythmic lock between voices that were independent. Deliberately eerie.

These are the events the Section 5.2 study injects and measures. Their detectors are approximate in v0.1; making them principled is future work and a genuine contribution.

## 6. Musicality layer (the anti-ugliness engine, do not skip)

Real samples played on random pitches at random times still sound terrible. This layer is what earns the word "symphony."

- Quantization: buffer incoming events and snap onsets to a rhythmic grid (16th notes at current tempo). Real-time but grid-locked, so it grooves.
- Scale constraint: map all continuous values to scale degrees of the current mode, never raw chromatic MIDI. Default output is therefore always in-key and consonant. Chromatic/microtonal notes are RESERVED for anomaly signals (drift, error, capture).
- Register allocation and voice-leading: each family gets a register band to avoid mud; within a family, assign notes to avoid collisions and move by small intervals where possible.
- Polyphony and density caps: cap simultaneous notes per instrument. When event density exceeds a threshold, AGGREGATE a group into a texture (a tremolo bed, a shimmer) instead of a note per event. This doubles as the scaling answer from the paper: beyond N audible agents, render a sub-swarm as one evolving textural voice rather than losing the plot.
- Dynamics smoothing and hysteresis on tempo and loudness so the piece breathes instead of flickering.
- Ugliness budget: enforce that consonance is default and that dissonance/silence/detuning come only from Section 5 signals. If the healthy baseline ever sounds bad, the study is compromised.

## 7. MIDI realization for Logic Pro X

- Transport: mapping engine (Python or JS) emits MIDI over the macOS IAC Driver bus (a virtual MIDI cable) or a Network MIDI session. Logic tracks each listen on a channel.
- Channel per agent: MIDI channels 1-16 = up to 16 solo voices. Beyond 16, use multiple IAC ports/buses (each gives another 16) or switch those agents into the aggregated-texture path from Section 6.
- Per note: note-on with quantized pitch, velocity = importance, note-off at latency-derived duration.
- Continuous controllers: CC11 (expression) = per-voice dynamics/throughput; CC1 (mod) or channel pressure = tension/divergence depth (can drive a dissonance layer or vibrato); pitch bend = the drift/detune signature.
- Tempo: engine owns the clock and quantizes to it; optionally drive Logic tempo via MIDI clock for visual sync.
- Instrument assignment: route each channel to a Logic track loaded with the chosen orchestral patch (Logic's orchestra, or Spitfire/Kontakt libraries if installed). Program-change or just fixed track routing.
- Study stimuli: for Section 5.2, do NOT play live. Drive Logic from a replayed trace, then bounce to a fixed audio file so every participant hears identical, high-fidelity audio. Live mode is for demos and the eventual product.

## 8. Minimal "first bars" recipe (hear something today)

1. Trace: a small real or synthetic run, a planner plus 3 workers issuing chat and tool calls, ~60-120 seconds.
2. Global: key C major, 4/4, tempo from span rate, 16th-note grid, a soft string pad holding a C-major triad as the backbone.
3. Voices (one IAC channel and one Logic track each): planner = solo cello (low register); worker 1 = flute, worker 2 = oboe, worker 3 = clarinet.
4. Actions: each span-start = a quantized in-key note on that agent's instrument; pitch = hash(action_type) to a C-major scale degree; velocity = output_tokens; duration = span latency. Tool calls = a pizzicato/harp pluck on a separate track. Tool error = a single sharp dissonant grace note.
5. Events: a spawn brings a new woodwind in on the next beat; an agent going idle for >T seconds drops its instrument to silence.
6. Inject one anomaly to prove the concept: on worker 2, ramp a downward pitch-bend (drift) over ~8 seconds so the oboe bends audibly flat against the pad. You should hear it go sour without watching anything.
7. Bounce it. That clip is both your first demo and the seed of a study stimulus.

## 9. Open calibration questions (feed the study and future work)

- Stall threshold T, drift-to-detune curve, density-aggregation threshold: all need pilot calibration so anomalies are detectable but not trivially obvious (Section 5.2 controls).
- Which derived signals (Section 5) are reliable enough to be load-bearing versus exploratory. Start with the DIRECT ones (spawn, silence, error, thrash) as the robust core; treat drift/collusion as the ambitious tier.
- Instrument/role mapping is a design variable; the trained-vs-untrained study arm will tell you how learnable the legend is.
- Aesthetic-vs-informative tension (paper Section 6): tune the ugliness budget so healthy runs are pleasant enough for sustained monitoring yet anomalies pop.
