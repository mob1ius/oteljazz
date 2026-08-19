#!/usr/bin/env python3
"""
live_producer.py - synthetic OTel span producer, for testing live.py before pointing it at a
real agent swarm.

Uses the REAL opentelemetry-sdk + OTLP/HTTP exporter (not a hand-rolled JSON/protobuf sender) --
the whole point of testing against this is to exercise the actual wire protocol live.py has to
parse, not a format we invented ourselves. Streams caidence.py's own trace generators
(extended_demo_trace or synthetic_trace) out in real time: one thread per span, each sleeping
until its scheduled start, then recording a real span with the right gen_ai.* attributes for
its scheduled duration.

Uses SimpleSpanProcessor, not the SDK's default BatchSpanProcessor -- Batch's default 5-second
schedule delay would clump every span into 5-second bursts instead of arriving as scheduled,
which would look like a broken receiver rather than a batching default.

Usage:
  python3 live_producer.py                         # streams the extended demo trace at 1x
  python3 live_producer.py --trace synthetic        # streams the ~30s calibration trace instead
  python3 live_producer.py --speed 2.0              # twice as fast
  python3 live_producer.py --endpoint http://localhost:4318/v1/traces
"""

import argparse
import threading
import time

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.trace import Status, StatusCode

import caidence as c


def emit_one(tracer, span_dict, speed):
    time.sleep(span_dict["start"] / speed)
    with tracer.start_as_current_span(span_dict.get("op", "chat")) as span:
        span.set_attribute("gen_ai.operation.name", span_dict.get("op", "chat"))
        # gen_ai.agent.id is the real semconv's unique-identity attribute, which is what
        # caidence.VoicePool needs (live.py prefers it, falling back to .name) -- see
        # caidence.py's VOICE POOL block comment. Setting both keeps this producer readable by
        # anything that only knows the older .name-only convention too.
        span.set_attribute("gen_ai.agent.id", span_dict["agent"])
        span.set_attribute("gen_ai.agent.name", span_dict["agent"])
        if span_dict.get("tool"):
            span.set_attribute("gen_ai.tool.name", span_dict["tool"])
        span.set_attribute("gen_ai.usage.output_tokens", int(span_dict.get("tokens", 100)))
        if span_dict.get("status") == "error":
            span.set_status(Status(StatusCode.ERROR))
        time.sleep(span_dict.get("duration", 0.5) / speed)


def main():
    ap = argparse.ArgumentParser(description="Synthetic live OTel producer for testing live.py")
    ap.add_argument("--endpoint", default="http://localhost:4318/v1/traces")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--trace", choices=["synthetic", "demo", "swarm"], default="demo")
    ap.add_argument("--seed", type=int, default=0, help="--trace swarm: pipeline seed")
    args = ap.parse_args()

    provider = TracerProvider()
    exporter = OTLPSpanExporter(endpoint=args.endpoint)
    provider.add_span_processor(SimpleSpanProcessor(exporter))   # not Batch -- see docstring
    trace.set_tracer_provider(provider)
    tracer = trace.get_tracer("cAIdence-live-producer")

    if args.trace == "swarm":
        import swarm as swarm_mod
        spans, sections = swarm_mod.swarm_trace(seed=args.seed)
        print(swarm_mod.describe(spans, sections))
        print("\n(live.py derives no sections of its own -- it plays the spans as they arrive;\n"
              " the derived form above is what the BATCH path would build from this same run.)\n")
    elif args.trace == "demo":
        spans, _regime, _sections = c.extended_demo_trace()   # regime/sections ignored -- live mode stays major, unsectioned
    else:
        spans = c.synthetic_trace()
    print(f"Streaming {len(spans)} spans to {args.endpoint} in real time (speed={args.speed}x)...")

    threads = [threading.Thread(target=emit_one, args=(tracer, s, args.speed)) for s in spans]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    provider.shutdown()
    print("Done streaming.")


if __name__ == "__main__":
    main()
