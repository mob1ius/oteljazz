#!/usr/bin/env python3
"""Generate the paper's figures from REAL engine output, not hand-drawn mockups.

Every number in Figure 1 is measured from a `--swarm` run and its exported note events, so the
figure and the prose in 07-oversight-symphony-sonification.md cannot drift apart: regenerate
after any mapping change and the figure updates with the engine.

    python3 make_figures.py [--seed N] [--outdir figures]

Outputs PDF (vector, for camera-ready) and PNG (for preview) per figure.

Design constraints, deliberate:
  - GREYSCALE-SAFE. Proceedings print black and white and reviewers print to whatever is in the
    office. Nothing is encoded by colour alone; every series is separable by linestyle, marker,
    or hatch. Colours are a redundant channel, not the channel.
  - VECTOR. PDF is the camera-ready format; PNG is a convenience preview only.
  - The seed is stamped into the caption text this script prints, because Section 6 rests on
    stimulus reproducibility and a figure whose provenance is unstated undercuts that argument.
"""
import argparse, json, os, subprocess, sys, tempfile

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swarm as S

# NOTE (this session): swarm.py used to pool subagent identity onto 3 literal voice names
# ("worker1".."worker3") before caidence.py ever saw a span, so REAL_AGENTS used to be exactly
# that closed set. That pooling moved to caidence.py's VoicePool (see its block comment) --
# spans now carry each subagent's TRUE, unbounded id (e.g. "subagent-r1-5"), which is the whole
# point of the fix (it's what makes a real scaling/saturation figure possible at all). "agents"
# below now just counts distinct span["agent"] values directly; REAL_AGENTS as a membership
# filter no longer means anything and would silently zero out Figure 1's agent-count panel if
# left in place. 'tools' and 'melody' remain VOICES, not agents -- never conflate those.

INK = "#1a1a1a"
MID = "#6e6e6e"

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "DejaVu Serif"],
    "font.size": 9,
    "axes.edgecolor": INK,
    "axes.labelcolor": INK,
    "text.color": INK,
    "xtick.color": INK,
    "ytick.color": INK,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "savefig.bbox": "tight",
    "savefig.pad_inches": 0.02,
})


def render(spans, seed):
    """Run the real engine over `spans` and return (sections, notes, voices)."""
    tmp = os.path.join(tempfile.gettempdir(), f"caidence_fig_{seed}.json")
    subprocess.run([sys.executable, "caidence.py", "--swarm", "--seed", str(seed),
                    "--export-events", tmp, "--port", "none"],
                   capture_output=True, text=True,
                   cwd=os.path.dirname(os.path.abspath(__file__)))
    with open(tmp) as f:
        d = json.load(f)
    return S.derive_sections(spans), d["notes"], d["voices"]


def measure(spans, sections, notes, voices):
    """Per-movement: tempo, span rate, live agents, and chord voices actually sounding."""
    chord = {v for v, m in voices.items() if m["role"] == "chord"}
    rows = []
    for sec in sections:
        a, b = sec["start"], sec["end"]
        rows.append({
            "a": a, "b": b,
            "bpm": sec["tempo_bpm"],
            "rate": sec["_span_rate"],
            "agents": len({s["agent"] for s in spans if a <= s["start"] < b}),
            "chordv": len({n["voice"] for n in notes
                           if a <= n["t"] < b and n["voice"] in chord}),
        })
    return rows


def _step(ax, rows, key, **kw):
    """Draw a per-movement value as a step function across each movement's real extent."""
    xs, ys = [], []
    for r in rows:
        xs += [r["a"], r["b"]]
        ys += [r[key], r[key]]
    ax.plot(xs, ys, **kw)


