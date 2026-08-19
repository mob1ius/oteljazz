# Adversarial Peer Review: "The Oversight Symphony" (Organised Sound submission)

Run via the `academic-research-skills` `academic-paper-reviewer` skill, full mode (v3.6.2 sprint-contract
protocol: 5-reviewer panel, EIC + Methodology + Domain + Perspective + Devil's Advocate, each run as a
paper-content-blind Phase 1 pre-commitment followed by a paper-visible Phase 2 review). Reviewed the paper
as reframed for Organised Sound (jazz-grounded musical grammar as primary contribution, AI-oversight as
motivating application only). Manuscript version reviewed: the version committed after the Organised Sound
reframe, ~6,450 words body+references.

## Panel-level mechanical decision

Per the sprint contract's `reviewer/reviewer_full/v1` template and its 3-step synthesizer protocol
(scoring matrix -> failure-condition evaluation -> severity/ordinal precedence):

| Dimension (priority) | EIC | R1 Methodology | R2 Domain | R3 Perspective | DA |
|---|---|---|---|---|---|
| D1 methodology_rigor (mandatory) | pass | warn | warn | pass | warn |
| D2 domain_accuracy (mandatory) | warn | warn | warn | warn | **block** |
| D3 argumentative_coherence (mandatory) | warn | warn | warn | warn | warn |
| D4 cross_disciplinary_relevance (high) | pass | warn | pass | warn | warn |
| D5 writing_and_structure (normal) | warn | pass | pass | pass | warn |

Failure conditions evaluated:
- **F1 (severity 90, "any mandatory dimension scores block") -> FIRED.** DA scored D2 `block`.
- **F2 (severity 70, "two or more mandatory dimensions score warn or worse", majority quantifier) -> FIRED.** All 5 reviewers individually had ≥2 mandatory dimensions at warn-or-worse (5/5 ≥ the majority threshold of 4/5).
- F3 (severity 60, "any high-priority dimension scores block") -> not fired. D4 never scored block.
- F0 (severity 10, "every mandatory dimension scores pass", all quantifier) -> not fired.

Highest-severity fired condition: **F1 (90) -> `editorial_decision = reject_or_major_revision`.**

**Editorial resolution of the disjunction: Major Revision, not Reject.** The contract's F1 action is
deliberately a disjunction the synthesizer must resolve with judgment, not arithmetic. Every reviewer,
including the Devil's Advocate, frames every finding (including the one CRITICAL) as correctable without
new data collection, a new prototype, or narrowing the paper's scope — a wording fix, a citation fix, or a
stated design response. The Devil's Advocate's own closing text: *"C2 is straightforwardly fixable... C1
is not a wording fix. It requires either evidence that per-voice deviation survives fusion, a redesign
that encodes drift in a fusion-surviving dimension, or an honest retreat from tuning as an oversight
channel."* That is a substantive, scoped revision demand, not evidence the paper's core contribution is
unsalvageable. Per `editorial_decision_standards.md`, Reject is reserved for "fundamental unfixable
issues"; this is not that.

## Decision: Major Revision

### Points of consensus ([CONSENSUS-5], all reviewers independently agree)

- **The paper's claim discipline is genuinely unusual and should not be sanded down in revision.** Every
  reviewer, unprompted, singled out the same passages: the abstract's closing disclaimer, Section 4's
  "mapping fidelity is a property of the system, not a listener," the Tier 1/Tier 2 split in Table 1, and
  Section 6's unhedged concession on the vigilance decrement. This is the paper's strongest asset across
  all five independent reads.
- **The central design move (fused harmonic object over one-voice-per-agent, forced by an unbounded
  population) is a real, transferable design contribution**, distinct from and better-argued than the
  AI-safety framing around it.
