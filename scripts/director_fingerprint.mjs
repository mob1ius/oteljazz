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
// After M1 (detected latency drift; SwarmEngine injection changes its draws, the anomaly roll lost
// "drift" and stands down while a drift finding is pending, so every hash moved on purpose).
// Incremental fills at 0.5s and 13s steps match:
//   seed 12345, 300s  -> 2393 notes  c1bff30dbc4deab7
//   seed 99,    300s  -> 2090 notes  0ab894fe218058c1
//   seed 12345, 1800s -> 13661 notes 722f12338e98a7e9
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Director } from "../web/director.js";

const LOOKAHEAD_S = 24;
const seed = Number(process.argv[2] || 12345);
const until = Number(process.argv[3] || 300);
const step = Number(process.argv[4] || 0);

const corpus = JSON.parse(readFileSync(new URL("../web/corpus_model_jazz.json", import.meta.url)));
const d = new Director(corpus.root_transition_matrix_major, { seed });
const h = createHash("sha256");
let notes = 0;
d.onScheduleNote = (...a) => { h.update(JSON.stringify(a)); notes++; };
d.onSpanLine = (s) => h.update("S" + JSON.stringify(s));
d.onChordChange = (c) => h.update("C" + JSON.stringify(c));

if (step > 0) for (let t = 0; t + LOOKAHEAD_S < until; t += step) d.fillUntil(t + LOOKAHEAD_S);
d.fillUntil(until);
console.log(`seed ${seed}  ${until}s  ${notes} notes  ${h.digest("hex").slice(0, 16)}`);
