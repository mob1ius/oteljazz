#!/usr/bin/env python3
"""render_test_audio.py -- a dependency-free WAV renderer for the forced-choice drift
perceptual check ONLY. Not the paper's supplementary-audio pipeline (that uses real sample
libraries via Logic/Web Audio, see zenodo_deposit/). This exists because this machine has no
numpy, fluidsynth, or soundfont available, and the perceptual check doesn't need real timbre --
it needs the timing artifact (drift's onset lag) to be audible, which a plain additive synth with
an ADSR envelope is enough for.

Reads the note-event JSON `export_events()` (caidence.py) already produces -- {"notes": [{t, ch,
voice, note, vel, dur}, ...], "deviations": [{t, voice, semitones}, ...]} -- and renders one clip
(a [clip_start, clip_end) window) to a mono 16-bit WAV. Each note is 3 stacked sine partials
(fundamental + 2 harmonics, falling amplitude) with a short linear attack/release; `deviations`
(drift's pitch-bend micro-cue) are applied as a per-voice nearest-preceding semitone offset at
each note's onset, since the ramp is slow relative to note length.
"""
import argparse
import json
import math
import struct
import wave


def midi_to_freq(note):
    return 440.0 * (2.0 ** ((note - 69) / 12.0))


def render_clip(events_path, out_path, clip_start, clip_end, sample_rate=22050):
    with open(events_path) as f:
        data = json.load(f)
    notes = data["notes"]
    deviations = data.get("deviations", [])

    dev_by_voice = {}
    for d in deviations:
        dev_by_voice.setdefault(d["voice"], []).append((d["t"], d["semitones"]))
    for pts in dev_by_voice.values():
        pts.sort()

    def bend_at(voice, t):
        pts = dev_by_voice.get(voice)
        if not pts:
            return 0.0
        semis = 0.0
        for pt_t, s in pts:
            if pt_t <= t:
                semis = s
            else:
                break
        return semis

    dur_s = clip_end - clip_start
    n_samples = max(1, int(dur_s * sample_rate))
    buf = [0.0] * n_samples

    for n in notes:
        t0, d = n["t"], n["dur"]
        if t0 + d < clip_start or t0 > clip_end:
            continue
        rel_t0 = t0 - clip_start
        bend = bend_at(n["voice"], t0)
        freq = midi_to_freq(n["note"] + bend)
        amp = (n["vel"] / 127.0) * 0.18
        start_i = max(0, int(rel_t0 * sample_rate))
        end_i = min(n_samples, int((rel_t0 + d) * sample_rate))
        length = end_i - start_i
        if length <= 0:
            continue
        attack = min(0.01, d * 0.2)
        release = min(0.15, d * 0.4)
        two_pi_f = 2 * math.pi * freq
        for i in range(length):
            tt = i / sample_rate
            if tt < attack:
                env = tt / attack
            elif tt > d - release:
                env = max(0.0, (d - tt) / release)
            else:
                env = 1.0
            phase = two_pi_f * tt
            sample = (math.sin(phase) + 0.35 * math.sin(2 * phase) +
                      0.15 * math.sin(3 * phase)) * amp * env
            buf[start_i + i] += sample

    peak = max((abs(x) for x in buf), default=0.0)
    scale = 0.9 / peak if peak > 0.9 else 1.0
    pcm = bytearray()
    for x in buf:
        v = int(max(-1.0, min(1.0, x * scale)) * 32767)
        pcm += struct.pack("<h", v)

    with wave.open(out_path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(bytes(pcm))
    return n_samples / sample_rate


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("events", help="path to a --export-events JSON file")
    ap.add_argument("--out", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--sample-rate", type=int, default=22050)
    args = ap.parse_args()
    secs = render_clip(args.events, args.out, args.start, args.end, sample_rate=args.sample_rate)
    print(f"Wrote {secs:.2f}s to {args.out}")


if __name__ == "__main__":
    main()
