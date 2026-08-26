# Changelog

## v1.1.0 — 2026-08-26

Corrects a result. The v1.0.0 archive should not be used to reproduce the accompanying
paper's Section 4.

### Retracted

**Tempo and ensemble thickness are not independent channels.** v1.0.0 and the earlier
draft of the paper claimed they were, on the strength of four hand-picked seeds. A
1000-seed sweep shows the change in tempo and the change in thickness correlate at
**r = +0.735 [0.705, 0.762], r² = 0.54** — the two share about half their variance. In
hindsight this should have been expected: a busier swarm raises span arrival rate and
live-agent count together, and calling them independently driven confused separate
attributes with separate processes.

What survives is weaker and still sufficient: the channels are **correlated but not
redundant**. Among the 771 runs whose tempo ends at the clamp floor, thickness still
ranges over 3–7 voices, with variance 1.29 against 1.67 across all 1000 runs — knowing
tempo has bottomed out narrows thickness very little. A channel with no residual
information would be decoration; this one has some.

### Added

- `engine/seed_sweep.py` — the sweep behind the correction. Deterministic (seeds
  `0..n-1`, one run each), goes through `caidence.py --export-events` rather than
  reimplementing the mapping, and reports Pearson r with a Fisher-z interval, Wilson
  intervals on every proportion, and the conditional-variance figures. Reruns are
  byte-identical.

  ```
  python3 engine/seed_sweep.py --n 1000 --out seed_sweep_1000.json
  ```

  Note the guard it prints: the conditional variance retained under a bottomed-out
  tempo (77%) is **not** 1 − r² (46%). They are different quantities and an earlier
  draft conflated them.

### Fixed

- `engine/make_figures.py` — panel C of the channels figure was titled "ensemble
  thickness does NOT return: the channels are independent". It now reads "thickness does
  not follow tempo down (r = 0.74 over 1000 seeds)". Regenerating the figure from
  v1.0.0 reproduces the retracted claim; regenerating from v1.1.0 does not.

### Unchanged

`caidence.py`, `drift_detect.py` and `swarm.py` differ from v1.0.0 in comments only, and
`corpus_model_jazz.json` is byte-identical. The engine that produced the sweep is the
engine that was archived — only the analysis script and one figure title are new.

## v1.0.0 — 2026-08-20

Initial release. Retire cAIdence as the project name; OtelJazz is correct throughout.
