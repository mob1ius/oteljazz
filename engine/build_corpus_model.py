#!/usr/bin/env python3
"""
build_corpus_model.py - offline corpus miner (dev-only, not part of the realtime engine)

Mines a public-domain symbolic corpus for the statistics that shape OtelJazz's harmony,
voice-leading, and cadence shape:

  1. Chord-transition probabilities (7x7 Markov matrices over scale degrees, roman numeral
     root only) -- separately for MAJOR and MINOR local-key context.
  2. Melodic interval distribution (signed semitone steps between consecutive notes within a
     voice/part).
  3. Cadence patterns: the (penultimate -> final) scale-degree bigram at the end of each piece.

Deliberately excludes dynamics/velocity/tempo: per the mapping spec (08-sonification-
mapping-spec.md), those channels already carry telemetry information (throughput, tokens,
latency) and must stay telemetry-driven, not corpus-driven, or an overseer can no longer
decode them.

Two sources:

  --source lieder (default)
    The OpenScore Lieder Corpus's Roman-numeral analyses, via Mark Gotham's When-in-Rome
    meta-corpus (github.com/MarkGotham/When-in-Rome, Corpus/OpenScore-LiederCorpus). 179
    songs across 27 nineteenth-century composers (Schubert's Winterreise / Schwanengesang /
    Die schoene Muellerin, Schumann, Brahms, Fanny Mendelssohn, Clara Schumann, and more).
    Scores are CC0; analyses are CC BY-SA -- no commercial restriction. These are EXPERT,
    hand-annotated Roman numerals (Mark Gotham et al.), not algorithmically guessed, so this
    is higher-fidelity ground truth than the bach source below. Because Romantic-era harmony
    leans heavily minor (Winterreise especially), transitions are mined separately by mode
    rather than filtered down to major-only, which was the bach source's simplification.
    Requires the corpus already checked out locally (see README / git sparse-checkout
    instructions) -- this script does not fetch it itself.

  --source bach
    music21's bundled Bach chorales (433 pieces, major-key only, roman numerals derived
    automatically via music21's chordify + romanNumeralFromChord -- algorithmic, not expert-
    annotated). Kept as a fallback/comparison source; no longer the default.

  --source jazz
    The Weimar Jazz Database (Jazzomat Research Project, jazzomat.hfm-weimar.de), 456 solo
    transcriptions (416 usable -- see below) over real jazz standards, mostly bebop/hard-bop
    era (Parker, Coltrane, Miles Davis, Rollins, and ~50 more performers with >=5 solos each).
    Released under the Open Data Commons Open Database License (ODbL) -- share-alike applies
    to DERIVATIVE DATABASES (arguably including corpus_model_jazz.json itself), so if this tool
    is ever distributed, that's a constraint to check, the same class of constraint that ruled
    out Chopin's CC BY-NC-SA for the Lieder source (not urgent now -- nothing here is published).
    Needs `corpus_raw/wjazzd.db` (SQLite, ~40MB, no music21/no registration --
    https://jazzomat.hfm-weimar.de/download/downloads/wjazzd.db). Produces a STRUCTURALLY
    DIFFERENT model than lieder/bach: jazz harmony is 7th-chord-based and far more chromatic
    (secondary dominants, tritone subs) than diatonic Roman-numeral analysis captures, so this
    source mines a 12-note CHROMATIC root-transition matrix (root's semitone distance from the
    solo's tonic, 0-11) plus a per-root chord-QUALITY distribution (maj/min/dom7/maj7/m7b5/
    dim7/aug/sus), not a 7-degree diatonic matrix. Only solos with an unambiguous major/minor
    key are used (416/456 -- skips modal/blues/chromatic-labeled and unlabeled keys). One global
    key per solo (the database's own annotation), so modulating standards are flattened to their
    nominal key -- a documented approximation, unlike Lieder's per-passage local-key analysis.
    Per-performer melodic-interval sub-models use real horn/reed soloists almost exclusively
    (420+ of 456 solos are horn transcriptions; only Herbie Hancock, 5 solos, and Red Garland, 1
    solo -- too few -- represent piano) -- this is a better fit for the engine's MONOPHONIC solo
    melody line than piano data would be, not a gap in what the corpus can deliver for that voice.

Output: corpus_model.json (lieder/bach) or corpus_model_jazz.json (jazz), a frozen artifact.
The realtime engine (caidence.py) only ever reads these files; it never imports music21 or
touches any corpus at runtime. Re-run this script only when deliberately updating a model, and
check the "generated"/"source" stamp so stimuli built against different versions aren't compared.

Usage:
  python3 build_corpus_model.py                                  # lieder source, default path
  python3 build_corpus_model.py --source bach
  python3 build_corpus_model.py --source lieder --lieder-root corpus_raw/When-in-Rome/Corpus/OpenScore-LiederCorpus
  python3 build_corpus_model.py --source jazz --jazz-db corpus_raw/wjazzd.db
  python3 build_corpus_model.py --limit N --out corpus_model.json
"""

