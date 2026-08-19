#!/usr/bin/env python3
"""
import_otel_hook_trace.py -- convert a REAL captured session from the `opentelemetry-hooks`
Claude Code hook (see BUILD_NOTES, "real-trace roadmap item") into caidence's internal span-dict
JSON, loadable via `caidence.py --trace PATH`.

Why this exists: the paper's mapping-fidelity claim (Section 4) has so far only been measured
against telemetry this project's own author generated (swarm.py's mock pipeline, or hand-authored
spans). R1's review flagged that as a structural confound -- mapping and trace generator both
author-written means correlation is guaranteed by construction. This script closes that gap by
converting a REAL Claude Code session (captured locally via `.claude/settings.json`'s otel-hook
wiring, see BUILD_NOTES for setup) into something caidence.py can render, so the same engine can
be run on telemetry nobody wrote for the paper.

Reverse-direction sibling of export_otel_trace.py (which goes caidence-shape -> OTLP/JSON). This
script goes the other way: otel-hook's local_spans JSONL -> caidence-shape.

INPUT SHAPE (verified against a real smoke-test run of `otel-hook --claude` piped a synthetic
hook event, NOT yet verified against a real multi-turn/multi-subagent session -- see the note
below and re-check this script's assumptions once real captured data exists):
  One JSON object per line, each a decoded span:
    {"name": "gen_ai.client.hook.PreToolUse" | "...PostToolUse" | "...SubagentStart" |
              "...SubagentStop" | "...Stop" | "gen_ai.client.generation" | ...,
     "trace_id": ..., "span_id": ..., "parent_span_id": ...,
     "start_time_ns": <int>, "end_time_ns": <int>,
     "attributes": {"gen_ai.operation.name": ..., "gen_ai.agent.id": ...,
                     "gen_ai.client.tool_name": ..., "gen_ai.client.command": ...,
                     "gen_ai.usage.output_tokens": ..., ...},
     "status": "UNSET" | "ERROR" | ...}

GRANULARITY NOTE (this is the part most likely to need adjusting against real data): otel-hook
logs PreToolUse and PostToolUse as two SEPARATE near-instant spans, not one span bracketing the
whole tool call the way live.py's span_to_dict expects from a real OTLP SDK export. This script
pairs same-tool_name PreToolUse -> next PostToolUse on the same parent (by trace_id + nearest
matching pair, since there's no shared span_id between them) into one caidence span running from
the PreToolUse start to the PostToolUse end. SubagentStart -> SubagentStop pairs, similarly,
become the boundary that assigns everything in between to a distinct agent identity (subagent_N),
rather than the flat default "orchestrator" identity used for tool calls issued directly by the
main session.

TOKEN COUNTS: real Claude Code hook payloads may or may not carry gen_ai.usage.* attributes (my
smoke test didn't exercise a real model turn, so this is unverified against real data). Falls
back to a length-derived proxy (gen_ai.client.tool.input.length + tool.response.length, which
otel-hook DOES emit unconditionally) when usage attributes are absent, so thickness/velocity
still varies with real activity rather than going flat. Re-check this against a real capture
before trusting it as more than a rough proxy.
"""
import argparse
import json
import sys
from collections import defaultdict

# Attribute keys to try, in order -- otel-hook uses gen_ai.client.tool_name (its own hook-runner
# naming) where live.py's real-OTLP-SDK path expects gen_ai.tool.name (the actual semconv name);
# check both rather than assume one, since this script has only been verified against otel-hook's
# own output, not a real SDK export.
TOOL_NAME_KEYS = ("gen_ai.client.tool_name", "gen_ai.tool.name")
AGENT_ID_KEYS = ("gen_ai.agent.id", "gen_ai.agent.name")
OP_NAME_KEY = "gen_ai.operation.name"
TOKEN_KEYS = ("gen_ai.usage.output_tokens", "gen_ai.usage.input_tokens")
LENGTH_KEYS = ("gen_ai.client.tool.input.length", "gen_ai.client.tool.response.length")

ORCHESTRATOR_ID = "orchestrator"


def load_spans(path):
    spans = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            spans.append(json.loads(line))
    return spans


def hook_event_name(span):
    # "gen_ai.client.hook.PreToolUse" -> "PreToolUse"; non-hook spans (e.g. the
    # gen_ai.client.generation container) return None.
    name = span.get("name", "")
    prefix = "gen_ai.client.hook."
    return name[len(prefix):] if name.startswith(prefix) else None


def first_attr(attrs, keys, default=None):
    for k in keys:
        if k in attrs and attrs[k] is not None:
            return attrs[k]
    return default


