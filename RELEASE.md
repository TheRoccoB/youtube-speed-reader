# Release checklist — Rivet

Path from "works on my machine" to "live on the Chrome Web Store with a
marketing site." Estimated end-to-end: a focused day of work plus the
~3-day store review wait.

## 1. Branding

- [x] Pick a working name — picked `Rivet` (manifest reads
      `Rivet — YouTube speed reader` so it's both branded and
      keyword-discoverable; `NAME` constant in code is just `Rivet`).
- [x] Update `src/manifest.json` `name`
- [x] Update `NAME` constant in `src/content.js`
- [x] Sanity-check: grep `Spritz` in user-visible strings — zero hits in
      `manifest.json` and UI text. Internal class names / localStorage
      keys still say `spritz` deliberately (invisible to users; renaming
      would invalidate every existing user's saved preferences).

## 2. Icons

Three PNGs needed in `src/icons/`: `icon16.png`, `icon48.png`, `icon128.png`.

The placeholder generator (`tools/make-placeholder-icons.py`) gets you a
black square with a red center — fine for dev, NOT good enough for the store.

Three real options:

- [ ] **DOM-rendered icon** (`tools/icon-studio.html`). Open in Chrome, click
      the export buttons. Generates real PNGs from an SVG that mirrors the
      overlay's actual look — black box, "abc" with red b, ORP ticks. Free,
      consistent with the brand. Recommended starting point.
- [ ] **Recraft** (recraft.ai). AI-generated, exports vector SVG you can
      regenerate at any size. Best if you want something more designed.
- [ ] **Hand-crafted**. Open `tools/icon-studio.html`'s SVG in Figma /
      Affinity, customize, re-export.

Whichever path: drop the three PNGs in `src/icons/`. The next build picks
them up automatically (`build.py` strips icon entries from the manifest if
the files don't exist, and re-adds them when they do).

## 3. Smoke-test on real videos

- [ ] Auto-generated captions video (word-by-word streaming — most YouTube
      videos)
- [ ] Manual / professional captions (line-by-line chunks — TED talks,
      Hollywood productions, official news)
- [ ] Theater mode (`t` key on YouTube)
- [ ] Fullscreen (`f` key)
- [ ] Different playback speeds (1x, 1.5x, 2x — overlay should stay synced
      because we render on caption mutations, not on a timer)
- [ ] SPA navigation: click a related video without page reload — overlay
      should pick up the new video's captions automatically
- [ ] Page refresh: localStorage state restores (size, CC visibility,
      enabled/disabled, dragged position)
- [ ] Window resize: dragged position scales correctly with player size
- [ ] Drag and drop the overlay; vertical + horizontal snap should both
      catch within ~26px of the home position
- [ ] CC button toggles native captions in/out without breaking the spritz
      overlay
- [ ] Close button (×) returns to "open button on hover" state
- [ ] Open button (`abc` badge) shows on player hover when overlay is off

## 4. Privacy + legal

- [ ] **Privacy policy.** Required by the Chrome Web Store even when you
      collect no data. Template lives in `README.md` — host it on GitHub
      Pages (see Section 7). Must be a public URL when you submit.
- [ ] **License.** Add a `LICENSE` file at the repo root. MIT recommended.
      `gh repo create` doesn't add this automatically.
- [ ] **Terms of Service.** Not required for an extension that has no
      accounts, no payments, no server. Skip unless something changes.
- [ ] **Trademark check.** "Spritz" must NOT appear in any user-visible
      string. (Already excluded from manifest as of 0.10.6.)

## 5. Production build

    python3 tools/build.py prod --zip

Verify before submitting:

- [ ] `dist/prod/manifest.json` does NOT contain `tabs`, `storage`, or any
      `localhost` host permission (those are dev-only)
- [ ] `dist/prod/manifest.json` `name` is the production name (no `(dev)`
      suffix)
- [ ] `dist/prod/` has no `dev-reloader.js`
- [ ] `dist/prod/icons/` contains real PNGs (not placeholders)
- [ ] `dist/prod/manifest.json` `version` is bumped from your last release

The zip lands at `dist/extension-vX.Y.Z.zip`. That's what gets uploaded.

## 6. Chrome Web Store submission

One-time:

- [ ] Pay the $5 developer registration at
      https://chrome.google.com/webstore/devconsole — Google Pay, one-time,
      not a subscription.

Per release:

- [ ] Upload the zip
- [ ] **Single purpose statement.** Recommended: "Reads YouTube's closed-
      captions and displays them as a single-word RSVP overlay with
      optimal-recognition-point highlighting."
- [ ] **Permission justifications.**
  - `host_permissions` for `*.youtube.com` and `youtube.com`: "The
    extension reads caption text from YouTube's player to render it as
    RSVP words. No data is sent off-device."
- [ ] **Privacy practices form.** Check NO for every data category (PII,
      location, financial, auth, personal communications, web history,
      user activity, website content). Affirm:
    - not selling user data: ✓
    - using data only for declared purpose: ✓
    - not using data for creditworthiness: ✓
- [ ] **Privacy policy URL** — point to your GH Pages site.
- [ ] **Screenshots** (1280×800 or 640×400, 1–5 of them):
  - [ ] Open button visible on player hover (overlay off state)
  - [ ] Overlay actively reading captions on a TED-style talk
  - [ ] Overlay with hover controls revealed (`-`, `+`, `CC`, `×` visible)
  - [ ] CC toggle ON state — both spritz overlay and native captions
        showing simultaneously
  - [ ] Optional: dragged to a custom position, fullscreen mode
- [ ] **Promotional tile** (440×280) — optional, the algorithm prefers
      listings that have one. Generate with the same SVG approach as the
      icon, just at the marketing tile dimensions.
- [ ] **Detailed description** — write it cleanly. Include:
    - what the extension does in one sentence
    - how to use it (hover the player, click the badge)
    - what features it has (CC toggle, drag, resize, persistent settings)
    - what data it collects (none)
    - link to the GH Pages site
- [ ] **Category.** "Accessibility" or "Productivity". Accessibility tends
      to get less competition.
- [ ] Submit. First review takes 1–7 business days. Updates are usually
      faster (often hours).

## 7. Marketing site (GitHub Pages, custom domain)

A single-page site is plenty.

- [ ] Decide on URL structure:
  - **Subdirectory**: put a `docs/` folder in the main branch with
    `index.html` + `privacy.html`. Enable Pages on `main / docs` in repo
    Settings → Pages. Easiest.
  - **Branch**: create a `gh-pages` branch from `main`. Same files. Pages
    Settings → Pages → branch `gh-pages`.
- [ ] Site contents (one-page is fine for v1):
  - hero: animated GIF or screenshot
  - "Install on the Chrome Web Store" button → store listing URL
  - 1-2 paragraph "how it works" section
  - link to GitHub repo
  - link to /privacy.html
- [ ] Privacy policy as `docs/privacy.html` — start from the template in
      `README.md`, expand if your data practices ever change.
- [ ] **Custom domain.** In repo Settings → Pages, set Custom domain to
      `rivet.simmerindustries.com` (subdomain of Simmer Industries' apex).
- [ ] **DNS at simmerindustries.com's registrar.** Add a single CNAME:
      `rivet  CNAME  TheRoccoB.github.io`.
      (Apex / www records aren't needed — the apex domain isn't being
      pointed at GitHub Pages, only the `rivet` subdomain.)
- [ ] Wait 5-30 minutes for DNS to propagate. GitHub will detect and
      issue a Let's Encrypt cert automatically.
- [ ] Toggle "Enforce HTTPS" once the cert is issued.

## 8. Post-launch

- [ ] Add `.github/ISSUE_TEMPLATE/bug_report.md` so reports come in
      structured (browser, video URL, what broke, console log)
- [ ] Set up a release flow: bump version → tag → `gh release create vX.Y.Z
      dist/extension-vX.Y.Z.zip --notes "..."` so the GitHub releases page
      tracks every store submission
- [ ] Watch reviews — YouTube ships DOM changes occasionally and the
      caption selectors will eventually need updating
- [ ] Consider adding telemetry-free crash reports via console.error
      (users can include console output in bug reports)

## Known issues

### Manual / professional captions read poorly

**Symptom.** On videos with editor-uploaded captions (full sentences arriving
all at once, e.g. https://www.youtube.com/watch?v=5B6kpND0eyw), the RSVP
playback feels off — words come too fast then sit too long, or vice versa.
Auto-generated captions (word-by-word streaming, e.g.
https://www.youtube.com/watch?v=L6Sccjh_MrI) work great.

**Why this is hard.** The two caption modes give us very different signals:

- Auto-captions: each MutationObserver fire = one new word. Each word's
  arrival timestamp = its actual spoken time. Trivially good RSVP.
- Manual captions: each MutationObserver fire = a whole sentence (5-12
  words). We have no per-word timestamps at all — the caption track is
  drawn into the DOM all-at-once at chunk-start.

We confirmed YouTube does NOT expose its captions through the standard
`<track>` / `video.textTracks` API — `textTracks.length` is 0 even with
CC visible on screen. The `aria-label` on the CC button literally says
"Subtitles/closed captions unavailable" while captions are actively
showing. YouTube renders captions purely via JavaScript directly into the
DOM, bypassing the W3C cue API.

**What we tried (v0.10.9).** Adaptive pacing: measure wall-clock time
between mutations as the previous chunk's actual duration, divide by next
chunk's word count for per-word timing. This auto-adapts to playback rate
changes. Works in principle but the experience still feels off — chunks
have varying word counts and the previous-chunk-as-prediction estimate
can be off by 2x for the next chunk.

**Things to try next.**

1. **Find YouTube's private cue data.** Their player almost certainly has
   the cue start/end times somewhere in JS state — we just need to find it
   (window.ytplayer? YT.config? An object on the player element itself?).
   Search for the caption text in `Object.values(window).find(o=>...)`
   and trace back to the timed track data. If we can read end times
   directly, this becomes trivial.
2. **Use video.currentTime + a probe.** When a chunk arrives at video
   time T, set a timeout that re-checks the DOM at T+0.1s, +0.2s, etc.
   The first time the chunk is GONE (replaced or empty), we know its
   end time and can retroactively pace.
3. **Two-mutation prediction.** Watch the mutation type — when the
   container empties (chunk removed) vs. fills (chunk added). Treat
   "removed" as the chunk's end. We get end time of chunk N-1 right at
   its actual end, instead of waiting for chunk N to arrive.
4. **Sentence-aware pacing.** Use punctuation in the chunk to add
   sub-pauses (commas → small pause, periods → larger pause). Even with
   imperfect total duration, intra-sentence rhythm makes it more
   readable.
5. **Per-source mode.** Detect "auto" vs. "chunk" caption mode (via
   word-count distribution over time) and apply different strategies.
   Currently we apply one heuristic to both.

**Workaround for users in the meantime.** Auto-captions work great. If a
video has both auto-generated and human captions, the auto ones can be
selected via YouTube's settings gear → Subtitles/CC → English (auto-
generated). Document this in the marketing site.

## What you DON'T need

  - A backend / database / accounts (keep it that way)
  - Payment infra (no monetization on day 1)
  - Code signing certs (Google handles cert for Web Store distribution)
  - npm / node / bundlers — pure stdlib Python tooling is intentional
  - Cookie consent banner (you set no cookies; localStorage on YouTube's
    own origin doesn't trigger consent rules)
  - Mobile right now — see `CLAUDE.md` for why mobile is a separate, much
    bigger project. Ship desktop first.
