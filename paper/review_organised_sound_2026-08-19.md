# Second-round adversarial review — "The Oversight Symphony"

Full 5-reviewer sprint-contract protocol (EIC, Methodology, Domain, Perspective, Devil's Advocate),
each run as a genuinely blind Phase 1 (paper-content-blind pre-commitment) followed by a
paper-visible Phase 2 scoring pass, mirroring the first round's methodology
(`review_organised_sound_2026-08-18.md`). Run against the revised, submission-ready manuscript at
`paper/07-oversight-symphony-sonification.md` after the author-date citation conversion, the
onset-lag redesign, and the full Priority 1–3 roadmap pass from the first round.

## Panel-level mechanical decision

| Dimension | EIC | R1 (methodology) | R2 (domain) | R3 (perspective) | DA |
|---|---|---|---|---|---|
| D1 methodology_rigor (mandatory) | Pass (78) | Pass | Warn | Pass | **Block** |
| D2 domain_accuracy (mandatory) | Pass (85) | Pass | Pass | Pass | Warn |
| D3 argumentative_coherence (mandatory) | Pass (83) | Pass | Pass | Pass | **Block** |
| D4 cross_disciplinary_relevance (high) | Pass (80) | Pass | Pass | Pass | Pass |
| D5 writing_and_structure (normal) | Pass (80) | Warn | Warn | Warn | Pass |
| **Recommendation** | Minor Rev. | Minor Rev. | Minor Rev. | Minor Rev. | CRITICAL found |

**Failure conditions evaluated:**
- F1 (severity 90, any mandatory scores block, quantifier=any) — **FIRES**. DA scores both D1 and D3 block.
- F2 (severity 70, two-or-more mandatory dimensions score warn-or-worse, quantifier=majority) — does not fire. No mandatory dimension has a majority (≥3/5) of reviewers at warn-or-worse; D1's worst case is 2/5 (R2 warn, DA block).
- F3 (severity 60, any high-priority dimension blocks) — does not fire. D4 is Pass across all five reviewers.
- F0 (severity 10, every mandatory dimension passes, quantifier=all) — does not fire, blocked by DA's D1/D3.

Highest-severity fired condition: **F1**, mandating `reject_or_major_revision`.

## Decision: Major Revision

Resolved the disjunction toward Major Revision, not Reject, on the same basis as the first round:
the Reject bar (`editorial_decision_standards.md`) requires fundamental, unfixable issues, and the
DA's own report signals a text/citation-level fix may exist, not a redesign — see below.

**This round's finding is materially different in shape from the first round's, and that
difference matters for how much weight to put on it.** In the first round, three of four other
reviewers independently corroborated the CRITICAL finding from different angles before ever
seeing each other's work. This round, four of five reviewers (EIC, R1, R2, R3) independently
landed on Minor Revision with no blocks. EIC's W1 flags the *identical passage* DA is concerned
with (Section 3's "is heard as the object's own transient smearing, the same way the fusion
argument requires it to be") — but reads it as an overconfident-hedging problem ("states the
predicted outcome as an accomplished fact rather than a design intention"), not a coherence-
breaking contradiction, and explicitly scores D3 Pass (83) with the note that the paper's
connective tissue is "repeatedly makes its own connective tissue explicit." The DA's finding is
real and specific, not fabricated pattern-matching, but it is this round's *lone* block, not a
cross-corroborated one. Under the protocol's IRON RULE, a lone DA CRITICAL still forces the
decision away from Accept regardless of corroboration — that rule is followed here — but the
isolation is worth knowing before deciding how much revision effort to commit.

## The CRITICAL finding, in full

**DA's argument:** Section 3 claims the redesigned drift signature (a voice's onset lagging the
shared attack, up to 45ms, replacing the pitch-bend claim the first round's CRITICAL was about)
"registers at the object level by construction, not by decomposition" — stated as a logical
entailment, not a hypothesis. DA's counter: onset asynchrony is not psychoacoustically neutral
once violated; DA cites Darwin's "captor tone" experiments and Rasch (1978) on ensemble onset
asynchrony as finding that a component whose onset lags a simultaneity by roughly 30–50ms is
"captured" out and heard as a distinct, individuated event — the opposite of object-level
smearing. The paper's 45ms maximum lag falls inside that range. DA also finds an internal
inconsistency: the paper's own logic elsewhere ("[the solo line and bass are] segregable
precisely because they violate the fusion cues that bind it," Section 3) says violating a fusion
cue produces segregation; applied consistently, that sentence would predict the drift voice
segregates too, contradicting the "registers at the object level" claim two paragraphs away. DA
explicitly notes the paper never cites the asynchrony-specific literature that would let it argue
a *slow ramp* to 45ms behaves differently from the *abrupt* onset offsets that literature tests —
an argument DA says could exist, but isn't made.

**⚠️ Verification needed before acting on this**: DA's argument rests on two specific citations
(Darwin's captor-tone work, Rasch 1978) that were not independently verified against a real
source in this review — check they exist and say what's claimed before committing a revision
strategy to them. This is exactly the kind of unverified-citation risk the review protocol itself
warns about, and it applies to the reviewer's own citations here as much as to the paper's.

**Two honest paths forward, neither requiring new code or a listener study:**
1. **Engage the literature and argue the slow-ramp distinction.** If a real asynchrony-onset
   citation supports that a *gradual* ramp to a threshold behaves differently from an *abrupt*
   onset offset (plausible — capture effects in the literature are typically tested with step
   changes, not ramps), cite it and make that argument explicit in Section 3.
2. **Downgrade to a hypothesis with both outcomes treated as viable.** Rewrite the claim to
   acknowledge that onset-lag might produce either object-level smearing (as currently claimed) or
   voice capture/individuation (per DA's cited mechanism) — and note that *either* outcome still
   serves the paper's actual oversight goal (the anomaly becomes salient one way or another), so
   the paper doesn't need to resolve which one occurs, only stop asserting it knows. This is
   consistent with how the paper already handles the completion-latency numbers ("we report these
   as the ranges observed during development, not a claim of statistical central tendency") — the
   same hedge register, applied to this one remaining unhedged claim.

Path 2 is lower-risk and doesn't depend on verifying DA's citations first; Path 1 is stronger if
the citations check out.

## Points of consensus

- **[CONSENSUS-4]** The prior round's citation-accuracy fixes (Bregman/Huron split,
  `stop_reason`→`gen_ai.response.finish_reasons`) are completely resolved. R2 and R3 both
  independently re-verified every instance and found zero remaining errors.
- **[CONSENSUS-4]** D2, D3 (outside the DA's specific block), and D4 are solid — all four other
  reviewers passed all three without reservation.
- **[CONSENSUS-3]** Prose density is a real, if minor, issue. R1, R2, and R3 independently flagged
  long, heavily subordinate-claused sentences (especially the abstract and Section 3) as costing
  readability for part of the target audience — this is a D5 Warn across three reviewers, though
  never rising to Block.
- **[CONSENSUS-2]** Figure numbering doesn't match figure filenames (Figure 1 = `fig2_perceptual.pdf`,
  Figure 2 = `fig3_saturation.pdf`, Figure 3 = `fig1_channels.pdf`), and Figure 3 is discussed in
  prose before Figure 2 is displayed. R1 and DA both independently caught this; R1 confirmed the
  actual files exist and are current, so it's a labeling artifact from section reordering, not a
  missing artifact.

## Points of disagreement

- **EIC vs. DA on Section 3's onset-lag claim** — detailed above. Same passage, different verdicts
  (hedging-language issue vs. coherence-breaking contradiction).
- **R1 vs. abstract/conclusion on the "independent channels" claim's scope.** R1 (alone) found
  that the headline claim — tempo returns while thickness doesn't, "showing the two channels carry
  independent information" — is stated unscoped, but only cleanly holds for the seed-0 run
  discussed in detail; at seed 42, thickness *decreases* from its own opening value (7→5-6),
  moving the same direction as tempo, which is closer to the "one signal twice" pattern the paper
  itself says would carry less information. Not caught by EIC, R2, or R3. Worth a look — R1's
  citation of specific numbers (seed 42: 7 voices opening, 5–6 at convergence) is checkable
  directly against the paper's own Section 4 text.

## Revision roadmap

### Priority 1 — must fix (gates re-review)

1. **Resolve the DA's onset-lag CRITICAL** (Section 3, the "registers at the object level by
   construction" passage and its neighbors) via Path 1 or Path 2 above. Verify DA's cited
   literature first if pursuing Path 1.
2. **Rescope the "independent channels" headline claim** (Abstract, Conclusion) to what the
   four-seed check actually shows, per R1's W1 — either scope explicitly to the seed-0 run, or
   state only the generalization the cross-seed data supports.
3. **Fix Table 1 row 5's source/transfer-function mismatch** (R1's W2): the bass walk-feel row
   lists `gen_ai.tool.name` presence as source but thresholds on activity level (row 6's variable),
   and Section 3's own prose never mentions tool-name presence for this row at all.

### Priority 2 — should fix (strengthens the paper materially)

4. Soften the two other unhedged perceptual-claim instances EIC flagged (W1) to match the paper's
   otherwise-consistent hedge register ("is designed to be heard as" / "should register as").
5. Address the saturation-regime design question EIC raised (W2): at fanout 32's 415.9
   reassignments/minute, does the voice-leading/crossing-suppression machinery still function, or
   does the grammar itself degrade? This is answerable from the existing architecture, no listener
   study needed.
6. Show the per-voice-class breakdown behind the 4-vs-6 intake/fan-out headline number (EIC's W3)
   rather than requiring the reader to reconstruct the tool-voice toggle from prose.
7. Source or explicitly flag the 45ms drift-lag threshold as an unvalidated, set-by-ear parameter
   (EIC's W4) — this is now the same category of fix Path 2 above would apply to the broader claim,
   so likely resolved together.
8. Verify the Axon et al. 2019 citation year against the publisher record (EIC's W6) — TDSC volume
   18 is generally associated with 2021 in most indices; may be an early-access/print-date mismatch.
9. Consider adding a minimal informal pilot check or explicitly justifying its complete absence
   (R2's W1) — not required for D1 to pass, but would strengthen it.
10. One added sentence noting the corpus-derived learnability hypothesis (Huron 2006, Pearce &
    Wiggins 2006) assumes exposure-derived expectation transfers from the melodic/homophonic
    contexts those sources tested to this paper's novel fused-polyphony target (R2's W3).

### Priority 3 — nice to fix (does not gate re-review)

11. Fix figure numbering/filename mismatch and reorder so figures are introduced before being
    discussed in detail (R1's W3/W4, DA's minor finding).
12. Clarify Table 1's token-usage transfer function — input+output summed, or output only? (R3)
13. Distinguish the tautological Table-1 confirmations from the genuinely emergent
    convergence-divergence finding with one clarifying sentence (R3).
14. Note the completion-lag numbers (1.8–8.2s / 0.8–3.2s) are pipeline-specific, not a claim about
    real production latency (R3) — the paper partly does this already; make it harder to miss.
15. One clause noting `gen_ai.response.finish_reasons`-as-completion-signal is a heuristic specific
    to this engine's filtering logic, not a general OTel GenAI lifecycle-semantics claim (R3).
16. State the numeric cap on arpeggio probability in Table 1's solo-line row (R1's W6).
17. Add a half-sentence specifying which realization (MIDI vs. Web Audio) the per-voice pitch-bend
    claim in Section 4 describes, and name the MIDI-path channel-routing mechanism (R1's W5).
18. Add "(406 after filtering)" or similar to the abstract's corpus-count figure to match Section
    4's fuller disclosure (EIC's W5, echoing R2's W4 — independently caught by two reviewers).

## Not yet done

This entry documents the review only. No findings have been acted on. The natural next step is
deciding Priority 1 item 1 (Path 1 vs. Path 2) — which itself depends on verifying DA's cited
literature first — before touching anything else, since it's the one item that could reopen how
several of the other fixes get framed.
