#!/usr/bin/env python3
"""
swarm.py - a mock multi-agent pipeline, and the telemetry-to-form derivation that goes with it.

Everything OtelJazz has played so far came from a hand-authored trace: extended_demo_trace() is
129 spans written by hand to make a nice arc, with its movements, tempos, and voice sets set by a
literal table. That is fine for tuning the instrument and useless for the actual claim -- a piece
whose shape a human chose is not evidence that swarm shape is audible. This module is the other
half: a pipeline that runs on its own logic and produces telemetry, plus derive_sections(), which
reads the resulting spans and works out the musical form FROM them.

WHAT IT EMULATES (per the user's own framing of the target):
  * A real pipeline in motion -- intake, decomposition, fan-out, execution, convergence, report.
  * A multitude of tool calls against mock MCP servers, each with its own latency profile and
    failure rate, so tool traffic has texture rather than being uniform.
  * Subagent spawning as the high-intensity moments, and sequential decomposition/synthesis as
    the slow, sparse ones -- which falls out of the pipeline's structure rather than being
    imposed on it.
  * stop_reason driving movement boundaries on a SLIDING SCALE, not a fixed count (see
    derive_sections).

WHAT THE MUSIC GETS FOR FREE, because the engine already reads these signals:
  * Simultaneous agent count -> how many voices are in the comp (comp liveness): one working
    agent really does mean close to a lone piano, a full fan-out really does mean the full
    ensemble. That mapping already existed; the swarm is simply the first thing to exercise it
    honestly.
  * Activity level -> walking bass two-feel vs four-feel, solo density, chord inversion.
  * Tool calls -> the tools voice; tool errors -> the dissonant grace note.

AGENT-TO-VOICE POOLING (an honest limitation, and a real design question for the paper): the
instrument has five agent voices and a swarm can have many more agents than that. This module
emits every subagent's TRUE, unbounded identity (see _fan_out) -- it does NOT pool them onto
voices itself. Pooling now happens in caidence.py's VoicePool, which is the mapping engine's job
for exactly the reason CLAUDE.md gives for keeping one shared mapping: real OTel telemetry will
never arrive pre-pooled either, so if THIS module collapsed identity before caidence.py ever saw
it, live and mock spans would take different paths through the code. A voice still represents
"whichever true agent is using that slot right now" once VoicePool has run -- that loss of
identity resolution is real and is the sort of thing that should be stated in the paper, not
hidden -- but it's now something that can be MEASURED (caidence.py --show-pool-stats /
VoicePool.overflow_events counts every forced slot steal), not merely asserted.

Usage:
  python3 swarm.py --show                     # print the pipeline it generated, and the form
                                              # derived from it, without playing anything
  python3 swarm.py --json trace.json          # dump spans for caidence.py --trace
  python3 caidence.py --swarm --port "IAC Driver Bus 1"      # play it
  python3 live_producer.py --trace swarm      # stream it as real OTel spans
"""

import argparse
import json
import random

# The orchestrator's true agent id -- fixed, never pooled, matches caidence.ORCHESTRATOR_AGENT_ID.
# Subagents get their own true, unbounded ids (see _fan_out) -- swarm.py does NOT pool them onto
# voices anymore. Pooling moved to caidence.py's VoicePool (see its block comment for why): real
# OTel will never arrive pre-pooled, so if the mock producer pooled identity before caidence.py
# ever saw the spans, live and mock telemetry would take different paths through the mapping --
# exactly the drift CLAUDE.md forbids. This module's only job is to emit true identities.
ORCHESTRATOR_AGENT_ID = "orchestrator"

# Mock MCP servers and the tools they expose, each with a latency profile (seconds, lognormal-ish
# via min/typical/max) and a failure rate. Different servers behave differently on purpose: a
# filesystem call is fast and reliable, a web fetch is slow and flaky, a database query sits in
# between. That texture is what makes tool traffic sound like tool traffic rather than a metronome.
MCP_SERVERS = {
    "mcp://filesystem": {
        "tools": ["read_file", "write_file", "list_dir", "grep"],
        "latency": (0.05, 0.15, 0.5), "failure_rate": 0.01,
    },
    "mcp://search": {
        "tools": ["web_search", "fetch_page"],
        "latency": (0.4, 1.2, 4.0), "failure_rate": 0.09,
    },
    "mcp://database": {
        "tools": ["query", "schema", "explain"],
        "latency": (0.1, 0.45, 2.0), "failure_rate": 0.04,
    },
    "mcp://github": {
        "tools": ["list_issues", "read_pr", "search_code"],
        "latency": (0.3, 0.8, 3.0), "failure_rate": 0.06,
    },
    "mcp://vector-store": {
        "tools": ["embed", "similarity_search"],
        "latency": (0.15, 0.35, 1.2), "failure_rate": 0.02,
    },
}

