# Icons

Chrome will load an unpacked extension without these (it just shows a default
puzzle-piece icon), but the **Chrome Web Store will reject submissions
without them**.

Drop three PNGs in this folder before submitting:

  icon16.png   (16 × 16  — toolbar)
  icon48.png   (48 × 48  — extensions page)
  icon128.png  (128 × 128 — store listing, install dialog)

Generate them however you like — Recraft (recraft.ai) is good for icons since
it outputs editable SVG that you can re-export at every size from one source.

The manifest already references all three by name (see `../manifest.json`),
so once these files exist the build picks them up automatically.
