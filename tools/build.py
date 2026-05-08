#!/usr/bin/env python3
"""
Build the Chrome extension.

  python3 tools/build.py dev          → dist/dev/   (auto-reload during dev)
  python3 tools/build.py prod         → dist/prod/  (clean build)
  python3 tools/build.py prod --zip   → dist/prod/ + dist/extension-vX.Y.Z.zip

The dev build adds a service-worker that polls a localhost server for changes
(see tools/dev-reloader.js) and adjusts the manifest with the extra
permissions the reloader needs. None of that ships to production.
"""
from __future__ import annotations
import json
import os
import shutil
import sys
import zipfile

ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC   = os.path.join(ROOT, 'src')
TOOLS = os.path.join(ROOT, 'tools')
DIST  = os.path.join(ROOT, 'dist')

DEV_SERVER_PORT = 8765


def _copy_tree(src: str, dst: str) -> None:
    """Recursively copy a directory, replacing any existing destination."""
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def build(target: str = 'dev') -> tuple[str, str]:
    if target not in ('dev', 'prod'):
        raise ValueError(f"unknown target: {target!r}")

    out_dir = os.path.join(DIST, target)
    _copy_tree(SRC, out_dir)

    manifest_path = os.path.join(out_dir, 'manifest.json')
    with open(manifest_path) as f:
        manifest = json.load(f)

    # Strip any icon entry whose file isn't actually present in the build.
    # Chrome refuses to load the extension if the manifest references missing
    # files. Real icons can be dropped into src/icons/ at any time and the
    # next build will pick them up.
    icons = manifest.get('icons', {})
    if isinstance(icons, dict) and icons:
        present = {}
        for size, rel in icons.items():
            if os.path.exists(os.path.join(out_dir, rel)):
                present[size] = rel
        if present:
            manifest['icons'] = present
        else:
            manifest.pop('icons', None)
            print("  (note) no PNG icons in src/icons/ — `icons` field omitted")

    if target == 'dev':
        # Mark the name so it's distinguishable in chrome://extensions.
        manifest['name'] = manifest.get('name', 'extension') + ' (dev)'

        # Service worker that watches the local dev server.
        manifest['background'] = {'service_worker': 'dev-reloader.js'}
        manifest.setdefault('permissions', [])
        for perm in ('tabs', 'storage'):
            if perm not in manifest['permissions']:
                manifest['permissions'].append(perm)
        manifest.setdefault('host_permissions', [])
        loopback = f'http://localhost:{DEV_SERVER_PORT}/*'
        if loopback not in manifest['host_permissions']:
            manifest['host_permissions'].append(loopback)

        # Drop dev-reloader.js into the build.
        shutil.copy2(
            os.path.join(TOOLS, 'dev-reloader.js'),
            os.path.join(out_dir, 'dev-reloader.js'),
        )

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

    version = manifest.get('version', 'unknown')
    print(f"✓ built [{target}] → {os.path.relpath(out_dir, ROOT)}  v{version}")
    return out_dir, version


def make_zip(out_dir: str, version: str) -> str:
    zip_path = os.path.join(DIST, f'extension-v{version}.zip')
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(out_dir):
            for fname in files:
                full = os.path.join(root, fname)
                arc = os.path.relpath(full, out_dir)
                z.write(full, arc)
    print(f"✓ zipped → {os.path.relpath(zip_path, ROOT)}")
    return zip_path


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    target = argv[0]
    do_zip = '--zip' in argv[1:]
    out_dir, version = build(target)
    if target == 'prod' and do_zip:
        make_zip(out_dir, version)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