def token_estimate(attrs):
    tok = first_attr(attrs, TOKEN_KEYS)
    if tok is not None:
        try:
            return max(1, int(tok))
        except (TypeError, ValueError):
            pass
    total_len = 0
    for k in LENGTH_KEYS:
        v = attrs.get(k)
        if isinstance(v, (int, float)):
            total_len += v
    # Rough chars-to-tokens proxy (~4 chars/token), floored so a real but tiny call still reads
    # as nonzero activity rather than silence.
    return max(20, int(total_len / 4)) if total_len else 100


def convert(spans, session_id):
    by_parent_stack = []   # stack of active subagent ids, for nesting SubagentStart/Stop
    current_agent = ORCHESTRATOR_ID
    subagent_counter = 0

    pending_pre = {}   # tool_name -> list of open PreToolUse spans awaiting a PostToolUse
    out = []

    events = []
    for s in spans:
        ev = hook_event_name(s)
        if ev is None:
            continue   # skip container spans (gen_ai.client.generation) -- we rebuild duration
                       # from the Pre/Post pair directly, not from the container
        events.append((s.get("start_time_ns", 0), ev, s))
    events.sort(key=lambda e: e[0])

    if not events:
        return out
    t0 = events[0][0]

    for start_ns, ev, s in events:
        attrs = s.get("attributes", {})
        tool_name = first_attr(attrs, TOOL_NAME_KEYS)

        if ev == "SubagentStart":
            subagent_counter += 1
            by_parent_stack.append(current_agent)
            current_agent = first_attr(attrs, AGENT_ID_KEYS) or f"subagent_{subagent_counter}"
            continue
        if ev == "SubagentStop":
            if by_parent_stack:
                current_agent = by_parent_stack.pop()
            continue

        if ev == "PreToolUse":
            pending_pre.setdefault(tool_name, []).append(s)
            continue

        if ev == "PostToolUse":
            queue = pending_pre.get(tool_name)
            pre = queue.pop(0) if queue else None
            pre_start = pre.get("start_time_ns", start_ns) if pre else start_ns
            post_end = s.get("end_time_ns", start_ns)
            duration_s = max(0.05, (post_end - pre_start) / 1e9)
            span_status = "error" if s.get("status") == "ERROR" else "ok"
            d = {
                "agent": current_agent,
                "op": first_attr(attrs, (OP_NAME_KEY,), "execute_tool"),
                "start": max(0.0, (pre_start - t0) / 1e9),
                "duration": duration_s,
                "tokens": token_estimate(attrs),
                "status": span_status,
            }
            if tool_name:
                d["tool"] = tool_name
            out.append(d)
            continue

        if ev in ("UserPromptSubmit", "Stop"):
            # A turn boundary, not a tool call -- render as a short "chat" span so the orchestrator
            # voice still articulates on turns with no tool calls, matching what a real reasoning
            # span (op=chat) would contribute in caidence's model.
            end_ns = s.get("end_time_ns", start_ns)
            duration_s = max(0.3, (end_ns - start_ns) / 1e9) if end_ns > start_ns else 0.8
            out.append({
                "agent": current_agent,
                "op": first_attr(attrs, (OP_NAME_KEY,), "chat"),
                "start": max(0.0, (start_ns - t0) / 1e9),
                "duration": duration_s,
                "tokens": token_estimate(attrs),
                "status": "ok",
            })
            continue
        # SessionStart/SessionEnd/PreCompact/PostCompact/PostToolUseFailure: not rendered as
        # spans (no clear musical analog yet); PostToolUseFailure's error status is already
        # carried by the paired PostToolUse's own status when Claude Code fires both.

    out.sort(key=lambda d: d["start"])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("local_spans_jsonl", help=".otel-hook-data/.state/local_spans/<session>.jsonl")
    ap.add_argument("--session-id", default=None, help="label only, for the printed summary")
    ap.add_argument("--out", default="real_trace.json")
    args = ap.parse_args()

    raw = load_spans(args.local_spans_jsonl)
    spans = convert(raw, args.session_id or args.local_spans_jsonl)

    if not spans:
        sys.exit(f"No convertible spans found in {args.local_spans_jsonl} "
                  f"(read {len(raw)} raw lines). Real hook data may use event names this script "
                  f"doesn't recognize yet -- inspect a few raw lines and extend hook_event_name's "
                  f"handling above.")

    with open(args.out, "w") as f:
        json.dump(spans, f, indent=1)

    agents = sorted(set(s["agent"] for s in spans))
    duration = spans[-1]["start"] + spans[-1]["duration"]
    print(f"Converted {len(raw)} raw hook events -> {len(spans)} spans, "
          f"{len(agents)} agent identities ({', '.join(agents)}), "
          f"{duration:.1f}s -> {args.out}")
    print(f"Play it with: python3 caidence.py --trace {args.out}")


if __name__ == "__main__":
    main()
