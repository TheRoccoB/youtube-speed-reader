#!/usr/bin/env python3
"""
Generate placeholder PNG icons in src/icons/ so the extension loads cleanly
in chrome://extensions before you have real artwork ready.

  python3 tools/make-placeholder-icons.py

Produces icon16.png, icon48.png, icon128.png — black square with a small red
square in the middle (mimicking the overlay's ORP highlight). Replace these
with proper artwork before publishing.
"""
from __future__ import annotations
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS_DIR = os.path.join(ROOT, 'src', 'icons')


def png(size: int, bg=(20, 20, 20), accent=(255, 68, 68)) -> bytes:
    """Build a square PNG of the given size: bg with a small accent block in the middle."""
    accent_size = max(2, size // 4)
    a_start = (size - accent_size) // 2
    a_end   = a_start + accent_size

    raw = bytearray()
    for y in range(size):
        raw.append(0)            # filter type (None) for each scanline
        for x in range(size):
            in_accent = (a_start <= x < a_end) and (a_start <= y < a_end)
            r, g, b = accent if in_accent else bg
            raw.extend((r, g, b))

    def chunk(typ: bytes, data: bytes) -> bytes:
        body = typ + data
        crc = zlib.crc32(body) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + body + struct.pack('>I', crc)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))  # 8-bit RGB
    idat = chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    iend = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend


def main() -> int:
    os.makedirs(ICONS_DIR, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(ICONS_DIR, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(png(size))
        print(f"  wrote {os.path.relpath(path, ROOT)}")
    print("done. re-run tools/dev.py (or tools/build.py) to pick them up.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