import argparse
import collections
import datetime
import glob
import json
import os
import re
import sqlite3
import sys

DEGREE_TRANSITION_SMOOTHING = 0.5   # additive (Laplace) smoothing so no transition is ever zero-probability
INTERVAL_CLAMP = 12                 # collapse melodic leaps beyond +/- an octave into the octave bucket
DEFAULT_LIEDER_ROOT = "corpus_raw/When-in-Rome/Corpus/OpenScore-LiederCorpus"
DEFAULT_JAZZ_DB = "corpus_raw/wjazzd.db"

def _require_music21():
    """Lazy import -- only the lieder/bach sources need music21; jazz only needs stdlib
    sqlite3, and shouldn't force a music21 install just to mine it."""
    try:
        import music21
        from music21 import corpus, converter, roman
        return music21, corpus, converter, roman
    except ImportError:
        sys.exit("music21 not installed. Run: pip install music21  (dev-only, not needed at runtime)")


def normalize_matrix(degree_transitions):
    """(from_degree, to_degree) count dict -> 7x7 row-normalized probability matrix."""
    matrix = [[0.0] * 7 for _ in range(7)]
    for frm in range(1, 8):
        row_counts = [degree_transitions.get((frm, to), 0) + DEGREE_TRANSITION_SMOOTHING for to in range(1, 8)]
        total = sum(row_counts)
        matrix[frm - 1] = [c / total for c in row_counts]
    return matrix


def melodic_intervals_from_score(score):
    counts = collections.Counter()
    for part in score.parts:
        notes = [n for n in part.recurse().notes if n.isNote]
        for a, b in zip(notes[:-1], notes[1:]):
            semitones = b.pitch.midi - a.pitch.midi
            semitones = max(-INTERVAL_CLAMP, min(INTERVAL_CLAMP, semitones))
            counts[semitones] += 1
    return counts


# --- source: bach (algorithmic roman numerals, major-key only) -------------------------------

def mine_bach(limit=None):
    music21, corpus, converter, roman = _require_music21()
    paths = list(corpus.getComposer("bach"))
    if limit:
        paths = paths[:limit]
    print(f"Mining {len(paths)} Bach pieces from music21 {music21.__version__} corpus...")

    major_transitions, cadence_bigrams, interval_counts = collections.Counter(), collections.Counter(), collections.Counter()
    used, skipped, errored = 0, 0, 0

    for i, path in enumerate(paths):
        try:
            score = corpus.parse(path)
            key = score.analyze("key")
            if key.mode != "major":
                skipped += 1
                continue
            chordified = score.chordify()
            chords = [c for c in chordified.recurse().getElementsByClass("Chord") if c.pitches]
            degrees = []
            for c in chords:
                try:
                    degrees.append(roman.romanNumeralFromChord(c, key).scaleDegree)
                except Exception:
                    continue
            if len(degrees) < 4:
                skipped += 1
                continue
            major_transitions.update(zip(degrees[:-1], degrees[1:]))
            cadence_bigrams[(degrees[-2], degrees[-1])] += 1
            interval_counts.update(melodic_intervals_from_score(score))
            used += 1
        except Exception:
            errored += 1
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(paths)} processed (used={used}, skipped={skipped}, errored={errored})")

    print(f"Done: {used} major-key pieces used, {skipped} skipped, {errored} errored.")
    return {
        "source_label": "bach (music21 core corpus, major-key only, algorithmic roman numerals)",
        "composers": ["J.S. Bach"],
        "pieces_used": used, "pieces_skipped": skipped, "pieces_errored": errored,
        "major_transitions": major_transitions,
        "minor_transitions": collections.Counter(),   # bach source is major-only
        "cadence_bigrams": cadence_bigrams,
        "interval_counts": interval_counts,
        "composer_interval_counts": collections.defaultdict(collections.Counter),
        "composer_song_counts": collections.Counter(),
    }


# --- source: lieder (expert roman numerals, major + minor) ---------------------------------

