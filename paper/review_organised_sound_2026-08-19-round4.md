# Fourth-round adversarial review — "The Oversight Symphony"

Full 5-reviewer sprint-contract protocol, run against the manuscript after round 3's fix (Section 3
rewritten to argue drift becomes progressively individuated rather than staying fused, citing
Bregman 1990 for the general mechanism and Rasch 1979 as a noise-floor calibration argument for the
45ms parameter).

## Panel-level mechanical decision

| Dimension | EIC | R1 | R2 | R3 | DA |
|---|---|---|---|---|---|
| D1 (mandatory) | Pass | Pass | **Block** | Pass | **Block** |
| D2 (mandatory) | Warn | **Block** | Warn | Pass | **Block** |
| D3 (mandatory) | Pass | Warn | **Block** | Pass | **Block** |
| D4 (high) | Pass | Pass | Pass | Pass | Pass |
| D5 (normal) | Warn | Warn | Pass | Pass | Warn |
| **Recommendation** | Minor Rev. | Major Rev. | Major Rev. | Minor Rev. | 2× CRITICAL |

F1 fires, now corroborated by **three of five reviewers** (R1, R2, DA) — the strongest
corroboration yet across four rounds on this passage.

## What round 3's fix got wrong

Two distinct, independently-confirmed problems, both in the same sentence:

**A plain arithmetic contradiction (R1 and DA, independently).** The text argued real ensembles
produce 30-50ms of onset spread "without anyone noticing," so a deliberate deviation "must exceed
that range to read as deliberate." The chosen parameter is 45ms. **45 does not exceed 50** — it
sits inside the cited range, directly contradicting the rule the paper stated for choosing it.
Both R1 and DA caught this independently, framing it as pure arithmetic, not a matter of
psychoacoustic interpretation.

**The configurational mismatch from round 3 persisted under the new framing (R2 and DA,
independently).** Moving Rasch's job from "why it's safe" to "why this specific number" didn't fix
the underlying transfer problem: Rasch (1979) measured *diffuse, symmetric* jitter distributed
across every voice in a live ensemble. This engine's actual configuration is *asymmetric* — six
voices machine-quantized to zero jitter, one voice carrying a deterministic, monotonically-ramping
bias. R2 noted that if anything, a rigid zero-jitter reference should make deviations *more*
salient than Rasch's numbers would predict, not less — the "must exceed" logic could be backwards
for this configuration. DA added that Rasch's "unnoticed" finding was measured under presumably
focused/critical listening, while this system's entire premise (Section 2) is peripheral,
divided-attention monitoring — detection thresholds under divided attention are generally larger,
not smaller, compounding the same-direction concern.

**DA also caught a related, newly-surfaced inconsistency**: Section 3 listed "synchrony" alongside
thickness/spelling/articulation as a property "of it" (the fused object, implying no decomposition
needed), while the same section's own description of the mechanism (voice becoming "increasingly
individuated, locatable") is explicitly a decomposition process. The two descriptions, read
together, contradict each other about whether drift requires decomposing the object.

## Resolution applied this session

Stopped trying to derive 45ms from a specific published threshold — this is the third framing to
fail scrutiny (round 2: pitch: contradicted the fusion argument; round 2/3: Rasch-as-safety-margin:
wrong paper, then wrong paradigm; round 3/4: Rasch-as-noise-floor: right paper, same paradigm
problem, plus an arithmetic contradiction). Rather than hunt for a fourth citation, the fix is
honest, not clever: **kept the general Bregman (1990) mechanism claim** (onset asynchrony from an
otherwise-synchronized reference is a primitive segregation cue — safe, general, well-supported,
survived all four rounds unchallenged) and **dropped any claim that 45ms is literature-derived**.
The paper now states plainly that no published ensemble-timing threshold transfers cleanly to this
engine's actual (asymmetric, machine-precise) configuration, and that 45ms was set by ear during
development, not derived — matching the exact honest-hedging pattern the paper already uses for
its completion-latency numbers ("ranges observed during development... not a claim of statistical
central tendency"). Rasch (1979) is removed from the paper entirely (was cited nowhere else) —
Table 1's row and the reference list updated to match.

Also fixed the thickness/spelling/articulation-vs-synchrony inconsistency DA caught: Section 3 now
explicitly names synchrony as the one property that works by partial decomposition, rather than
listing it alongside the three genuinely holistic properties without qualification.

**Word budget**: pushed to 7,024 after the rewrite, trimmed to 6,992. Citation round-trip
re-verified: 28/28 resolve (one fewer than round 3, since Rasch was removed rather than corrected).

## Other round-4 findings, not acted on this session

- **EIC**: prose density in the abstract and Section 3 (Warn, D5) — general note, not itemized.
- **R1**: recommends re-auditing every other numeric claim tied to a citation in Table 1/Section 3,
  given this is the third rewrite of one passage to have a citation-transfer problem survive
  earlier rounds. Not done this session — worth doing before further rounds.
- **R2**: W3, the "same mechanism keeping solo and bass segregable... applied gradually" line
  overstates parity — solo/bass segregate via multiple bundled cues (register + rhythm + timbre),
  drift via one cue (timing) alone, which is a weaker segregation strength in Bregman's own
  taxonomy. Partially addressed by this session's edit (removed the "same mechanism" framing in
  favor of "same cue family"), not fully — R2 wanted this named as an open perceptual question,
  which the rewrite doesn't yet do explicitly.
- **DA's alternative-literature suggestion**, not pursued this session: onset-asynchrony
  stream-segregation JND work using synthetic tone-pairs against a steady reference (closer to
  this engine's actual configuration than Rasch's ensemble data) might support a real numeric
  threshold — DA notes it would likely suggest a *lower*, not higher, threshold than 30-50ms.
  Deliberately not chased this round, given the pattern of citation-hunting itself being the
  recurring failure mode across three attempts; the "calibrated by ear, not derived" resolution
  sidesteps needing to get a fourth citation right.
- **DA's masking-literature alternative**: informational masking in complex auditory scenes as a
  framing sensitive to the six-voice backdrop's actual (controlled, uniform-timbre) complexity —
  not pursued.

## Not yet done

A fifth review round to check whether removing the literature-derivation claim (rather than fixing
it a third time) actually satisfies fresh scrutiny. Given the pattern — three consecutive rounds
found real, corroborated, worsening problems in the same 60-word span — this "stop claiming
literature-derivation, be honest it's calibrated by ear" resolution is structurally different from
the previous three (it makes a smaller claim, not a differently-cited version of the same claim),
which is a reason for cautious optimism, not certainty. Left as the user's call.
