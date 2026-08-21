# Supplementary data for "The Oversight Ensemble: A Jazz-Grounded Musical Grammar for Sonifying Multi-Agent AI Coordination"

OtelJazz Project (ORCID: REDACTED)

This deposit accompanies the paper's submission to the *Journal of the Audio Engineering Society*
(AES). It contains the rendered audio examples described in Section 4 ("Supplementary audio"),
the exported note-event data those renders were produced from, and the corpus model the harmonic
grammar (Section 3) is mined from. The paper's own code, and the exact commit this deposit
corresponds to, is archived separately via GitHub's Zenodo integration (see "Code availability"
below) — this deposit is data only.

## Audio (Table 1 correspondence)

All five files are rendered through the batch engine (`caidence.py`, Python/MIDI, played through
Logic Pro X with the Concert Grand and upright bass patches described in Section 4) at real,
un-sped-up tempo.

- `clean-run.m4a` — the clean run through intake, fan-out, and convergence. Real, not hand-tuned,
  telemetry: the mock swarm pipeline's own derived spans (`swarm.py --seed 0`), the same run
  plotted in Figure 3. 74.8s.
- `tier2-drift.m4a` — the goal-drift signature (Table 1, Tier 2): the target voice's attack
  trailing the shared onset grid, ramping to 45ms late, plus a secondary pitch-bend micro-cue.
  Excerpted from the hand-authored calibration trace at its documented injection timestamp
  (drift_start=12.0s, window=8.0s). 12.0s.
- `tier2-poisoned-spawn.m4a` — the poisoned-spawn signature: a chromatic wrong-note cluster
  right after an external tool-call ingestion point. Documented injection timestamp ~9.6s. 4.0s.
- `tier2-stall.m4a` — the silent-failure/stall signature: a chord voice's permanent dropout after
  its agent goes quiet past the liveness window, audible as the full ensemble's thickness
  dropping from 5 to 4 voices at t=20.0s. 12.0s.
- `tier2-collusion.m4a` — the collusion signature: two independent voices (planner, worker1)
  locking into unexpected unison. Documented injection timestamp collusion_start=27.0s. 5.6s.

Consistent with the paper's own claims (Section 3, Section 4): the four Tier-2 examples are
scripted injections on a hand-authored calibration trace with known, documented timestamps, not
excerpted from the drift detector's own output. Drift alone now has a first-pass detector
(Section 5) computing onset lag directly from real span timing; the other three signatures
(collusion, poisoned spawn, silent failure/stall) remain scripted, with a detector an open
direction. None of these four excerpts are claimed to be real telemetry. The clean run is real
telemetry.

## Note-event data

JSON exports of the exact rendered note events (`caidence.py --export-events`), for the two
source traces the audio above was cut from:

- `clean-run-note-events.json` — full note-event export for the swarm seed-0 run (513 events),
  underlying `clean-run.m4a` and Figure 3.
- `anomaly-trace-note-events.json` — full note-event export for the hand-authored calibration
  trace (202 events), underlying all four Tier-2 excerpts.

Each entry carries `t` (onset, seconds), `voice` (physical chord-voice name), `note` (MIDI pitch),
`vel` (velocity), `dur` (duration, seconds), and `ch` (MIDI channel); a top-level `deviations`
array carries the continuous pitch-bend stream (drift's secondary micro-cue).

## Corpus model

- `corpus_model_jazz.json` — the harmonic model described in Section 4 ("Corpus and harmonic
  model"): a 12-degree chromatic root-transition matrix and a chord-quality distribution per
  root, mined from the Weimar Jazz Database's beat-synchronous chord annotations (Pfleiderer et
  al. 2017; ODbL license, https://jazzomat.hfm-weimar.de), 456 solos mined, 406 used after
  filtering (criteria stated in Section 4). This is the frozen model the prototype reads at
  runtime, not the raw database (which remains at the Jazzomat Research Project's own site under
  its own license).

## Code availability

The engine (`caidence.py`), the mock multi-agent pipeline (`swarm.py`), the live OTLP path
(`live.py`), the figure-generation script (`make_figures.py`), and everything else needed to
reproduce these renders is available at https://github.com/mob1ius/oteljazz, archived at the v1.0.0
release corresponding to this submission via Zenodo's GitHub integration: doi:10.5281/zenodo.22035239.

## License

This deposit (audio, note-event data, corpus model derivative) is released under CC BY 4.0. The
underlying Weimar Jazz Database is ODbL-licensed by the Jazzomat Research Project; the corpus
model here is a derived statistical summary, not a redistribution of the raw database.