def figure1(spans, rows, seed, outdir):
    """Telemetry in, two INDEPENDENT musical parameters out.

    The point of this figure is the decoupling at convergence: tempo returns to its opening value
    while ensemble thickness does not. Two channels, not one signal encoded twice.
    """
    fig, axes = plt.subplots(3, 1, figsize=(6.6, 5.4), sharex=True,
                             gridspec_kw={"height_ratios": [1.05, 1, 1], "hspace": 0.42})
    end = rows[-1]["b"]

    # movement bands, so the three panels read against a common structure
    for ax in axes:
        for i, r in enumerate(rows):
            if i % 2 == 0:
                ax.axvspan(r["a"], r["b"], color="#000000", alpha=0.035, lw=0)
        ax.set_xlim(0, end)

    # --- panel A: the telemetry itself
    ax = axes[0]
    for s in spans:
        ax.plot([s["start"]], [0.5], marker="|", ms=5, color=MID, mew=0.7)
    _step(ax, rows, "rate", color=INK, lw=1.5, solid_joinstyle="miter")
    ax.set_ylabel("spans / s")
    ax.set_ylim(0, max(r["rate"] for r in rows) * 1.18)
    ax.set_title("A   telemetry in: span arrival rate (ticks = individual spans)",
                 loc="left", fontsize=8.5, style="italic", pad=4)

    # --- panel B: tempo
    ax = axes[1]
    _step(ax, rows, "bpm", color=INK, lw=1.6)
    ax.set_ylabel("tempo (BPM)")
    ax.set_ylim(52, 152)
    ax.axhline(rows[0]["bpm"], color=MID, lw=0.8, ls=":", zorder=0)
    ax.set_title("B   tempo follows span rate, and RETURNS to its opening value",
                 loc="left", fontsize=8.5, style="italic", pad=4)
    ax.annotate(f"{rows[0]['bpm']} BPM", (rows[0]["a"] + 0.5, rows[0]["bpm"]),
                xytext=(0, 6), textcoords="offset points", fontsize=8)
    hi = max(rows, key=lambda r: r["bpm"])
    ax.annotate(f"{hi['bpm']} BPM", ((hi["a"] + hi["b"]) / 2, hi["bpm"]),
                xytext=(0, 5), textcoords="offset points", fontsize=8, ha="center")
    ax.annotate(f"{rows[-1]['bpm']} BPM", ((rows[-1]["a"] + rows[-1]["b"]) / 2, rows[-1]["bpm"]),
                xytext=(0, 9), textcoords="offset points", fontsize=8, ha="center")

    # --- panel C: ensemble thickness
    ax = axes[2]
    _step(ax, rows, "chordv", color=INK, lw=1.6, ls="--")
    _step(ax, rows, "agents", color=MID, lw=1.2, ls="-.")
    ax.set_ylabel("voices / agents")
    ax.set_ylim(0, 10.5)
    ax.set_yticks(range(0, 9, 2))
    ax.axhline(rows[0]["chordv"], color=MID, lw=0.8, ls=":", zorder=0)
    ax.set_title("C   ensemble thickness does NOT return: the channels are independent",
                 loc="left", fontsize=8.5, style="italic", pad=4)
    ax.plot([], [], color=INK, lw=1.6, ls="--", label="chord voices sounding")
    ax.plot([], [], color=MID, lw=1.2, ls="-.", label="live agents")
    ax.legend(loc="upper left", fontsize=7.5, frameon=False, ncol=2,
              handlelength=2.6, borderaxespad=0.1)
    ax.set_xlabel("time (s)")

    # the observation the figure exists to make
    last = rows[-1]
    ax.annotate(
        f"tempo back to opening,\nthickness stays at {last['chordv']}",
        xy=((last["a"] + last["b"]) / 2, last["chordv"]),
        xytext=(last["b"] - 0.5, 8.5), textcoords="data",
        fontsize=7.8, ha="right", va="center",
        arrowprops=dict(arrowstyle="->", lw=0.8, color=INK,
                        connectionstyle="arc3,rad=0.3"))

    for ext in ("pdf", "png"):
        fig.savefig(os.path.join(outdir, f"fig1_channels.{ext}"), dpi=300)
    plt.close(fig)