- **Something is materially wrong with the paper's claim that per-agent state (tuning, thickness) is
  cleanly recoverable from a chord engineered for fusion.** This is the single most load-bearing
  cross-reviewer convergence, found four independent ways:
  - DA (CRITICAL, D2 block): mistuning inside an engineered-fusion chord is heard as roughness/souring of
    the object, not a localized voice event; the choir analogy covers thickness loss, not intonation.
  - R2 (D3 warn): "the fusion commitment and the anomaly channel pull in opposite directions... the choir
    analogy does not hold... losing one [voice] is much closer to Huron's denumerability task."
  - R3 (D3 warn): "ensemble thickness carries live agent count" is contradicted by the paper's own
    numbers (1 agent -> 4 voices, 4 agents -> 6 voices, seed 42 -> 7 voices for the same phase).
  - R1 (D3 warn): the fusion prediction is "well grounded in Bregman's cue theory and is probably right;
    it is still a prediction," flagged as an unproven perceptual claim stated as achieved fact.
- **The abstract overstates what Table 1 documents.** The abstract's "telemetry drives... a set of
  adversarial signatures... rendered as specific musical events" reads, on a first pass, as though Tier 2
  is telemetry-driven; Table 1 and Section 5 both state plainly that Tier 2 has no detector and is
  hand-injected. Found independently by DA (as CRITICAL C2) and R1 (as an internal contradiction between
  Section 3's "scripted injections on hand-authored spans" and Section 4's "real (not hand-tuned)
  telemetry").
- **No number in the paper is independently checkable.** No repository, DOI, or artifact statement; the
  promised supplementary audio has no location or per-example identifiers. Raised independently by EIC,
  R1, and R2.

### DA CRITICAL findings (required by protocol to appear here regardless of EIC agreement)

**C1 (D2, block).** Per-voice pitch deviation ("tuning") is claimed perceptible without decomposing the
fused chord object, warranted only by a choir-losing-its-tenors analogy that licenses thickness/register
loss, not intonation of one voice inside a chord deliberately engineered (shared timbre, shared onset,
voice-led motion) to withhold segregation cues. Goal drift, Tier 2's first row and the paper's own
"the point," depends on this. **Corroboration: substantial** — R2 independently identified the same
fusion/detection tension via Huron (1989) on voice denumerability in homogeneous-timbre polyphony; R3
independently found the adjacent claim (thickness = agent count) contradicted by the paper's own figures;
R1 independently flagged the fusion-to-decodability inference as an unproven prediction stated as fact.
**EIC assessment:** valid and correctly scored as the panel's most serious finding. It does not require
rejecting the paper's design, but it does require the paper to either supply psychoacoustic support for
per-voice detectability inside deliberate fusion, redesign the drift signature to use a fusion-surviving
cue (onset offset, attack envelope, vibrato — as DA's own "Ignored Alternative Explanations" suggests), or
explicitly downgrade "tuning" from a claimed-detectable channel to a design intuition awaiting the Section
5 listening study. **Required author response:** one of the three paths above, stated explicitly, not a
wording softener.

**C2 (D5/D1, contributing to F1's dimension but not itself block-scored).** Abstract vs. Table 1
inconsistency on whether Tier 2 is telemetry-driven. **Corroboration: strong** — R1 found the same
underlying inconsistency from a different angle (Section 3 vs. Section 4 on Tier 2 audio provenance).
**EIC assessment:** valid, and the more mechanically simple of the two CRITICAL items — a rewrite of one
abstract clause and one Architecture-paragraph clause resolves it. **Required author response:** align the
abstract's language with Table 1's own "rendered... currently injected" framing; do not let the abstract
imply detection where only rendering exists.

### Points of disagreement

- **EIC and R3 scored D1 `pass`; R1, R2, and DA scored it `warn`.** Not a genuine disagreement on the
  facts — all five reviewers cite the same underlying issues (self-generated/self-judged evidence,
  n=1-then-4-seeds of one hand-authored pipeline, no artifact deposit). The split is in dimension
  ownership: EIC and R3 filed several of these findings under D5 (writing/structure) or D4 (their own
  dimensions) rather than D1. **Editor's resolution:** treat as consensus on the underlying facts with a
  scoring-boundary difference, not as a substantive split. The Revision Roadmap below is organized by
  finding, not by which reviewer's column it landed in.
- **R1 alone flagged internal numeric contradictions (tempo range 60-160 vs. 68-132 BPM; corpus counts 406
  solos / 406 recordings / 456 solos) as independently warn-triggering under D2.** Other reviewers noted
  one or the other but not both in combination. **Editor's resolution:** both are real, both are simple
  fixes (reconcile to single figures), and are folded into the roadmap as Priority 3 items despite R1's
  more severe framing, since none of the other four reviewers treated them as load-bearing.
- **No reviewer disagreement on the overall decision.** All five independently landed on Major Revision or
  the more severe reject_or_major_revision (DA, forced by protocol once a block fires). No reviewer
  recommended Accept or Minor Revision.

---

## Revision Roadmap

### Priority 1 — Must fix (blocks re-review passing)

1. **[DONE 2026-08-18]** Resolved by redesign (option b), not citation-defense or downgrade: goal-drift's
   primary signature is now a per-voice onset lag (implemented in `caidence.py`, see BUILD_NOTES.md),
   which violates the shared-onset-grid cue the chorale's fusion depends on directly, rather than a pitch
   cue fusion is built to withhold. Paper text (abstract, Section 3 body, Figure 2 caption, Table 1,
   Section 7) updated to describe synchrony/onset-lag as the claimed-audible property instead of "tuning."
   The pitch bend is kept only as a secondary micro-cue, explicitly demoted in the text.
2. **[DONE 2026-08-18]** Abstract rewritten: Tier 2 signatures are now explicitly "layered on as scripted
   musical events rather than detected from telemetry (a detector is future work)," matching Section 3/4/5.
3. **[DONE 2026-08-18]** Section 3's thickness paragraph now states the floor (2 always-on harmonic-rhythm
   voices), the ceiling (pool saturation), and that thickness is ordinal, not a count a listener could
   subtract back out to an exact number, framed as a deliberate compression that keeps the audible stream
   count near the three-or-four-object limit. Conclusion's parallel claim softened to match.
4. **[DONE 2026-08-18]** Huron (1989), "Voice Denumerability in Polyphonic Music of Homogeneous Timbres,"
   *Music Perception* 6(4), added as reference [25] and cited alongside Bregman [5] at both stream-capacity
   claims (Section 1, Section 3); Bregman kept for the general fusion/segregation mechanism, Huron for the
   specific numeric capacity and its homogeneous-timbre degradation.
5. **[DONE 2026-08-18]** Abstract's opening claim narrowed from "sonification target" to "musification
   target," matching Section 1's already-correct scoping, with an explicit sentence acknowledging that
   sonifying unbounded behaviorally-defined populations (e.g. network-security sonification) is not new —
   what's new is rendering it as musical texture rather than a signature/alert.
6. **[DONE 2026-08-18]** `stop_reason` replaced with `gen_ai.response.finish_reasons` (the real OTel GenAI
   semconv attribute) in Table 1 and the Key Calibration Discoveries paragraph. **Not done**: the
   in-flight-span-state-before-span-end premise question and the mock-emitter-only measurement caveat —
   still open, needs its own pass.

### Priority 2 — Should fix (strengthens the paper materially)

7. **[DONE 2026-08-18]** Tempo range fixed to 68-132 BPM in Section 3 (was 60-160, stale relative to
   `swarm.py`'s actual `TEMPO_MIN, TEMPO_MAX = 68, 132`, which Table 1 and Figure 1 already matched).
   Corpus-count wording standardized to "406 solos used after filtering" in Section 3, matching the
   abstract and Section 4's existing 456-total/406-used explanation — this was a terminology mismatch
   (solos vs. recordings), not an actual numeric contradiction, once Section 4 is read closely.
8. Specify the mapping as functions, not just channel names (R1): ranges, transfer functions, window
   lengths, and boundary behavior for each Table 1 row; add the solo line and motif, currently undescribed
   in the table despite being called telemetry-responsive in prose.
9. Deposit code, corpus model, exported note events, and the promised audio examples at a persistent,
   resolvable location with per-example identifiers keyed to Table 1 rows (EIC, R1, R2, R3 — the single
   most independently-repeated finding across the panel).
10. State the pitch-space convention (absolute vs. tonic-relative) and the self-transition policy for the
    root-transition-matrix verification claims, and clarify which Weimar Jazz Database layer (solo
    transcription vs. beat/chord annotation) actually supplied the harmonic model (R2).
11. State the voice-allocation/pool-slot arithmetic explicitly (R1, R3): how one live agent yields four
    voices, how the 3-worker-slot pool relates to the `--fanout` axis in Figure 3, and whether Figure 1's
    flagship demonstration ran at or past the measured saturation ceiling.
12. Address deployment realities in a paragraph or two (R3): who the overseer concretely is and what they
    do on detection; accessibility for d/Deaf and hard-of-hearing readers, framed as a supplementary-not-
    sole-channel scope statement; what pool-saturation thrash sounds like, given 415.9 forced voice-slot
    reassignments/minute at fanout 32 plausibly being audible as instability rather than silently absorbed.
13. Add the field-level and comparative citations R2 identifies as genuinely missing: Gaver, Smith & O'Shea
    on the ARKola continuous-auditory-monitoring study (directly relevant to and complicating the
    stream-limit argument); a taxonomic anchor beyond the 1999 ICAD report (Hermann's Sonification
    Handbook/taxonomy work); Broze & Shanahan on jazz-harmony corpus work specifically, since WJD's primary
    layer is solo transcription not harmony; Pearce & Wiggins in place of Gjerdingen for the
    statistical-learning claim (Gjerdingen concerns 18th-century schemata, not statistical learning).
14. Correct the threshold-alert rebuttal in Section 6 (R3, DA): "a thinned ensemble" is Tier 1 and
    threshold-expressible; swap in the measured tempo/thickness convergence dissociation, which genuinely
    has no single crossing value and is measured rather than asserted.

### Priority 3 — Nice to fix (text/formatting, does not gate re-review)

15. Renumber figures to match order of first mention (Figures 2 and 3 appear in Section 3, Figure 1 in
    Section 4).
16. Mark Figure 2 explicitly as a design schematic rather than a measurement, and rewrite its caption out
    of the achieved-fact register ("the listener's load is approximately three concurrent objects" is a
    prediction, not a result).
17. Add polarity/range columns to Table 1 rows beyond tempo.
18. Complete reference apparatus (venue/access route missing for [7], [8], [10], [12]-[15], [24]).
19. State the corpus filtering criterion (456 -> 406 solos) and give a run count/central tendency for the
    completion-latency figures (1.8-8.2s -> 0.8-3.2s) rather than a bare range.

---

## Full reviewer reports

The complete text of all five Phase 1 (blind pre-commitment) and Phase 2 (paper-visible) reviewer
outputs — EIC, Methodology (R1), Domain (R2), Perspective (R3), and Devil's Advocate — including every
dimension score, justification, full narrative review body (strengths/weaknesses/detailed comments/
questions for authors/minor issues), and per-reviewer editorial decision, are preserved in this session's
transcript. This file carries the synthesized decision and roadmap; ask if you want the full per-reviewer
narrative reports written out to a companion file as well.

## Note on scope

This review was run against the paper as reframed for Organised Sound (grammar/systems paper, AI-oversight
as motivating context only). It supersedes the ICAD-shaped review rounds from earlier in this project's
history (see `BUILD_NOTES.md` and the paper's own working notes) — those addressed a different claimed
contribution and are not comparable to this panel's findings.
