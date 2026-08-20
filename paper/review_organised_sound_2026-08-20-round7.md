# Seventh-round adversarial review — "The Oversight Symphony"

Full 5-reviewer blind protocol, same format as rounds 1-6. Scope: the full register/structure
rewrite from this session (voice-only and structure-only, no intended content change) — every
first-person "we"/"our" removed, the Abstract rewritten from a results-summary into a conceptual
framing, ~34 bolded run-in paragraph headers converted to flowing prose, and the former "6.
Objections and Responses" FAQ section rewritten as flowing discussion prose and renamed "6.
Discussion." Table 1 and the Section 3 drift/segregation passage were left untouched content-wise.

## Panel-level mechanical decision

| Dimension | EIC | R1 | R2 | R3 | DA |
|---|---|---|---|---|---|
| D1 (mandatory) | Pass | Pass | Pass | Pass | Pass |
| D2 (mandatory) | Pass | **Block** | Pass | Pass | **Block** |
| D3 (mandatory) | Pass | Pass | Pass | Pass | Pass |
| D4 (high) | Pass | Pass | Warn | Pass | Pass |
| D5 (normal) | Warn | Warn | Warn | Warn | Warn |
| **Recommendation** | Minor Rev. | Major Rev. | Minor Rev. | Minor Rev. | Warn, not CRITICAL |

No CRITICAL fires. R1 and DA independently catch the same MAJOR problem, and it is, ironically,
the exact failure class round 6 just fixed — reintroduced by this session's own rewrite, in the
same paragraph (the Abstract) round 6 already flagged twice.

## The MAJOR finding

**The Abstract has a second dropped-linking-verb sentence, the same defect class round 6 fixed.**
It now reads: *"A set of adversarial signatures, drift, collusion, a poisoned spawn, is layered on
as scripted musical events, **drift alone also detected from real span timing**; the signature
renders as a voice's attack trailing the shared onset grid..."*

"Drift alone also detected from real span timing" has no verb — it needs "is" ("drift alone is
also detected...") to parse as a sentence rather than a dangling participial fragment. This is
structurally identical to round 6's finding (a dropped linking verb in the Abstract, introduced
while compressing a sentence during a revision pass), just relocated to a different clause. R1
caught it doing the same "read the Abstract as a first-time reader" pass every round has done
since round 5's CRITICAL; DA flagged it independently as concerning precisely because it is a
repeat of a failure mode the project has now fixed once already and just reintroduced — a pattern,
not a one-off, and specifically dangerous in the Abstract, the paragraph two of the last three
rounds have each found a defect in.

**Fix**: insert "is" — "drift alone is also detected from real span timing" — a one-word fix, not
a rewrite, consistent with round 6's own lesson (restore the dropped word rather than compress
further).

## Other round-7 findings, not blocking

- **DA/R3, MAJOR-adjacent but not independently corroborated**: Section 3's ensemble-definition
  sentence lost its subject when the header was stripped. It now reads *"The ensemble itself is one
  harmonic object, not many streams, the design's central perceptual commitment and a deliberate
  departure from the approach used elsewhere in this space."* The trailing appositive ("the
  design's central perceptual commitment...") has no clear referent — grammatically it seems to
  describe "not many streams" or the whole preceding clause, neither of which reads cleanly.
  Recommended fix: restore a full stop and start a new sentence, e.g. "...not many streams. This is
  the design's central perceptual commitment..." — matches the pattern used successfully elsewhere
  in this same rewrite (e.g. the walking-bass and chorale-voicing conversions, which kept clean
  sentence boundaries where this one didn't).
- **R2, MINOR**: Section 2's "The difference, target and grammar, is linked:" (comparing this
  design to Train Jazz) parses ambiguously on first read — a reader has to backtrack to figure out
  whether "target and grammar" is an appositive to "difference" or a separate clause. Suggested:
  "The difference is target and grammar, and the two are linked" (closer to the pre-rewrite
  phrasing, which read cleanly).
