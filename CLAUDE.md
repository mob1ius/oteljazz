# Instructions for Claude working in this directory

This is the OtelJazz project (semantic sonification of multi-agent AI coordination).
Layout: `paper/` (the submission + design spec + figures), `engine/` (the Python engine,
`caidence.py` and everything it depends on), `web/` (the browser port), `docs/` (this project's
own documentation: `README.md` orientation + file map, `BUILD_NOTES.md` running build log,
`ROADMAP.md` where the project is going).

## Before making this repo public (READ FIRST if that's the task)

This repo is currently **private** and headed toward being made public. The pre-public content
scrub is **done as of 2026-08-20**: `docs/BUILD_NOTES.md` and `paper/working-notes.md` are
untracked (`git rm --cached` + `.gitignore`, still present locally, also backed up outside the
repo at `~/Private/oteljazz-internal-backup/`) and their history was stripped from every commit
via `git filter-repo --path docs/BUILD_NOTES.md --path paper/working-notes.md --invert-paths
--force` (verified: `git log --all -- <path>` and `git rev-list --objects --all | grep` both come
back empty for both files). `working-notes.md` was added to the scrub list after a full re-scan
found it: candid acceptance-strategy/venue-shopping reasoning ("RECON STATUS" kill-search log,
honest novelty grading, a "HackerNews path" distribution-tactics section), same category as
BUILD_NOTES.md, not paper content. The re-scan covered every other tracked file and found nothing
else.

**filter-repo removes the `origin` remote as a safety feature** -- it needs to be re-added
(`git remote add origin https://github.com/mob1ius/oteljazz.git`) before anything can be pushed.
**Nothing has been force-pushed yet.** The rewritten local history and the still-private GitHub
remote have now diverged, so the actual "make it public" step still needs, in order: re-add the
remote, confirm the user is ready for the force-push specifically (irreversible on the remote,
overwrites the old history other collaborators or forks would see), run `git push --force origin
main`, then flip the repo's visibility to public in GitHub settings. If asked to make the repo
public again in some future session and this checklist looks stale (new tracked files appeared,
history/backup paths changed), re-verify before trusting this note rather than assuming it's still
accurate -- do a fresh re-scan rather than skipping straight to the push.

## Every session

**Read `docs/BUILD_NOTES.md` first**, before making changes. It has decisions, tradeoffs, and bug
fixes from prior sessions that aren't obvious from the code alone -- especially anything under
its "Open work" section, which is the current state of in-progress work across context resets.

## After every build or ship

**Update `docs/BUILD_NOTES.md`.** Add a new entry at the top of the chronological log (newest first)
covering what changed and why -- not a diff summary, but the reasoning a future session with no
memory of this conversation would need: what was tried, what broke, what the tradeoff was, what
explicitly got scoped out and why. Update the "Where things stand" section at the top if the
overall state changed, and update "Open work" to reflect what's now done vs. still pending.

This exists because the project spans multiple sessions and context windows, and the code alone
doesn't carry the reasoning behind non-obvious decisions (e.g., why mode-shift is decoupled from
the chord-degree sequence, why `synthetic_trace()` must never take a random seed, why the pad
voice-leading fix mattered). Losing that reasoning means re-deriving it, or worse, re-breaking
something that was already fixed for a documented reason.

## Working conventions already established (see BUILD_NOTES.md for the reasoning)

- `synthetic_trace()` is the calibration-shaped path: always deterministic, seed=0, never
  randomized. `extended_demo_trace()` is the demo/listening path: randomized seed by default via
  `--demo`, reproducible with `--seed N`. Don't blur this line.
- The batch and live paths share exactly one per-span mapping implementation
  (`emit_span_events`). Never add a second one for live-mode convenience -- they will drift.
- Dynamics (velocity, tempo where implemented, event density) are telemetry-driven; harmony,
  voice-leading, and cadence shape are corpus-driven. Don't cross those wires -- an overseer
  needs the telemetry channels to stay decodable.
- Before attributing a "wrong" sound to the musical mapping, verify the actual Logic MIDI
  channel routing with `--test-note --channel N`. A Logic-side track reorder silently breaks the
  channel table in `VOICES` with no error, just wrong-sounding output, and this has been the
  real cause more than once.
