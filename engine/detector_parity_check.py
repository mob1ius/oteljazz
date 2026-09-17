#!/usr/bin/env python3
"""Check that the Python and browser detectors agree on the same spans.

Covers both pairs: drift_detect.detect_latency_drift_at vs web/engine.js's detectLatencyDrift,
and collusion_detect.detect_collusion_at vs its detectCollusion. Each pair is a hand-kept copy of
one statistic, which is exactly how two implementations silently drift apart (CLAUDE.md), so this
is the guard.

    python3 detector_parity_check.py [--seeds 20] [--seconds 400]

Node generates the spans (the browser's SwarmEngine, both injections on for every round so there
is something to find) and evaluates its detectors at every bar; this script evaluates the Python
ones on the identical spans at the identical times. Decisions (which agent or pair, or none) must
match exactly; the reported statistics must agree to 1e-9.
"""
import argparse, json, math, os, subprocess, sys

from collusion_detect import detect_collusion_at
from drift_detect import detect_latency_drift_at

HERE = os.path.dirname(os.path.abspath(__file__))
NODE_SRC = r"""
import { Rng, SwarmEngine, detectLatencyDrift, detectCollusion } from "../web/engine.js";
import { BAR_S } from "../web/director.js";
const [seeds, seconds] = process.argv.slice(2).map(Number);
const out = [];
for (let seed = 1; seed <= seeds; seed++) {
  const sw = new SwarmEngine(new Rng(seed), { latencyDrift: { prob: 1 }, collusion: { prob: 1 } });
  sw.advanceUntil(seconds + 40);
  const spans = sw.spans.map(({ agent, op, start, duration, mcp_server, tool }) => ({ agent, op, start, duration, mcp_server, tool }));
  const evals = [];
  for (let t = BAR_S; t < seconds; t += BAR_S) evals.push([t, detectLatencyDrift(spans, t), detectCollusion(spans, t)]);
  out.push({ seed, spans, evals });
}
process.stdout.write(JSON.stringify(out));
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=20)
    ap.add_argument("--seconds", type=float, default=400)
    args = ap.parse_args()
    script = os.path.join(HERE, "_detector_parity_node.mjs")
    with open(script, "w") as f:
        f.write(NODE_SRC)
    try:
        raw = subprocess.run(["node", script, str(args.seeds), str(args.seconds)],
                             check=True, capture_output=True, text=True, cwd=HERE).stdout
    finally:
        os.remove(script)
    evals = findings = mismatches = 0
    worst = 0.0
    for case in json.loads(raw):
        spans = [{k: v for k, v in s.items() if v is not None} for s in case["spans"]]
        for t, js, js_col in case["evals"]:
            evals += 1
            py = detect_latency_drift_at(spans, t)
            if (js is None) != (py is None) or (js and js["agent"] != py["agent"]):
                mismatches += 1
                print(f"MISMATCH drift seed {case['seed']} t={t}: js={js and js['agent']} py={py and py['agent']}")
            elif js:
                findings += 1
                for k in ("r", "growth", "z", "recent", "noise", "startS", "endS"):
                    worst = max(worst, abs(js[k] - py[k]))

            py_col = detect_collusion_at(spans, t)
            js_pair = (js_col["agentA"], js_col["agentB"]) if js_col else None
            py_pair = (py_col["agent_a"], py_col["agent_b"]) if py_col else None
            if js_pair != py_pair:
                mismatches += 1
                print(f"MISMATCH collusion seed {case['seed']} t={t}: js={js_pair} py={py_pair}")
            elif js_col:
                findings += 1
                for a, b in (("z", "z"), ("matchFrac", "match_frac"), ("sameKindFrac", "same_kind_frac"),
                             ("expected", "expected"), ("matches", "matches")):
                    worst = max(worst, abs(js_col[a] - py_col[b]))
    print(f"{evals} evaluations, {findings} findings, {mismatches} decision mismatches, "
          f"max stat difference {worst:.2e}")
    sys.exit(1 if mismatches or worst > 1e-9 else 0)


if __name__ == "__main__":
    main()
