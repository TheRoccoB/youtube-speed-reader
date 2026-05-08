# YouTube Speed Reader — Claude Code context

Chrome extension (Manifest V3) that reads YouTube's closed-caption text and
displays it as a Spritz-style RSVP overlay — one word at a time, with the ORP
("optimal recognition point") letter in red. Originally a Tampermonkey
userscript, ported to a Chrome extension with a dev/prod build split.

If you're a Claude Code session opening this for the first time, read this
file end-to-end before editing anything. RELEASE.md has the open todo list.

## Project layout

    src/
      manifest.json                MV3 manifest (NAME / VERSION live here)
      content.js                   the entire extension — single IIFE
      icons/                       icon16/48/128.png
    tools/
      build.py                     builds dist/dev or dist/prod
      dev.py                       file-watching dev server on :8765
      dev-reloader.js              MV3 SW that polls dev.py + reloads
      make-placeholder-icons.py    pure-stdlib PNG generator
      icon-studio.html             open in Chrome to design + export real icons
    scripts/
      init-github.sh               one-shot git init + gh repo create + push
    dist/                          build outputs (gitignored)
      dev/                         unpacked extension, load in chrome://extensions
      prod/                        clean build for the store
      extension-vX.Y.Z.zip         what you upload to the Web Store
    CLAUDE.md                      this file
    RELEASE.md                     publish checklist
    README.md                      end-user / developer overview
    .gitignore

## Commands

    python3 tools/dev.py                       # watch + auto-reload during dev
    python3 tools/build.py dev                 # one-off dev build
    python3 tools/build.py prod                # one-off prod build
    python3 tools/build.py prod --zip          # prod build + .zip ready for store
    python3 tools/make-placeholder-icons.py    # if src/icons/ is empty
    bash scripts/init-github.sh                # publish to GitHub (one-time)

To load in Chrome: `chrome://extensions` → Developer mode → Load unpacked →
select `dist/dev/`. The "(dev)" name suffix in the manifest is your visual
confirmation you've loaded the dev build.

## Hard rules — DO NOT VIOLATE

These are bugs we already fixed once. Re-introducing them would regress.

  1. **No `innerHTML`.** YouTube enforces Trusted Types in their player CSP.
     Build all DOM with `document.createElement` + `textContent`.

  2. **Hide native CC with `opacity: 0`, NEVER `visibility: hidden` or
     `display: none`.** YouTube short-circuits caption rendering when the
     caption container is laid out as hidden. The DOM updates we observe
     stop arriving. opacity:0 is the only safe option.

  3. **Use ONLY `.ytp-caption-segment` to read caption text.** Don't also
     query `.caption-visual-line` — the latter wraps segments and you'll
     double-count text. The script's `getCaptionText()` is correct; don't
     "improve" it.

  4. **Rail width MUST be odd (`RAIL = 21`).** With an even width the rail's
     50% center falls on a cell boundary, which puts the ORP tick 0.5ch off
     from the pivot character's center. The relevant constants are at the
     top of content.js: `RAIL = 21`, `CENTER = 11`.

  5. **No `letter-spacing` on the word row.** Even tiny values accumulate
     across 21 cells, push the line wider than `21ch`, and `text-align:
     center` then offsets the pivot from the rail center. It's been left at
     `letter-spacing: 0` deliberately.

  6. **Position is stored as fractions of player size, NOT pixels.** When
     the player resizes (theater toggle, fullscreen, window resize), pixels
     stop being meaningful. See `userPosFracX` / `userPosFracY` and the
     drag handler. If you change the format, update both the writer (drag
     handler) and the reader (`positionOverlay`).

  7. **Drag uses `pointerdown / pointermove / pointerup` with
     `setPointerCapture`.** Do NOT add `mouseup` to the `stopPropagation`
     list on the overlay — that breaks drag release (we already fixed this).
     Currently we stopProp on `click` and `dblclick` only.

  8. **Trademark: "Spritz" is registered to Spritz Inc.** Do not put
     "Spritz" in any user-facing string (manifest name, description, store
     listing, marketing site). Internal class names / localStorage keys
     still say `spritz` for legacy reasons; that's invisible to users.

