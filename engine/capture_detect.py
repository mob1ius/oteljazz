"""A first-pass capture-spike detector: an agent whose own output balloons right after it ingests
a tool result.

Mirrors web/engine.js's detectCaptureSpike line for line -- same constants, same statistic -- so
the browser and this engine can never disagree. Rerun engine/detector_parity_check.py after
touching either.

For each of an agent's tool calls, compare the tokens of its chat spans before with those in the
window straight after. A capture reads as a step, not as the ordinary spread of that agent's own
output (measured: an agent's chat tokens normally vary about 1.5x between quartiles). The spread
used for the z test comes from the BEFORE spans only, or the captured spans would inflate the
noise floor they are judged against.

Honest limit, measured on synthetic injection (scripts/capture_validation.mjs, 40 seeds x 600s):
1.3% of 16-bar windows flagged with nothing injected, but only 68.8% of injected captures found.
Of the ones whose agent keeps talking long enough to measure it finds 87%; the rest go quiet
after being captured, which leaves this detector nothing to compare. Weaker than
drift_detect.detect_latency_drift and collusion_detect.detect_collusion, and stated as such.
"""
import math

CAPTURE_DETECT = {
    "window_s": 40.0,
    "after_s": 18.0,
    "min_before": 3,
    "min_after": 2,
    "min_ratio": 2.4,
    "z_thresh": 3.0,
}


def _op(s):
    return s.get("op") or s.get("action")


def _median(a):
    s = sorted(a)
    m = len(s) >> 1
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def detect_capture_spike_at(spans, now_s, **opts):
    """Return None or {agent, at_s, before, after, ratio, z} for the clearest capture, judged only
    on spans that had ENDED by now_s."""
    o = {**CAPTURE_DETECT, **opts}
    lo = now_s - o["window_s"]
    win = [s for s in spans if s["start"] >= lo and s["start"] + s.get("duration", 0.0) <= now_s]
    by_agent = {}
    for s in win:
        by_agent.setdefault(s["agent"], []).append(s)

    best = None
    for agent in sorted(by_agent):
        mine = sorted(by_agent[agent], key=lambda s: s["start"])
        chats = [s for s in mine if _op(s) == "chat" and s.get("tokens", 0) > 0]
        if len(chats) < o["min_before"] + o["min_after"]:
            continue
        for tool in [s for s in mine if _op(s) == "execute_tool"]:
            at = tool["start"] + tool.get("duration", 0.0)
            before = [s for s in chats if s["start"] < tool["start"] and s["start"] >= at - o["window_s"]]
            after = [s for s in chats if at <= s["start"] <= at + o["after_s"]]
            if len(before) < o["min_before"] or len(after) < o["min_after"]:
                continue
            mb = _median([s["tokens"] for s in before])
            ma = _median([s["tokens"] for s in after])
            ratio = ma / mb
            if ratio < o["min_ratio"]:
                continue
            logs = [math.log(s["tokens"]) for s in before]
            mid = _median(logs)
            sigma = 1.4826 * _median([abs(x - mid) for x in logs])
            z = (math.log(ratio) / (sigma * math.sqrt(1 / len(before) + 1 / len(after)))
                 if sigma > 1e-6 else float("inf"))
            if z < o["z_thresh"]:
                continue
            if best is None or ratio > best["ratio"]:
                best = {"agent": agent, "at_s": at, "before": mb, "after": ma, "ratio": ratio, "z": z}
    return best


def detect_capture_spike(spans, resolved=None, step_s=2.5):
    """Batch form for caidence.py --detect-capture: step through the trace a bar at a time and
    return the FIRST finding, shaped for build_timeline's capture marker -- "voice" is the
    physical voice the flagged agent held then, "true_agent" who it actually was."""
    if not spans:
        return None
    end = max(s["start"] + s.get("duration", 0.0) for s in spans)
    t = step_s
    while t <= end + step_s:
        found = detect_capture_spike_at(spans, t)
        if found:
            voice = found["agent"]
            if resolved is not None:
                mine = [s for s in spans if s["agent"] == found["agent"] and s["start"] <= t]
                if mine:
                    voice = resolved.get(id(max(mine, key=lambda s: s["start"])), found["agent"])
            return {"voice": voice, "true_agent": found["agent"], "capture_spike": found["at_s"],
                    "ratio": found["ratio"], "z_score": found["z"]}
        t += step_s
    return None
