#!/usr/bin/env python3
"""
export_otel_trace.py -- convert swarm.py's REAL simulated spans into a realistic OTLP/JSON trace
(resourceSpans + resourceLogs), for the demo page's terminal pane.

Why this exists: demo.html's terminal was showing a compact, invented `[t] voice note vel` line
per note -- not a real span shape, and not what the user asked for. The user wants the terminal to
show actual OTel telemetry, generated from real data rather than hand-placeholder text. The
realest data this project has is swarm.py's own simulated pipeline -- it's what already drives
ab_test.json's music (--swarm --seed 42, the defaults: fanout=4, rounds=2) -- so this script
re-runs THE SAME swarm with THE SAME seed and reshapes its actual spans into OTLP/JSON, rather than
fabricating a second, disconnected mock trace. What's in the terminal is what's driving the music.

Attribute choice, deliberately not copying the user's example verbatim: the example used
`llm.model_name` / `llm.usage.prompt_tokens`, an older/different convention family. This project's
own engine (live.py's span_to_dict) reads the OTel GenAI semantic conventions --
`gen_ai.agent.name`, `gen_ai.operation.name`, `gen_ai.usage.output_tokens`, `gen_ai.tool.name`.
Using anything else here would make the terminal's "this is the real telemetry" claim false for
this specific engine. `gen_ai.response.finish_reasons` is included too, using the real semconv
name, even though live.py doesn't read it yet (see ROADMAP.md 5, "no completion signal live") --
correct for the mock, and a reminder of the gap.

Span/trace IDs are deterministic hex derived from a seeded RNG (not python's `secrets`) so this
script's output is reproducible run to run, matching the project's existing determinism
conventions elsewhere (synthetic_trace's seed=0 rule, etc.).
"""
import argparse
import json
import random

from swarm import SwarmSim
import swarm as swarm_mod

BASE_EPOCH_S = 1_800_000_000  # an arbitrary but plausible-looking recent Unix time


def hexid(rng, nbytes):
    return "".join(f"{rng.randint(0,255):02x}" for _ in range(nbytes))


def sval(s):
    return {"stringValue": s}


def ival(i):
    return {"intValue": str(i)}


def aval(values):
    return {"arrayValue": {"values": [sval(v) for v in values]}}


def attr(key, value):
    return {"key": key, "value": value}