def mine_lieder(root, limit=None):
    music21, corpus, converter, roman = _require_music21()
    analysis_paths = sorted(glob.glob(os.path.join(root, "*", "**", "analysis.txt"), recursive=True))
    if not analysis_paths:
        sys.exit(f"No analysis.txt files found under {root}. Check the path / that the corpus "
                  f"is checked out (see this script's docstring for the sparse-checkout command).")
    if limit:
        analysis_paths = analysis_paths[:limit]
    print(f"Mining {len(analysis_paths)} Lieder analyses from {root} "
          f"(music21 {music21.__version__})...")

    major_transitions, minor_transitions = collections.Counter(), collections.Counter()
    cadence_bigrams, interval_counts = collections.Counter(), collections.Counter()
    composer_interval_counts = collections.defaultdict(collections.Counter)
    composer_song_counts = collections.Counter()
    composers = set()
    used, skipped, errored = 0, 0, 0

    for i, analysis_path in enumerate(analysis_paths):
        song_dir = os.path.dirname(analysis_path)
        score_path = os.path.join(song_dir, "score.mxl")
        composer = analysis_path.replace(root, "").strip(os.sep).split(os.sep)[0]
        try:
            rn_stream = converter.parse(analysis_path, format="romanText")
            rns = list(rn_stream.recurse().getElementsByClass("RomanNumeral"))
            degrees_and_mode = [(rn.scaleDegree, rn.key.mode) for rn in rns if rn.key is not None]
            if len(degrees_and_mode) < 4:
                skipped += 1
                continue

            for (d_from, mode_from), (d_to, _mode_to) in zip(degrees_and_mode[:-1], degrees_and_mode[1:]):
                bucket = major_transitions if mode_from == "major" else minor_transitions
                bucket[(d_from, d_to)] += 1
            cadence_bigrams[(degrees_and_mode[-2][0], degrees_and_mode[-1][0])] += 1

            if os.path.exists(score_path):
                score = converter.parse(score_path)
                song_intervals = melodic_intervals_from_score(score)
                interval_counts.update(song_intervals)
                composer_interval_counts[composer].update(song_intervals)
                composer_song_counts[composer] += 1

            composers.add(composer)
            used += 1
        except Exception as e:
            errored += 1
        if (i + 1) % 30 == 0:
            print(f"  {i + 1}/{len(analysis_paths)} processed (used={used}, skipped={skipped}, errored={errored})")

    print(f"Done: {used} songs used across {len(composers)} composers, {skipped} skipped, {errored} errored.")
    return {
        "source_label": "OpenScore Lieder Corpus via When-in-Rome (expert-annotated roman numerals)",
        "composers": sorted(composers),
        "pieces_used": used, "pieces_skipped": skipped, "pieces_errored": errored,
        "major_transitions": major_transitions,
        "minor_transitions": minor_transitions,
        "cadence_bigrams": cadence_bigrams,
        "interval_counts": interval_counts,
        "composer_interval_counts": composer_interval_counts,
        "composer_song_counts": composer_song_counts,
    }


# --- source: jazz (Weimar Jazz Database, chromatic root + chord-quality, sqlite, no music21) --

# Note-name -> pitch class (0-11). Both spellings map to the same pc; the source data uses
# both ('C#-maj' and 'Db-maj' both appear as solo_info.key roots).
_ROOT_PC = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5,
    "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}

_KEY_RE = re.compile(r"^([A-G][b#]?)-(maj|min)$")
_CHORD_RE = re.compile(r"^([A-G][b#]?)(.*)$")


def _parse_key(key_str):
    """solo_info.key -> (tonic_pc, mode) or None. Only unambiguous major/minor keys are used --
    the database also has 'mix'/'dor'/'blues'/'chrom' suffixes and some empty/malformed values
    (416 of 456 solos have a clean maj/min key; the rest are skipped, not guessed at)."""
    m = _KEY_RE.match(key_str or "")
    if not m:
        return None
    root, mode = m.groups()
    return _ROOT_PC[root], ("major" if mode == "maj" else "minor")