def figure2(outdir):
    """The perceptual claim: 7 chord voices FUSE into one object; 2 streams stay segregable.

    Conceptual, not data-driven -- it illustrates the stream-segregation argument in Section 4,
    which is the paper's central perceptual commitment and was prose-only before this.
    """
    fig, ax = plt.subplots(figsize=(6.6, 3.9))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 10)
    ax.axis("off")

    L, R = 2.15, 6.75          # box extent
    CX = (L + R) / 2
    # label backgrounds match the block fill, so a label reads as text ON the object rather
    # than as a nested box
    WHITE = dict(facecolor="#f4f4f4", edgecolor="none", pad=2.0)

    def box(y, h, fc="white"):
        ax.add_patch(FancyBboxPatch((L, y), R - L, h,
                                    boxstyle="round,pad=0.012,rounding_size=0.05",
                                    lw=1.1, ec=INK, fc=fc, zorder=2))

    # register axis
    ax.annotate("", xy=(1.45, 8.85), xytext=(1.45, 1.15),
                arrowprops=dict(arrowstyle="<->", lw=1.0, color=MID))
    ax.text(1.16, 5.0, "register", rotation=90, va="center", ha="center",
            fontsize=8, color=MID)

    # --- stream 2: solo line
    box(7.75, 1.1)
    ax.text(CX, 8.48, "solo piano line", ha="center", va="center", fontsize=9, zorder=3)
    ax.text(CX, 8.02, "own register, own rhythm, phrased with rests",
            ha="center", va="center", fontsize=7.2, style="italic", color=MID, zorder=3)

    # --- the fused object: 7 chord voices
    box(3.35, 4.0, fc="#f4f4f4")
    for i in range(7):
        yy = 3.68 + i * 0.545
        ax.plot([L + 0.42, R - 0.42], [yy, yy], lw=0.8, color=MID, zorder=3)
    ax.text(CX, 6.15, "7 chord voices, uniform piano timbre",
            ha="center", va="center", fontsize=9, zorder=4, bbox=WHITE)
    ax.text(CX, 5.35, "shared timbre  +  shared onset grid  +  voice-led motion",
            ha="center", va="center", fontsize=7.2, style="italic", color=MID,
            zorder=4, bbox=WHITE)
    ax.text(CX, 4.62, "segregation cues deliberately withheld",
            ha="center", va="center", fontsize=7.2, style="italic", color=MID,
            zorder=4, bbox=WHITE)

    # --- stream 3: bass
    box(1.15, 1.1)
    ax.text(CX, 1.88, "walking bass", ha="center", va="center", fontsize=9, zorder=3)
    ax.text(CX, 1.42, "distinct instrument, own register, steady pulse",
            ha="center", va="center", fontsize=7.2, style="italic", color=MID, zorder=3)

    # --- brace marking the fused object
    bx = R + 0.22
    ax.plot([bx, bx], [3.35, 7.35], lw=1.1, color=INK)
    for yy in (3.35, 7.35):
        ax.plot([bx, bx + 0.18], [yy, yy], lw=1.1, color=INK)
    ax.text(bx + 0.32, 5.35, "heard as ONE\nharmonic object", va="center", fontsize=8.5)
    ax.text(bx + 0.32, 8.30, "stream 2", va="center", fontsize=8, color=MID)
    ax.text(bx + 0.32, 1.70, "stream 3", va="center", fontsize=8, color=MID)

    ax.text(0.1, 9.72, "Approximately 3 concurrent auditory objects, not 9 streams",
            fontsize=9.5, va="top")
    ax.text(0.1, 0.55,
            "Thickness = live agent count.   Spelling = coherence.   Detuning = drift.\n"
            "Monitored as properties OF the object, without decomposing it.",
            fontsize=7.4, va="top", color=MID)

    for ext in ("pdf", "png"):
        fig.savefig(os.path.join(outdir, f"fig2_perceptual.{ext}"), dpi=300)
    plt.close(fig)