def build_trace(seed, fanout, rounds):
    sim = SwarmSim(seed=seed, fanout=fanout, rounds=rounds)
    spans = sim.run()
    spans = sorted(spans, key=lambda s: s["start"])

    id_rng = random.Random(f"otel-ids-{seed}-{fanout}-{rounds}")
    trace_id = hexid(id_rng, 16)

    # deterministic span id per span (keyed on its own content+index so it's stable across runs)
    span_ids = {}
    for i, s in enumerate(spans):
        span_ids[i] = hexid(id_rng, 8)

    # parent linking: a subagent span's parent is the most recent ORCHESTRATOR span that had
    # started by the time this span begins -- approximates "the orchestrator's current turn is
    # what spawned/is coordinating this subagent work", which is the real shape of this pipeline
    # (see swarm.py's docstring: intake -> decompose -> fan-out -> execute -> converge -> report).
    last_orchestrator_idx = None
    parent_of = {}
    for i, s in enumerate(spans):
        if s["agent"] == swarm_mod.ORCHESTRATOR_AGENT_ID:
            parent_of[i] = None
            last_orchestrator_idx = i
        else:
            parent_of[i] = last_orchestrator_idx

    resource_spans_by_agent = {}
    resource_logs_by_agent = {}

    for i, s in enumerate(spans):
        # s["agent"] is now the TRUE unpooled identity (swarm.py emits it directly -- see its
        # module docstring); the old "swarm_agent" side field this used to fall back to no
        # longer exists, because agent/swarm_agent carrying the same information in two places
        # was exactly the kind of drift-prone duplication CLAUDE.md warns about.
        agent_id = s["agent"]
        service = "agent-swarm-orchestrator" if agent_id == swarm_mod.ORCHESTRATOR_AGENT_ID else f"{agent_id}-worker"

        start_ns = int((BASE_EPOCH_S + s["start"]) * 1e9)
        end_ns = int((BASE_EPOCH_S + s["start"] + s["duration"]) * 1e9)

        attributes = [
            # gen_ai.agent.id is the real semantic convention's UNIQUE-identity attribute -- see
            # caidence.VoicePool's block comment for why this distinction (id vs. the often-
            # shared-role gen_ai.agent.name) is what makes true pooling possible downstream.
            attr("gen_ai.agent.id", sval(agent_id)),
            attr("gen_ai.agent.name", sval(agent_id)),
            attr("gen_ai.operation.name", sval(s["op"])),
            attr("gen_ai.usage.output_tokens", ival(s["tokens"])),
        ]
        if "tool" in s:
            attributes.append(attr("gen_ai.tool.name", sval(s["tool"])))
        if "mcp_server" in s:
            attributes.append(attr("mcp.server.address", sval(s["mcp_server"])))
        if "stop_reason" in s:
            attributes.append(attr("gen_ai.response.finish_reasons", aval([s["stop_reason"]])))

        span_obj = {
            "traceId": trace_id,
            "spanId": span_ids[i],
            "name": f"{s['agent']}.{s['op']}",
            "kind": 3 if s["op"] == "execute_tool" else (2 if s["op"] == "create_agent" else 1),
            "startTimeUnixNano": str(start_ns),
            "endTimeUnixNano": str(end_ns),
            "attributes": attributes,
            "status": {"code": 2 if s["status"] == "error" else 1},
        }
        parent_i = parent_of.get(i)
        if parent_i is not None:
            span_obj["parentSpanId"] = span_ids[parent_i]

        resource_spans_by_agent.setdefault(service, []).append(span_obj)

        if s["op"] == "execute_tool":
            outcome = "failed" if s["status"] == "error" else "succeeded"
            body = f"{s['agent']} called {s.get('tool','?')} via {s.get('mcp_server','?')} -- {outcome} in {s['duration']:.2f}s"
            resource_logs_by_agent.setdefault(service, []).append({
                "timeUnixNano": str(start_ns),
                "severityText": "ERROR" if s["status"] == "error" else "INFO",
                "severityNumber": 17 if s["status"] == "error" else 9,
                "body": sval(body),
                "traceId": trace_id,
                "spanId": span_ids[i],
                "attributes": [attr("mcp.server.address", sval(s.get("mcp_server", "?")))],
            })

    resource_spans = []
    for service, spans_list in resource_spans_by_agent.items():
        resource_spans.append({
            "resource": {"attributes": [
                attr("service.name", sval(service)),
                attr("service.version", sval("0.1.0-demo")),
                attr("deployment.environment", sval("demo")),
            ]},
            "scopeSpans": [{
                "scope": {"name": "caidence.swarm.sim", "version": "0.1.0"},
                "spans": spans_list,
            }],
        })

    resource_logs = []
    for service, logs_list in resource_logs_by_agent.items():
        resource_logs.append({
            "resource": {"attributes": [attr("service.name", sval(service))]},
            "scopeLogs": [{
                "scope": {"name": "caidence.swarm.sim"},
                "logRecords": logs_list,
            }],
        })

    return {"resourceSpans": resource_spans, "resourceLogs": resource_logs}, spans


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--fanout", type=int, default=4)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--out", default="otel_trace_demo.json")
    ap.add_argument("--flat-out", default=None,
                     help="also write the flat (start,duration,...) spans, for time-syncing a UI")
    args = ap.parse_args()

    trace, flat_spans = build_trace(args.seed, args.fanout, args.rounds)
    with open(args.out, "w") as f:
        json.dump(trace, f, indent=1)
    n_spans = sum(len(rs["scopeSpans"][0]["spans"]) for rs in trace["resourceSpans"])
    n_logs = sum(len(rl["scopeLogs"][0]["logRecords"]) for rl in trace["resourceLogs"])
    print(f"Wrote {n_spans} spans, {n_logs} log records, {len(trace['resourceSpans'])} resources to {args.out}")

    if args.flat_out:
        with open(args.flat_out, "w") as f:
            json.dump(flat_spans, f, indent=1)
        print(f"Wrote {len(flat_spans)} flat spans to {args.flat_out}")