def _bucket_chord_quality(suffix):
    """Jazzomat's own chord shorthand ('-'=minor, 'j'=major7, 'o'=diminished, '+'=augmented,
    bare leading digit=dominant, 'm7b5'=half-diminished) -> one of 8 quality buckets. Verified
    against the actual database before writing this: this exact rule set covers 100% of the
    30,548 non-empty chord annotations in wjazzd.db (0 unparsed tokens across 418 distinct
    chord strings) with a musically sane distribution (45% dom7, 27% min, 11% maj7, 7% maj,
    4% m7b5, 3% sus, 2% dim7, 1% aug) -- not a guess, counted."""
    s = suffix
    if s.startswith("m7b5"):
        return "m7b5"
    if s == "" or s.startswith("6"):
        return "maj"
    if s.startswith("j"):
        return "maj7"
    if s.startswith("-"):
        return "min"
    if s.startswith("o"):
        return "dim7"
    if s.startswith("+"):
        return "aug"
    if s.startswith("sus"):
        return "sus"
    if s and s[0].isdigit():
        return "dom7"
    return None   # unreached against the actual corpus, but never crash on an unseen token


def _parse_chord(token):
    """Chord symbol -> (root_pc, quality) or None for 'NC' (no chord) / anything unparseable.
    Slash-chord bass notes (e.g. 'A/G') are dropped -- only the chord's own root matters for the
    root-transition matrix; the bass note isn't tracked separately in this pass."""
    if not token or token == "NC":
        return None
    m = _CHORD_RE.match(token)
    if not m:
        return None
    root, suffix = m.groups()
    quality = _bucket_chord_quality(suffix.split("/")[0])
    if quality is None or root not in _ROOT_PC:
        return None
    return _ROOT_PC[root], quality


def mine_jazz(db_path, limit=None, min_performer_solos=5):
    if not os.path.exists(db_path):
        sys.exit(f"{db_path} not found. Download it (no registration needed):\n"
                  f"  curl -o {db_path} https://jazzomat.hfm-weimar.de/download/downloads/wjazzd.db")
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute("select melid, key, performer, instrument from solo_info")
    solos = cur.fetchall()
    if limit:
        solos = solos[:limit]
    print(f"Mining {len(solos)} solos from {db_path}...")

    root_transitions = {"major": collections.Counter(), "minor": collections.Counter()}
    quality_by_root = {"major": collections.defaultdict(collections.Counter),
                        "minor": collections.defaultdict(collections.Counter)}
    cadence_bigrams = collections.Counter()
    interval_counts = collections.Counter()
    performer_interval_counts = collections.defaultdict(collections.Counter)
    performer_song_counts = collections.Counter()
    performers = set()
    used, skipped = 0, 0

    for i, (melid, key_str, performer, instrument) in enumerate(solos):
        key = _parse_key(key_str)
        if key is None:
            skipped += 1
            continue
        tonic_pc, mode = key

        cur.execute("select chord from beats where melid=? and chord is not null and chord != '' "
                    "order by beatid", (melid,))
        raw_chords = [r[0] for r in cur.fetchall()]
        # Collapse consecutive identical raw tokens -- the annotation marks a chord on its
        # attack beat only, but a chord held across an unusually long span can still repeat
        # across more than one annotated slot; a repeat isn't a "transition" worth counting.
        collapsed = [tok for j, tok in enumerate(raw_chords) if j == 0 or tok != raw_chords[j - 1]]
        parsed = [p for p in (_parse_chord(tok) for tok in collapsed) if p is not None]
        degrees = [((root_pc - tonic_pc) % 12, quality) for root_pc, quality in parsed]
        if len(degrees) < 4:
            skipped += 1
            continue

        for (d_from, _q_from), (d_to, _q_to) in zip(degrees[:-1], degrees[1:]):
            root_transitions[mode][(d_from, d_to)] += 1
        for degree_pc, quality in degrees:
            quality_by_root[mode][degree_pc][quality] += 1
        cadence_bigrams[(degrees[-2][0], degrees[-1][0])] += 1

        cur.execute("select pitch from melody where melid=? order by onset", (melid,))
        pitches = [round(r[0]) for r in cur.fetchall()]
        song_intervals = collections.Counter()
        for a, b in zip(pitches[:-1], pitches[1:]):
            semitones = max(-INTERVAL_CLAMP, min(INTERVAL_CLAMP, b - a))
            song_intervals[semitones] += 1
        interval_counts.update(song_intervals)
        if performer:
            performer_interval_counts[performer].update(song_intervals)
            performer_song_counts[performer] += 1
            performers.add(performer)

        used += 1
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(solos)} processed (used={used}, skipped={skipped})")

    con.close()
    print(f"Done: {used} solos used across {len(performers)} performers, {skipped} skipped "
          f"(no clean major/minor key, or too few chords).")
    return {
        "source_label": "Weimar Jazz Database (Jazzomat Research Project, ODbL)",
        "performers": sorted(performers),
        "pieces_used": used, "pieces_skipped": skipped, "pieces_errored": 0,
        "root_transitions": root_transitions,
        "quality_by_root": quality_by_root,
        "cadence_bigrams": cadence_bigrams,
        "interval_counts": interval_counts,
        "performer_interval_counts": performer_interval_counts,
        "performer_song_counts": performer_song_counts,
        "min_performer_solos": min_performer_solos,
    }


