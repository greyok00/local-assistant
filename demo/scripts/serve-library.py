#!/usr/bin/env python3
"""Serve the research library as a read-only demo tenant.

The site being served (DEMO_LIBRARY, default ../research-library relative to
the repository) is never written to. Product code is
mounted at /local-assistant/* by aliasing requests to product/src/*, the demo
bench to /local-assistant/bench/*, and the built index to
/local-assistant/assistant-index.json/.bin.

    python3 demo/scripts/serve-library.py [--port 4180]
"""

from __future__ import annotations

import argparse
import mimetypes
import os
import posixpath
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

REPO = Path(__file__).resolve().parents[2]
LIBRARY = Path(os.environ.get('DEMO_LIBRARY', REPO.parent / 'research-library')).expanduser()
PRODUCT_SRC = REPO / 'product' / 'src'
DEMO = REPO / 'demo'
DEMO_BENCH = DEMO / 'bench'
DEMO_BUILD = DEMO / 'build'

# Mutable so --root/--artifact-dir can point the same server at another site
# (the UMGC library install uses it to crawl and verify that tree).
SITE = LIBRARY
ARTIFACT_DIR = DEMO_BUILD
INDEX_FILES = {}

ASSET_PREFIX = '/local-assistant/'
BENCH_PREFIX = '/local-assistant/bench/'

mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('text/javascript', '.mjs')


def resolve(url_path: str) -> Path | None:
    """Map a URL path to a file, refusing anything outside the mount roots."""
    if url_path in INDEX_FILES:
        return INDEX_FILES[url_path]

    if url_path.startswith(BENCH_PREFIX):
        return _join(DEMO_BENCH, url_path[len(BENCH_PREFIX):], 'index.html')

    if url_path.startswith(ASSET_PREFIX):
        return _join(PRODUCT_SRC, url_path[len(ASSET_PREFIX):], 'index.html')

    return _join(SITE, url_path.lstrip('/'), 'index.html')


def _join(root: Path, relative: str, default: str) -> Path | None:
    relative = posixpath.normpath(unquote(relative))
    if relative in ('.', '/'):
        relative = default
    if relative.startswith('../') or relative == '..' or relative.startswith('/'):
        return None
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    if candidate.is_dir():
        candidate = candidate / default
    return candidate


class Handler(BaseHTTPRequestHandler):
    server_version = 'demo-tenant/1.0'

    def do_GET(self) -> None:  # noqa: N802
        self._serve(send_body=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve(send_body=False)

    def do_POST(self) -> None:  # noqa: N802
        # Two demo-only sinks, used by the instrumented measurement run:
        # /__progress logs progress text, /__artifact.json|.bin writes the
        # finished index into demo/build so a slow run cannot lose it.
        path = urlsplit(self.path).path
        length = int(self.headers.get('Content-Length') or 0)
        if path == '/__progress':
            body = self.rfile.read(min(length, 8192)).decode('utf-8', 'replace')
            sys.stderr.write(f'PROGRESS {body[:400]}\n')
            self.send_response(204)
            self.end_headers()
            return
        if path in ('/__artifact.json', '/__artifact.bin'):
            ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
            target = ARTIFACT_DIR / ('assistant-index' + ('.json' if path.endswith('json') else '.bin'))
            remaining = length
            with target.open('wb') as handle:
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 1 << 20))
                    if not chunk:
                        break
                    handle.write(chunk)
                    remaining -= len(chunk)
            sys.stderr.write(f'ARTIFACT {target.name} {target.stat().st_size} bytes\n')
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404, 'Not found')

    def _serve(self, send_body: bool) -> None:
        path = urlsplit(self.path).path or '/'
        target = resolve(path)
        if target is None or not target.is_file():
            self.send_error(404, 'Not found')
            return

        body = target.read_bytes()
        content_type = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4180)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--root', type=Path, default=LIBRARY,
                        help='site tree to serve at / (default: the research library)')
    parser.add_argument('--artifact-dir', type=Path, default=DEMO_BUILD,
                        help='where /__artifact.* and the demo index live')
    args = parser.parse_args()

    global SITE, ARTIFACT_DIR, INDEX_FILES
    SITE = args.root.resolve()
    ARTIFACT_DIR = args.artifact_dir.resolve()
    INDEX_FILES = {
        '/local-assistant/assistant-index.json': ARTIFACT_DIR / 'assistant-index.json',
        '/local-assistant/assistant-index.bin': ARTIFACT_DIR / 'assistant-index.bin',
    }

    if not SITE.is_dir():
        print(f'site root not found: {SITE}', file=sys.stderr)
        return 1
    for source_dir in (PRODUCT_SRC, DEMO_BENCH):
        if not source_dir.is_dir():
            print(f'required directory not found: {source_dir}', file=sys.stderr)
            return 1

    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f'Site URL:      http://{args.bind}:{args.port}/')
    print(f'Dashboard:     http://{args.bind}:{args.port}/local-assistant/dashboard.html')
    print(f'Demo bench:    http://{args.bind}:{args.port}/local-assistant/bench/bench.html')
    print(f'Site root:     {SITE} (read-only)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
