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
