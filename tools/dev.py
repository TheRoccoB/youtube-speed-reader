#!/usr/bin/env python3
"""
Development server for the Chrome extension.

  python3 tools/dev.py

What it does:
  1. Builds dist/dev/ once on startup.
  2. Watches src/ and tools/dev-reloader.js for any change (mtime polling).
  3. On change, rebuilds dist/dev/ and bumps an in-memory version counter.
  4. Serves http://localhost:8765/dev/version  →  {"version": "<int>"}

The dev-reloader.js service worker (only present in the dev build) polls that
endpoint every 2 seconds. When the version changes it reloads any open
YouTube tabs and then reloads the extension itself.

How to use:
  • In one terminal:  python3 tools/dev.py
  • In Chrome:        chrome://extensions → Load unpacked → select dist/dev/
  • Edit src/content.js (or anything in src/). The build rebuilds; YouTube
    tab reloads ~2-4 seconds later. No manual reload needed.
"""
from __future__ import annotations
import http.server
import json
import os
import socketserver
import sys
import threading
import time

# Make the build module importable when run as a script.
THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if THIS_DIR not in sys.path:
    sys.path.insert(0, THIS_DIR)

import build as build_mod  # noqa: E402

ROOT  = os.path.dirname(THIS_DIR)
SRC   = os.path.join(ROOT, 'src')
PORT  = build_mod.DEV_SERVER_PORT  # 8765
WATCHED_PATHS = [SRC, os.path.join(THIS_DIR, 'dev-reloader.js')]
POLL_INTERVAL_S = 1.0


# ------------------------------------------------------------------
# Shared state
# ------------------------------------------------------------------
class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.version = self._now_token()

    @staticmethod
    def _now_token() -> str:
        return str(int(time.time() * 1000))

    def bump(self) -> str:
        with self.lock:
            self.version = self._now_token()
            return self.version

    def get(self) -> str:
        with self.lock:
            return self.version


state = State()


# ------------------------------------------------------------------
# File watcher
# ------------------------------------------------------------------
def collect_mtimes(paths: list[str]) -> dict[str, float]:
    """Return a {path: mtime} map covering every regular file under each path."""
    out: dict[str, float] = {}
    for p in paths:
        if os.path.isfile(p):
            try: out[p] = os.path.getmtime(p)
            except OSError: pass
        elif os.path.isdir(p):
            for root, _dirs, files in os.walk(p):
                for f in files:
                    fp = os.path.join(root, f)
                    try: out[fp] = os.path.getmtime(fp)
                    except OSError: pass
    return out


def watcher_loop() -> None:
    last = collect_mtimes(WATCHED_PATHS)
    while True:
        time.sleep(POLL_INTERVAL_S)
        try:
            current = collect_mtimes(WATCHED_PATHS)
        except Exception:
            continue
        if current != last:
            try:
                build_mod.build('dev')
                version = state.bump()
                print(f"  ↻ reload signaled  (v={version})")
            except Exception as e:
                print(f"  ✗ build failed: {e}", file=sys.stderr)
            last = current


# ------------------------------------------------------------------
# HTTP server
# ------------------------------------------------------------------
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split('?', 1)[0]
        if path == '/dev/version':
            body = json.dumps({'version': state.get()}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store, must-revalidate')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
        elif path == '/' or path == '/dev':
            body = (
                f"YouTube RSVP Reader dev server.\n"
                f"version endpoint: /dev/version (current = {state.get()})\n"
            ).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {fmt % args}\n")


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


# ------------------------------------------------------------------
# Entrypoint
# ------------------------------------------------------------------
def main() -> int:
    # Initial build.
    build_mod.build('dev')
    print(f"\nDev server: http://localhost:{PORT}/dev/version  (v={state.get()})")
    print(f"Load unpacked extension from:")
    print(f"  {os.path.relpath(os.path.join(ROOT, 'dist', 'dev'), os.getcwd())}")
    print(f"Watching: src/ and tools/dev-reloader.js")
    print(f"Edit a file → rebuild → YouTube tabs auto-reload in ~2-4s.")
    print(f"Ctrl-C to stop.\n")

    threading.Thread(target=watcher_loop, daemon=True).start()
    with ReusableTCPServer(('127.0.0.1', PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