- **R1, MINOR**: the Abstract's "structurally, non-arbitrarily correlated with the telemetry" is
  ambiguous on a first read — unclear whether this is two separate adverbs modifying "correlated"
  or a single hyphenated-in-spirit compound that lost its hyphen. A comma-free "structurally and
  non-arbitrarily correlated" or simply "structurally correlated, not arbitrarily so" (matching
  phrasing already used successfully in Section 1) would resolve it.
- **R2, MINOR, observation not defect**: the swarm-simulation paragraph in Section 4 ("A mock
  pipeline (`swarm.py`), intake, a planner spawning workers, workers calling simulated tool
  servers, convergence, emits OTel GenAI spans...") has always had a long subject-to-verb gap, but
  the removed header ("**Swarm simulation.**") previously gave a reader a half-second of context
  before hitting it. Now unbuffered, it reads harder to parse on first pass. Pre-existing structure,
  not introduced this session, but worth a look given everything else in its neighborhood just got
  cleaned up.
- **R3, Warn (D5, register)**: the rewrite successfully removed the CS-paper tells it targeted, but
  several passages now read choppier than the venue samples researched this session (short,
  clipped declarative fragments in sequence, e.g. Section 1's "It grows and shrinks at runtime.
  What matters about it is..."), rather than the longer, more integrated sentences typical of the
  Organised Sound abstracts checked. Not a factual or structural problem, a partial register
  overcorrection — worth a light polish pass for flow, not urgent.
- **EIC, Warn (D5, general)**: word count is 7,025 against the venue's ~7,000 target, accepted as
  an honest overage per this session's own plan rather than force-trimmed. Not blocking on its own,
  but combined with the fixes above (all net-neutral or near-neutral in length) there's no reason
  this couldn't land back under 7,000 in the same pass that fixes the grammar issues.

## Points of consensus

All five reviewers agree the structural changes (headers removed, Section 6 folded into flowing
discussion, "we" eliminated) succeeded at the stated goal and did not alter any factual claim,
number, or citation — the pre-edit checklist discipline held. All five also agree the drift/
segregation passage in Section 3 and Table 1, both deliberately untouched, remain exactly as
solid as round 6 left them; no reviewer reopened either.

## Points of disagreement

R1 rates the Abstract's dropped-verb sentence MAJOR (gates re-review, since it's the second such
defect in two consecutive rounds and the Abstract specifically has now failed three of the last
four rounds); DA agrees it's real but frames it as a Warn given the one-word fix is trivial and the
underlying claim was never in doubt. Editorial judgment sides with R1's MAJOR framing given the
recurrence, not because DA's assessment of severity is wrong on its own terms — the pattern matters
more than any single instance's difficulty to fix.

## Revision roadmap

### Priority 1 — must fix (gates re-review)

1. **Insert the dropped "is"** in the Abstract's drift-detector clause (R1, DA).

### Priority 2 — should fix (strengthens the paper materially)

2. Restore a sentence boundary in Section 3's ensemble-definition sentence so the trailing
   appositive has a clear referent (DA/R3).
3. Rephrase Section 2's "The difference, target and grammar, is linked" for a cleaner first-read
   parse (R2).
4. Disambiguate the Abstract's "structurally, non-arbitrarily correlated" phrasing (R1).

### Priority 3 — nice to fix (does not gate re-review)

5. Consider restoring light connective framing to the swarm-simulation paragraph's opening, now
   that it lost its buffering header (R2).
6. A light flow pass on the choppiest converted paragraphs, matching the longer integrated
   sentences the venue samples actually use (R3).

## Not yet done

Given items 1-4 are all one-clause fixes with no research or re-verification burden, a full round 8
is unlikely to be needed after they land — a light verification pass on just the Abstract and
Section 3 (the two places with defects this round) should suffice, same reasoning as round 6's own
closing note. Left as the user's call, per standing practice.