# Terminal stop reasons, roughly as an LLM agent runtime reports them. These are what
# derive_sections listens to for movement boundaries -- see WEIGHT below for why they aren't
# treated as equally significant.
# Terminal reasons are the ones that mean "this agent is done" (caidence retires the voice on
# them). "tool_use" is not terminal -- the agent paused to call a tool and continues after.
STOP_REASONS = ["end_turn", "tool_use", "max_tokens", "stop_sequence"]
TOOL_FAILURE_WEIGHT = 2.0   # a failed tool call is structurally significant for movement
                             # boundaries even though it isn't a stop_reason at all

# How much each stop_reason argues for "a movement just ended". A subagent finishing its turn is
# a small structural event; a run hitting max_tokens or erroring out is a big one. derive_sections
# accumulates this weight and only closes a movement when it crosses a threshold, which is what
# makes the boundary a SLIDING SCALE rather than "every Nth stop".
STOP_REASON_WEIGHT = {
    "end_turn": 1.0,
    "tool_use": 0.12,      # deliberately small: a busy stretch produces hundreds of these, and
                            # at a higher weight sheer tool VOLUME would manufacture boundaries
                            # that correspond to nothing structural
    "stop_sequence": 1.2,
    "max_tokens": 2.5,
}

# A burst of spawns is a structural event in its own right -- it's the swarm changing shape, and
# per the user's framing it's where "the fast, high intensity parts" begin. Waiting for
# stop_reason weight to accumulate would fold the sparse single-agent lead-in and the fan-out
# into one movement, which buries the clearest mapping the instrument has (one agent really does
# sound like a lone piano). This many create_agent spans inside this window forces a boundary.
SPAWN_BURST_COUNT = 2
SPAWN_BURST_WINDOW_S = 2.0


def _latency(rng, profile):
    """A plausible latency draw: mostly near `typical`, occasionally out toward `max`. Real tool
    latencies are long-tailed, and a uniform draw would make every tool call sound alike."""
    lo, typical, hi = profile
    if rng.random() < 0.15:                      # the tail
        return rng.uniform(typical, hi)
    return max(lo, rng.gauss(typical, typical * 0.35))


