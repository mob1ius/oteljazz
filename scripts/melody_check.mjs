// melody_check.mjs -- what the browser's solo line actually does, measured from Director's own
// output (no audio). Used to compare the solo line before and after a change.
//
//   node scripts/melody_check.mjs [seeds=40] [secondsPerSeed=600]
//
// Reports, over seeds 1..N:
//   - density: melody notes per minute, overall and by how many agents were active in the bar
//     (the telemetry channel the solo is allowed to follow);
//   - harmony: share of notes whose pitch class is a tone of the chord shown at that moment;
//   - guide tones: share of notes on the chord's 3rd or 7th;
//   - contour: median and p90 size of the step between consecutive notes, counting only steps
//     between notes less than a bar apart (a new phrase after a rest may leap);
//   - register: lowest and highest note, and the share inside MELODY_REGISTER if exported;
//   - motif (when Director keeps a motifLog): how many phrases stated the motif and how, whether
//     every chorus-top phrase stated it exactly, and how many times it was renewed.
import { readFileSync } from "node:fs";
import { Director, BAR_S } from "../web/director.js";
import * as E from "../web/engine.js";

const SEEDS = Number(process.argv[2] || 40);
const T = Number(process.argv[3] || 600);
const corpus = JSON.parse(readFileSync(new URL("../web/corpus_model_jazz.json", import.meta.url)));
const PC = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const NAMES = ["Db", "Eb", "Gb", "Ab", "Bb", "C", "D", "E", "F", "G", "A", "B"];
const SUF = { maj7: "maj7", m7b5: "m7b5", m7: "min", "7sus4": "sus", dim7: "dim7", "+7": "aug", 7: "dom7", 6: "maj" };
const parse = (sym) => { const nm = NAMES.find(x => sym.startsWith(x)); return { root: PC[nm], q: SUF[sym.slice(nm.length)] }; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };

let notes = 0, inChord = 0, guide = 0, lo = 127, hi = 0, inRegister = 0;
const steps = [], perActivity = {};
const motif = { phrases: 0, kinds: {}, chorusTops: 0, chorusTopsExact: 0, renewals: 0, statements: 0, shapeKept: 0 };
const REG = E.MELODY_REGISTER;
const opts = { performerIntervals: corpus.performer_interval_distributions };
for (let seed = 1; seed <= SEEDS; seed++) {
  const d = new Director(corpus.root_transition_matrix_major, { seed, ...opts });
  const chords = [], mel = [], agentsByBar = {};
  d.onChordChange = (c) => chords.push({ t: c.t, ...parse(c.symbol) });
  d.onScheduleNote = (v, n, vel, dur, at) => { if (v === "melody") mel.push([at, n]); };
  d.onSpanLine = (l) => {
    if (l.service === "oversight-grammar" || l.service === "tempo") return;
    const b = Math.floor(l.t / BAR_S);
    (agentsByBar[b] ||= new Set()).add(l.service);
  };
  d.fillUntil(T);
  mel.sort((a, b) => a[0] - b[0]);
  let ci = 0, prev = null;
  for (const [at, n] of mel) {
    while (ci + 1 < chords.length && chords[ci + 1].t <= at + 1e-6) ci++;
    const c = chords[ci];
    notes++;
    const rel = (((n % 12) - c.root) % 12 + 12) % 12;
    const idx = E.JAZZ_CHORD_TONES[c.q].indexOf(rel);
    if (idx >= 0) inChord++;
    if (idx === 1 || idx === 3) guide++;
    lo = Math.min(lo, n); hi = Math.max(hi, n);
    if (REG && n >= REG[0] && n <= REG[1]) inRegister++;
    if (prev && at - prev[0] < BAR_S) steps.push(Math.abs(n - prev[1]));
    prev = [at, n];
    const act = Math.min(6, (agentsByBar[Math.floor(at / BAR_S)] || new Set()).size);
    perActivity[act] = (perActivity[act] || 0) + 1;
  }
  if (d.motifLog) {
    for (const m of d.motifLog) {
      if (m.event === "renew") { motif.renewals++; continue; }
      motif.phrases++;
      motif.kinds[m.kind] = (motif.kinds[m.kind] || 0) + 1;
      if (m.chorusTop) { motif.chorusTops++; if (m.kind === "exact") motif.chorusTopsExact++; }
      // Recognisability: do the statement's sounding notes move in the same directions as its
      // shape (up / down / repeat between consecutive chord-tone offsets)?
      if (m.shape) {
        const i0 = mel.findIndex(([at]) => at >= m.t - 0.2);
        const played = mel.slice(i0, i0 + m.shape.length).map(([, n]) => n);
        if (played.length === m.shape.length) {
          motif.statements++;
          const sign = (x) => Math.sign(x);
          const same = m.shape.slice(1).every((off, k) => sign(off - m.shape[k]) === sign(played[k + 1] - played[k]));
          if (same) motif.shapeKept++;
        }
      }
    }
  }
}
const minutes = SEEDS * T / 60;
const pct = (x, n) => `${(100 * x / n).toFixed(1)}%`;
console.log(`notes/min ${(notes / minutes).toFixed(1)}; by active agents in the bar: ` +
  Object.entries(perActivity).map(([k, v]) => `${k}:${v}`).join(" "));
console.log(`in the shown chord ${pct(inChord, notes)}, on a guide tone (3rd/7th) ${pct(guide, notes)}`);
console.log(`step size within a phrase: median ${q(steps, 0.5)}, p90 ${q(steps, 0.9)} semitones (n=${steps.length})`);
console.log(`register ${lo}..${hi}` + (REG ? `, inside ${REG[0]}..${REG[1]}: ${pct(inRegister, notes)}` : ""));
if (motif.phrases) {
  console.log(`phrases ${motif.phrases}: ${JSON.stringify(motif.kinds)}; chorus-top phrases stated exactly ` +
    `${motif.chorusTopsExact}/${motif.chorusTops}; motif renewals ${motif.renewals}`);
  console.log(`motif statements whose notes keep the shape's up/down pattern: ` +
    `${motif.shapeKept}/${motif.statements} (${pct(motif.shapeKept, motif.statements)})`);
}
