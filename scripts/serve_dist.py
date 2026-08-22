#!/usr/bin/env python3
"""Serve dist/ locally WITH the production headers applied.

Plain `python3 -m http.server` sends no CSP, so it cannot catch the failure mode that matters
most before a launch: a Content-Security-Policy that blocks the page's own scripts. That fails
silently in the network tab and shows visitors a dead radio. This applies the same `_headers`
rules Cloudflare Pages will, so a CSP mistake surfaces here instead of in production.

    bash scripts/build_site.sh && python3 scripts/serve_dist.py
    # then open http://localhost:8999 and check the console for CSP violations
"""
import fnmatch
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
HEADERS_FILE = DIST / "_headers"


def parse_headers(path):
    """Parse Cloudflare's _headers format into [(pattern, {name: value}), ...]."""
    rules, pattern, current = [], None, {}
    for raw in path.read_text().splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if not raw.startswith((" ", "\t")):
            if pattern:
                rules.append((pattern, current))
            pattern, current = raw.strip(), {}
        elif ":" in raw:
            name, _, value = raw.strip().partition(":")
            current[name.strip()] = value.strip()
    if pattern:
        rules.append((pattern, current))
    return rules


class Handler(http.server.SimpleHTTPRequestHandler):
    rules = []

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        for pattern, headers in self.rules:
            if fnmatch.fnmatch(path, pattern) or (pattern == "/*" and path.startswith("/")):
                for name, value in headers.items():
                    self.send_header(name, value)
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    if not HEADERS_FILE.exists():
        sys.exit("dist/_headers not found -- run: bash scripts/build_site.sh")
    Handler.rules = parse_headers(HEADERS_FILE)
    print(f"serving {DIST} on http://localhost:8999 with production headers:")
    for pattern, headers in Handler.rules:
        print(f"  {pattern} -> {', '.join(headers)}")
    handler = functools.partial(Handler, directory=str(DIST))
    http.server.ThreadingHTTPServer(("127.0.0.1", 8999), handler).serve_forever()


if __name__ == "__main__":
    main()