class SwarmSim:
    """A pipeline that runs on its own logic and records what it did.

    Deliberately NOT written to produce a nice musical arc -- it's written to behave like a
    pipeline. Any arc the music has comes from derive_sections reading this back, which is the
    entire point: if the shape were authored here the demonstration would be circular."""

    def __init__(self, seed=0, fanout=4, rounds=2):
        self.rng = random.Random(seed)
        self.fanout = fanout
        self.rounds = rounds
        self.spans = []
        self.t = 0.0

    def _add(self, agent_id, op, start, duration, tokens, **extra):
        """agent_id is the TRUE identity (e.g. 'orchestrator' or 'subagent-r2-5') -- unpooled.
        See the module docstring and caidence.VoicePool for where pooling actually happens now."""
        span = dict(agent=agent_id, op=op, start=round(start, 3),
                    duration=round(duration, 3), tokens=int(tokens), status="ok")
        span.update(extra)
        self.spans.append(span)
        return span

    def _tool_call(self, agent_id, at):
        """One MCP tool call. Returns when it finished."""
        server = self.rng.choice(list(MCP_SERVERS))
        spec = MCP_SERVERS[server]
        tool = self.rng.choice(spec["tools"])
        dur = _latency(self.rng, spec["latency"])
        failed = self.rng.random() < spec["failure_rate"]
        # stop_reason is "tool_use" whether or not the CALL failed: the agent stopped to use a
        # tool, which is what stop_reason describes. A tool failure is a status, not a reason the
        # agent terminated -- conflating them would retire the voice (see
        # caidence.TERMINAL_STOP_REASONS) every time a web fetch 500'd, which is not what happened.
        self._add(agent_id, "execute_tool", at, dur, self.rng.randint(15, 60),
                  tool=f"{server}/{tool}", mcp_server=server,
                  status="error" if failed else "ok", stop_reason="tool_use")
        return at + dur

    def _reason(self, agent_id, at, tokens, stop_reason=None):
        dur = max(0.25, self.rng.gauss(0.8, 0.3))
        self._add(agent_id, "chat", at, dur, tokens,
                  **({"stop_reason": stop_reason} if stop_reason else {}))
        return at + dur

    # --- pipeline phases -----------------------------------------------------------------

    def _intake(self):
        """One agent, thinking, barely any tool use. Sparse and slow by construction."""
        t = self.t
        for i in range(3):
            t = self._reason(ORCHESTRATOR_AGENT_ID, t, 240 + i * 40)
            t += self.rng.uniform(0.4, 1.1)
        t = self._tool_call(ORCHESTRATOR_AGENT_ID, t)
        self.t = t + 0.6
        return self.t

    def _decompose(self):
        """Sequential decomposition: the orchestrator works through subtasks one at a time. Still
        one agent -- this is the 'slower, less intense' stretch, and it's slow because only one
        thing is happening, not because a table said so."""
        t = self.t
        for i in range(self.fanout):
            t = self._reason(ORCHESTRATOR_AGENT_ID, t, 180 + i * 25)
            if self.rng.random() < 0.5:
                t = self._tool_call(ORCHESTRATOR_AGENT_ID, t)
            t += self.rng.uniform(0.3, 0.8)
        t = self._reason(ORCHESTRATOR_AGENT_ID, t, 300, stop_reason="end_turn")
        self.t = t + 0.5
        return self.t

    def _fan_out(self, round_idx):
        """Spawn subagents in a burst, then let them work in parallel with heavy tool traffic.
        The high-intensity stretch -- and it's intense because N agents really are running at
        once, which the comp reads directly as ensemble thickness.

        Each subagent's id (f"subagent-r{round_idx}-{i}") is TRUE and unbounded -- at --fanout 32
        this emits 32 distinct identities in one burst, exactly as many as actually spawned.
        caidence.py's VoicePool is what compresses that onto the 3 physical worker voices; this
        method has no opinion about voices at all anymore."""
        spawn_t = self.t
        agents = []
        for i in range(self.fanout):
            agent_id = f"subagent-r{round_idx}-{i}"
            # spawns land close together: a burst, not a trickle
            self._add(agent_id, "create_agent", spawn_t + i * 0.18, 0.25, 40)
            agents.append((agent_id, spawn_t + i * 0.18 + 0.3))

        finish_times = []
        for agent_id, start in agents:
            t = start
            for step in range(self.rng.randint(3, 6)):
                t = self._reason(agent_id, t, self.rng.randint(160, 420))
                for _ in range(self.rng.randint(1, 3)):
                    t = self._tool_call(agent_id, t)
                    t += self.rng.uniform(0.05, 0.3)
                t += self.rng.uniform(0.1, 0.5)
            # each subagent ends with a real terminal reason
            reason = self.rng.choices(
                ["end_turn", "end_turn", "end_turn", "max_tokens", "stop_sequence"], k=1)[0]
            t = self._reason(agent_id, t, self.rng.randint(200, 500), stop_reason=reason)
            finish_times.append(t)

        self.t = max(finish_times) + 0.4
        return self.t

    def _converge(self, round_idx, final):
        """Subagents are done; the orchestrator merges. Back to one agent -- the ensemble thins
        on its own because nothing else is running."""
        t = self.t
        for i in range(2):
            t = self._reason(ORCHESTRATOR_AGENT_ID, t, 260 - i * 60)
            if self.rng.random() < 0.4:
                t = self._tool_call(ORCHESTRATOR_AGENT_ID, t)
            t += self.rng.uniform(0.5, 1.2)
        reason = "end_turn" if not final else "stop_sequence"
        t = self._reason(ORCHESTRATOR_AGENT_ID, t, 150, stop_reason=reason)
        self.t = t + (1.4 if not final else 0.8)
        return self.t

    def run(self):
        self._intake()
        self._decompose()
        for r in range(self.rounds):
            self._fan_out(r)
            self._converge(r, final=(r == self.rounds - 1))
        self.spans.sort(key=lambda s: s["start"])
        return self.spans