def normalize_root_matrix(root_transitions):
    """(from_pc, to_pc) count dict -> 12x12 row-normalized probability matrix, pc 0-11 (semitone
    distance from the solo's own tonic) -- the chromatic-root equivalent of normalize_matrix's
    7x7 diatonic-degree matrix. Kept separate rather than generalizing normalize_matrix: 1-indexed
    scale degrees (1-7) and 0-indexed pitch classes (0-11) are different enough conventions that
    sharing one function risked an off-by-one bug for a one-time mining script."""
    matrix = [[0.0] * 12 for _ in range(12)]
    for frm in range(12):
        row_counts = [root_transitions.get((frm, to), 0) + DEGREE_TRANSITION_SMOOTHING for to in range(12)]
        total = sum(row_counts)
        matrix[frm] = [c / total for c in row_counts]
    return matrix


def _write_jazz_model(mined, out_path):
    if mined["pieces_used"] < 10:
        sys.exit("Too few usable solos, aborting rather than freezing a degenerate model.")

    major_matrix = normalize_root_matrix(mined["root_transitions"]["major"])
    minor_matrix = normalize_root_matrix(mined["root_transitions"]["minor"])

    def quality_dist(mode):
        out = {}
        for degree_pc in range(12):
            counts = mined["quality_by_root"][mode].get(degree_pc)
            if not counts:
                continue
            total = sum(counts.values())
            out[str(degree_pc)] = {q: c / total for q, c in counts.items()}
        return out

    total_intervals = sum(mined["interval_counts"].values())
    interval_dist = {str(k): v / total_intervals for k, v in sorted(mined["interval_counts"].items())} \
        if total_intervals else {"0": 1.0}

    cadences = [
        {"from_root_pc": frm, "to_root_pc": to, "weight": count}
        for (frm, to), count in mined["cadence_bigrams"].most_common(8)
    ]

    min_performer_solos = mined["min_performer_solos"]
    performer_intervals = {}
    for performer, count in mined["performer_song_counts"].items():
        if count < min_performer_solos:
            continue
        counts = mined["performer_interval_counts"][performer]
        total = sum(counts.values())
        if total == 0:
            continue
        performer_intervals[performer] = {str(k): v / total for k, v in sorted(counts.items())}

    model = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": "jazz",
        "corpus": mined["source_label"],
        "performers": mined["performers"],
        "pieces_used": mined["pieces_used"],
        "pieces_skipped": mined["pieces_skipped"],
        "pieces_errored": mined["pieces_errored"],
        "root_transition_matrix_major": major_matrix,   # 12x12, pc = semitones from tonic (0-11)
        "root_transition_matrix_minor": minor_matrix,
        "quality_distribution_by_root_major": quality_dist("major"),   # {"0":{"maj7":.6,...}, ...}
        "quality_distribution_by_root_minor": quality_dist("minor"),
        "melodic_interval_distribution": interval_dist,
        "cadence_patterns": cadences,   # from_root_pc/to_root_pc, NOT from_degree/to_degree --
                                         # this is a chromatic root distance, not a diatonic degree
        "performer_interval_distributions": performer_intervals,
        "notes": (
            "STRUCTURALLY DIFFERENT from corpus_model.json (lieder/bach): 12-note chromatic "
            "root-transition matrices (pc = semitones from the solo's own tonic), not 7-degree "
            "diatonic ones -- jazz harmony (secondary dominants, tritone subs) doesn't fit a "
            "diatonic Roman-numeral model. quality_distribution_by_root_* gives the chord "
            "quality (maj/min/dom7/maj7/m7b5/dim7/aug/sus) actually played at each root, mined "
            "not assumed. One key per solo (the database's own annotation) -- modulating "
            "standards are flattened to their nominal key. performer_interval_distributions is "
            f"almost entirely horn/reed soloists (>=  {min_performer_solos} solos each) -- see "
            "this script's module docstring for why that's a good fit for the engine's "
            "monophonic melody voice, not a gap. NOT YET WIRED into caidence.py -- the engine's "
            "harmonic model (TRIADS, chorale_voicing) is still triad-only; rendering this "
            "through a triad-based engine would silently drop the chord qualities this file "
            "exists to capture. See BUILD_NOTES.md before wiring in a --corpus jazz flag."
        ),
    }

    with open(out_path, "w") as f:
        json.dump(model, f, indent=2)
    print(f"Wrote {out_path}")
    print(f"Performers ({len(mined['performers'])} total, "
          f"{len(model['performer_interval_distributions'])} with >= {min_performer_solos} solos): "
          f"{', '.join(mined['performers'][:6])} ...")
    if cadences:
        print(f"Top cadence: root pc {cadences[0]['from_root_pc']} -> {cadences[0]['to_root_pc']} "
              f"({cadences[0]['weight']} occurrences)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["lieder", "bach", "jazz"], default="lieder")
    ap.add_argument("--lieder-root", default=DEFAULT_LIEDER_ROOT)
    ap.add_argument("--jazz-db", default=DEFAULT_JAZZ_DB)
    ap.add_argument("--limit", type=int, default=None, help="cap number of pieces (debugging)")
    ap.add_argument("--out", default=None,
                     help="default: corpus_model.json (lieder/bach) or corpus_model_jazz.json (jazz)")
    args = ap.parse_args()

    if args.source == "jazz":
        mined = mine_jazz(args.jazz_db, limit=args.limit)
        _write_jazz_model(mined, args.out or "corpus_model_jazz.json")
        return

    if args.source == "bach":
        mined = mine_bach(limit=args.limit)
    else:
        mined = mine_lieder(args.lieder_root, limit=args.limit)
    args.out = args.out or "corpus_model.json"

    if mined["pieces_used"] < 10:
        sys.exit("Too few usable pieces, aborting rather than freezing a degenerate model.")

    major_matrix = normalize_matrix(mined["major_transitions"])
    minor_matrix = normalize_matrix(mined["minor_transitions"]) if mined["minor_transitions"] else major_matrix

    total_intervals = sum(mined["interval_counts"].values())
    interval_dist = {str(k): v / total_intervals for k, v in sorted(mined["interval_counts"].items())} \
        if total_intervals else {"0": 1.0}

    cadences = [
        {"from_degree": frm, "to_degree": to, "weight": count}
        for (frm, to), count in mined["cadence_bigrams"].most_common(8)
    ]

    # Per-composer melodic-interval distributions, for a solo/melody voice that rotates
    # between composer "handwriting" styles. Only composers with enough songs to be a real
    # distribution rather than smoothing noise (see corpus_model_min_composer_songs).
    min_composer_songs = 9
    composer_intervals = {}
    for composer, count in mined["composer_song_counts"].items():
        if count < min_composer_songs:
            continue
        counts = mined["composer_interval_counts"][composer]
        total = sum(counts.values())
        if total == 0:
            continue
        composer_intervals[composer] = {str(k): v / total for k, v in sorted(counts.items())}

    model = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "music21_version": music21.__version__,
        "source": args.source,
        "corpus": mined["source_label"],
        "composers": mined["composers"],
        "pieces_used": mined["pieces_used"],
        "pieces_skipped": mined["pieces_skipped"],
        "pieces_errored": mined["pieces_errored"],
        "degree_transition_matrix": major_matrix,          # kept for backwards compat -- healthy baseline uses this
        "degree_transition_matrix_major": major_matrix,
        "degree_transition_matrix_minor": minor_matrix,     # available for a future mode-shift/escalation signal
        "melodic_interval_distribution": interval_dist,
        "cadence_patterns": cadences,
        "composer_interval_distributions": composer_intervals,   # {composer: {interval: prob}}, min_composer_songs cutoff
        "notes": (
            "Dynamics/velocity/tempo intentionally excluded -- those channels are "
            "telemetry-driven per the mapping spec, not corpus-driven. Minor-mode matrix is "
            "mined but not yet wired into the engine's healthy baseline (spec SS2: mode shift "
            "is reserved for a future degraded-state signal). composer_interval_distributions "
            f"only includes composers with >= {min_composer_songs} songs mined."
        ),
    }

    with open(args.out, "w") as f:
        json.dump(model, f, indent=2)
    print(f"Wrote {args.out}")
    print(f"Composers: {', '.join(mined['composers'][:6])}"
          f"{' ...' if len(mined['composers']) > 6 else ''}")
    if cadences:
        print(f"Top cadence: degree {cadences[0]['from_degree']} -> {cadences[0]['to_degree']} "
              f"({cadences[0]['weight']} occurrences)")


if __name__ == "__main__":
    main()
