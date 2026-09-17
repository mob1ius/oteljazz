"""A first-pass collusion detector: two agents moving in lockstep, found from span timing.

Mirrors web/engine.js's detectCollusion line for line -- same constants, same statistic, same
tie-breaking -- so the browser and this engine can never disagree about what collusion is. Rerun
engine/detector_parity_check.py after touching either.

What the signal is: two agents that should be working independently do the same kind of work
within a moment of each other, over and over. For every pair, count how many of the quieter
agent's spans have one of the other's within `tol_s`, and compare that with what independence
predicts from the two rates alone (expected = nA x nB x 2 x tol / window). Agents in one fan-out
overlap by chance all the time, which is what the expected-coincidence baseline is for; what they
don't do is shadow each other's exact tool calls, which is what `min_same_kind_frac` tests.

Validated on synthetic injection only (scripts/collusion_validation.mjs, 40 seeds x 600s):
2.3% of 16-bar windows flagged with nothing injected, 96.9% of injected shadowing found.
Recall against collusion in a real system is unverified, exactly as for detect_latency_drift.
"""
import math

COLLUSION_DETECT = {
    "window_s": 40.0,
    "tol_s": 0.25,
    "min_spans_each": 8,
    "z_thresh": 5.0,
    "min_match_frac": 0.45,
    "min_same_kind_frac": 0.6,
}
EXCLUDED_OPS = {"create_agent"}


def _op(s):
    return s.get("op") or s.get("action")


def _kind(s):
    if _op(s) == "execute_tool":
        return "tool:" + (s.get("mcp_server") or s.get("tool") or "")
    return "op:" + str(_op(s))


def detect_collusion_at(spans, now_s, **opts):
    """Return None or {agent_a, agent_b, matches, expected, z, match_frac, same_kind_frac} for the
    most locked-together pair, judged only on spans that had ENDED by now_s."""
    o = {**COLLUSION_DETECT, **opts}
    lo = now_s - o["window_s"]
    win = [s for s in spans
           if _op(s) not in EXCLUDED_OPS
           and s["start"] >= lo and s["start"] + s.get("duration", 0.0) <= now_s]
    by_agent = {}
    for s in win:
        by_agent.setdefault(s["agent"], []).append(s)
    agents = sorted(a for a in by_agent if len(by_agent[a]) >= o["min_spans_each"])
    for a in agents:
        by_agent[a].sort(key=lambda s: s["start"])

    best = None
    for i in range(len(agents)):
        for j in range(i + 1, len(agents)):
            A, B = by_agent[agents[i]], by_agent[agents[j]]
            small, large = (A, B) if len(A) <= len(B) else (B, A)
            used = set()
            matches = same_kind = 0
            for s in small:
                hit = -1
                for k, other in enumerate(large):
                    if k in used:
                        continue
                    if abs(other["start"] - s["start"]) <= o["tol_s"]:
                        hit = k
                        break
                    if other["start"] - s["start"] > o["tol_s"]:
                        break
                if hit < 0:
                    continue
                used.add(hit)
                matches += 1
                if _kind(large[hit]) == _kind(s):
                    same_kind += 1
            if not matches:
                continue
            expected = (len(A) * len(B) * 2 * o["tol_s"]) / o["window_s"]
            z = (matches - expected) / math.sqrt(max(expected, 1.0))
            match_frac = matches / len(small)
            same_kind_frac = same_kind / matches
            if z < o["z_thresh"] or match_frac < o["min_match_frac"] \
                    or same_kind_frac < o["min_same_kind_frac"]:
                continue
            if best is None or z > best["z"]:
                best = {"agent_a": agents[i], "agent_b": agents[j], "matches": matches,
                        "expected": expected, "z": z, "match_frac": match_frac,
                        "same_kind_frac": same_kind_frac}
    return best


def detect_collusion(spans, resolved=None, step_s=2.5):
    """Batch form for caidence.py --detect-collusion: step through the trace a bar at a time and
    return the FIRST finding, shaped for build_timeline's collusion marker -- "voices" are the two
    physical voices the flagged agents held then, "true_agents" who they actually were."""
    if not spans:
        return None
    end = max(s["start"] + s.get("duration", 0.0) for s in spans)
    t = step_s
    while t <= end + step_s:
        found = detect_collusion_at(spans, t)
        if found:
            voices = []
            for agent in (found["agent_a"], found["agent_b"]):
                voice = agent
                if resolved is not None:
                    mine = [s for s in spans if s["agent"] == agent and s["start"] <= t]
                    if mine:
                        voice = resolved.get(id(max(mine, key=lambda s: s["start"])), agent)
                voices.append(voice)
            return {"voices": tuple(voices), "true_agents": (found["agent_a"], found["agent_b"]),
                    "collusion_start": t, "z_score": found["z"], "match_frac": found["match_frac"]}
        t += step_s
    return None