# --- telemetry -> musical form ------------------------------------------------------------

MIN_SECTION_S = 9.0        # a movement shorter than this isn't perceptible as a movement
BOUNDARY_WEIGHT_THRESHOLD = 4.0   # accumulated stop_reason weight that closes a movement
TEMPO_MIN, TEMPO_MAX = 68, 132


def _active_agents_in(spans, start, end, resolved):
    """PHYSICAL chord voices active in [start, end) -- resolved via the same VoicePool run as
    everything else (see derive_sections), not raw true agent ids. caidence.py's section gating
    (voices_active_at) checks membership against CHORD_VOICE_ORDER's physical names, so this must
    return those, not the unbounded true identities spans now carry in "agent"."""
    return {resolved.get(id(s), s["agent"]) for s in spans
            if s.get("op") != "execute_tool" and start <= s["start"] < end}


def derive_sections(spans, tail_s=6.0):
    """Work the musical form out FROM the telemetry, instead of authoring it.

    Boundaries: accumulate STOP_REASON_WEIGHT as terminal spans go by and close a movement when
    the running total crosses BOUNDARY_WEIGHT_THRESHOLD -- a sliding scale, per the user's ask,
    rather than "every Nth stop". A pile of routine tool_use stops takes a long time to add up to
    a boundary; a single error or a max_tokens run gets most of the way there on its own. A
    minimum length stops a cluster of stops from shredding the piece into fragments.

    Tempo: from span density in the section, mapped onto TEMPO_MIN..TEMPO_MAX. A fan-out with
    four subagents hammering MCP servers really is faster than an orchestrator thinking alone.

    Voices: exactly the agent voices that appear in the section, so the ensemble contracts and
    expands with the swarm's real width. 'melody' joins whenever more than one agent is active --
    the solo sits out the truly sparse stretches.

    Swing: busier sections swing harder; the sparsest go straight.
    """
    if not spans:
        return []
    # Lazy import (matches caidence.py's own lazy `import swarm` inside main()) -- avoids a
    # module-load-time circular import between the two. Same VoicePool run build_timeline will
    # use on this identical span list -- VoicePool has no randomness of its own, so calling it
    # again here is safe and produces the identical resolution, not a second, divergent one.
    from caidence import pool_spans
    resolved, _pool = pool_spans(spans)
    end_all = max(s["start"] + s.get("duration", 0.5) for s in spans) + tail_s

    # --- spawn bursts: the swarm changing shape, which is a movement start on its own terms
    spawns = sorted(s["start"] for s in spans if s.get("op") == "create_agent")
    burst_starts = []
    for i, t0 in enumerate(spawns):
        inside = [t for t in spawns[i:] if t - t0 <= SPAWN_BURST_WINDOW_S]
        if len(inside) >= SPAWN_BURST_COUNT and (not burst_starts or t0 - burst_starts[-1] > SPAWN_BURST_WINDOW_S):
            burst_starts.append(t0)

    # --- boundaries: accumulated stop_reason weight OR a spawn burst, whichever comes first,
    # both floored by MIN_SECTION_S so a cluster of events can't shred the piece into fragments
    ordered = sorted(spans, key=lambda x: x["start"])
    bounds, acc, last = [0.0], 0.0, 0.0
    pending_bursts = list(burst_starts)
    for s in ordered:
        t_end = s["start"] + s.get("duration", 0.0)

        while pending_bursts and pending_bursts[0] <= s["start"]:
            bt = pending_bursts.pop(0)
            if (bt - last) >= MIN_SECTION_S and bt < end_all - MIN_SECTION_S:
                bounds.append(round(bt, 3))
                last, acc = bt, 0.0

        reason = s.get("stop_reason")
        failed = s.get("status") == "error"
        if not reason and not failed:
            continue
        acc += STOP_REASON_WEIGHT.get(reason, 0.0) + (TOOL_FAILURE_WEIGHT if failed else 0.0)
        if acc >= BOUNDARY_WEIGHT_THRESHOLD and (t_end - last) >= MIN_SECTION_S \
                and t_end < end_all - MIN_SECTION_S:
            bounds.append(round(t_end, 3))
            last, acc = t_end, 0.0
    bounds = sorted(set(bounds)) + [end_all]

    # --- per-section tempo / voices / swing from what actually happened in it
    rates = []
    for a, b in zip(bounds, bounds[1:]):
        n = sum(1 for s in spans if a <= s["start"] < b)
        rates.append(n / max(1e-6, b - a))
    lo_r, hi_r = (min(rates), max(rates)) if rates else (0.0, 1.0)

    sections = []
    for (a, b), rate in zip(zip(bounds, bounds[1:]), rates):
        frac = 0.5 if hi_r <= lo_r else (rate - lo_r) / (hi_r - lo_r)
        voices = _active_agents_in(spans, a, b, resolved)
        has_tools = any(s.get("op") == "execute_tool" and a <= s["start"] < b for s in spans)
        if has_tools:
            voices = voices | {"tools"}
        if len(voices) > 1:
            voices = voices | {"melody"}
        sections.append({
            "start": a, "end": b,
            "tempo_bpm": int(round(TEMPO_MIN + frac * (TEMPO_MAX - TEMPO_MIN))),
            "swing": round(0.54 + frac * 0.12, 3),
            "active_voices": voices,
            "_span_rate": round(rate, 2),          # kept for --show; the engine ignores extras
        })
    return sections


