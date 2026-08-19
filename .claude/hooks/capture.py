#!/usr/bin/env python3
"""
capture.py -- minimal, dependency-free Claude Code hook that appends one JSON line per hook
event to .otel-hook-data/.state/local_spans/<session_id>.jsonl.

Why this exists, replacing opentelemetry-hooks: that package's local-spans feature (the piece
this project needs -- see BUILD_NOTES, "real-trace roadmap item") turned out to be dead code in
the installed version (0.14.0). `_save_local_span_event`, the function whose entire job is
writing one JSONL line per event, is defined but never called anywhere in the 6,218-line source
(grepped every reference, confirmed by direct testing: piped synthetic hook events through
`otel-hook --claude` repeatedly, with IDE_OTEL_LOCAL_SPANS=true and IDE_OTEL_DISABLE_BATCH=true,
zero files ever appeared). Persistence appears to route through the OpenTelemetry SDK's normal
batched span-export pipeline instead, which a short-lived per-event CLI process may never get a
chance to flush, and which was additionally failing on every call trying to reach a live OTLP
collector at localhost:4317 that was never supposed to be configured (an artifact of the
package's auto-copied example config, not anything we asked for).

This script sidesteps all of that: no OTel SDK, no live exporter, no batching, no third-party
dependency at all -- just read one JSON object from stdin, append one JSON object to a file,
exit. It writes the SAME per-line span shape `import_otel_hook_trace.py` already expects
(one object with "name": "gen_ai.client.hook.<EventName>", start_time_ns/end_time_ns,
"attributes", "status"), so that script needs no changes -- only the capture mechanism changed.

PRIVACY: deliberately narrower than opentelemetry-hooks' own defaults. No tool_response body, no
prompt text, no file contents -- only event type, timing, tool name, and (for Bash-shaped calls
only) the command string itself, since that's genuinely useful for reconstructing what kind of
work happened and this project's earlier privacy review already accepted that specific field.
Nothing is exported anywhere; this only ever writes to a local, gitignored directory.

FAIL-OPEN: any internal error here must never block the user's Claude Code session. Every code
path below is wrapped so this always exits 0 with {"continue": true} on stdout, even if the
hook's stdin payload is malformed or unexpected -- a bug in this script should degrade to "this
one event didn't get logged," never to "the user's tool call got blocked."

FIELD NAMES: Claude Code's own hook payload shape for SessionStart/SubagentStart/SubagentStop is
not independently re-verified here beyond PreToolUse/PostToolUse/UserPromptSubmit, which are
well-documented. Unknown/unexpected top-level fields are preserved under attributes["_raw"] as a
fallback so nothing is silently dropped -- inspect a real captured file before trusting the
agent-identity nesting in import_otel_hook_trace.py, and extend the mapping below if Claude Code's
actual SubagentStart/Stop payload uses different field names than guessed.
"""
import json
import os
import re
import sys
import time

HOOK_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HOOK_DIR))
LOCAL_SPANS_DIR = os.path.join(PROJECT_ROOT, ".otel-hook-data", ".state", "local_spans")

# Fields we know how to map cleanly, per Claude Code's documented hook payload shape.
KNOWN_TOP_LEVEL = {
    "session_id", "hook_event_name", "tool_name", "tool_input", "tool_response",
    "prompt", "cwd", "transcript_path", "stop_hook_active", "trigger",
}


def safe_session_key(session_id):
    key = session_id or "unscoped"
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", key)


def build_span(event):
    now_ns = time.time_ns()
    hook_event_name = event.get("hook_event_name", "Unknown")
    session_id = event.get("session_id")
    tool_name = event.get("tool_name")

    attributes = {}
    if tool_name:
        attributes["gen_ai.client.tool_name"] = tool_name

    tool_input = event.get("tool_input")
    if isinstance(tool_input, dict):
        # Bash-shaped calls carry a "command" string -- keep it (matches the prior privacy
        # review's one accepted exception); nothing else from tool_input is captured.
        command = tool_input.get("command")
        if isinstance(command, str):
            attributes["gen_ai.client.command"] = command
        attributes["gen_ai.client.tool.input.length"] = len(json.dumps(tool_input))

    tool_response = event.get("tool_response")
    status = "ERROR" if (isinstance(tool_response, dict) and tool_response.get("error")) else "UNSET"
    if isinstance(tool_response, dict):
        attributes["gen_ai.client.tool.response.length"] = len(json.dumps(tool_response))

    prompt = event.get("prompt")
    if isinstance(prompt, str):
        attributes["gen_ai.client.prompt.length"] = len(prompt)

    # Preserve anything we don't have an explicit mapping for, so future inspection of a real
    # capture can extend the mapping above without having silently lost the data.
    raw_extra = {k: v for k, v in event.items()
                 if k not in KNOWN_TOP_LEVEL and not isinstance(v, (dict, list))}
    if raw_extra:
        attributes["_raw"] = raw_extra

    return {
        "name": f"gen_ai.client.hook.{hook_event_name}",
        "trace_id": safe_session_key(session_id),
        "span_id": f"{now_ns:x}",
        "parent_span_id": None,
        "start_time_ns": now_ns,
        "end_time_ns": now_ns,
        "attributes": attributes,
        "status": status,
    }


def main():
    try:
        raw_stdin = sys.stdin.read()
        event = json.loads(raw_stdin) if raw_stdin.strip() else {}
        span = build_span(event)
        session_id = event.get("session_id")
        os.makedirs(LOCAL_SPANS_DIR, exist_ok=True)
        path = os.path.join(LOCAL_SPANS_DIR, f"{safe_session_key(session_id)}.jsonl")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(span, ensure_ascii=True, default=str) + "\n")
    except Exception:
        pass  # fail-open: never block the session over a capture bug
    finally:
        print(json.dumps({"continue": True}))


if __name__ == "__main__":
    main()
