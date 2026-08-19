#!/usr/bin/env python3
"""
live.py - real OTLP receiver + real-time player for cAIdence (v0.1 of the live path)

Reads real OTel GenAI spans over the standard OTLP/HTTP wire protocol (protobuf, the default
encoding for every OTel SDK exporter -- verified empirically against the real Python SDK before
writing this, not assumed) and plays them as MIDI in real time, instead of caidence.py's
precompute-the-whole-piece-then-play model.

Scope of v0.1 (deliberately smaller than the batch/--demo path):
  - Harmonic backbone: yes, the same repeating FORM the batch path uses (FormSchedule +
    _extend_harmony below) -- the 7-voice jazz chorale voicing via c.jazz_chorale_voicing, the
    SAME function the batch path uses, with the two arch voices articulating each chord change.
  - Per-span DIRECT tier (spawn/activity/tool calls/tool errors): yes, via emit_span_events --
    the SAME function the batch path uses, imported from caidence.py, not a second mapping
    implementation. A real span's status=="error" from the actual OTel span status maps to the
    dissonant grace note exactly like a scripted one does.
  - Solo melody line: NOT YET. generate_solo_melody's batch implementation assumes it can walk
    from t=0 to a known total_seconds; making it incremental (remembering its last note/index
    across calls) is real work, scoped out of v0.1 to ship a working core loop first. This also
    means live mode currently has NO activity-driven note density -- that lives in the melody.
  - Mode/regime: always major (no regime_schedule live), so chord qualities are always drawn
    from the major per-root distribution. Drift/capture-spike/conflict/collusion are all
    SCRIPTED anomalies triggered by explicit flags on hand-authored spans (drift_start,
    conflict_start, etc.) -- they don't exist for arbitrary live spans, and deriving them from
    real telemetry is the Tier 2 "ambitious tier" work the spec itself defers (Section 9).
  - Sections: none. Fixed tempo (GRID_TEMPO), full ensemble always, no cadential section
    boundaries -- all of that is batch-only compositional form.

Threading (this matters -- mido ports are not thread-safe):
  Receiver HTTP threads (one per request, ThreadingHTTPServer) parse + convert spans and push
  onto a queue.Queue. Exactly ONE player thread owns the MIDI port: it drains the queue, extends
  the chord schedule/voicing, converts relative-second event times into absolute wall-clock due
  times on a heapq, and pops+sends when they come due. Nothing else touches the port or the heap.

Usage:
  python3 live.py --port "IAC Driver Bus 1"     # listens on :4318 for OTLP/HTTP traces
"""

import argparse
import heapq
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import mido
except ImportError:
    sys.exit("mido not installed. Run: pip install mido python-rtmidi")

try:
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
except ImportError:
    sys.exit("opentelemetry-proto not installed. Run: pip install opentelemetry-proto")

import caidence as c

OTLP_HTTP_PORT = 4318
GRID_TEMPO = 96.0   # live mode's fixed tempo -- see live.py docstring re: --speed being meaningless live
ACTIVITY_WINDOW_S = 8.0   # live proxy for batch's per-chord-window activity_level -- see _extend_pad

STATUS_CODE_ERROR = 2   # opentelemetry.proto.trace.v1.Status.StatusCode.STATUS_CODE_ERROR


def span_to_dict(otlp_span, t0_nano):
    """Convert one decoded OTLP span into caidence's internal span-dict format. t0_nano anchors
    the FIRST span's start as t=0 -- everything else becomes relative seconds from there, so the
    existing quantize()/grid math (built for a batch trace starting at t=0) keeps working
    unchanged. start_time_unix_nano/end_time_unix_nano decode as plain Python ints from
    protobuf (unlike OTLP/JSON, where the same fields arrive as strings -- verified, not
    assumed, against the real SDK's HTTP/protobuf exporter)."""
    attrs = {kv.key: getattr(kv.value, kv.value.WhichOneof("value"))
             for kv in otlp_span.attributes}
    start_s = (otlp_span.start_time_unix_nano - t0_nano) / 1e9
    duration_s = max(0.05, (otlp_span.end_time_unix_nano - otlp_span.start_time_unix_nano) / 1e9)
    return {
        # gen_ai.agent.id is the real semantic convention's UNIQUE identifier (what
        # caidence.VoicePool needs) -- gen_ai.agent.name is often a shared role/type label
        # ("code-reviewer") rather than a unique instance, so it's only the fallback for
        # instrumentation that doesn't set .id. Both being absent means a span this engine can't
        # attribute to any agent, hence the "worker1" default -- see caidence.VoicePool for why
        # that default is safe (it's just one true identity among however many are pooled).
        "agent": attrs.get("gen_ai.agent.id") or attrs.get("gen_ai.agent.name", "worker1"),
        "op": attrs.get("gen_ai.operation.name", "chat"),
        "start": max(0.0, start_s),
        "duration": duration_s,
        "tokens": attrs.get("gen_ai.usage.output_tokens", attrs.get("gen_ai.usage.input_tokens", 100)),
        "tool": attrs.get("gen_ai.tool.name"),
        "status": "error" if otlp_span.status.code == STATUS_CODE_ERROR else "ok",
    }