## Architecture notes

  - **Single content script.** No background service worker in production.
    The dev build temporarily adds one (`dev-reloader.js`) for the auto-
    reload loop only.
  - **Mounting.** The overlay element is appended to `.html5-video-player`
    (or `#movie_player` as fallback). This makes it a child of the player,
    so it goes fullscreen / theater with the player automatically and drag
    is naturally clamped to the player rect.
  - **Sizing.** `transform: scale(N)` with `transform-origin: 50% 100%`
    (bottom-center). N = `clamp(playerHeight * SCALE_RATIO * userScale,
    SCALE_MIN, SCALE_MAX)`. Bottom-center transform-origin means the visual
    bottom-center stays put across scale changes — convenient because that's
    also our positioning anchor.
  - **Reading captions.** MutationObserver on the caption container. Each
    mutation = our render trigger. We do NOT poll. The CC mutation IS the
    timing source — earlier versions tried to use video playbackRate to
    "predict" word timing, which was wrong and caused lag. Don't go back.
  - **SPA navigation.** YouTube fires `yt-navigate-finish` on every in-app
    nav. We listen for it and reset state (drop the observer, clear
    lastCaptionText, re-find the caption container after a 600ms grace).
  - **Persistence.** `localStorage` keys live on the youtube.com origin,
    not in `chrome.storage`. Three keys: `spritz-rsvp-enabled`,
    `spritz-rsvp-cc-visible`, `spritz-rsvp-scale`.

## Conventions

  - Bump VERSION in BOTH `src/content.js` (top of the IIFE) AND
    `src/manifest.json` for every visible change. They must match.
  - The bottom-right hover label shows `${NAME} v${VERSION}`. If the in-
    overlay version doesn't match what you just edited, you forgot to
    bump (or the dev server hasn't rebuilt yet).
  - Comments explain the WHY for non-obvious choices. The hard rules above
    each correspond to a comment in content.js. Don't strip them.
  - Pure stdlib for tooling. No npm. No build dependencies. Python 3.

## Open problems

### Manual-caption pacing is unsatisfactory

Manual / pro-uploaded captions (full sentences arriving as one mutation)
still don't read well even with v0.10.9's adaptive pacing.

What we know:
  - YouTube does NOT expose captions via the W3C TextTrack API on this
    site. `video.textTracks.length === 0` even when captions are visibly
    rendering. The CC button's aria-label says "captions unavailable"
    while captions are on screen. Caption rendering is pure JS-to-DOM,
    bypassing standard cue events. Confirmed empirically.
  - Adaptive pacing measures wall-clock time between caption mutations
    and uses prev-chunk duration / next-chunk word count. Auto-adapts
    to playback rate. Works on auto-captions (1 word per fire) but the
    chunk-mode prediction is consistently off because adjacent chunks
    can have wildly different word counts (3 words vs 12 words → same
    duration, very different per-word time).

Things to try (see RELEASE.md "Known issues" for fuller writeup):
  1. Locate YouTube's private cue data (probably on `window.ytplayer`
     or the `#movie_player` element). End times exist somewhere.
  2. Treat "container emptied" mutations as chunk-end signals.
  3. Sentence-aware pacing using punctuation pauses.
  4. Detect auto vs chunk mode and apply different heuristics.

This issue is the biggest remaining blocker on perceived quality. Auto-
generated captions are a workaround until it's solved.

## Recent work (newest first)

  - 0.10.9  Adaptive per-word pacing using measured chunk intervals
            (works on auto-captions; manual captions still unsatisfactory
            — see "Open problems" above)
  - 0.10.8  Static chunk-mode pacing (READING_PACE_MS=250 for 4+ word
            mutations); superseded by 0.10.9 logic
  - 0.10.7  Re-enable CC after ad → main video transition
  - 0.10.6  Renamed to "YouTube Speed Reader" (was "YouTube RSVP Reader")
  - 0.10.5  Vertical drag snap to default y-anchor
  - 0.10.4  Bottom-right label includes name + version
  - 0.10.3  CC toggle button, default scale 1.25, persisted size
  - 0.10.2  min-height on word row (no collapse pre-first-caption)
  - 0.10.1  CSS-drawn icons, CSS-hover open button
  - 0.10.0  Open/close buttons, localStorage persistence
  - 0.9.x   Polishing pass: padding, alignment, drag fixes
  - 0.8.0   transform: scale instead of font-size
  - 0.7.0   Hover-revealed corner controls, dataset-driven hide
  - 0.6.0   Render-on-mutation only (no rate prediction)
  - 0.5.0   Hide native CC, fixed-position anchor
  - 0.4.0   Auto-CC, anchor above caption window
  - 0.3.0   Diff-based new-word detection (suffix-prefix match)

## See also

  - `RELEASE.md` — what's left to actually ship to the Chrome Web Store.
  - `README.md` — end-user / install instructions.
