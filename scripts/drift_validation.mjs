// drift_validation.mjs -- how well engine.js's detectLatencyDrift finds injected latency drift.
//
//   node scripts/drift_validation.mjs [seeds=40] [secondsPerSeed=600]
//
// Everything here is SYNTHETIC: SwarmEngine injects a latency ramp into one subagent and the
// detector is asked to find it. Nothing here says anything about real-world drift, and nothing
// derived from it should be worded as if it does.
//
// Three measurements, all seeded (seeds 1..N), so reruns are identical:
//   1. False positives: injection OFF. The detector is evaluated at every bar boundary; a 16-bar
//      window (one chorus) counts as a false positive if the detector fired anywhere inside it.
//      Same unit as drift_detect.py's validation. Bar: <= 3%.
//   2. Recall, per injection, at several drift sizes: once as a stress test (every fan-out round
//      injects) and once at the page's own injection rate. An injection counts as found if,
//      within RECALL_HORIZON_S of its start, the detector names that exact agent. Two
//      denominators, both always printed: ALL injections, and ELIGIBLE ones (the agent produced
//      at least minSpans scored spans, which is the only case the detector can ever flag --
//      drift_detect.py's own validation only used cases like that).
//      Misattribution: of the bar-level firings on drifting streams, how many named an agent
//      that was not drifting. The injection-off false-positive test cannot see this error.
//   3. End to end: the real Director with page defaults. Audible drifts per 5 minutes, the share
//      that match an injection, injection-to-audible latency, and the overall anomaly rate.
import { readFileSync } from "node:fs";
import { Director, BAR_S } from "../web/director.js";
import { Rng, SwarmEngine, detectLatencyDrift, LATENCY_DRIFT_INJECT, LATENCY_DRIFT_DETECT } from "../web/engine.js";

const SEEDS = Number(process.argv[2] || 40);
const T = Number(process.argv[3] || 600);
const WARMUP_S = 16 * BAR_S;          // skip the first chorus, as the onset-lag validation did
const RECALL_HORIZON_S = 40;
const corpus = JSON.parse(readFileSync(new URL("../web/corpus_model_jazz.json", import.meta.url)));

function streamFor(seed, prob, maxMult) {
  const sw = new SwarmEngine(new Rng(seed), { latencyDrift: { prob, maxMult } });
  sw.advanceUntil(T + 60);
  return sw;
}
function barTimes() {
  const out = [];
  for (let t = WARMUP_S; t < T; t += BAR_S) out.push(t);
  return out;
}
const pct = (x, n) => `${x}/${n} (${(100 * x / n).toFixed(1)}%)`;

// 1. False positives
let fpWindows = 0, windows = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const sw = streamFor(seed, 0, 1);
  const bars = barTimes();
  for (let i = 0; i + 16 <= bars.length; i += 16) {
    windows++;
    if (bars.slice(i, i + 16).some(t => detectLatencyDrift(sw.spans, t))) fpWindows++;
  }
}
console.log(`false-positive 16-bar windows (injection off): ${pct(fpWindows, windows)}`);

// 2. Recall, as a sensitivity curve -- first as a stress test (every round injects, so drifting
// agents overlap in the look-back window), then at the page's own injection rate.
for (const [label, prob, seeds] of [["every round", 1, SEEDS], ["page rate", LATENCY_DRIFT_INJECT.prob, SEEDS * 5]])
for (const mult of [2, 3, 4, 6]) {
  let found = 0, total = 0, wrong = 0, fired = 0, eligible = 0, eligibleFound = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const sw = streamFor(seed, prob, mult);
    const inj = sw.injectedDrifts.filter(d => d.t0 >= WARMUP_S && d.t0 + RECALL_HORIZON_S <= T);
    const explained = [];
    const hits = barTimes().map(t => {
      const ex = [];
      const f = detectLatencyDrift(sw.spans, t, { explain: ex });
      explained.push([t, ex]);
      return [t, f];
    }).filter(([, f]) => f);
    fired += hits.length;
    for (const [t, f] of hits) {
      const match = sw.injectedDrifts.some(d => d.agent === f.agent && t >= d.t0 && t <= d.t0 + RECALL_HORIZON_S);
      if (!match) wrong++;
    }
    for (const d of inj) {
      total++;
      const hit = hits.some(([t, f]) => f.agent === d.agent && t >= d.t0 && t <= d.t0 + RECALL_HORIZON_S);
      if (hit) found++;
      const canFlag = explained.some(([t, ex]) => t >= d.t0 && t <= d.t0 + RECALL_HORIZON_S &&
        ex.some(e => e.agent === d.agent && e.startS >= d.t0 - 1 && e.n >= LATENCY_DRIFT_DETECT.minSpans));
      if (canFlag) { eligible++; if (hit) eligibleFound++; }
    }
  }
  const mark = mult === LATENCY_DRIFT_INJECT.maxMult ? "  <- page default" : "";
  console.log(`x${mult} (${label}): recall all ${pct(found, total)}, eligible ${pct(eligibleFound, eligible)}; ` +
    `misattributed firings ${pct(wrong, fired)}${mark}`);
}

// 3. End to end, page defaults
let audible = 0, matched = 0, lat = [], anomalies = 0, firstAnomaly = [], injected = 0, injHeard = 0;
const skips = {};
for (let seed = 1; seed <= SEEDS; seed++) {
  const d = new Director(corpus.root_transition_matrix_major, { seed });
  const lines = [];
  d.onSpanLine = (l) => { if (l.service === "oversight-grammar") lines.push(l.t); };
  d.fillUntil(T);
  anomalies += lines.length;
  if (lines.length) firstAnomaly.push(Math.min(...lines));
  const inj = d.swarm.injectedDrifts.filter(x => x.t0 < T - RECALL_HORIZON_S);
  injected += inj.length;
  injHeard += inj.filter(x => d.driftLog.some(e => e.agent === x.agent && e.t >= x.t0 && e.t <= x.t0 + RECALL_HORIZON_S)).length;
  for (const [k, v] of Object.entries(d.driftSkips)) skips[k] = (skips[k] || 0) + v;
  for (const e of d.driftLog) {
    audible++;
    const src = d.swarm.injectedDrifts.filter(x => x.agent === e.agent && x.t0 <= e.t && e.t - x.t0 <= RECALL_HORIZON_S);
    if (src.length) { matched++; lat.push(e.t - src[src.length - 1].t0); }
  }
}
const per5 = (x) => (x / SEEDS / (T / 300)).toFixed(2);
lat.sort((a, b) => a - b);
const q = (p) => lat.length ? lat[Math.floor(p * (lat.length - 1))].toFixed(1) : "-";
firstAnomaly.sort((a, b) => a - b);
console.log(`end to end (page defaults, ${SEEDS} seeds x ${T}s):`);
console.log(`  injected drifts per 5min ${per5(injected)}, audible drifts per 5min ${per5(audible)}, ` +
  `audible drifts matching an injection ${pct(matched, audible || 1)}`);
console.log(`  injections that became audible within ${RECALL_HORIZON_S}s: ${pct(injHeard, injected)}`);
console.log(`  finding-bars not rendered, by reason: ${JSON.stringify(skips)}`);
console.log(`  injection -> audible onset: median ${q(0.5)}s, p90 ${q(0.9)}s`);
console.log(`  all anomalies per 5min ${per5(anomalies)}; first anomaly median ` +
  `${firstAnomaly[Math.floor(firstAnomaly.length / 2)]?.toFixed(1)}s`);
