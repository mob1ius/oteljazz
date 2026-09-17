"""A real, first-pass drift detector: computes onset-lag deviation from actual span timing,
instead of reading a hand-typed `drift_start` literal out of a trace file.

Where the signal comes from: `generate_chord_schedule` (caidence.py) builds the shared onset
grid purely from tempo/form -- it is a clock, not a readout of any agent's behavior. The genuine
"is this voice lagging" signal is the gap between each chord window's start (the grid) and the
earliest span any given physical voice actually emits inside that window. Nothing in the existing
pipeline computes that gap; this module does, then looks for one voice whose gap is TRENDING UP
relative to the OTHER live voices' gaps at the same windows -- not relative to an assumed-zero
baseline, since a bit of scheduling jitter for everyone is normal and not itself drift.

Method, and why: a single voice's deviation-from-cross-voice-median series is regressed against
window time (`statistics.linear_regression`/`correlation`, stdlib, no new dependency). A real
ramp needs BOTH a positive slope AND a real correlation (r >= r_thresh) -- slope alone fires on
noisy near-flat data with one lucky endpoint, which an early version of this detector actually
did (see BUILD_NOTES: a monotonic-trailing-3-windows rule flagged ordinary jitter as drift and
missed an actual 8ms/window synthetic ramp, both in the same test run). The final z-score check
uses the POOLED spread of every voice's deviation across every window as the noise floor, not a
single window's 4-5-voice sample stdev, since that sample is too small to estimate spread from at
one point in time.

This is a first-pass detector, not a validated production one. It is scoped and validated by
ground-truth recovery on a synthetic case with a known injected ramp, a false-positive check
against pure jitter, and an honest, unvalidated look at one real captured trace.
"""
import statistics
from collections import defaultdict

from caidence import CHORD_AGENT_VOICES


def agent_onset_offsets(spans, chord_schedule, resolved=None):
    """Per physical voice, the list of (window_start, offset) where offset is that voice's
    earliest span start inside the window minus the window's own start -- how late that voice's
    first activity in this window landed relative to the shared grid. Windows where a voice has
    no span at all are simply absent from its series (silence isn't lag).
    """
    per_voice = defaultdict(list)
    for start, end, _root_pc, _quality, _bar_in_form in chord_schedule:
        earliest = {}
        for s in spans:
            voice = resolved.get(id(s), s["agent"]) if resolved is not None else s["agent"]
            if voice not in CHORD_AGENT_VOICES:
                continue
            if start <= s["start"] < end:
                if voice not in earliest or s["start"] < earliest[voice]:
                    earliest[voice] = s["start"]
        for voice, t0 in earliest.items():
            per_voice[voice].append((start, t0 - start))
    return per_voice


def detect_drift(spans, chord_schedule, resolved=None, min_windows=6, r_thresh=0.6,
                  z_thresh=2.0, min_growth_s=0.02):
    """Return None, or a dict shaped like the hand-authored `drift_start`/`drift_window` kwargs
    (`agent`, `drift_start`, `drift_window`, plus `slope`/`r`/`z_score`/`net_growth_s` for
    reporting) describing the most-drifting voice found.

    A voice is flagged only if ALL of: it has at least `min_windows` windows of data; its
    deviation-from-group-median series has a positive linear-regression slope with correlation
    >= r_thresh (a real trend, not noise); the total growth across its series is >= min_growth_s;
    and its final deviation is >= z_thresh standard deviations above the pooled cross-voice,
    cross-window noise floor. Among multiple candidates, returns the one with the largest net
    growth.
    """
    per_voice = agent_onset_offsets(spans, chord_schedule, resolved=resolved)

    window_offsets = defaultdict(dict)
    for voice, series in per_voice.items():
        for w, off in series:
            window_offsets[w][voice] = off

    voice_devs = {}
    all_devs = []
    for voice, series in per_voice.items():
        devs = []
        for w, off in series:
            others = [o for v2, o in window_offsets[w].items() if v2 != voice]
            if not others:
                continue
            med = statistics.median(others)
            devs.append((w, off - med))
        voice_devs[voice] = devs
        all_devs.extend(d for _w, d in devs)

    noise_std = statistics.pstdev(all_devs) if len(all_devs) > 1 else 0.0

    best = None
    for voice, devs in voice_devs.items():
        if len(devs) < min_windows:
            continue
        xs = [w for w, _d in devs]
        ys = [d for _w, d in devs]

        try:
            slope, _intercept = statistics.linear_regression(xs, ys)
            r = statistics.correlation(xs, ys)
        except statistics.StatisticsError:
            continue
        if slope <= 0 or r < r_thresh:
            continue

        net_growth = ys[-1] - ys[0]
        if net_growth < min_growth_s:
            continue

        z = ys[-1] / noise_std if noise_std > 1e-6 else float("inf")
        if z < z_thresh:
            continue

        candidate = {
            "agent": voice,
            "drift_start": xs[0],
            "drift_window": max(xs[-1] - xs[0], 1.0),
            "slope": slope,
            "r": r,
            "z_score": z,
            "net_growth_s": net_growth,
        }
        if best is None or net_growth > best["net_growth_s"]:
            best = candidate
    return best


