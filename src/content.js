
(function () {
    'use strict';

    if (window.__rivetInstalled) return;
    window.__rivetInstalled = true;

    // ============== CONFIG ==============
    const NAME             = 'Rivet';
    const VERSION          = '0.11.1';
    const STORAGE_KEYS = {
        enabled: 'rivet-enabled',
        cc:      'rivet-cc-visible',
        scale:   'rivet-scale',
    };
    const DEFAULT_SCALE_FACTOR = 1.25;     // about two `+` clicks above 1.0
    const TOGGLE_KEY       = 'S';    // Shift + this key toggles overlay on/off
    const BURST_WORD_MS    = 110;    // 2-3 word bursts (auto-caption catching up) — flash quickly
    const READING_PACE_MS  = 250;    // initial guess for chunk-mode captions before we have measured data
    const CHUNK_THRESHOLD  = 4;      // word count at which we switch from burst pace to reading pace
    const ADAPTIVE_MIN_MS  = 90;     // floor for adaptive per-word duration (keeps it readable at 4x video)
    const ADAPTIVE_MAX_MS  = 500;    // ceiling for adaptive per-word duration (keeps it from feeling stuck)
    const ADAPTIVE_INTERVAL_MIN_MS = 500;   // ignore inter-chunk intervals shorter than this (seeks, spurious mutations)
    const ADAPTIVE_INTERVAL_MAX_MS = 8000;  // ignore intervals longer than this (pauses, scene changes without speech)
    const ORP_COLOR        = '#ff4444';
    const FONT_PX          = 36;     // natural (un-scaled) font size — actual on-screen size is FONT_PX * totalScale
    const SCALE_RATIO      = 0.0017; // auto-scale = player.height * this
    const SCALE_MIN        = 0.6;
    const SCALE_MAX        = 4.0;
    const AUTO_ENABLE_CC   = true;   // click YouTube's CC button if it's off when we toggle on
    const BOTTOM_PCT       = 0.13;   // overlay bottom edge sits this fraction of player height above player bottom
    const SNAP_PX          = 26;     // drag snaps overlay center to player center within this many pixels
    // ====================================

    let enabled            = false;
    let lastCaptionText    = '';
    let wordQueue          = [];     // [{word, durMs}]
    let displayTimer       = null;
    // Adaptive pacing — see onCaptionUpdate. Wall-clock interval between
    // caption mutations is the previous chunk's actual on-screen duration,
    // which we use to pace the next chunk's words. This auto-adapts to
    // playback rate changes (faster video → faster mutations → faster
    // pacing) without ever reading playbackRate.
    let lastChunkArrivalMs = null;
    let lastChunkDurationMs = null;
    let observer           = null;
    let captionContainer   = null;
    let overlayEl          = null;
    let wordBeforeEl       = null;
    let wordPivotEl        = null;
    let wordAfterEl        = null;
    let userMovedOverlay   = false;  // once user drags, stop auto-positioning
    let resizeRaf          = 0;
    let hideStyleEl        = null;   // <style> we inject to hide native CC
    let scaleFactor        = 1.0;    // initialized from storage below, after lsGet helpers exist
    let ccVisible          = false;  // when true, native YouTube CC remains visible alongside the overlay
    let ccBtn              = null;   // reference to the CC toggle button (its visual state needs updating)
    let tryFindCaptions    = null;   // exposed so SPA nav can force a re-attach

    // User-chosen position, stored as FRACTIONS of player size (not pixels) so
    // it survives player resizes (theater toggle, fullscreen, window resize).
    // The fractions describe the overlay's bottom-center anchor point —
    // (centerX / playerWidth, bottomY / playerHeight).
    let userPosFracX       = null;
    let userPosFracY       = null;

    // Small "click to enable" button mounted in the player's top-right corner.
    // Only visible while the cursor is over the player AND the overlay is off.
    // Visibility is handled by an injected stylesheet (see ensureOpenButtonStyle).
    let openButtonEl       = null;

    // ---------- Persistence helpers ----------
    function lsGet(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }
    function lsSet(key, value) {
        try { localStorage.setItem(key, value); } catch (_) { /* private mode etc. */ }
    }
    function loadStoredEnabled()    { return lsGet(STORAGE_KEYS.enabled) === '1'; }
    function storeEnabled(on)       { lsSet(STORAGE_KEYS.enabled, on ? '1' : '0'); }
    function loadStoredCcVisible()  { return lsGet(STORAGE_KEYS.cc) === '1'; }
    function storeCcVisible(on)     { lsSet(STORAGE_KEYS.cc, on ? '1' : '0'); }
    function loadStoredScale() {
        const v = parseFloat(lsGet(STORAGE_KEYS.scale));
        return (isFinite(v) && v >= 0.4 && v <= 5.0) ? v : null;
    }
    function storeScale(v)          { lsSet(STORAGE_KEYS.scale, String(v)); }

    // Hydrate state from storage now that the helpers are defined.
    {
        const storedScale = loadStoredScale();
        scaleFactor = (storedScale != null) ? storedScale : DEFAULT_SCALE_FACTOR;
        ccVisible   = loadStoredCcVisible();
    }

    // ---------- DOM helpers (no innerHTML — YouTube enforces Trusted Types) ----------
    function el(tag, styles, text) {
        const e = document.createElement(tag);
        if (styles) e.style.cssText = styles;
        if (text != null) e.textContent = text;
        return e;
    }

    function buildOverlay() {
        // Tight padding — the box is sized just around the word. The +/- and
        // version are absolute-positioned overlays that float OVER the corners
        // of the word area; for short/typical words they sit in empty corner
        // space, and for unusually wide words (16+ chars) they may visually
        // overlap the word's edge while you're hovering — acceptable since
        // the controls are only revealed on hover anyway.
        // position: absolute — the overlay is mounted INSIDE the YouTube player
        // (see ensureMounted), so it can't be dragged outside the video frame
        // and it scales / fullscreens with the player automatically.
        const root = el('div', `
            position: absolute;
            top: 0px;
            left: 0px;
            z-index: 100;
            background: rgba(0,0,0,0.88);
            color: #fff;
            font-family: 'Courier New', ui-monospace, monospace;
            font-size: ${FONT_PX}px;
            padding: 20px 14px;
            border-radius: 8px;
            text-align: center;
            user-select: none;
            box-shadow: 0 4px 14px rgba(0,0,0,0.55);
            display: none;
            cursor: move;
            pointer-events: auto;
            transform-origin: 50% 100%;
            touch-action: none;
        `);
        root.id = 'rivet-overlay';

        const rail = el('div', `position:relative; width: ${RAIL}ch; margin: 0 auto;`);

        // Ticks pushed 10px out from the rail (was 6px) so there's a small but
        // visible gap between the tick end and the letter glyph.
        const tickTop = el('div', `position:absolute; left:50%; top:-10px; width:1px; height:6px; background:${ORP_COLOR}; transform: translateX(-50%);`);
        const tickBot = el('div', `position:absolute; left:50%; bottom:-10px; width:1px; height:6px; background:${ORP_COLOR}; transform: translateX(-50%);`);
        rail.appendChild(tickTop);
        rail.appendChild(tickBot);

        // No letter-spacing — even a tiny amount accumulated across 21 cells
        // breaks the rail-center vs. pivot-center alignment, since the line
        // becomes wider than `${RAIL}ch` and text-align centers the spillover.
        // min-height keeps the box from collapsing when the word spans are
        // empty (e.g. before the first caption arrives) — without it, the
        // overlay shrinks to just the padding and noticeably "jumps" once
        // the first word appears.
        const wordRow = el('div', 'white-space: pre; letter-spacing: 0; line-height: 1.1; min-height: 1.1em;');
        wordBeforeEl = el('span', 'opacity:0.9;');
        wordPivotEl  = el('span', `color:${ORP_COLOR}; font-weight:700;`);
        wordAfterEl  = el('span', 'opacity:0.9;');
        wordRow.appendChild(wordBeforeEl);
        wordRow.appendChild(wordPivotEl);
        wordRow.appendChild(wordAfterEl);
        rail.appendChild(wordRow);
        root.appendChild(rail);

        // +/- buttons floating over the top-right corner of the word area.
        // Only visible on hover.
        const ctrlBox = el('div', `
            position: absolute;
            top: 4px; right: 4px;
            display: flex; gap: 3px;
            opacity: 0; transition: opacity 0.12s ease;
            pointer-events: auto;
        `);
        const minusBtn = makeCtrlButton('minus');
        const plusBtn  = makeCtrlButton('plus');
        ccBtn          = makeCcButton();             // shared module-level ref for state updates
        const closeBtn = makeCtrlButton('close');
        // A little extra breathing room before the × — visually separates the
        // "kill the overlay" affordance from the size/CC controls so users
        // don't dismiss it by accident while reaching for CC.
        closeBtn.style.marginLeft = '12px';
        ctrlBox.appendChild(minusBtn);
        ctrlBox.appendChild(plusBtn);
        ctrlBox.appendChild(ccBtn);
        ctrlBox.appendChild(closeBtn);
        for (const b of [minusBtn, plusBtn, ccBtn, closeBtn]) {
            b.addEventListener('mousedown', e => e.stopPropagation());
        }
        minusBtn.addEventListener('click', e => {
            scaleFactor = clamp(scaleFactor / 1.12, 0.4, 5.0);
            storeScale(scaleFactor);
            schedulePosition();
            e.stopPropagation();
        });
        plusBtn.addEventListener('click', e => {
            scaleFactor = clamp(scaleFactor * 1.12, 0.4, 5.0);
            storeScale(scaleFactor);
            schedulePosition();
            e.stopPropagation();
        });
        ccBtn.addEventListener('click', e => {
            ccVisible = !ccVisible;
            storeCcVisible(ccVisible);
            // Toggle native CC visibility immediately (only matters while
            // overlay is on; otherwise CC is naturally visible anyway).
            if (enabled) setNativeCcHidden(!ccVisible);
            updateCcBtnVisual();
            e.stopPropagation();
        });
        closeBtn.addEventListener('click', e => {
            setEnabled(false);
            e.stopPropagation();
        });
        updateCcBtnVisual();           // reflect persisted state on the button
        root.appendChild(ctrlBox);

        // Name + version label floating over the bottom-right corner.
        // Hover-revealed (the controls and this label fade in together).
        const versionEl = el('span', `
            position: absolute;
            bottom: 3px; right: 8px;
            font-family: system-ui, sans-serif;
            font-size: 10px; line-height: 1;
            opacity: 0; transition: opacity 0.12s ease;
            user-select: none;
            pointer-events: none;
            text-shadow: 0 0 3px rgba(0,0,0,0.9);
            white-space: nowrap;
        `, NAME + ' v' + VERSION);
        root.appendChild(versionEl);

        root.addEventListener('mouseenter', () => {
            ctrlBox.style.opacity = '1';
            versionEl.style.opacity = '0.6';
        });
        root.addEventListener('mouseleave', () => {
            ctrlBox.style.opacity = '0';
            versionEl.style.opacity = '0';
        });

        // Block clicks / double-clicks from reaching the underlying video
        // (otherwise YouTube treats them as play/pause and fullscreen toggles).
        // NOTE: do NOT stopPropagation 'mouseup' / 'pointerup' — the drag
        // handler relies on those events to release.
        for (const evt of ['click', 'dblclick']) {
            root.addEventListener(evt, e => e.stopPropagation());
        }

        // Don't appendChild here. The overlay gets mounted inside the YouTube
        // player by ensureMounted() the first time we need to position it.
        makeDraggable(root);
        return root;
    }

    // Make sure the overlay AND the open button are children of the current
    // YouTube player. This keeps them inside the video frame (so the overlay
    // can't be dragged out, and they both automatically go fullscreen /
    // theater with the player). Visibility of the open button is controlled
    // entirely with CSS :hover on the player (see ensureOpenButtonStyle) —
    // JS mouseenter/mouseleave is unreliable when the cursor is already
    // inside the player at script-load time.
    function ensureMounted() {
        const player = document.querySelector('.html5-video-player') || document.querySelector('#movie_player');
        if (!player) return null;
        if (overlayEl && overlayEl.parentElement !== player) {
            player.appendChild(overlayEl);
        }
        if (openButtonEl && openButtonEl.parentElement !== player) {
            player.appendChild(openButtonEl);
        }
        return player;
    }

    // YouTube Shorts uses a vertical-video player at /shorts/<id>. The
    // captions there are different (often burnt-in or repositioned) and the
    // RSVP overlay doesn't make sense over a 60-second clip — so we suppress
    // both the overlay and the open button when the user is on a Shorts URL.
    function isShortsPath() {
        return location.pathname.startsWith('/shorts/');
    }

    // Inject a stylesheet for the open button: hidden by default, shown only
    // when the cursor hovers the player AND the overlay is OFF. Idempotent.
    function ensureOpenButtonStyle() {
        if (document.getElementById('rivet-open-style')) return;
        const s = document.createElement('style');
        s.id = 'rivet-open-style';
        s.textContent = `
            #rivet-open-btn {
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.15s ease;
            }
            .html5-video-player:hover #rivet-open-btn,
            #movie_player:hover #rivet-open-btn {
                opacity: 1;
                pointer-events: auto;
            }
            /* When the overlay is enabled, force-hide the open button. */
            #rivet-open-btn[data-hide="1"] {
                opacity: 0 !important;
                pointer-events: none !important;
            }
        `;
        document.head.appendChild(s);
    }

    function buildOpenButton() {
        // Clickable badge in the player's top-right. Word-mark version of the
        // overlay's own styling: monospace "Rivet" with the middle letter in
        // ORP red — same visual grammar as the in-overlay word display, so
        // it doubles as a preview of what clicking it does.
        // Visibility is controlled by injected CSS — opacity here is just the
        // initial value before the stylesheet attaches.
        const b = el('button', `
            position: absolute;
            top: 12px; right: 12px;
            z-index: 9999;
            background: rgba(0,0,0,0.85);
            border: 1px solid rgba(255,255,255,0.55);
            color: #fff;
            font-family: ui-monospace, 'SF Mono', Menlo, 'Courier New', monospace;
            font-size: 18px; font-weight: 700; line-height: 1;
            letter-spacing: 0.04em;
            padding: 9px 14px;
            border-radius: 5px;
            cursor: pointer;
            user-select: none;
            display: inline-flex; align-items: center; justify-content: center;
            pointer-events: auto;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
        `);
        b.id = 'rivet-open-btn';
        b.title = 'Open ' + NAME;
        // Stylized "Rivet" — middle letter (v) in red as the ORP cue.
        b.appendChild(el('span', 'opacity:0.9;', 'R'));
        b.appendChild(el('span', 'opacity:0.9;', 'i'));
        b.appendChild(el('span', `color:${ORP_COLOR};`, 'v'));
        b.appendChild(el('span', 'opacity:0.9;', 'e'));
        b.appendChild(el('span', 'opacity:0.9;', 't'));
        b.addEventListener('mouseenter', () => {
            b.style.background   = 'rgba(0,0,0,0.95)';
            b.style.borderColor  = ORP_COLOR;
            b.style.transform    = 'translateY(-1px)';
        });
        b.addEventListener('mouseleave', () => {
            b.style.background   = 'rgba(0,0,0,0.85)';
            b.style.borderColor  = 'rgba(255,255,255,0.55)';
            b.style.transform    = '';
        });
        b.addEventListener('mousedown',  e => e.stopPropagation());
        b.addEventListener('click', e => {
            setEnabled(true);
            e.stopPropagation();
        });
        return b;
    }

    // The actual show/hide is done by CSS (player:hover #rivet-open-btn).
    // We only toggle a data attribute that force-hides it when the overlay
    // is enabled — so the open button doesn't appear on top of the overlay.
    function updateOpenButtonVisibility() {
        if (!openButtonEl) return;
        // On Shorts, force-hide regardless of enabled state.
        if (isShortsPath() || enabled) openButtonEl.setAttribute('data-hide', '1');
        else                           openButtonEl.removeAttribute('data-hide');
    }

    // Build a control button with a CSS-drawn icon (not a Unicode glyph).
    // Using divs with absolute positioning gives pixel-perfect centering,
    // since font metrics for symbols like − + × put the glyph at unpredictable
    // vertical positions inside their line-box.
    function makeCtrlButton(kind /* 'minus' | 'plus' | 'close' */) {
        const b = el('button', `
            background: rgba(0,0,0,0.55);
            border: 1px solid rgba(255,255,255,0.4);
            color: #fff;
            width: 18px; height: 18px;
            padding: 0; margin: 0;
            border-radius: 3px;
            cursor: pointer;
            user-select: none;
            position: relative;
            box-sizing: border-box;
        `);
        const bar = (extraTransform = '') => el('div', `
            position: absolute;
            top: 50%; left: 50%;
            width: 10px; height: 2px;
            background: #fff;
            border-radius: 1px;
            transform: translate(-50%, -50%) ${extraTransform};
            pointer-events: none;
        `);
        if (kind === 'minus' || kind === 'plus') {
            b.appendChild(bar());                      // horizontal
            if (kind === 'plus') b.appendChild(bar('rotate(90deg)')); // + vertical
        } else if (kind === 'close') {
            b.appendChild(bar('rotate(45deg)'));
            b.appendChild(bar('rotate(-45deg)'));
        }
        b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.25)');
        b.addEventListener('mouseleave', () => b.style.background = 'rgba(0,0,0,0.55)');
        return b;
    }

    // Sized to match the +/- buttons in height; slightly wider to fit "CC".
    // Visual state (off/on) is applied separately by updateCcBtnVisual.
    function makeCcButton() {
        return el('button', `
            background: rgba(0,0,0,0.55);
            border: 1px solid rgba(255,255,255,0.4);
            color: #fff;
            font-family: system-ui, sans-serif;
            font-size: 9px; font-weight: 700; line-height: 1;
            height: 18px; min-width: 22px; padding: 0 3px;
            margin: 0;
            border-radius: 3px;
            cursor: pointer;
            user-select: none;
            display: flex; align-items: center; justify-content: center;
            box-sizing: border-box;
            letter-spacing: 0.5px;
        `, 'CC');
    }

    function updateCcBtnVisual() {
        if (!ccBtn) return;
        if (ccVisible) {
            // "On" — inverted so it stands out (like YouTube's own active CC).
            ccBtn.style.background   = 'rgba(255,255,255,0.92)';
            ccBtn.style.color        = '#000';
            ccBtn.style.borderColor  = '#fff';
        } else {
            ccBtn.style.background   = 'rgba(0,0,0,0.55)';
            ccBtn.style.color        = '#fff';
            ccBtn.style.borderColor  = 'rgba(255,255,255,0.4)';
        }
    }

    function makeDraggable(node) {
        // Pointer events + setPointerCapture means the element will keep
        // receiving move/up events even if the cursor leaves it (or goes
        // over a sibling that would otherwise eat the event). That fixes
        // the "doesn't let go on mouseup" bug.
        let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

        const stopDrag = () => {
            dragging = false;
        };

        node.addEventListener('pointerdown', (e) => {
            // Ignore drag start on the +/- buttons themselves.
            if (e.target && e.target.tagName === 'BUTTON') return;
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            origLeft = parseFloat(node.style.left) || 0;
            origTop  = parseFloat(node.style.top)  || 0;
            try { node.setPointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        });
        node.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX, dy = e.clientY - startY;
            // The instant we actually move, mark this as user-placed so the
            // periodic positionOverlay tick stops snapping it back to center.
            if (!userMovedOverlay && Math.abs(dx) + Math.abs(dy) > 2) {
                userMovedOverlay = true;
            }
            let newLeft = origLeft + dx;
            let   newTop = origTop + dy;

            // Use the player's CURRENT size for snap + clamp. The overlay is a
            // child of the player, so style.left/top are player-local coords.
            const player = node.parentElement;
            if (player) {
                const pw = player.clientWidth;
                const ph = player.clientHeight;
                const ow = node.offsetWidth;
                const oh = node.offsetHeight;

                // Snap X center to player center when close.
                const playerCenterX  = pw / 2;
                const overlayCenterX = newLeft + ow / 2;
                if (Math.abs(overlayCenterX - playerCenterX) < SNAP_PX) {
                    newLeft = playerCenterX - ow / 2;
                }

                // Snap Y to the default auto-anchor position when close. This
                // is the same y the overlay would render at if you'd never
                // dragged it (aligned with the bottom of YouTube's caption
                // window when detectable, else BOTTOM_PCT fallback), so
                // dragging back near home gives a satisfying click into place.
                const defaultTop = getDefaultBottomY(player, ph) - oh;
                if (Math.abs(newTop - defaultTop) < SNAP_PX) {
                    newTop = defaultTop;
                }

                // Clamp inside the player so the layout box never escapes.
                newLeft = clamp(newLeft, 0, Math.max(0, pw - ow));
                newTop  = clamp(newTop,  0, Math.max(0, ph - oh));

                // Persist position as FRACTIONS of player size — this is what
                // makes the overlay stay in the same RELATIVE position across
                // theater / fullscreen / window resize.
                if (pw && ph) {
                    userPosFracX = (newLeft + ow / 2) / pw;     // X-center fraction
                    userPosFracY = (newTop  + oh)     / ph;     // bottom-Y fraction
                }
            }

            node.style.left = newLeft + 'px';
            node.style.top  = newTop  + 'px';
        });
        node.addEventListener('pointerup',     stopDrag);
        node.addEventListener('pointercancel', stopDrag);
    }

    // Returns the player-local Y where the overlay's bottom edge should rest
    // by default. We try to align with the bottom of YouTube's caption
    // rendering area (.caption-window) so the overlay feels like it's
    // *replacing* the captions rather than floating somewhere arbitrary.
    // Falls back to the old BOTTOM_PCT-based estimate when we can't read
    // the caption window (CC truly off, or first frame before YouTube has
    // mounted the caption DOM).
    function getDefaultBottomY(player, ph) {
        const cw = player.querySelector('.caption-window');
        if (cw) {
            const r = cw.getBoundingClientRect();
            if (r.height > 0) {
                const pr = player.getBoundingClientRect();
                const y = r.bottom - pr.top;
                // Sanity-clamp to inside the player in case YouTube parks
                // the caption window somewhere unexpected.
                if (y > 0 && y <= ph) return y;
            }
        }
        return ph * (1 - BOTTOM_PCT);
    }

    // ---------- Positioning + responsive sizing ----------
    // The overlay's natural size is fixed (FONT_PX). On-screen size is set with
    // CSS transform: scale(N), where N grows with player height (theater /
    // fullscreen) and is multiplied by user-adjustable scaleFactor.
    //
    // transform-origin is bottom-center, so scaling grows the box upward and
    // outward from a fixed bottom-center anchor — exactly what we want for a
    // captions-style overlay.
    //
    // The overlay is a CHILD of the YouTube player element, so style.left and
    // style.top are in player-local coords (px from the player's top-left).
    function positionOverlay() {
        if (!overlayEl || !enabled) return;
        // On Shorts, hide and bail. Overlay re-shows on next nav back to a
        // regular watch page (the periodic schedulePosition tick picks it up).
        if (isShortsPath()) { overlayEl.style.display = 'none'; return; }
        if (overlayEl.style.display === 'none') overlayEl.style.display = 'block';
        const player = ensureMounted();
        if (!player) return;
        const pw = player.clientWidth;
        const ph = player.clientHeight;
        if (!pw || !ph) return;

        const totalScale = clamp(ph * SCALE_RATIO * scaleFactor, SCALE_MIN, SCALE_MAX);
        overlayEl.style.transform = `scale(${totalScale.toFixed(3)})`;

        const ow = overlayEl.offsetWidth  || 360;
        const oh = overlayEl.offsetHeight || 70;

        if (userMovedOverlay) {
            // Recompute pixel position from saved FRACTIONS so the overlay
            // stays in the same relative spot when the player resizes
            // (theater toggle, fullscreen, window resize). Falls back to the
            // current pixel position if no fractions are stored yet.
            let newLeft, newTop;
            if (userPosFracX != null && userPosFracY != null) {
                newLeft = userPosFracX * pw - ow / 2;
                newTop  = userPosFracY * ph - oh;
            } else {
                newLeft = parseFloat(overlayEl.style.left) || 0;
                newTop  = parseFloat(overlayEl.style.top)  || 0;
            }
            newLeft = clamp(newLeft, 0, Math.max(0, pw - ow));
            newTop  = clamp(newTop,  0, Math.max(0, ph - oh));
            overlayEl.style.left = Math.round(newLeft) + 'px';
            overlayEl.style.top  = Math.round(newTop)  + 'px';
            return;
        }

        // Auto-anchor: bottom-center of the un-scaled layout box at this point
        // (transform-origin keeps the visual bottom-center pinned here too).
        const cx = pw / 2;
        const cy = getDefaultBottomY(player, ph);
        overlayEl.style.left = Math.round(cx - ow / 2) + 'px';
        overlayEl.style.top  = Math.round(cy - oh)     + 'px';
    }

    function schedulePosition() {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
            resizeRaf = 0;
            positionOverlay();
        });
    }

    // ---------- Caption reading ----------
    function getCaptionText() {
        const c = document.querySelector('.ytp-caption-window-container');
        if (!c) return '';
        // ONLY .ytp-caption-segment (the leaf). .caption-visual-line wraps segments,
        // so querying both would double-count the same text.
        const segs = c.querySelectorAll('.ytp-caption-segment');
        const txt = segs.length
            ? Array.from(segs).map(s => s.innerText).join(' ')
            : c.innerText;
        return txt.replace(/\s+/g, ' ').trim();
    }

    function diffNewWords(prev, curr) {
        const pw = prev.split(/\s+/).filter(Boolean);
        const cw = curr.split(/\s+/).filter(Boolean);
        if (!pw.length) return cw;
        const maxK = Math.min(pw.length, cw.length);
        let bestK = 0;
        for (let k = maxK; k >= 1; k--) {
            let ok = true;
            for (let i = 0; i < k; i++) {
                if (pw[pw.length - k + i] !== cw[i]) { ok = false; break; }
            }
            if (ok) { bestK = k; break; }
        }
        return cw.slice(bestK);
    }

    function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

    function onCaptionUpdate() {
        if (!enabled) return;
        const text = getCaptionText();
        if (text === lastCaptionText) return;

        const newWords = diffNewWords(lastCaptionText, text);
        lastCaptionText = text;
        if (!newWords.length) return;

        // Update the inter-chunk interval timer. The wall-clock time between
        // this mutation and the previous one IS the previous chunk's actual
        // visible duration — we use that to pace the new chunk's words.
        // Why wall-clock instead of video.currentTime? Because then if the
        // user changes playback rate mid-video, the next mutation arrives
        // proportionally sooner/later in real time, and our pacing adjusts
        // automatically with no playbackRate variable in this code.
        const now = performance.now();
        if (lastChunkArrivalMs != null) {
            const interval = now - lastChunkArrivalMs;
            if (interval >= ADAPTIVE_INTERVAL_MIN_MS &&
                interval <= ADAPTIVE_INTERVAL_MAX_MS) {
                lastChunkDurationMs = interval;
            }
            // else: pause / seek / silence — keep the previous estimate.
        }
        lastChunkArrivalMs = now;

        // Choose per-word duration:
        //   1 word                         → value irrelevant (no timer fires
        //                                     for a 1-item queue), use min.
        //   2-3 words, no measured data    → BURST_WORD_MS (catch-up speed).
        //   2-3 words, have measured data  → derived from previous chunk
        //                                     duration / count, clamped.
        //   4+ words, no measured data     → READING_PACE_MS (initial guess).
        //   4+ words, have measured data   → derived from previous chunk
        //                                     duration / count, clamped.
        let perWord;
        if (newWords.length === 1) {
            perWord = ADAPTIVE_MIN_MS;
        } else if (lastChunkDurationMs != null) {
            perWord = clamp(
                lastChunkDurationMs / newWords.length,
                ADAPTIVE_MIN_MS,
                ADAPTIVE_MAX_MS,
            );
        } else {
            // No measured data yet — first chunk of the video.
            perWord = newWords.length >= CHUNK_THRESHOLD
                ? READING_PACE_MS
                : BURST_WORD_MS;
        }
        wordQueue = newWords.map(w => ({ word: w, durMs: perWord }));
        if (displayTimer) { clearTimeout(displayTimer); displayTimer = null; }
        showNext();
    }

    // ---------- RSVP rendering ----------
    function orpIndex(len) {
        if (len <= 1)  return 0;
        if (len <= 5)  return 1;
        if (len <= 9)  return 2;
        if (len <= 13) return 3;
        return 4;
    }

    // Rail width MUST be ODD so its visual center coincides with the center
    // of a single character cell (where the pivot lives). With an even width
    // the center falls on the boundary between two cells and the ORP tick
    // would be 0.5ch off from the pivot's center.
    const RAIL   = 21;   // total width in monospace cells (must be odd)
    const CENTER = 11;   // pivot column (1-indexed) — ((RAIL+1)/2)
    const NB = ' ';

    function renderWord(word) {
        const i = orpIndex(word.length);
        const before = word.slice(0, i);
        const pivot  = word[i] || '';
        const after  = word.slice(i + 1);
        const leftPad  = Math.max(0, CENTER - before.length - 1);
        const rightPad = Math.max(0, RAIL - leftPad - before.length - 1 - after.length);
        if (wordBeforeEl) wordBeforeEl.textContent = NB.repeat(leftPad) + before;
        if (wordPivotEl)  wordPivotEl.textContent  = pivot;
        if (wordAfterEl)  wordAfterEl.textContent  = after + NB.repeat(rightPad);
    }

    function clearWord() {
        if (wordBeforeEl) wordBeforeEl.textContent = '';
        if (wordPivotEl)  wordPivotEl.textContent  = '';
        if (wordAfterEl)  wordAfterEl.textContent  = '';
    }

    function showNext() {
        if (!enabled) { displayTimer = null; return; }
        const next = wordQueue.shift();
        if (!next) { displayTimer = null; return; }
        renderWord(next.word);
        // If more words queued, advance using the per-word duration set when
        // the queue was filled (BURST_WORD_MS for small bursts, READING_PACE_MS
        // for big chunks — see onCaptionUpdate). Otherwise stop the timer:
        // the rendered word stays on screen until the next caption mutation.
        if (wordQueue.length > 0) {
            displayTimer = setTimeout(showNext, next.durMs);
        } else {
            displayTimer = null;
        }
    }

    // ---------- Observation ----------
    function findAndObserveCaptions() {
        tryFindCaptions = () => {
            const c = document.querySelector('.ytp-caption-window-container');
            if (c && c !== captionContainer) {
                if (observer) observer.disconnect();
                captionContainer = c;
                observer = new MutationObserver(onCaptionUpdate);
                observer.observe(c, { childList: true, subtree: true, characterData: true });
                // Sync baseline so we only emit words from the NEXT mutation
                // onward, no flashing through whatever's already on screen.
                if (enabled) lastCaptionText = getCaptionText();
            }
            // YouTube can silently turn captions OFF when it transitions
            // between an ad and the main video (and a few other state
            // changes). If the user has the overlay enabled, re-enable
            // captions so we keep getting mutations to read from.
            if (enabled && AUTO_ENABLE_CC) {
                const btn = document.querySelector('.ytp-subtitles-button');
                if (btn && btn.getAttribute('aria-pressed') === 'false') {
                    btn.click();
                }
            }
        };
        tryFindCaptions();
        setInterval(tryFindCaptions, 1500); // re-attach across navigations / seeks
    }

    // ---------- SPA navigation handling ----------
    // YouTube is a single-page app. When the URL changes (e.g. clicking on a
    // related video), the player keeps living but its caption container, and
    // the cue text we've cached, become stale. Reset and re-attach.
    function onSpaNavigate() {
        if (observer) { observer.disconnect(); observer = null; }
        captionContainer = null;
        lastCaptionText  = '';
        wordQueue        = [];
        // Reset adaptive-pacing state so the new video's pacing is measured
        // fresh (not biased by the previous video's chunk durations).
        lastChunkArrivalMs  = null;
        lastChunkDurationMs = null;
        if (displayTimer) { clearTimeout(displayTimer); displayTimer = null; }
        clearWord();
        if (!enabled) return;
        // Give YouTube a moment to spin up the new player state, then re-init.
        setTimeout(() => {
            if (!enabled) return;
            ensureCaptionsOn();
            setNativeCcHidden(!ccVisible);
            if (tryFindCaptions) tryFindCaptions();
            schedulePosition();
        }, 600);
    }

    // ---------- Auto-enable YouTube captions ----------
    function ensureCaptionsOn() {
        if (!AUTO_ENABLE_CC) return;
        let tries = 0;
        const tick = () => {
            const btn = document.querySelector('.ytp-subtitles-button');
            if (btn && btn.getAttribute('aria-pressed') === 'false') {
                btn.click();
            }
            const onNow = btn && btn.getAttribute('aria-pressed') === 'true';
            if (!onNow && tries++ < 20) setTimeout(tick, 400);
        };
        tick();
    }

    // ---------- Hide / restore native CC rendering ----------
    // We still NEED CC turned on (so the DOM keeps populating with the cue
    // text we want to read). We have to use opacity:0 (NOT visibility:hidden
    // or display:none) — YouTube checks the visual state of the caption
    // container and stops rendering captions if it sees them as hidden, but
    // it doesn't notice opacity changes.
    function setNativeCcHidden(hidden) {
        if (hidden) {
            if (hideStyleEl) return;
            hideStyleEl = document.createElement('style');
            hideStyleEl.id = 'rivet-hide-cc';
            hideStyleEl.textContent =
                '.ytp-caption-window-container{opacity:0!important;pointer-events:none!important;}';
            document.head.appendChild(hideStyleEl);
        } else if (hideStyleEl) {
            hideStyleEl.remove();
            hideStyleEl = null;
        }
    }

    // ---------- Toggle ----------
    function setEnabled(on) {
        enabled = on;
        if (!overlayEl) overlayEl = buildOverlay();
        overlayEl.style.display = on ? 'block' : 'none';
        if (!on) {
            wordQueue = [];
            if (displayTimer) { clearTimeout(displayTimer); displayTimer = null; }
            clearWord();
            setNativeCcHidden(false);   // always restore native CC when overlay is off
        } else {
            // Sync to whatever's already on screen so we ONLY emit words from
            // the next mutation onward — no flashing through the backlog.
            lastCaptionText = getCaptionText();
            ensureCaptionsOn();
            setNativeCcHidden(!ccVisible);   // honor user's CC toggle
            schedulePosition();
        }
        storeEnabled(on);
        updateOpenButtonVisibility();
    }

    document.addEventListener('keydown', (e) => {
        if (!e.shiftKey) return;
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
        if (e.key.toUpperCase() === TOGGLE_KEY) {
            setEnabled(!enabled); e.preventDefault();
        }
    });

    // Expose programmatic hooks (handy for debugging / future Chrome extension popup)
    window.__rivet = {
        toggle: () => { setEnabled(!enabled); return enabled; },
        on:     () => setEnabled(true),
        off:    () => setEnabled(false),
        state:  () => ({ enabled, queueLen: wordQueue.length, lastCaptionText })
    };

    // Re-anchor on viewport / fullscreen / theater changes.
    window.addEventListener('resize',           schedulePosition);
    document.addEventListener('fullscreenchange', schedulePosition);
    setInterval(() => { if (enabled) positionOverlay(); }, 500);

    // YouTube's SPA navigation events. yt-navigate-finish fires when the new
    // page (video) is fully ready. yt-navigate-start fires when navigation
    // begins. We listen on both to cover edge cases.
    document.addEventListener('yt-navigate-finish', onSpaNavigate);
    window.addEventListener('yt-navigate-finish',   onSpaNavigate);

    // Periodically refresh the open button's mounting + visibility, so it
    // shows up after SPA navigations or when the player is created late.
    setInterval(() => { ensureMounted(); updateOpenButtonVisibility(); }, 500);

    // ---------- Boot ----------
    const boot = () => {
        if (!document.body) return setTimeout(boot, 300);
        ensureOpenButtonStyle();
        if (!overlayEl) overlayEl = buildOverlay();
        if (!openButtonEl) openButtonEl = buildOpenButton();
        ensureMounted();
        updateOpenButtonVisibility();
        findAndObserveCaptions();

        // Restore persisted enabled state. Wait briefly so the player and
        // CC button are ready before we try to flip everything on.
        if (loadStoredEnabled()) {
            setTimeout(() => { if (!enabled) setEnabled(true); }, 800);
        }

        // eslint-disable-next-line no-console
        console.log('[' + NAME + ' v' + VERSION + '] loaded. Hover the video for the open button, or press Shift+' + TOGGLE_KEY + '.');
    };
    boot();
})();
