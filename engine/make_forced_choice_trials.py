#!/usr/bin/env python3
"""make_forced_choice_trials.py -- generates the N=5 forced-choice drift-audibility trials
described in paper Section 5. For each of 5 seeds, renders the SAME extended_demo_trace() with
drift on and drift off (do_drift=True/False, everything else identical), clips both to the same
window around the scripted drift instance (worker2, t=35.0-49.0s), shuffles which one is "A" and
which is "B" per trial (seeded on the trial index so it's reproducible), and writes an answer key
kept separate from the files handed to a listener.

Not the paper's supplementary-audio pipeline -- see render_test_audio.py's docstring. This script
exists only to produce this one perceptual check's stimuli.
"""
import json
import os
import random

from caidence import (extended_demo_trace, generate_jazz_form, load_corpus_model, build_timeline,
                       export_events)
from render_test_audio import render_clip

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "supplementary_audio", "forced_choice_trials")
CLIP_START, CLIP_END = 33.0, 49.0   # 2s before the scripted drift_start (35.0) to 2s past drift_window (14.0)
SEEDS = [1, 2, 3, 4, 5]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    corpus = load_corpus_model()
    spans, regime_schedule, sections = extended_demo_trace()

    answer_key = []
    for trial_i, seed in enumerate(SEEDS, start=1):
        form = generate_jazz_form(corpus, seed=seed)
        events = {}
        for label, do_drift in [("drift", True), ("nodrift", False)]:
            timeline = build_timeline(spans, 96.0, 1.0, do_drift=do_drift, corpus_model=corpus,
                                       regime_schedule=regime_schedule, seed=seed,
                                       sections=sections, form=form)
            events_path = os.path.join(OUT_DIR, f"_trial{trial_i}_{label}_events.json")
            export_events(timeline, events_path, meta={"seed": seed, "drift": do_drift},
                          chord_windows=None)
            events[label] = events_path

        rng = random.Random(f"trial-{trial_i}")
        order = ["drift", "nodrift"]
        rng.shuffle(order)
        labels = {"A": order[0], "B": order[1]}

        for slot, label in labels.items():
            out_wav = os.path.join(OUT_DIR, f"trial{trial_i}_{slot}.wav")
            render_clip(events[label], out_wav, CLIP_START, CLIP_END)

        for label in ("drift", "nodrift"):
            os.remove(events[label])

        drift_slot = "A" if labels["A"] == "drift" else "B"
        answer_key.append({"trial": trial_i, "seed": seed, "drift_slot": drift_slot})
        print(f"trial{trial_i}: seed={seed}  drift is slot {drift_slot} "
              f"(not written to the trial files themselves)")

    with open(os.path.join(OUT_DIR, "answer_key.json"), "w") as f:
        json.dump(answer_key, f, indent=2)
    print(f"\nWrote {len(SEEDS)} trials + answer_key.json to {OUT_DIR}")


if __name__ == "__main__":
    main()
