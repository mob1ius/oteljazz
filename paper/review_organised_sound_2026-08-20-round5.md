# Fifth-round adversarial review — "The Oversight Symphony"

Full 5-reviewer blind protocol (Phase 1 pre-commitment against a summary of what changed, Phase 2
against the full manuscript), same format as rounds 1-4. Scope: everything changed since round 4
(`review_organised_sound_2026-08-19-round4.md`) — the round-4 fix itself (45ms stated as calibrated
by ear, Rasch removed), the W3 segregation-parity fix, the new real drift detector (Section 3/5,
Table 1), and this session's four round-3 closures (reworded "genuinely emergent" claim, new
adversary-evasion objection, explicit Bregman cue-trading naming, EIC W2 confirmed moot).

## Panel-level mechanical decision

| Dimension | EIC | R1 | R2 | R3 | DA |
|---|---|---|---|---|---|
| D1 (mandatory) | Pass | **Block** | Pass | Pass | **Block** |
| D2 (mandatory) | Pass | Pass | Warn | Pass | Pass |
| D3 (mandatory) | Warn | Pass | Pass | Warn | Pass |
| D4 (high) | Pass | Pass | Pass | Warn | Pass |
| D5 (normal) | Pass | Warn | Warn | Pass | Warn |
| **Recommendation** | Minor Rev. | Major Rev. | Minor Rev. | Minor Rev. | 1× CRITICAL |

F1 (the drift/onset-lag passage that failed rounds 1-4) does **not** fire this round — the passage
itself, unchanged in substance since round 4, holds. A new, different problem fires instead: **R1
and DA independently caught the same self-contradiction**, this time between the Abstract and the
body, not within Section 3.

## The CRITICAL finding

**The Abstract still says no detector exists; Section 3, Section 5, and Table 1 all say drift now
has one.** Abstract, mid-sentence: *"...a set of adversarial signatures, drift, collusion, a
poisoned spawn, layered on as scripted musical events rather than detected from telemetry (a
detector is future work)..."* — stated as a blanket, unqualified claim covering all the signatures
named in that sentence, drift included. But Section 3 (`**The adversarial signatures**`, `**The
mapping, stated explicitly**`), Section 5 (`**A first drift detector**`), and Table 1's drift row
all now say the opposite for drift specifically: *"drift now also has a first-pass detector,"*
*"first-pass detector implemented (Section 5), statistical, not yet production-validated."*

