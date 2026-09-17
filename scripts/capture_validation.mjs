// capture_validation.mjs -- how well engine.js's detectCaptureSpike finds injected capture spikes.
//
//   node scripts/capture_validation.mjs [seeds=40] [secondsPerSeed=600]
//
// Synthetic only: SwarmEngine makes one subagent's output balloon after one of its own tool
// calls, and the detector is asked to find it. Says nothing about capture in a real system.
//
//   1. False positives: nothing injected; a 16-bar window counts as one if anything was flagged.
//   2. Recall, on two denominators: every injection, and only those the detector could possibly
//      catch (the agent emits at least minBefore chat spans before and minAfter after -- an agent
//      that goes quiet right after being captured leaves nothing to compare). The gap between
//      those two numbers IS the honest limit of this detector.
//   3. End to end: the real Director at page defaults.
import { readFileSync } from "node:fs";
import { Director, BAR_S } from "../web/director.js";
import { Rng, SwarmEngine, detectCaptureSpike, CAPTURE_DETECT, CAPTURE_INJECT } from "../web/engine.js";

const SEEDS = Number(process.argv[2] || 40);
const T = Number(process.argv[3] || 600);
const WARMUP_S = 16 * BAR_S;
const E2E_SEEDS = Math.max(SEEDS, 150);
const corpus = JSON.parse(readFileSync(new URL("../web/corpus_model_jazz.json", import.meta.url)));
const pct = (x, n) => `${x}/${n} (${(100 * x / n).toFixed(1)}%)`;
const bars = [];
for (let t = WARMUP_S; t < T; t += BAR_S) bars.push(t);

let fp = 0, windows = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const sw = new SwarmEngine(new Rng(seed), { capture: { prob: 0 } });
  sw.advanceUntil(T + 60);
  for (let i = 0; i + 16 <= bars.length; i += 16) {
    windows++;
    if (bars.slice(i, i + 16).some(t => detectCaptureSpike(sw.spans, t))) fp++;
  }
}
console.log(`false-positive 16-bar windows (nothing injected): ${pct(fp, windows)}`);

for (const [label, prob, seeds] of [["every round", 1, SEEDS], ["page rate", CAPTURE_INJECT.prob, SEEDS * 4]]) {
  let found = 0, total = 0, eligible = 0, eligibleFound = 0, lag = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const sw = new SwarmEngine(new Rng(seed), { capture: { prob } });
    sw.advanceUntil(T + 60);
    for (const c of sw.injectedCaptures.filter(c => c.t0 >= WARMUP_S && c.endS + 20 <= T)) {
      total++;
      const chats = sw.spans.filter(s => s.agent === c.agent && s.op === "chat" && s.tokens > 0);
      const testable = chats.filter(s => s.start >= c.t0 && s.start <= c.t0 + CAPTURE_DETECT.afterS).length >= CAPTURE_DETECT.minAfter
        && chats.filter(s => s.start < c.t0 && s.start >= c.t0 - CAPTURE_DETECT.windowS).length >= CAPTURE_DETECT.minBefore;
      let hit = false;
      for (let t = c.t0; t <= c.endS + 20; t += BAR_S) {
        const f = detectCaptureSpike(sw.spans, t);
        if (f && f.agent === c.agent) { hit = true; lag.push(t - c.t0); break; }
      }
      if (hit) found++;
      if (testable) { eligible++; if (hit) eligibleFound++; }
    }
  }
  lag.sort((a, b) => a - b);
  console.log(`recall (${label}): all ${pct(found, total)}, testable ${pct(eligibleFound, eligible)}; ` +
    `capture -> detected: median ${lag.length ? lag[lag.length >> 1].toFixed(1) : "-"}s`);
}

let audible = 0, matched = 0, injected = 0, injHeard = 0;
const skips = {};
for (let seed = 1; seed <= E2E_SEEDS; seed++) {
  const d = new Director(corpus.root_transition_matrix_major, {
    seed, performerIntervals: corpus.performer_interval_distributions,
  });
  d.fillUntil(T);
  const inj = d.swarm.injectedCaptures.filter(c => c.endS + 20 <= T);
  injected += inj.length;
  injHeard += inj.filter(c => d.captureLog.some(e => e.agent === c.agent && e.t >= c.t0 && e.t <= c.endS + 20)).length;
  audible += d.captureLog.length;
  matched += d.captureLog.filter(e => d.swarm.injectedCaptures.some(c => c.agent === e.agent && e.t >= c.t0 && e.t <= c.endS + 20)).length;
  for (const [k, v] of Object.entries(d.captureSkips || {})) skips[k] = (skips[k] || 0) + v;
}
console.log(`end to end (page defaults, ${E2E_SEEDS} seeds x ${T}s):`);
console.log(`  injected per 5min ${(injected / E2E_SEEDS / (T / 300)).toFixed(2)}, audible per 5min ` +
  `${(audible / E2E_SEEDS / (T / 300)).toFixed(2)}, audible matching an injection ${pct(matched, audible || 1)}`);
console.log(`  injections that became audible: ${pct(injHeard, injected)}`);
console.log(`  finding-bars not rendered, by reason: ${JSON.stringify(skips)}`);