class FormSchedule:
    """The repeating form (caidence.generate_jazz_form), tiled bar by bar as real time passes.

    Much simpler than what this replaced (a lazily-extended Markov walk): the changes are a
    fixed list now, so "what chord is playing at bar N" is just an index into it. Live mode has
    no sections, so every bar is the same wall-clock length and the bar index is exact. Live is
    always major -- no regime_schedule -- so only the major realization is used."""

    def __init__(self, form, bar_s):
        self.form = form
        self.bar_s = bar_s

    def bar_at(self, t):
        return int(t // self.bar_s)

    def window(self, bar_idx):
        """(start, end, root_pc, quality) for the given absolute bar index."""
        root_pc, quality = self.form[bar_idx % len(self.form)]
        return bar_idx * self.bar_s, (bar_idx + 1) * self.bar_s, root_pc, quality


class LivePlayer:
    def __init__(self, port_name, corpus_model, seed=0, swing=c.SWING_DEFAULT):
        self.out = mido.open_output(port_name)
        self.corpus_model = corpus_model
        self.seed = seed
        self.swing = swing
        self.grid = c.grid_seconds(GRID_TEMPO)
        self.chord_s = c.BARS_PER_CHORD * self.grid * 16
        major_form, _minor_form = c.generate_jazz_form(corpus_model, seed=seed)
        self.schedule = FormSchedule(major_form, self.chord_s)
        print(f"Form ({c.FORM_BARS} bars, repeats every chorus):\n  {c.form_as_text(major_form)}")

        self.q = queue.Queue()
        self.heap = []            # (due_wall_time, counter, msg)
        self._counter = 0
        self._heap_lock = threading.Lock()
        self.t0_wall = None       # wall-clock time corresponding to relative t=0
        self.t0_nano = None       # first span's OTel start time, anchors relative time
        self.chord_boundaries_seen = 0
        self.voicing = None             # current 7-voice chorale voicing (c.jazz_chorale_voicing),
                                         # see _extend_harmony -- the SAME function the batch path
                                         # uses, per CLAUDE.md's "exactly one mapping" rule
        self.quality = "dom7"           # current chord quality, needed by emit_span_events
        self.root_pc = 0                # current chord root, needed by emit_span_events
        self.voice_pool = c.VoicePool()  # true agent id -> physical chord voice, run per-span as
                                          # spans actually arrive -- the SAME class/algorithm
                                          # build_timeline runs in one pass over a sorted list
                                          # (see caidence.py's VOICE POOL block comment). This is
                                          # what replaced the old "role = agent if agent in
                                          # CHORD_AGENT_VOICES else tools" line: that fallback
                                          # meant every real (unpooled) agent id EXCEPT the 5
                                          # literal voice names silently played on "tools"
                                          # regardless of whether it was even a tool call.
        self.bass_note = sum(c.BASS_RANGE) // 2   # walking-bass position, voice-led bar to bar
        self._prev_root = None          # previous bar's root, for cadence emphasis
        # Two separate last-seen maps, because activity_level and live_voices now need two
        # different things: activity_level counts TRUE distinct agents (unbounded, matches the
        # batch path's post-fix definition), live_voices needs PHYSICAL voice names (bounded,
        # what jazz_chorale_voicing's sounding_voices actually keys on). Both updated together
        # per span in run()'s receive loop.
        self.recent_true_agent_seen = {}   # true agent id -> last-seen relative time
        self.recent_voice_seen = {}        # physical voice -> last-seen relative time

        for role, (ch, prog, _base) in c.VOICES.items():
            self.out.send(mido.Message("program_change", channel=ch, program=prog))

    def submit_span_dict(self, span_dict):
        """Called from receiver threads. Only touches the thread-safe queue."""
        self.q.put(span_dict)

    def _add_relative(self, t_relative, msg):
        """Convert a relative-second event time into an absolute wall-clock due time and push
        onto the heap. Only ever called from the player thread.

        Swing is applied here rather than as a whole-timeline pass (live has no whole timeline to
        pass over), which works because c.apply_swing is a pure function of the time and the beat
        length -- every voice therefore swings identically, same as batch. Live has one fixed
        tempo, so the beat length is constant."""
        if self.t0_wall is None:
            return   # no spans yet -- shouldn't happen, but don't crash on it
        if msg.type in ("note_on", "note_off"):
            msg.note = c.transposed_note(msg.channel, msg.note)   # see VOICE_OUTPUT_TRANSPOSE
        due = self.t0_wall + c.apply_swing(t_relative, 60.0 / GRID_TEMPO, self.swing)
        with self._heap_lock:
            heapq.heappush(self.heap, (due, self._counter, msg))
            self._counter += 1

    def _extend_harmony(self, now_relative):
        """Walk the harmony forward through any chord boundaries up to now_relative: advance the
        7-voice chorale voicing (c.jazz_chorale_voicing -- the SAME function the batch path
        uses, one window at a time instead of all at once) and lay down the COMP, exactly like
        the batch path's comp loop. No final note-off -- live has no 'end', only Ctrl-C.

        Root and quality both come from the form, exactly as in batch -- same tune, same key,
        same recurrence. Live voices are the arch pair plus any agent seen within
        COMP_LIVE_WINDOW_S, so the chord thins as agents go quiet and is fully spelled while the
        swarm works, same as batch. The one necessary difference from batch is that both
        activity_level and liveness use a real-time backward-looking window: live can't look
        ahead into future spans the way batch's per-window count does. Live is always major --
        no regime_schedule -- so only the major realization of the form is ever used, and there
        are no sections, so nothing is ever gated out of the comp."""
        while True:
            bar_idx = self.chord_boundaries_seen
            start, chord_end, root_pc, quality = self.schedule.window(bar_idx)
            if start > now_relative + self.chord_s:   # don't get too far ahead
                break
            activity_level = sum(1 for last_seen in self.recent_true_agent_seen.values()
                                  if start - last_seen <= ACTIVITY_WINDOW_S)
            live_voices = set(c.ARCH_VOICES) | {
                voice for voice, last_seen in self.recent_voice_seen.items()
                if voice in c.CHORD_AGENT_VOICES and start - last_seen <= c.COMP_LIVE_WINDOW_S
            }
            self.voicing = c.jazz_chorale_voicing(self.voicing, root_pc, quality,
                                                   sounding_voices=live_voices)
            bass_idx = c.bass_tone_choice(activity_level, f"live-bass-tone-{bar_idx}-seed{self.seed}")
            self.bass_note = c.bass_target(root_pc, quality, bass_idx)
            self.quality, self.root_pc = quality, root_pc

            dur = min(chord_end - start, 6.0) * c.COMP_SUSTAIN_FRAC
            # Same emphasis rules as batch: lean on the top of a chorus and on a V -> I arrival.
            # No anticipation/push live -- pushing a chord early means emitting it before its bar,
            # and the player only ever looks forward, so there is no previous bar left to shorten.
            accent = c.COMP_ACCENT_FORM_TOP if bar_idx % c.FORM_BARS == 0 else 0
            if self._prev_root == 7 and root_pc == 0:
                accent += c.COMP_ACCENT_CADENCE
            self._prev_root = root_pc
            for voice in c.CHORD_VOICE_ORDER:
                if voice not in live_voices:
                    continue
                ch = c.VOICES[voice][0]
                note = self.voicing[voice]
                vel = max(1, min(127, c.COMP_VELOCITY + accent))
                self._add_relative(start, mido.Message("note_on", channel=ch, note=note,
                                                        velocity=vel))
                self._add_relative(start + dur, mido.Message("note_off", channel=ch, note=note,
                                                              velocity=0))

            # Walking bass on ch9, same generator as batch. Live can't see the NEXT bar's target
            # from a voicing it hasn't computed yet, so it derives it from the form directly --
            # the form is fixed and known in advance, which is exactly what makes a walk (which
            # must aim at where the harmony is GOING) possible live at all.
            nxt_root, nxt_quality = self.schedule.form[(bar_idx + 1) % len(self.schedule.form)]
            next_target = c.bass_target(nxt_root, nxt_quality, 0)
            beat_s = (chord_end - start) / 4.0
            four_feel = activity_level >= c.WALK_FOUR_FEEL_ACTIVITY
            bass_ch = c.VOICES[c.BASS_VOICE][0]
            for beat_off, note in c.walking_bass_bar(self.bass_note, next_target,
                                                      root_pc, quality, four_feel,
                                                      f"live-walk-{bar_idx}-seed{self.seed}"):
                t0 = start + beat_off * beat_s
                vel = c.WALK_VELOCITY + (c.COMP_ACCENT_FORM_TOP // 2
                                          if (bar_idx % c.FORM_BARS == 0 and beat_off == 0.0) else 0)
                vel = max(1, min(127, vel))
                note = max(0, min(127, note))
                self._add_relative(t0, mido.Message("note_on", channel=bass_ch, note=note,
                                                     velocity=vel))
                self._add_relative(t0 + beat_s * c.WALK_NOTE_FRAC,
                                    mido.Message("note_off", channel=bass_ch, note=note, velocity=0))

            self.chord_boundaries_seen += 1

    def run(self):
        print("Live player running. Ctrl-C to stop.")
        try:
            while True:
                # Drain incoming spans (non-blocking).
                while True:
                    try:
                        span_dict = self.q.get_nowait()
                    except queue.Empty:
                        break
                    if self.t0_wall is None:
                        self.t0_wall = time.time()
                        print(f"First span received -- clock started.")
                    onset = c.quantize(span_dict["start"], self.grid)
                    true_id = span_dict["agent"]
                    terminal = span_dict.get("stop_reason") in c.TERMINAL_STOP_REASONS
                    resolved_voice = c.resolve_voice(self.voice_pool, true_id, onset, terminal=terminal)
                    self.recent_true_agent_seen[true_id] = onset
                    self.recent_voice_seen[resolved_voice] = onset
                    c.emit_span_events(span_dict, onset, self.root_pc, self.quality,
                                        self.voicing or {}, self._add_relative,
                                        resolved_voice=resolved_voice)

                if self.t0_wall is not None:
                    self._extend_harmony(time.time() - self.t0_wall)

                now = time.time()
                with self._heap_lock:
                    while self.heap and self.heap[0][0] <= now:
                        _, _, msg = heapq.heappop(self.heap)
                        self.out.send(msg)
                time.sleep(0.005)
        except KeyboardInterrupt:
            print("\nInterrupted.")
        finally:
            c.all_off(self.out)
            self.out.close()
            print("Done.")


class OTLPHandler(BaseHTTPRequestHandler):
    player = None   # set by main() before serving

    def do_POST(self):
        if self.path != "/v1/traces":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            req = ExportTraceServiceRequest()
            req.ParseFromString(body)
            for rs in req.resource_spans:
                for ss in rs.scope_spans:
                    for span in ss.spans:
                        if OTLPHandler.player.t0_nano is None:
                            OTLPHandler.player.t0_nano = span.start_time_unix_nano
                        span_dict = span_to_dict(span, OTLPHandler.player.t0_nano)
                        OTLPHandler.player.submit_span_dict(span_dict)
        except Exception as e:
            print(f"Failed to parse OTLP payload: {e}")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, fmt, *args):
        pass   # quiet -- the player prints what matters


def main():
    ap = argparse.ArgumentParser(description="cAIdence live OTLP receiver + player")
    ap.add_argument("--port", required=True, help="MIDI output port (substring match ok)")
    ap.add_argument("--seed", type=int, default=0, help="form (tune) seed (default 0)")
    ap.add_argument("--swing", type=float, default=c.SWING_DEFAULT,
                     help=f"swing ratio: 0.5 = straight, 0.667 = full triplet feel")
    ap.add_argument("--otlp-port", type=int, default=OTLP_HTTP_PORT)
    args = ap.parse_args()

    midi_port = c.pick_port(args.port)
    corpus_model = c.load_corpus_model()
    player = LivePlayer(midi_port, corpus_model, seed=args.seed, swing=args.swing)
    OTLPHandler.player = player

    server = ThreadingHTTPServer(("localhost", args.otlp_port), OTLPHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"OTLP/HTTP receiver listening on http://localhost:{args.otlp_port}/v1/traces")
    print(f"MIDI out: {midi_port}")

    player.run()
    server.shutdown()


if __name__ == "__main__":
    main()
