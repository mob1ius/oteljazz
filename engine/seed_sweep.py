#!/usr/bin/env python3
"""Measure the tempo/thickness relationship across many seeds, from REAL engine output.

Section 4 of the paper used to claim that tempo and ensemble thickness move *independently*,
on the strength of four hand-picked seeds. They do not. This script is what established that:
across 1000 seeds the two channels correlate at r = +0.735, and the earlier reading was a
small-sample artifact. The claim in the paper is now "correlated but non-redundant", and this
script is the thing a reader reruns to check it.

    python3 seed_sweep.py [--n 1000] [--out seed_sweep_1000.json]

Every row is measured from a `--swarm` run and its exported note events -- the same path
make_figures.py uses -- so the sweep and the figures cannot drift apart. Reruns are
byte-identical: SwarmSim is seeded per run and the seeds are 0..n-1, never randomized.

Reported, with 95% intervals throughout, because the point of the exercise was that a
four-seed reading is not enough to carry an independence claim:
  - Pearson r between (final - opening) tempo and (final - opening) thickness, Fisher-z CI
  - the proportions Sec. 4 quotes, each with a Wilson interval
  - variance of thickness overall and within the tempo-floor subset, which is what
    "knowing tempo has bottomed out narrows thickness very little" rests on
"""
import argparse, json, math, os, statistics, subprocess, sys, tempfile
from collections import Counter

import swarm as S

HERE = os.path.dirname(os.path.abspath(__file__))


def wilson(x, n, z=1.96):
    """Wilson score interval. Used rather than normal-approximation because several of the
    proportions here sit near 1.0, where the normal approximation runs past 100%."""
    if n == 0:
        return 0.0, 0.0
    p = x / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z / den * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, centre - half), min(1.0, centre + half)


def fisher_ci(r, n, z=1.96):
    """Fisher z-transform CI for a Pearson correlation."""
    if n < 4 or abs(r) >= 1.0:
        return r, r
    zf = 0.5 * math.log((1 + r) / (1 - r))
    se = 1 / math.sqrt(n - 3)
    return math.tanh(zf - z * se), math.tanh(zf + z * se)


def run_seed(seed):
    """One swarm run -> per-movement (tempo_bpm, chord voices sounding).

    Goes through caidence.py's own --export-events path rather than reimplementing the
    mapping: there is exactly one per-span mapping implementation and this must not become
    a second one.
    """
    spans = S.SwarmSim(seed=seed).run()
    tmp = os.path.join(tempfile.gettempdir(), "seed_sweep_%d.json" % seed)
    subprocess.run(
        [sys.executable, "caidence.py", "--swarm", "--seed", str(seed),
         "--export-events", tmp, "--port", "none"],
        capture_output=True, text=True, cwd=HERE,
    )
    if not os.path.exists(tmp):
        return None
    try:
        with open(tmp) as f:
            events = json.load(f)
    finally:
        os.remove(tmp)

    notes, voices = events["notes"], events["voices"]
    chord = {v for v, meta in voices.items() if meta["role"] == "chord"}
    rows = []
    for sec in S.derive_sections(spans):
        a, b = sec["start"], sec["end"]
        sounding = {n["voice"] for n in notes if a <= n["t"] < b and n["voice"] in chord}
        rows.append((sec["tempo_bpm"], len(sounding)))
    return rows if len(rows) >= 2 else None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=1000, help="seeds 0..n-1 (default 1000)")
    ap.add_argument("--out", default="seed_sweep_1000.json",
                    help="where to write the per-seed rows")
    a = ap.parse_args()

    rows = []
    for seed in range(a.n):
        r = run_seed(seed)
        if r:
            rows.append({"seed": seed,
                         "open_bpm": r[0][0], "open_v": r[0][1],
                         "final_bpm": r[-1][0], "final_v": r[-1][1],
                         "peak_bpm": max(x[0] for x in r)})
        if seed and seed % 200 == 0:
            print("  ...%d" % seed, file=sys.stderr, flush=True)

    n = len(rows)
    if n < 4:
        sys.exit("too few completed runs (%d) to report anything" % n)

    d_tempo = [x["final_bpm"] - x["open_bpm"] for x in rows]
    d_thick = [x["final_v"] - x["open_v"] for x in rows]
    r = statistics.correlation(d_tempo, d_thick)
    lo, hi = fisher_ci(r, n)

    print("\nn = %d seeds (0..%d), deterministic, one run each\n" % (n, a.n - 1))
    print("  correlation of (final - opening) tempo with (final - opening) thickness")
    print("    r = %+.3f  [%.3f, %.3f]   r^2 = %.3f" % (r, lo, hi, r * r))
    print("    -> the channels share %.0f%% of their variance; %.0f%% is not shared."
          % (r * r * 100, (1 - r * r) * 100))

    def prop(label, k):
        w_lo, w_hi = wilson(k, n)
        print("  %-52s %4d/%d = %5.1f%%  [%.1f, %.1f]"
              % (label, k, n, k / n * 100, w_lo * 100, w_hi * 100))

    print("\n  proportions quoted in Sec. 4:")
    prop("thickness at convergence > at opening", sum(1 for x in rows if x["final_v"] > x["open_v"]))
    prop("tempo peaks at/above 130 BPM mid-run", sum(1 for x in rows if x["peak_bpm"] >= 130))
    prop("tempo ends at the 68-69 BPM floor", sum(1 for x in rows if x["final_bpm"] <= 69))
    for tol in (2, 5, 10):
        prop("tempo within +/-%d BPM of opening AND thickness up" % tol,
             sum(1 for x in rows
                 if abs(x["final_bpm"] - x["open_bpm"]) <= tol and x["final_v"] > x["open_v"]))

    floor = [x["final_v"] for x in rows if x["final_bpm"] <= 69]
    allv = [x["final_v"] for x in rows]
    if len(floor) > 1:
        v_floor, v_all = statistics.pvariance(floor), statistics.pvariance(allv)
        print("\n  thickness variance, all runs        : %.2f" % v_all)
        print("  thickness variance, tempo-floor runs: %.2f  (n = %d, range %d..%d)"
              % (v_floor, len(floor), min(floor), max(floor)))
        print("    -> conditioning on a bottomed-out tempo retains %.0f%% of the variance,"
              % (v_floor / v_all * 100))
        print("       i.e. it narrows thickness very little. NOTE this is NOT 1 - r^2 above;")
        print("       they are different quantities and an earlier draft conflated them.")

    dist = Counter(x["final_v"] - x["open_v"] for x in rows)
    print("\n  distribution of (final voices - opening voices):")
    for k in sorted(dist):
        print("     %+d: %4d  (%4.1f%%)" % (k, dist[k], dist[k] / n * 100))

    with open(a.out, "w") as f:
        json.dump(rows, f)
    print("\n  per-seed rows -> %s" % a.out)


if __name__ == "__main__":
    main()