def figure3(outdir, pool_slots=None, trials_per_fanout=5, fanouts=None):
    """The saturation ceiling: real measurement, not an assertion.

    caidence.VoicePool compresses however many TRUE agent identities a swarm produces onto a
    small fixed set of physical voices (POOL_SLOTS = 3 worker slots), stealing the
    longest-idle slot when a new identity arrives and none are free. Below fanout ~3 (concurrent
    subagents <= pool capacity) that never happens; above it, every additional concurrent agent
    forces a steal. This is exactly the "genuine scaling figure" Section 6 needed and previously
    only asserted -- it was unmeasurable before this session because swarm.py used to pool
    identity itself, before caidence.py (the mapping engine) ever saw more than 3 distinct names.

    Averaged over `trials_per_fanout` seeds per fanout value, because SwarmSim's own randomness
    (tool-call counts, latencies) makes a single run noisy at the high end."""
    import caidence as C
    pool_slots = pool_slots or len(C.POOL_SLOTS)
    fanouts = fanouts or [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32]

    rows = []
    for fanout in fanouts:
        distinct_list, overflow_list, dur_list = [], [], []
        for seed in range(trials_per_fanout):
            spans = S.SwarmSim(seed=seed, fanout=fanout, rounds=2).run()
            distinct_list.append(len({s["agent"] for s in spans}))
            _resolved, pool = C.pool_spans(spans)
            overflow_list.append(pool.overflow_events)
            dur_list.append(max(s["start"] + s["duration"] for s in spans))
        n = len(distinct_list)
        avg_distinct = sum(distinct_list) / n
        avg_overflow = sum(overflow_list) / n
        avg_overflow_per_min = avg_overflow / (sum(dur_list) / n) * 60
        rows.append(dict(fanout=fanout, distinct=avg_distinct, overflow=avg_overflow,
                          overflow_per_min=avg_overflow_per_min))

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(6.6, 2.9))

    # --- panel A: true agent count vs. fanout (linear, no ceiling -- the pool doesn't cap THIS)
    xs = [r["fanout"] for r in rows]
    ax1.plot(xs, [r["distinct"] for r in rows], color=INK, lw=1.4, marker="o", ms=5.5,
             mfc=INK, mec="white", mew=0.8)
    ax1.set_xlabel("--fanout (subagents/round)")
    ax1.set_ylabel("true distinct agents")
    ax1.set_title("A   identity is never lost upstream", loc="left", fontsize=8.5,
                  style="italic", pad=4)

    # --- panel B: overflow events vs fanout, with the pool-capacity threshold marked
    ax2.plot(xs, [r["overflow_per_min"] for r in rows], color=INK, lw=1.4, marker="s", ms=5.5,
             mfc=INK, mec="white", mew=0.8)
    ax2.axvline(pool_slots, color=MID, lw=0.9, ls=":", zorder=0)
    ax2.annotate(f"pool capacity\n({pool_slots} slots)", xy=(pool_slots, 0),
                xytext=(pool_slots + 0.6, ax2.get_ylim()[1] * 0.72 if ax2.get_ylim()[1] else 5),
                fontsize=7.2, color=MID, ha="left")
    ax2.set_xlabel("--fanout (subagents/round)")
    ax2.set_ylabel("forced slot steals / min")
    ax2.set_title("B   the ceiling: measured, not asserted", loc="left", fontsize=8.5,
                  style="italic", pad=4)

    fig.tight_layout()
    for ext in ("pdf", "png"):
        fig.savefig(os.path.join(outdir, f"fig3_saturation.{ext}"), dpi=300)
    plt.close(fig)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--outdir", default="figures")
    a = ap.parse_args()

    os.makedirs(a.outdir, exist_ok=True)
    spans = S.SwarmSim(seed=a.seed).run()
    sections, notes, voices = render(spans, a.seed)
    rows = measure(spans, sections, notes, voices)

    figure1(spans, rows, a.seed, a.outdir)
    figure2(a.outdir)
    sat_rows = figure3(a.outdir)

    print(f"seed={a.seed}  {len(spans)} spans  {len(rows)} movements  -> {a.outdir}/")
    print(f"{'mv':>2} {'bpm':>4} {'rate':>5} {'agents':>6} {'chordv':>6}")
    for i, r in enumerate(rows, 1):
        print(f"{i:>2} {r['bpm']:>4} {r['rate']:>5.2f} {r['agents']:>6} {r['chordv']:>6}")

    print(f"\nfig3 saturation sweep ({len(sat_rows)} fanout values, 5 seeds each):")
    print(f"{'fanout':>6} {'distinct':>8} {'overflow/min':>12}")
    for r in sat_rows:
        print(f"{r['fanout']:>6} {r['distinct']:>8.1f} {r['overflow_per_min']:>12.1f}")


if __name__ == "__main__":
    main()
