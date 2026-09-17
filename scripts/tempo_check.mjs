// tempo_check.mjs -- what the tempo arc (M3) does, and whether variable bar lengths broke timing.
//
//   node scripts/tempo_check.mjs [seeds=40] [secondsPerSeed=900]
//
// Tempo behaviour: distribution of chorus tempos, how often it changes, step sizes, time spent
// pinned at the limits, and how closely tempo follows log(throughput / usual) -- the rule's input.
// Timing integrity, from Director's own output: every bar starts where the previous one ended;
// every bar inside a chorus has that chorus's length; walking-bass and solo notes sound inside
// their own bar; nothing is scheduled earlier than an eighth-note push before its bar.
import { readFileSync } from "node:fs";
import { Director } from "../web/director.js";
import { CHORD_VOICE_ORDER, COMP_VELOCITY } from "../web/engine.js";

const SEEDS = Number(process.argv[2] || 40);
const T = Number(process.argv[3] || 900);
const corpus = JSON.parse(readFileSync(new URL("../web/corpus_model_jazz.json", import.meta.url)));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
const corr = (xs, ys) => {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};

const tempos = [], steps = [], logRatio = [], offset = [];
let changes = 0, pinned = 0, decisions = 0;
let barGaps = 0, badBarLen = 0, bars = 0, stray = 0, notes = 0, early = 0, compChords = 0, compOff = 0;
const firstChange = [];
const COMP_VELS = new Set();
for (const a of [0, 22]) for (const b of [0, 14]) for (const c of [0, 10]) COMP_VELS.add(COMP_VELOCITY + a + b + c);
for (let seed = 1; seed <= SEEDS; seed++) {
  const d = new Director(corpus.root_transition_matrix_major, {
    seed, performerIntervals: corpus.performer_interval_distributions,
  });
  const barStarts = [], ev = [];
  d.onChordChange = (c) => barStarts.push(c.t);
  d.onScheduleNote = (v, n, vel, dur, at) => ev.push([v, at, dur, vel]);
  d.fillUntil(T);
  // tempo behaviour
  let prev = 96, sawChange = false;
  for (const e of d.tempoLog) {
    decisions++;
    tempos.push(e.bpm);
    if (e.bpm !== prev) { changes++; steps.push(Math.abs(e.bpm - prev)); if (!sawChange) { firstChange.push(e.t); sawChange = true; } }
    if (e.bpm === 76 || e.bpm === 120) pinned++;
    logRatio.push(Math.log(e.rate / e.usual)); offset.push(e.bpm - 96);
    prev = e.bpm;
  }
  // timing integrity: bar lengths come from consecutive bar starts
  const lens = [];
  for (let i = 1; i < barStarts.length; i++) lens.push(barStarts[i] - barStarts[i - 1]);
  for (let i = 0; i < lens.length; i++) {
    bars++;
    if (lens[i] <= 0) barGaps++;
    // inside one chorus (16 bars) every bar has the same length
    if (i % 16 !== 15 && i + 1 < lens.length && (i + 1) % 16 !== 0 && Math.abs(lens[i + 1] - lens[i]) > 1e-9) badBarLen++;
  }
  const barOf = (t) => { let lo = 0, hi = barStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (barStarts[m] <= t + 1e-9) lo = m; else hi = m - 1; } return lo; };
  for (const [v, at] of ev) {
    notes++;
    const b = barOf(at);
    const len = lens[Math.min(b, lens.length - 1)];
    if (at < barStarts[0] - 1e-9) early++;
    // an eighth-note push (plus a drift lag) may start a comp chord just before its bar; the
    // walking bass and the solo must sit inside the bar they were written for
    if ((v === "bass" || v === "melody") && barStarts[b + 1] !== undefined && at >= barStarts[b + 1] - 1e-9) stray++;
  }
  // sustained comp chords: each attack sits on a bar start, or an eighth note before one (the
  // push), give or take the drift onset lag (<= 45ms). Either tempo's eighth is accepted at a
  // chorus boundary, since the push is decided with the tempo of the bar being written.
  // (comp chords are told apart from long per-span notes by their velocity: COMP_VELOCITY plus
  // some combination of the form-top, cadence and push accents)
  // and by company: a comp chord is at least three voices attacking within the drift lag.
  const cand = ev.filter(([v, at, dur, vel]) => CHORD_VOICE_ORDER.includes(v) && dur > 1 && COMP_VELS.has(vel))
    .sort((x, y) => x[1] - y[1]);
  const comp = cand.filter(([, at], i) => {
    let k = 0;
    for (let j = i - 6; j <= i + 6; j++) if (j !== i && cand[j] && Math.abs(cand[j][1] - at) <= 0.046) k++;
    return k >= 2;
  });
  for (const [v, at, dur, vel] of comp) {
    compChords++;
    const ok = barStarts.some((b0, i) => {
      if (Math.abs(at - b0) > 1.0) return false;
      if (at - b0 >= -1e-9 && at - b0 <= 0.046) return true;
      const eighths = [lens[i - 1], lens[i]].filter(Boolean).map(l => l / 8);
      return eighths.some(e => Math.abs((b0 - at) - e) <= 0.046 || (at - (b0 - e) >= -1e-9 && at - (b0 - e) <= 0.046));
    });
    if (!ok) compOff++;
  }
}
const minutes = SEEDS * T / 60;
console.log(`chorus tempos: min ${Math.min(...tempos)} p10 ${q(tempos, 0.1)} median ${q(tempos, 0.5)} p90 ${q(tempos, 0.9)} max ${Math.max(...tempos)}`);
console.log(`changes per 5 min ${(changes / minutes * 5).toFixed(2)} (of ${decisions} chorus decisions); step size median ${q(steps, 0.5)} max ${Math.max(...steps)}; ` +
  `decisions pinned at 76/120: ${(100 * pinned / decisions).toFixed(1)}%; first change median ${q(firstChange, 0.5)?.toFixed(0)}s`);
console.log(`correlation of tempo offset with log(throughput / usual): ${corr(logRatio, offset).toFixed(3)} (n=${logRatio.length})`);
console.log(`timing: ${bars} bars, non-increasing bar starts ${barGaps}, uneven bars inside a chorus ${badBarLen}; ` +
  `${notes} notes, bass/solo notes outside their bar ${stray}, notes before the first bar ${early}; ` +
  `sustained comp attacks off the bar/push grid ${compOff} of ${compChords}`);
