# YouTube Speed Reader — Chrome extension

RSVP-style reader that overlays the current word on YouTube videos with the
ORP (optimal recognition point) letter highlighted. Reads from YouTube's
caption track and optionally hides the native captions.

Two companion docs:
  • `CLAUDE.md`  — context for resuming work (especially in Claude Code)
  • `RELEASE.md` — actionable checklist to publish on the Web Store

## Layout

    src/
      manifest.json        Manifest V3
      content.js           the actual extension code (was the userscript IIFE)
      icons/               drop icon16/48/128.png here before publishing
    tools/
      build.py             build dev or prod
      dev.py               dev server with file-watch + auto-reload
      dev-reloader.js      MV3 service worker that listens to dev.py
    dist/                  build outputs (gitignored)
      dev/                 unpacked extension for development
      prod/                unpacked extension for the store
      extension-vX.Y.Z.zip  zip ready to upload to the Web Store

## Development workflow

In one terminal:

    python3 tools/dev.py

It does the initial build, then:
  • watches `src/` and `tools/dev-reloader.js` for changes
  • rebuilds `dist/dev/` on every save
  • serves `http://localhost:8765/dev/version`

In Chrome (one time only):
  • Open `chrome://extensions`
  • Turn on **Developer mode** (top right)
  • Click **Load unpacked**
  • Select `dist/dev/`

You'll see "YouTube RSVP Reader (dev)" appear. The "(dev)" suffix and an
extra service worker are the only differences from the production build.

Now edit `src/content.js` (or any other file in `src/`). Within ~2-4 seconds
of saving, any open YouTube tab refreshes itself and the extension reloads.
No manual reload needed.

## Production build

    python3 tools/build.py prod              # writes dist/prod/
    python3 tools/build.py prod --zip        # writes dist/prod/ AND a versioned .zip

Upload `dist/extension-vX.Y.Z.zip` to the Chrome Web Store developer dashboard.

The prod build:
  • does NOT include `dev-reloader.js`
  • does NOT have `tabs`/`storage` permissions or the localhost host
  • does NOT have the "(dev)" name suffix

## Versioning

Bump `version` in `src/manifest.json` before each release. Chrome enforces
strictly-monotonic versions on the store. (You can also bump the matching
`VERSION` constant at the top of `content.js` so it shows up in the overlay's
hover-revealed corner.)

## Permissions

The extension requests the absolute minimum:
  • `host_permissions` for `*.youtube.com` and bare `youtube.com` only
  • no `storage`, `tabs`, `scripting`, etc. in the prod build

Caption text and user preferences (overlay enabled, font scale, CC visibility,
drag position) are stored locally via `localStorage` on the YouTube origin.
Nothing is sent to any server.

## Before shipping to the Chrome Web Store

  1. Add real icon16/48/128.png in `src/icons/`.
  2. Decide on the public name. "Spritz" is a registered trademark of Spritz
     Inc.; pick something else (Rivet, Tachi, Flick, etc.) and update
     `src/manifest.json` → `name`.
  3. Write a privacy policy (template below) and host it on a public URL
     (GitHub Pages works).
  4. `python3 tools/build.py prod --zip`.
  5. Submit at https://chrome.google.com/webstore/devconsole/

## Privacy policy template

> [Name] does not collect, transmit, or sell any user data. The extension
> reads the closed-caption text already shown on YouTube's video player to
> render it as a single-word RSVP display, and stores user preferences
> (overlay enabled state, font size, CC visibility, position) only in the
> browser's local storage on your own device. No data leaves your computer.
> You can clear stored preferences at any time by clearing site data for
> youtube.com or by uninstalling the extension. Contact: <your-email>.
