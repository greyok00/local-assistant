#!/usr/bin/env python3
"""Compile the demo server into a comment-free Cython extension.

This is the Python half of the release ritual: comments and docstrings are
stripped, then the file is compiled to a native extension. The shipped
assistant is JavaScript and PHP, so nothing in product/ uses this; it exists
so the demo tenant can be handed over without readable Python source.

    python3 demo/scripts/cythonize.py          # build demo/build/cython/
    demo/build/cython/serve-library --port 4180

The extension and launcher land in demo/build/cython/, which is git-ignored.
demo/scripts/serve-library.py stays the source of truth.
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / 'demo' / 'scripts' / 'serve-library.py'
OUT = REPO / 'demo' / 'build' / 'cython'
MODULE = 'serve_library'

LAUNCHER = """#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import {module} as server

repo = Path(__file__).resolve().parents[3]
server.REPO = repo
server.PRODUCT_SRC = repo / 'product' / 'src'
server.DEMO = repo / 'demo'
server.DEMO_BENCH = repo / 'demo' / 'bench'
server.DEMO_BUILD = repo / 'demo' / 'build'
server.SITE = server.LIBRARY

raise SystemExit(server.main())
"""


def strip_comments(source: str) -> str:
    """Drop docstrings and re-emit the module without comments."""
    tree = ast.parse(source)
    for node in ast.walk(tree):
        body = getattr(node, 'body', None)
        if not isinstance(body, list) or not body:
            continue
        first = body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                and isinstance(first.value.value, str):
            node.body = body[1:] or [ast.Pass()]
    return ast.unparse(ast.fix_missing_locations(tree)) + '\n'


def main() -> int:
    if not SOURCE.exists():
        print(f'missing {SOURCE}', file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f'{MODULE}.py'
    target.write_text(strip_comments(SOURCE.read_text()))
    print(f'decommented -> {target} ({target.stat().st_size} bytes)')

    build = subprocess.run(
        [sys.executable, '-m', 'Cython.Build.Cythonize', '-3', '--no-docstrings', '-i', '-q', target.name],
        cwd=OUT,
    )
    if build.returncode != 0:
        return build.returncode

    so = next(OUT.glob(f'{MODULE}.*.so'), None)
    if so is None:
        print('cythonize reported success but produced no extension', file=sys.stderr)
        return 1

    launcher = OUT / 'serve-library'
    launcher.write_text(LAUNCHER.format(module=MODULE))
    launcher.chmod(0o755)
    print(f'compiled    -> {so.name} ({so.stat().st_size} bytes)')
    print(f'launcher    -> {launcher.relative_to(REPO)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
