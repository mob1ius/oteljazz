// director_fingerprint.mjs -- a seed-reproducibility fingerprint of web/director.js's output.
//
// Director never touches Tone (it only calls onScheduleNote/onSpanLine/onChordChange), so it runs
// headless here. Every callback's arguments are hashed in call order; two runs with the same seed
// must print the same hash. Use it before and after any change: a UX-only change must leave the
// hash byte-identical, a musical change should move it on purpose.
//
//   node scripts/director_fingerprint.mjs [seed=12345] [fillToS=300] [stepS=0]
//
// stepS > 0 mimics the page's rolling fill (fillUntil(t + LOOKAHEAD_S) every stepS seconds, then
// one final fill to fillToS). Measured identical to a single fill at 0.5/7/13s steps, so the
// trim path in fillUntil doesn't change the stream.
//
// Blind spot: app.js. Station drift moves the tuning filter from app.js, which this can't see; it
// is seeded separately (see app.js's startStationDrift) and logged in __oteljazzDebug().stationDrift.
//
// Baselines. v1.4.1 and v1.5.0 (b1cc4f8, af19b72; Director unchanged between them):
//   seed 12345, 300s  -> 2509 notes  06ee7cfba6d753cc
//   seed 99,    300s  -> 2230 notes  18aa25a55556152e
//   seed 12345, 1800s -> 14497 notes c716b5001eece049
// v1.5.1 (live-only fixes): identical to the above.
// v1.6.0, after M1 (detected latency drift; SwarmEngine injection changes its draws, the anomaly roll lost
// "drift" and stands down while a drift finding is pending, so every hash moved on purpose).
// Incremental fills at 0.5s and 13s steps match:
//   seed 12345, 300s  -> 2393 notes  c1bff30dbc4deab7
//   seed 99,    300s  -> 2090 notes  0ab894fe218058c1
//   seed 12345, 1800s -> 13661 notes 722f12338e98a7e9
// v1.6.1 (audio follows the displayed key; note counts, timing and velocity unchanged, only
// pitches moved):
//   seed 12345, 300s  -> 2393 notes  13d96707a6d0ba6b
//   seed 99,    300s  -> 2090 notes  87394a0b1d2a6786
//   seed 12345, 1800s -> 13661 notes be75aadc22e8f7f1
// v1.7.0 (M2: the solo line has its own random stream and is a port of the Python solo). The
// "everything else" hash was first taken with the OLD solo moved onto its own stream, then held
// unchanged through the rewrite, so the new solo provably moved nothing else:
//   seed 12345, 300s  -> 2047 notes  ba38d9a8582fab56  (everything else 8d4c5cbe)
//   seed 99,    300s  -> 1821 notes  2ebf79942d7651ca  (everything else 193b8dee)
//   seed 12345, 1800s -> 11324 notes 1ff809d161f18837  (everything else 09914836)
// v1.8.0 (M3 tempo arc). Variable bar lengths were first added with the tempo held at 96 and
// reproduced the v1.7.0 hashes above exactly; then the tempo rule moved everything on purpose:
//   seed 12345, 300s  -> 1632 notes  0f74400d5b6fd92d
//   seed 99,    300s  -> 1871 notes  17219ffa5b336f2e
//   seed 12345, 1800s -> 10225 notes d8ea1f66642d9b49
// v1.9.0 (M4 live lead-voice assignment): identical to v1.8.0 -- the synthetic swarm's first
// agent is its orchestrator, which is exactly who the old name check picked.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Director } from "../web/director.js";

const LOOKAHEAD_S = 24;
const seed = Number(process.argv[2] || 12345);
const until = Number(process.argv[3] || 300);
const step = Number(process.argv[4] || 0);

const corpus = JSON.parse(readFileSync(new URL("../web/corpus_model_jazz.json", import.meta.url)));
const d = new Director(corpus.root_transition_matrix_major, {
    seed, performerIntervals: corpus.performer_interval_distributions,
  });
const h = createHash("sha256");
// Per-part hashes as well, so a change meant for one part can prove it left the others alone.
const melodyH = createHash("sha256"), restH = createHash("sha256");
let notes = 0;
d.onScheduleNote = (...a) => {
  const j = JSON.stringify(a);
  h.update(j);
  (a[0] === "melody" ? melodyH : restH).update(j);
  notes++;
};
d.onSpanLine = (s) => { h.update("S" + JSON.stringify(s)); restH.update("S" + JSON.stringify(s)); };
d.onChordChange = (c) => { h.update("C" + JSON.stringify(c)); restH.update("C" + JSON.stringify(c)); };

if (step > 0) for (let t = 0; t + LOOKAHEAD_S < until; t += step) d.fillUntil(t + LOOKAHEAD_S);
d.fillUntil(until);
console.log(`seed ${seed}  ${until}s  ${notes} notes  ${h.digest("hex").slice(0, 16)}` +
  `  (melody ${melodyH.digest("hex").slice(0, 8)}, everything else ${restH.digest("hex").slice(0, 8)})`);