This is not a matter of interpretation or hedging register — it is a direct factual contradiction
inside the same document, one sentence in the Abstract flatly asserting something four other
passages just as flatly deny. Caught independently by R1 (methodology reviewer, doing the standard
"does the Abstract's claim inventory match the body" pass every methodology review does) and DA
(who flagged it as the kind of self-undermining inconsistency that costs credibility on everything
else in the paper, since a reader who spots it will re-read every other claim more skeptically).
Given this paper's specific history — four straight rounds where a stale or drifted claim in one
passage went unnoticed because a *different* passage was being actively revised — this is exactly
the failure mode BUILD_NOTES itself already named as a risk (R1's round-4 recommendation to
re-audit every numeric/status claim, which this session's audit covered corpus statistics but not,
apparently, the Abstract's own detector-status sentence).

**Fix is trivial and should not reopen any word-budget fight**: the Abstract's clause needs
scoping, e.g. "...layered on as scripted musical events, drift alone now also detected from real
span timing rather than injected, the rest still scripted..." or similar — a net-neutral or
near-neutral rewording, not a new claim, since the underlying fact is already stated and validated
elsewhere in the paper. This is a same-session, same-sitting fix, not a research question.

## Other round-5 findings, not blocking

- **R1 (methodology), MAJOR, not independently corroborated**: the detector's one "real captured
  session" validation point (333 spans, 29 agent identities) is, per `import_otel_hook_trace.py`'s
  own docstring, converted through a pairing heuristic "NOT yet verified against a real
  multi-turn/multi-subagent session." More specifically: that captured session is a single Claude
  Code coding-assistant session (this project's own development work), not a multi-agent swarm
  coordinating on a shared task the way the paper's target scenario (planner, parallel workers,
  tool calls) describes — subagent spans there are more likely nested/sequential delegation than
  the concurrent multi-agent coordination the grammar is built to sonify. The paper's phrasing
  ("one real captured session") is accurate and doesn't overclaim what it is, but doesn't disclose
  what it *isn't* either. Suggested one-clause fix in Section 5's detector paragraph or footnote,
  not blocking, since the paper already correctly declines to claim recall against "genuine
  real-world drift" is verified — this just sharpens *why* that one data point is weaker evidence
  than "one real trace" suggests on its own.
- **R2 (domain), Warn, not blocking**: the new Bregman "cue-trading" language in Section 3 ("though
  weaker by Bregman's own cue-trading logic, more simultaneous cues integrate into a stronger
  percept") is directionally correct as a characterization of trading relations / cue integration
  in Auditory Scene Analysis, but is cited generically to `(Bregman 1990)` with no page or chapter
  pointer, the same citation already carrying the sentence's other claim. Given this exact passage
  has failed four rounds specifically on citation-transfer problems (wrong claim -> wrong citation
  -> wrong paradigm -> arithmetic contradiction), R2 flags this as worth a specific page reference
  if it survives to camera-ready, not because anything is wrong with it, but because this passage's
  track record means an unpinned citation here reads as risk regardless of whether it's actually
  correct.
- **R3 (perspective), Warn**: the new objection ("Publishing 45ms openly lets an adversary evade
  it") is honest but thin at two sentences — it names the risk and immediately says "we do not
  address" it, with no gesture at what a mitigation would even look like in kind (e.g., varying the
  threshold per-deployment, detecting evasion attempts as a distinct signature). Not required for
  this round, but the objection reads slightly like a box-check next to the other, more developed
  objections in Section 6.
- **DA, MINOR**: the reworded convergence-finding sentence in Section 4 ("that two
  independently-driven channels *could* dissociate was architecturally predictable, but the seed-0
  magnitude... is a genuine discovery") is an improvement over round 4's blanket "genuinely
  emergent," but immediately re-asserts the old framing two sentences later without the same
  qualification: "convergence is the one genuinely emergent finding" no longer appears verbatim,
  good, but the paragraph's rhythm still reads as making the stronger claim first and the weaker,
  correct one second, which undersells the fix. Cosmetic, not blocking.
- **EIC, Warn (D5, general)**: word count is at 6,997/~7,000 by the project's own count script —
  essentially zero headroom. Any fix from this round, including the Abstract rewording above,
  needs to be net-neutral or come with an equal-or-larger cut, same discipline as every prior
  round. Flagged generally, not itemized further.

## Points of consensus

All five reviewers agree: the round-4 fix to the drift-parameter passage itself holds under fresh
scrutiny — no reviewer re-opened F1 against the passage's actual content this round, a first across
five rounds. All five also treat the drift detector as a genuine, positive addition to the paper's
contribution, not merely defensive scaffolding around the earlier citation problems; R1, R2, and
EIC each independently used some version of "moves the paper from asserting mapping fidelity to
demonstrating a first real capability" in their notes.

## Points of disagreement

R1 rates the real-trace validation concern MAJOR (methodology gap); EIC and R3 treat it as a Warn,
since the paper's own hedging ("recall against genuine real-world drift is unverified... that trace
carries none by construction") already substantially covers the concern R1 raises, just not the
more specific "this trace isn't even the right kind of multi-agent data" point. Editorial judgment:
side with the Warn framing for this round's Recommendation, since the paper does not overclaim what
it validated, but flag R1's more specific concern for a one-clause fix alongside the CRITICAL item,
since both land in the same paragraph and are cheap to fix together.

## Revision roadmap

### Priority 1 — must fix (gates re-review)

1. **Resolve the Abstract/body detector-status contradiction** (R1, DA, CRITICAL). Scope the
   Abstract's "a detector is future work" clause to exclude drift, matching Section 3/5/Table 1.

### Priority 2 — should fix (strengthens the paper materially)

2. One clause distinguishing the real-trace validation's actual provenance (a single-session coding
   assistant capture, not multi-agent swarm coordination) from what "one real captured session"
   might imply (R1).
3. A specific page/chapter pointer for the Bregman cue-trading claim, given this passage's citation
   history (R2) — not required this round, worth doing before camera-ready.

### Priority 3 — nice to fix (does not gate re-review)

4. Expand the adversary-evasion objection by one clause naming what a mitigation direction would
   look like, even briefly (R3).
5. Minor rhythm fix in the Section 4 convergence paragraph so the qualified claim isn't
   immediately followed by language that reads like the unqualified one (DA).

## Not yet done

A sixth review round to confirm the Abstract fix doesn't reintroduce a new inconsistency elsewhere
(the Abstract is the most load-bearing single paragraph in the paper and has not been touched since
early sessions) is the natural next check, but this is one clause, not four rounds' worth of
citation archaeology — a lighter verification pass, not necessarily a full round 6, is likely
sufficient. Left as the user's call, per this project's standing practice.
