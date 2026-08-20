# Third-round adversarial review — "The Oversight Symphony"

Full 5-reviewer sprint-contract protocol, run against the manuscript after the round-2 CRITICAL
fix (Section 3's drift claim rewritten to cite Rasch 1978 and frame the 45ms onset-lag parameter
as "within the natural ensemble-asynchrony range"). The round-3 Devil's Advocate was explicitly
instructed to stress-test that fix rather than accept it at face value.

## Panel-level mechanical decision

| Dimension | EIC | R1 | R2 | R3 | DA |
|---|---|---|---|---|---|
| D1 methodology_rigor (mandatory) | Pass | Pass | Pass (bordering Warn) | Pass | Warn |
| D2 domain_accuracy (mandatory) | Pass | Pass | **Block** | Pass | **Block** |
| D3 argumentative_coherence (mandatory) | Warn | Warn | Warn | Pass | Warn |
| D4 cross_disciplinary_relevance (high) | Pass | Pass | Pass | Pass | Pass |
| D5 writing_and_structure (normal) | Pass | Pass | Pass | Warn | Pass |
| **Recommendation** | Minor Rev. | Minor Rev. | **Major Rev.** | Minor Rev. | CRITICAL found |

F1 (any mandatory blocks, severity 90) fires, corroborated this time by two independent
reviewers on D2 — a stronger signal than round 2's isolated DA-only block.

## What round 2's fix actually got wrong

The round-2 fix cited "Rasch 1978" for the claim that natural ensemble performance exhibits
30-50ms of onset asynchrony, subconsciously exploited by listeners without breaking the
ensemble's cohesion. Two independent problems surfaced on fresh review:

**R2 (domain reviewer): citation misattribution.** The 30-50ms figure belongs to a *different*
paper by the same author — Rasch, R. A. 1979, "Synchronization in Performed Ensemble Music,"
Acustica 43: 121-131 (measured real trio recordings) — not Rasch 1978, "The Perception of
Simultaneous Notes such as in Polyphonic Music," Acustica 40: 21-33 (a laboratory masking-paradigm
study with different, smaller thresholds). Independently verified via web search before acting:
confirmed. R2 also flagged a directional problem — the literature's account of *why* this
asynchrony doesn't destroy ensemble cohesion is that it **enhances voice individuation**, which is
closer to the opposite of "stays smeared, not consciously localized."

**DA: a deeper paradigm mismatch, not just a citation-year error.** Rasch's ensemble data describe
*diffuse, mutual* asynchrony — every voice wanders a little relative to every other voice, no
fixed external reference. This engine's actual mechanism (verified directly against `caidence.py`)
is structurally different: six voices machine-quantized to a perfectly rigid, silent-baseline
onset grid, and exactly one voice ramping away from it. That's a single outlier against a rigid
background — closer to an auditory oddball/deviance-detection configuration than to "everyone in
the ensemble is a little imprecise together." Transplanting Rasch's "goes unnoticed" finding into
a system whose baseline has zero natural jitter isn't licensed by the citation, and the round-2
text never argued that it was. DA also caught the internal tension the round-2 fix left
unresolved: "audibly late... load-bearing" (Section 3, adversarial signatures) vs. "not a voice a
listener must consciously localize" (Section 3, the ensemble) — the same passage contradicting
itself on how perceptible the signature actually is.

## Resolution applied this session

Stopped trying to defend "stays fused, unnoticed" and rewrote Section 3 to argue the opposite,
honestly: a component breaking from an otherwise-synchronized reference is a primitive
segregation cue (Bregman 1990, already cited and safely general — no new citation risk), and
drift is *designed* to become an increasingly individuated, locatable voice as it ramps toward
45ms, using the same segregation logic that already justifies solo/bass staying segregable,
applied gradually to one voice instead of permanently to two. This directly resolves the
solo/bass-vs-drift internal-contradiction concern DA raised across both rounds (round 2 and
round 3), since the paper no longer claims drift is exempt from the segregation logic it applies
everywhere else.

Rasch's role changed from "why it's safe" to "why 45ms specifically": corrected to Rasch 1979
(the right paper), now used as a **noise-floor calibration** argument — real ensembles naturally
produce 30-50ms of onset spread even when no one is meant to notice, so a deliberate deviation has
to reach past that range to read as a genuine departure rather than ordinary performance
imprecision. This directly answers a MAJOR finding both DA rounds raised independently (why the
upper bound of the range, not the middle) with an actual design rationale rather than leaving it
unexplained.

Reference list corrected: Rasch 1978 entry replaced with Rasch 1979 (right title, right pages).
Table 1's drift row updated to match. The "adversarial signatures" paragraph's "audibly late...
load-bearing" language, which was inconsistent with the old "ensemble" paragraph, no longer needs
touching — both passages now say the same thing.

**Not independently re-verified after this edit**: whether this new framing itself holds up is,
by the same logic that's applied twice now, worth a fresh Devil's Advocate rather than my own
confidence in it. Flagging that explicitly rather than assuming three rounds is enough.

## Other round-3 findings, not yet acted on

- **R1, R3**: confirmed both round-2 items (seed-42 scoping, Table 1 bass-row source mismatch)
  are fixed; R1 found one remaining unscoped restatement in the Conclusion — fixed this session
  (added the "three of four checked seeds" qualifier to match the Abstract).
- **EIC W2** (unflagged): the jitter-vs-sustained-bias transfer assumption (natural incidental
  multi-voice jitter vs. this design's systematic single-voice ramp) is still not explicitly named
  as an assumption, even after the rewrite above. Worth a look in a future pass.
- **EIC W3**: connecting the "why one bounded cue doesn't over-segregate the way solo/bass's
  multiple permanent cues do" logic back to Bregman's cue-integration principle explicitly, rather
  than leaving it implicit. Partially addressed by the rewrite (the "applied gradually to one
  voice instead of permanently to two" clause), not fully.
- **DA MINOR**: "genuinely emergent finding" (Section 4) mildly overstates what is, mechanically,
  the predictable output of two independently-driven functions evaluated on realistic data — the
  magnitude of the seed-0 divergence was a genuine discovery, the type of phenomenon was not.
  Not acted on.
- **DA red-team observation**: the paper publishes its own detection threshold (45ms) in the open
  literature; doesn't discuss whether a sophisticated adversary could stay under a known,
  published threshold. Interesting for Section 5 but not blocking, not acted on.
- **R2, R3 word budget / prose density notes**: general, not itemized further here.

## Not yet done

A fourth review round to check whether the new framing holds up under fresh adversarial scrutiny.
Given the pattern across three rounds (each fix revealed a more precise version of the same
underlying concern), that scrutiny is worth doing before treating this as settled — but three full
10-agent rounds is already substantial, and diminishing returns are a real consideration. Left as
the user's call rather than run automatically.