def swarm_trace(seed=0, fanout=4, rounds=2):
    """The pipeline's spans plus the form derived from them. Returns (spans, sections) -- there is
    deliberately no regime_schedule: major/minor is a narrative device from the hand-authored
    demo, and nothing in real telemetry says 'go to minor here'."""
    spans = SwarmSim(seed=seed, fanout=fanout, rounds=rounds).run()
    return spans, derive_sections(spans)


def describe(spans, sections):
    lines = []
    end = max(s["start"] + s.get("duration", 0.5) for s in spans)
    tools = [s for s in spans if s.get("op") == "execute_tool"]
    errs = [s for s in tools if s.get("status") == "error"]
    spawns = [s for s in spans if s.get("op") == "create_agent"]
    labels = {s["agent"] for s in spans}   # true identities, unpooled -- see the module docstring
    lines.append(f"Pipeline: {len(spans)} spans over {end:.1f}s, {len(labels)} distinct agents "
                 f"({len(spawns)} spawned), {len(tools)} tool calls, {len(errs)} failed")
    by_server = {}
    for s in tools:
        by_server[s.get("mcp_server", "?")] = by_server.get(s.get("mcp_server", "?"), 0) + 1
    lines.append("MCP traffic: " + ", ".join(f"{k.split('//')[-1]}={v}"
                                              for k, v in sorted(by_server.items())))
    lines.append("")
    lines.append(f"Derived form: {len(sections)} movements (boundaries from stop_reason weight)")
    for i, sec in enumerate(sections):
        vs = ",".join(sorted(v for v in sec["active_voices"] if v != "melody")) or "-"
        lines.append(f"  {i+1}. {sec['start']:6.1f}-{sec['end']:6.1f}s  "
                     f"{sec['tempo_bpm']:3d}bpm swing={sec['swing']:.2f}  "
                     f"rate={sec['_span_rate']:5.2f}/s  voices[{len(sec['active_voices'])}]: {vs}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Mock multi-agent swarm + telemetry-derived form")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--fanout", type=int, default=4, help="subagents spawned per round")
    ap.add_argument("--rounds", type=int, default=2, help="fan-out/converge cycles")
    ap.add_argument("--show", action="store_true", help="print the pipeline and derived form")
    ap.add_argument("--json", default=None, help="write spans to this path (for --trace)")
    args = ap.parse_args()

    spans, sections = swarm_trace(seed=args.seed, fanout=args.fanout, rounds=args.rounds)
    if args.show or not args.json:
        print(describe(spans, sections))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(spans, f, indent=2)
        print(f"\nWrote {len(spans)} spans to {args.json}")


if __name__ == "__main__":
    main()
