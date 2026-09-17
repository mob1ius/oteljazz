// collusion_validation.mjs -- how well engine.js's detectCollusion finds injected collusion.
//
//   node scripts/collusion_validation.mjs [seeds=40] [secondsPerSeed=600]
//
// Synthetic only: SwarmEngine makes one subagent shadow another (same work, moments later) and
// the detector is asked to find that pair. Says nothing about collusion in a real system.
//
//   1. False positives: no collusion injected. A 16-bar window counts as a false positive if the
//      detector flagged any pair inside it. Bar: <= 3%. Note the synthetic swarm is a hard case:
//      subagents in one fan-out start together and hit the same tools, which is what the
//      expected-coincidence baseline and the same-kind-of-work test exist to see past.
//   2. Recall: injection on for every fan-out round. An injection counts as found if the detector
//      names that exact pair while it is shadowing (plus 30s). Bar: >= 95%.
//   3. End to end: the real Director at page defaults -- audible collusions per 5 minutes, how
//      many match an injection, and how long detection takes.
import { readFileSync } from "node:fs";
import { Director, BAR_S } from "../web/director.js";
import { Rng, SwarmEngine, detectCollusion, COLLUSION_INJECT } from "../web/engine.js";

const SEEDS = Number(process.argv[2] || 40);
const T = Number(process.argv[3] || 600);
const WARMUP_S = 16 * BAR_S;
const E2E_SEEDS = Math.max(SEEDS, 150);
const corpus = JSON.parse(readFileSync(new URL("../web/corpus_model_jazz.json", import.meta.url)));
const pct = (x, n) => `${x}/${n} (${(100 * x / n).toFixed(1)}%)`;
const bars = [];
for (let t = WARMUP_S; t < T; t += BAR_S) bars.push(t);
const isPair = (f, c) => f && ((f.agentA === c.leader && f.agentB === c.follower) ||
                               (f.agentB === c.leader && f.agentA === c.follower));

let fp = 0, windows = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const sw = new SwarmEngine(new Rng(seed), { collusion: { prob: 0 } });
  sw.advanceUntil(T + 60);
  for (let i = 0; i + 16 <= bars.length; i += 16) {
    windows++;
    if (bars.slice(i, i + 16).some(t => detectCollusion(sw.spans, t))) fp++;
  }
}
console.log(`false-positive 16-bar windows (nothing injected): ${pct(fp, windows)}`);

for (const [label, prob, seeds] of [["every round", 1, SEEDS], ["page rate", COLLUSION_INJECT.prob, SEEDS * 4]]) {
  let found = 0, total = 0, lag = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const sw = new SwarmEngine(new Rng(seed), { collusion: { prob } });
    sw.advanceUntil(T + 60);
    for (const c of sw.injectedCollusions.filter(c => c.t0 >= WARMUP_S && c.endS + 30 <= T)) {
      total++;
      for (let t = c.t0; t <= c.endS + 30; t += BAR_S) {
        if (isPair(detectCollusion(sw.spans, t), c)) { found++; lag.push(t - c.t0); break; }
      }
    }
  }
  lag.sort((a, b) => a - b);
  console.log(`recall (${label}): ${pct(found, total)}; shadowing starts -> detected: median ` +
    `${lag.length ? lag[lag.length >> 1].toFixed(1) : "-"}s`);
}

let audible = 0, matched = 0, injected = 0, injHeard = 0;
const skips = {};
for (let seed = 1; seed <= E2E_SEEDS; seed++) {
  const d = new Director(corpus.root_transition_matrix_major, {
    seed, performerIntervals: corpus.performer_interval_distributions,
  });
  d.fillUntil(T);
  const inj = d.swarm.injectedCollusions.filter(c => c.endS + 30 <= T);
  injected += inj.length;
  injHeard += inj.filter(c => d.collusionLog.some(e => isPair(e, c) && e.t >= c.t0 && e.t <= c.endS + 30)).length;
  audible += d.collusionLog.length;
  matched += d.collusionLog.filter(e => d.swarm.injectedCollusions.some(c => isPair(e, c) && e.t >= c.t0 && e.t <= c.endS + 30)).length;
  for (const [k, v] of Object.entries(d.collusionSkips || {})) skips[k] = (skips[k] || 0) + v;
}
console.log(`end to end (page defaults, ${E2E_SEEDS} seeds x ${T}s):`);
console.log(`  injected per 5min ${(injected / E2E_SEEDS / (T / 300)).toFixed(2)}, audible per 5min ` +
  `${(audible / E2E_SEEDS / (T / 300)).toFixed(2)}, audible matching an injection ${pct(matched, audible || 1)}`);
console.log(`  injections that became audible: ${pct(injHeard, injected)}`);
console.log(`  finding-bars not rendered, by reason: ${JSON.stringify(skips)}`);