# ============================================================================================
# A SECOND detector: goal-drift as a latency trend. Mirrors web/engine.js's detectLatencyDrift
# line for line -- same constants, same statistics, same tie-breaking. Change one, change the
# other, and rerun engine/drift_parity_check.py.
#
# detect_drift above is untouched (the paper cites its onset-lag sensitivity curve). This one
# exists because onset lag against the chord grid detected nothing on the browser's span stream
# (noise floor 0.59s vs. the +-30ms it was validated at), and a live OTLP stream can't feed it:
# SDKs batch-export spans when they END, so arrival time is not start time. Duration survives.
#
# Four deliberate differences from detect_drift, each measured (docs/ROADMAP.md, M1):
#   1. per-span log-latency residual against OTHER agents doing the same kind of work, not a
#      per-window onset offset against the grid;
#   2. noise = 1.4826 x MAD, not pstdev;
#   3. noise is leave-one-out (excludes the candidate agent), not pooled -- pooling let the
#      drifting agent inflate its own noise floor (0.65 vs 0.42 clean) and hid most drifts;
#   4. "still off now" = the later half of the run's mean residual in standard errors, not the
#      last point over a single point's spread; plus r >= 0.5 and min_spans = 6.
# Validated on synthetic injection only (scripts/drift_validation.mjs). Recall against real drift
# is unverified.
# ============================================================================================
import math

LATENCY_DRIFT_DETECT = {
    "window_s": 40.0,
    "run_gap_s": 8.0,
    "min_spans": 6,
    "min_peers": 3,
    "r_thresh": 0.5,
    "z_thresh": 3.5,
    "min_growth": math.log(1.8),
}
LATENCY_DRIFT_EXCLUDED_OPS = {"create_agent"}


def _op(s):
    return s.get("op") or s.get("action")


def latency_key(s):
    if _op(s) == "execute_tool":
        return "tool:" + (s.get("mcp_server") or s.get("tool") or "")
    return "op:" + str(_op(s))


def _median(a):
    s = sorted(a)
    m = len(s) >> 1
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def detect_latency_drift_at(spans, now_s, explain=None, **opts):
    """Return None or {agent, startS, endS, n, r, growth, z, recent, noise} for the one TRUE agent
    (unpooled id) whose latency is trending up against its peers, judged only on spans that had
    ENDED by now_s. Pass explain=[] to collect every candidate's numbers."""
    o = {**LATENCY_DRIFT_DETECT, **opts}
    lo = now_s - o["window_s"]
    win = [s for s in spans
           if s.get("duration", 0) > 0 and _op(s) not in LATENCY_DRIFT_EXCLUDED_OPS
           and s["start"] >= lo and s["start"] + s["duration"] <= now_s]
    by_key = {}
    for s in win:
        by_key.setdefault(latency_key(s), []).append(s)

    by_agent = {}
    n_all = 0
    for s in win:
        peers = [p for p in by_key[latency_key(s)] if p["agent"] != s["agent"]]
        if len(peers) < o["min_peers"]:
            continue
        y = math.log(s["duration"]) - math.log(_median([p["duration"] for p in peers]))
        by_agent.setdefault(s["agent"], []).append((s["start"], y))
        n_all += 1
    if n_all < 2:
        return None

    def noise_excluding(agent):
        ys = [p[1] for a, pts in by_agent.items() if a != agent for p in pts]
        if len(ys) < 2:
            return 0.0
        mid = _median(ys)
        return 1.4826 * _median([abs(y - mid) for y in ys])

    best = None
    for agent in sorted(by_agent):
        pts = sorted(by_agent[agent], key=lambda p: p[0])
        first = len(pts) - 1
        while first > 0 and pts[first][0] - pts[first - 1][0] <= o["run_gap_s"]:
            first -= 1
        run = pts[first:]
        row = {"agent": agent, "n": len(run), "startS": run[0][0], "endS": run[-1][0]}
        if explain is not None:
            explain.append(row)
        if len(run) < o["min_spans"]:
            continue
        xs = [p[0] for p in run]
        ys = [p[1] for p in run]
        n = len(run)
        mx = sum(xs) / n
        my = sum(ys) / n
        sxy = sxx = syy = 0.0
        for i in range(n):
            sxy += (xs[i] - mx) * (ys[i] - my)
            sxx += (xs[i] - mx) ** 2
            syy += (ys[i] - my) ** 2
        if sxx <= 0 or syy <= 0:
            continue
        slope = sxy / sxx
        r = sxy / math.sqrt(sxx * syy)
        growth = slope * (xs[-1] - xs[0])
        k = max(3, math.ceil(n / 2))
        noise = noise_excluding(agent)
        recent = sum(ys[-k:]) / k
        z = recent / (noise / math.sqrt(k)) if noise > 1e-6 else float("inf")
        row.update(r=r, growth=growth, z=z, recent=recent, noise=noise)
        if not (slope > 0) or r < o["r_thresh"] or growth < o["min_growth"] or z < o["z_thresh"]:
            continue
        if best is None or growth > best["growth"]:
            best = dict(row)
    return best


def detect_latency_drift(spans, resolved=None, step_s=2.5, window_range=(8.0, 16.0)):
    """Batch form for caidence.py --detect-drift=latency: step through the trace every `step_s`
    (a bar at 96bpm), return the FIRST finding shaped like detect_drift's result -- "agent" is the
    physical voice the flagged true agent held at that moment (so build_timeline renders it), and
    "true_agent" is who it actually was."""
    if not spans:
        return None
    end = max(s["start"] + s.get("duration", 0) for s in spans)
    t = step_s
    while t <= end + step_s:
        found = detect_latency_drift_at(spans, t)
        if found:
            voice = found["agent"]
            if resolved is not None:
                mine = [s for s in spans if s["agent"] == found["agent"] and s["start"] <= t]
                if mine:
                    last = max(mine, key=lambda s: s["start"])
                    voice = resolved.get(id(last), found["agent"])
            window = max(window_range[0], min(window_range[1], found["endS"] - found["startS"]))
            return {"agent": voice, "true_agent": found["agent"], "drift_start": t,
                    "drift_window": window, "z_score": found["z"],
                    "latency_ratio": math.exp(found["recent"]), "r": found["r"]}
        t += step_s
    return None
