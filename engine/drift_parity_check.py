#!/usr/bin/env python3
"""Check that drift_detect.detect_latency_drift_at and web/engine.js's detectLatencyDrift give the
same answer on the same spans. The two are hand-kept copies of one statistic, which is exactly how
two implementations silently drift apart (CLAUDE.md), so this is the guard.

    python3 drift_parity_check.py [--seeds 20] [--seconds 400]

Node generates the spans (the browser's SwarmEngine, injection on for every round so there is
something to find) and evaluates its detector at every bar; this script evaluates the Python
detector on the identical spans at the identical times. Decisions (which agent, or none) must
match exactly; the reported statistics must agree to 1e-9.
"""
import argparse, json, math, os, subprocess, sys

from drift_detect import detect_latency_drift_at

HERE = os.path.dirname(os.path.abspath(__file__))
NODE_SRC = r"""
import { Rng, SwarmEngine, detectLatencyDrift } from "../web/engine.js";
import { BAR_S } from "../web/director.js";
const [seeds, seconds] = process.argv.slice(2).map(Number);
const out = [];
for (let seed = 1; seed <= seeds; seed++) {
  const sw = new SwarmEngine(new Rng(seed), { latencyDrift: { prob: 1 } });
  sw.advanceUntil(seconds + 40);
  const spans = sw.spans.map(({ agent, op, start, duration, mcp_server, tool }) => ({ agent, op, start, duration, mcp_server, tool }));
  const evals = [];
  for (let t = BAR_S; t < seconds; t += BAR_S) evals.push([t, detectLatencyDrift(spans, t)]);
  out.push({ seed, spans, evals });
}
process.stdout.write(JSON.stringify(out));
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=20)
    ap.add_argument("--seconds", type=float, default=400)
    args = ap.parse_args()
    script = os.path.join(HERE, "_drift_parity_node.mjs")
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
        for t, js in case["evals"]:
            evals += 1
            py = detect_latency_drift_at(spans, t)
            if (js is None) != (py is None) or (js and js["agent"] != py["agent"]):
                mismatches += 1
                print(f"MISMATCH seed {case['seed']} t={t}: js={js and js['agent']} py={py and py['agent']}")
                continue
            if js:
                findings += 1
                for k in ("r", "growth", "z", "recent", "noise", "startS", "endS"):
                    worst = max(worst, abs(js[k] - py[k]))
    print(f"{evals} evaluations, {findings} findings, {mismatches} decision mismatches, "
          f"max stat difference {worst:.2e}")
    sys.exit(1 if mismatches or worst > 1e-9 else 0)


if __name__ == "__main__":
    main()
