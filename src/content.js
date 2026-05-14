
(function () {
    'use strict';

    if (window.__rivetInstalled) return;
    window.__rivetInstalled = true;

    // ============== CONFIG ==============
    const NAME             = 'Rivet';
    const VERSION          = '0.13.6';
    const STORAGE_KEYS = {
        enabled:    'rivet-enabled',
        cc:         'rivet-cc-visible',
        scale:      'rivet-scale',
        manualAck:  'rivet-manual-warn-ack',
        autoSwAck:  'rivet-auto-switch-ack',
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
    function loadStoredManualAck()  { return lsGet(STORAGE_KEYS.manualAck) === '1'; }
    function storeManualAck(on)     { lsSet(STORAGE_KEYS.manualAck, on ? '1' : '0'); }
    function loadStoredAutoSwAck()  { return lsGet(STORAGE_KEYS.autoSwAck) === '1'; }
    function storeAutoSwAck(on)     { lsSet(STORAGE_KEYS.autoSwAck, on ? '1' : '0'); }

    // Debug logger — silent in normal operation; enable from the page console:
    //   localStorage.setItem('rivet-debug', '1'); location.reload();
    // Disable with: localStorage.removeItem('rivet-debug');
    function dbg() {
        if (lsGet('rivet-debug') !== '1') return;
        const args = Array.prototype.slice.call(arguments);
        // eslint-disable-next-line no-console
        console.log.apply(console, ['[Rivet]'].concat(args));
    }

    // Authoritative caption-track state from probe.js (page-context script
    // that calls player.getOption). Null until the probe responds.
    //   - trackKind: 'asr' (auto-generated), 'manual' (editor-uploaded), or null
    //   - availableTracks: array of {languageCode, kind?, ...} from
    //     player.getOption('captions','tracklist')
    //   - originalTrackBeforeSwitch: snapshot of the track we replaced
    //     when the user clicked "Switch to auto-generated", so we can
    //     offer a "Switch back" affordance.
    //   - rivetAutoSwitched: true after we've called setOption to swap
    //     tracks; keeps the (!) badge present (muted) so user can revert.
    let trackKind                  = null;
    let availableTracks            = [];
    let originalTrackBeforeSwitch  = null;
    let rivetAutoSwitched          = false;
    let probeReady                 = false;
    // Per-video latch: true once we've evaluated/attempted an auto-switch
    // for the current video so the polling cycle doesn't keep re-firing it.
    let autoSwitchAttempted        = false;
    // Set when an auto-switch fires AND the user has never been shown the
    // explanation popup. Consumed by the 'switched' handler to auto-open
    // the popup once; cleared after.
    let pendingAutoExplain         = false;
    // Persisted: has the user ever been shown the "Rivet auto-switched"
    // explanation? After yes, subsequent auto-switches stay silent.
    let autoSwitchEverExplained    = false;

    // Set true once we're confident this video is using manual / pro-uploaded
    // captions (drives the (!) badge). The probe's authoritative answer
    // overrides this when available; otherwise we fall back to the chunk-
    // pattern heuristic below.
    let manualCaptionsDetected = false;
    // Counters fed by every caption mutation; the heuristic uses both.
    //
    // Why both?
    //   - A *single* >=CHUNK_THRESHOLD mutation is NOT enough — auto-captions
    //     often deliver the first cue of a video as a 3-6 word group.
    //   - Pure manual captions NEVER emit single-word mutations (always
    //     full sentences). So singleWordChunks == 0 is a strong "manual"
    //     signal once we've also seen multi-word chunks.
    //   - As a fast-path, a *very* large chunk (>=8 words) is almost
    //     certainly manual — auto-captions rarely arrive that much at once.
    //
    // Reset per video (SPA nav) so a manual video followed by an auto-
    // captioned video gets reclassified.
    let singleWordChunks = 0;
    let multiWordChunks  = 0;
    const MANUAL_LARGE_CHUNK    = 8;   // 1 chunk this big => manual
    const MANUAL_REPEAT_CHUNKS  = 2;   // 2+ multi-word chunks AND no singles => manual
    // Has the user clicked the (!) badge at least once? Persisted, so they
    // only see the prominent version on first encounter ever.
    let manualWarnAck = false;
    let warnBtnEl     = null;
    let warnPopupEl   = null;

    // Hydrate state from storage now that the helpers are defined.
    {
        const storedScale = loadStoredScale();
        scaleFactor      = (storedScale != null) ? storedScale : DEFAULT_SCALE_FACTOR;
        ccVisible        = loadStoredCcVisible();
        manualWarnAck             = loadStoredManualAck();
        autoSwitchEverExplained   = loadStoredAutoSwAck();
    }

    // ---------- DOM helpers (no innerHTML — YouTube enforces Trusted Types) ----------
    function el(tag, styles, text) {
        const e = document.createElement(tag);
        if (styles) e.style.cssText = styles;
        if (text != null) e.textContent = text;
        return e;
    }

    // ---------- Probe bridge (page-context player API) ----------
    // probe.js runs in the page world (loaded via web_accessible_resources)
    // so it can call player.getOption / setOption. We talk to it via
    // window.postMessage. See src/probe.js for the other side.
    function injectProbe() {
        if (document.getElementById('rivet-probe-script')) return;
        try {
            const s = document.createElement('script');
            s.id = 'rivet-probe-script';
            s.src = chrome.runtime.getURL('probe.js');
            // Remove the tag once it's run; the script's effect persists on
            // the page's window object (window.__rivetProbeInstalled), so we
            // don't need the DOM node hanging around.
            s.onload = () => { try { s.remove(); } catch (_) {} };
            (document.head || document.documentElement).appendChild(s);
        } catch (_) { /* extension URL unavailable in some test contexts */ }
    }

    function probeSend(op, extra) {
        try {
            const msg = Object.assign({ source: 'rivet-cs', op: op }, extra || {});
            window.postMessage(msg, '*');
        } catch (_) {}
    }

    function requestTrackInfo() { probeSend('getTrackInfo'); }

    // Reconcile state with the probe's snapshot. Authoritative when present.
    function applyTrackSnapshot(snap) {
        if (!snap) return;
        const cur = snap.current || null;
        availableTracks = Array.isArray(snap.available) ? snap.available : [];
        // The probe sometimes reports current as `{}` before the player has
        // selected a track (most often on the very first 'ready' message,
        // before the user has enabled captions). Empty object → unknown, NOT
        // manual — otherwise we'd auto-switch on every page load even before
        // the user opens Rivet.
        if (cur && typeof cur === 'object' && cur.languageCode) {
            trackKind = cur.kind === 'asr' ? 'asr' : 'manual';
        } else {
            trackKind = null;
        }
        dbg('snapshot', { trackKind: trackKind, listLen: availableTracks.length, currentLang: cur && cur.languageCode });
        updateWarnBtn();
        // Once we have authoritative track info, see if we should silently
        // upgrade the user to the auto-generated track. No-op if already
        // attempted this video, or if no matching ASR track exists.
        maybeAutoSwitch();
    }

    // Compare language codes treating regional variants as equivalent. The
    // manual track on a US-English video reports 'en-US' while the ASR
    // track reports the bare 'en' — those ought to match for our purposes.
    function langBase(code) {
        if (!code) return '';
        return String(code).split(/[-_]/)[0].toLowerCase();
    }

    // The track object passed to setOption needs to be one of the entries
    // we got from tracklist (YouTube's player compares by identity / shape).
    // Match on (base) language AND kind='asr' so we don't accidentally pick
    // a different language.
    function findAsrTrackFor(currentTrack, tracks) {
        if (!tracks || !tracks.length) return null;
        const lang = currentTrack && langBase(currentTrack.languageCode);
        if (lang) {
            const sameLang = tracks.find(t => t && t.kind === 'asr' && langBase(t.languageCode) === lang);
            if (sameLang) return sameLang;
        }
        return tracks.find(t => t && t.kind === 'asr') || null;
    }

    function switchToAsr() {
        // Need a current track to remember (for revert) and a tracklist to
        // search. If either is missing, just bail — the popup will continue
        // to show the explanation without a switch button.
        const tracks = availableTracks;
        const target = findAsrTrackFor(originalTrackBeforeSwitch || lastCurrentTrack(), tracks);
        if (!target) return;
        originalTrackBeforeSwitch = lastCurrentTrack();
        rivetAutoSwitched = true;
        probeSend('switchToTrack', { track: target });
    }

    // Default behavior: when the probe authoritatively reports that the
    // current track is manual AND an ASR track exists in the same base
    // language, switch automatically. Latched per video by
    // autoSwitchAttempted so the polling loop doesn't keep re-firing this.
    function maybeAutoSwitch() {
        if (autoSwitchAttempted) { dbg('maybeAutoSwitch: skip (already attempted)'); return; }
        // Don't touch the user's captions until they're actually using Rivet.
        // Firing earlier (e.g. on page load) would mutate their CC selection
        // even on pages they never engaged with the overlay on.
        if (!enabled) { dbg('maybeAutoSwitch: skip (Rivet not enabled yet)'); return; }
        if (trackKind !== 'manual') { dbg('maybeAutoSwitch: skip (trackKind=', trackKind, ')'); return; }
        if (rivetAutoSwitched) { dbg('maybeAutoSwitch: skip (already switched)'); return; }
        const target = findAsrTrackFor(lastCurrentTrack(), availableTracks);
        if (!target) { dbg('maybeAutoSwitch: skip (no matching ASR track in list of', availableTracks.length, ')'); return; }
        autoSwitchAttempted = true;
        // First-time auto-switch surface: queue the popup to open once the
        // probe confirms the swap landed. After the user dismisses it, the
        // ack persists and all future auto-switches happen silently.
        if (!autoSwitchEverExplained) pendingAutoExplain = true;
        originalTrackBeforeSwitch = lastCurrentTrack();
        rivetAutoSwitched = true;
        dbg('maybeAutoSwitch: switching to', target.languageCode, target.kind, 'pendingExplain=', pendingAutoExplain);
        probeSend('switchToTrack', { track: target });
    }

    function revertTrackSwitch() {
        if (!originalTrackBeforeSwitch) return;
        probeSend('switchToTrack', { track: originalTrackBeforeSwitch });
        rivetAutoSwitched = false;
        originalTrackBeforeSwitch = null;
    }

    // The "current track" we remember between probe round-trips. We can't
    // store the full snapshot mutably without race conditions, but for the
    // ASR-match heuristic we just need the languageCode of whatever the
    // probe most recently reported.
    let _lastCurrentTrack = null;
    function lastCurrentTrack() { return _lastCurrentTrack; }

    window.addEventListener('message', (e) => {
        // Don't compare e.source to window — content scripts run in an
        // isolated world, so the page's Window proxy and this script's
        // `window` ref point to the same frame but are NOT === equal. That
        // identity check silently dropped every probe message. We gate on
        // origin (same-document only) and on our message tag instead.
        if (e.origin && e.origin !== location.origin) return;
        const m = e.data;
        if (!m || m.source !== 'rivet-probe') return;
        if (lsGet('rivet-debug') === '1') {
            let s;
            try { s = JSON.stringify(m.data); } catch (_) { s = '<unstringifiable>'; }
            // eslint-disable-next-line no-console
            console.log('[Rivet cs] ←', m.op, s);
        }
        switch (m.op) {
            case 'ready':
                probeReady = true;
                if (m.data) {
                    _lastCurrentTrack = m.data.current || null;
                    applyTrackSnapshot(m.data);
                }
                break;
            case 'trackInfo':
                if (m.data) {
                    _lastCurrentTrack = m.data.current || null;
                    applyTrackSnapshot(m.data);
                }
                break;
            case 'switched': {
                const newSnap = m.data && m.data.snapshot;
                if (newSnap) {
                    _lastCurrentTrack = newSnap.current || null;
                    applyTrackSnapshot(newSnap);
                }
                // Verify the switch actually landed. setOption sometimes
                // reports ok=true but the player ignored it (e.g. track
                // identity mismatch). Roll back our optimistic flags if so.
                if (rivetAutoSwitched && trackKind !== 'asr') {
                    rivetAutoSwitched = false;
                    originalTrackBeforeSwitch = null;
                    pendingAutoExplain = false;
                    updateWarnBtn();
                    break;
                }
                // After swapping tracks, YouTube sometimes drops caption
                // visibility (or restarts the caption-window element). Give
                // the player a moment to settle, then make sure CC is back
                // on and our hide preference is reapplied so the user's
                // CC-toggle state stays consistent across the swap.
                if (rivetAutoSwitched && trackKind === 'asr' && enabled) {
                    setTimeout(() => {
                        if (!enabled) return;
                        ensureCaptionsOn();
                        setNativeCcHidden(!ccVisible);
                    }, 300);
                }
                // First successful auto-switch ever → open the explainer
                // popup once so the user knows what just happened and how to
                // revert. Persisted ack means we stay quiet next time.
                if (pendingAutoExplain && rivetAutoSwitched && trackKind === 'asr') {
                    renderWarnPopup();
                    if (warnPopupEl) warnPopupEl.style.display = 'block';
                    pendingAutoExplain = false;
                    autoSwitchEverExplained = true;
                    storeAutoSwAck(true);
                }
                renderWarnPopup();
                break;
            }
        }
    });

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

        // Manual-caption warning badge — top-left of the overlay, always visible
        // once we detect chunk-mode captions (no hover required). Prominent
        // (pulsing red) until the user clicks it once, then permanently muted
        // (small gray dot) per user preference. See updateWarnBtn().
        ensureWarnKeyframes();
        warnBtnEl = buildWarnButton();
        warnPopupEl = buildWarnPopup();
        warnBtnEl.addEventListener('mousedown', e => e.stopPropagation());
        warnBtnEl.addEventListener('click', e => {
            const showing = warnPopupEl.style.display === 'block';
            if (!showing) renderWarnPopup();
            warnPopupEl.style.display = showing ? 'none' : 'block';
            if (!manualWarnAck) {
                manualWarnAck = true;
                storeManualAck(true);
                updateWarnBtn();
            }
            e.stopPropagation();
        });
        root.appendChild(warnBtnEl);
        root.appendChild(warnPopupEl);
        updateWarnBtn();


        // Name + version label, hover-revealed in the bottom-right corner.
        // Clickable: opens the Rivet marketing site in a new tab. Hover
        // gives it a subtle underline + brighter opacity to advertise the
        // link affordance, since the badge is otherwise visually understated.
        const versionEl = el('a', `
            position: absolute;
            bottom: 3px; right: 8px;
            font-family: system-ui, sans-serif;
            font-size: 10px; line-height: 1;
            color: #fff;
            text-decoration: none;
            opacity: 0; transition: opacity 0.12s ease;
            user-select: none;
            pointer-events: none;
            text-shadow: 0 0 3px rgba(0,0,0,0.9);
            white-space: nowrap;
            cursor: pointer;
        `, NAME + ' v' + VERSION);
        versionEl.href = 'https://rivet.simmerindustries.com/';
        versionEl.target = '_blank';
        versionEl.rel = 'noopener noreferrer';
        // Drag handler swallows clicks via mousedown on root, but the link's
        // own click needs to fire so the navigation happens. Don't propagate.
        // Drag handler attaches to pointerdown on root and calls
        // preventDefault, which kills the link's subsequent click event. Stop
        // propagation at the source so the drag handler never sees pointer
        // events that started on the link.
        versionEl.addEventListener('pointerdown', e => e.stopPropagation());
        versionEl.addEventListener('pointerup',   e => e.stopPropagation());
        versionEl.addEventListener('mousedown',   e => e.stopPropagation());
        versionEl.addEventListener('click',       e => e.stopPropagation());
        versionEl.addEventListener('mouseenter', () => { versionEl.style.textDecoration = 'underline'; versionEl.style.opacity = '1'; });
        versionEl.addEventListener('mouseleave', () => { versionEl.style.textDecoration = 'none'; versionEl.style.opacity = '0.6'; });
        root.appendChild(versionEl);

        root.addEventListener('mouseenter', () => {
            ctrlBox.style.opacity = '1';
            versionEl.style.opacity = '0.6';
            // Re-enable the link's pointer-events only while the overlay is
            // hovered, so the invisible/0-opacity label doesn't intercept
            // clicks meant for the underlying video.
            versionEl.style.pointerEvents = 'auto';
            // Reveal the (!) badge with the rest of the chrome. Only if
            // updateWarnBtn has decided we should be showing it — display
            // stays 'none' when there's nothing to communicate.
            if (warnBtnEl && warnBtnEl.style.display !== 'none') {
                warnBtnEl.style.opacity = (manualWarnAck || rivetAutoSwitched) ? '0.6' : '1';
            }
        });
        root.addEventListener('mouseleave', () => {
            ctrlBox.style.opacity = '0';
            versionEl.style.opacity = '0';
            versionEl.style.pointerEvents = 'none';
            if (warnBtnEl) warnBtnEl.style.opacity = '0';
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

    // Rivet only makes sense on the canonical watch page (/watch?v=…).
    // Channel pages, search results, the home feed, and YouTube Shorts all
    // mount their own player elements (often auto-playing previews), but
    // none of those are real "watching" contexts and we shouldn't drop an
    // overlay onto them.
    function isWatchPath() {
        return location.pathname === '/watch';
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
        // Force-hide on any non-watch page — channel/home/search/shorts all
        // mount preview players, but we don't want the badge appearing there.
        if (!isWatchPath() || enabled) openButtonEl.setAttribute('data-hide', '1');
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

    // Manual-caption (!) badge — see buildOverlay for the click wiring.
    // Two visual states driven by updateWarnBtn():
    //   - prominent: red bg, pulsing — first time the user sees it
    //   - muted: small gray dot — after they've acknowledged with one click
    function buildWarnButton() {
        const b = el('button', `
            position: absolute;
            top: 4px; left: 4px;
            z-index: 11;
            padding: 0; margin: 0;
            cursor: pointer;
            user-select: none;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
            font-weight: 700; line-height: 1;
            display: none;
            opacity: 0; transition: opacity 0.12s ease;
            align-items: center; justify-content: center;
            box-sizing: border-box;
        `);
        b.setAttribute('aria-label', 'Manual captions detected — info');
        b.title = 'Manual captions detected — click for info';
        b.textContent = '!';
        return b;
    }

    function buildWarnPopup() {
        // Empty container; renderWarnPopup() populates body based on state.
        // Default is "above the overlay" since the overlay is bottom-anchored
        // by default and a downward popup would overflow the player. The
        // positionWarnPopup() helper flips to "below" if the overlay was
        // dragged near the top of the player.
        return el('div', `
            position: absolute;
            left: 4px;
            bottom: calc(100% + 6px);
            z-index: 12;
            width: 240px;
            padding: 9px 11px;
            border-radius: 6px;
            background: rgba(0,0,0,0.95);
            color: #f5f5f7;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
            font-size: 11px; line-height: 1.4;
            font-weight: 400;
            box-shadow: 0 4px 14px rgba(0,0,0,0.6);
            border: 1px solid rgba(255,255,255,0.18);
            display: none;
            pointer-events: auto;
            text-align: left;
        `);
    }

    // Choose "above" vs "below" the overlay depending on which side has more
    // room inside the player. Falls back to "above" when measurements aren't
    // available — that's the right default for the standard bottom-anchored
    // overlay placement.
    function positionWarnPopup() {
        if (!warnPopupEl || !overlayEl) return;
        const player = overlayEl.parentElement;
        if (!player) return;
        const ov = overlayEl.getBoundingClientRect();
        const pl = player.getBoundingClientRect();
        if (!ov.height || !pl.height) return;
        const spaceAbove = ov.top    - pl.top;
        const spaceBelow = pl.bottom - ov.bottom;
        if (spaceAbove >= spaceBelow) {
            warnPopupEl.style.top    = '';
            warnPopupEl.style.bottom = 'calc(100% + 6px)';
        } else {
            warnPopupEl.style.top    = '26px';
            warnPopupEl.style.bottom = '';
        }
    }

    function makePopupButton(text) {
        return el('button', `
            display: block;
            margin-top: 8px;
            padding: 5px 9px;
            background: ${ORP_COLOR};
            color: #fff;
            border: 1px solid rgba(255,255,255,0.35);
            border-radius: 4px;
            font: inherit;
            font-weight: 600;
            cursor: pointer;
        `, text);
    }

    function makePopupCloseX() {
        const x = el('button', `
            position: absolute;
            top: 2px; right: 4px;
            width: 16px; height: 16px;
            padding: 0; margin: 0;
            background: transparent;
            border: 0;
            cursor: pointer;
            color: rgba(255,255,255,0.55);
            font: 700 14px/1 system-ui;
            line-height: 16px;
        `, '×');
        x.title = 'Dismiss';
        x.addEventListener('mouseenter', () => { x.style.color = '#fff'; });
        x.addEventListener('mouseleave', () => { x.style.color = 'rgba(255,255,255,0.55)'; });
        return x;
    }

    // Rebuild the popup body from current state. Called whenever the popup is
    // about to be shown, and whenever the underlying state changes while the
    // popup is open (e.g. probe responds with track info; we switched).
    function renderWarnPopup() {
        if (!warnPopupEl) return;
        positionWarnPopup();
        while (warnPopupEl.firstChild) warnPopupEl.removeChild(warnPopupEl.firstChild);

        // Universal dismiss control — the (!) badge can also toggle it,
        // but a × in the corner is more discoverable.
        const closeX = makePopupCloseX();
        closeX.addEventListener('mousedown', e => e.stopPropagation());
        closeX.addEventListener('click', e => {
            warnPopupEl.style.display = 'none';
            e.stopPropagation();
        });
        warnPopupEl.appendChild(closeX);

        // Variant A: we auto-switched (or user manually clicked to switch).
        if (rivetAutoSwitched) {
            warnPopupEl.appendChild(el('div', 'padding-right: 14px;',
                'Rivet switched to auto-generated captions for smoother pacing. The original ("pre-written") captions are still available on this video.'));
            const back = makePopupButton('Switch back to original');
            back.addEventListener('mousedown', e => e.stopPropagation());
            back.addEventListener('click', e => {
                revertTrackSwitch();
                e.stopPropagation();
            });
            warnPopupEl.appendChild(back);
            return;
        }

        // Variant B: manual captions, no ASR available (or no match for
        // current language). Tell the user why pacing might feel uneven.
        warnPopupEl.appendChild(el('div', 'padding-right: 14px;',
            "This video uses pre-written captions, which arrive as full sentences instead of word-by-word. Rivet's pacing can feel uneven here."));

        const asr = findAsrTrackFor(lastCurrentTrack(), availableTracks);
        if (asr) {
            // Edge case: API hasn't auto-switched yet (or user reverted and
            // is now reconsidering). Still offer a manual switch button.
            const btn = makePopupButton('Switch to auto-generated');
            btn.addEventListener('mousedown', e => e.stopPropagation());
            btn.addEventListener('click', e => {
                switchToAsr();
                e.stopPropagation();
            });
            warnPopupEl.appendChild(btn);
        } else {
            warnPopupEl.appendChild(el('div', 'margin-top: 6px; opacity: 0.7;',
                "No auto-generated track was found for this language."));
        }
    }

    let warnKeyframesInjected = false;
    function ensureWarnKeyframes() {
        if (warnKeyframesInjected) return;
        warnKeyframesInjected = true;
        const s = document.createElement('style');
        s.id = 'rivet-warn-keyframes';
        s.textContent = `
            @keyframes rivet-warn-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(255,68,68,0.65); }
                50%      { box-shadow: 0 0 0 6px rgba(255,68,68,0); }
            }
        `;
        document.head.appendChild(s);
    }

    // Whether the (!) badge should be visible at all.
    //
    // The authoritative answer is trackKind from the player API:
    //   - 'asr'    → captions ARE auto-generated. Hide (unless we initiated
    //                a switch — then keep the badge so user can revert).
    //   - 'manual' → captions ARE pre-written. Show.
    //   - null     → API hasn't answered yet. Fall back to the chunk-pattern
    //                heuristic (manualCaptionsDetected).
    function shouldShowWarnBadge() {
        if (rivetAutoSwitched) return true;        // for the "switch back" affordance
        if (trackKind === 'asr')    return false;
        if (trackKind === 'manual') return true;
        return manualCaptionsDetected;             // unknown → heuristic
    }

    function updateWarnBtn() {
        if (!warnBtnEl) return;
        if (!shouldShowWarnBadge()) {
            warnBtnEl.style.display = 'none';
            if (warnPopupEl) warnPopupEl.style.display = 'none';
            return;
        }
        warnBtnEl.style.display = 'inline-flex';
        // Muted state covers both "user acked" and "user clicked to switch
        // tracks" — in both cases they've engaged with the badge already and
        // we want it small/quiet but still clickable.
        const muted = manualWarnAck || rivetAutoSwitched;
        if (!muted) {
            // Prominent: red disc, white !, pulsing halo.
            warnBtnEl.style.width        = '20px';
            warnBtnEl.style.height       = '20px';
            warnBtnEl.style.fontSize     = '13px';
            warnBtnEl.style.background   = ORP_COLOR;
            warnBtnEl.style.color        = '#fff';
            warnBtnEl.style.border       = '1px solid rgba(255,255,255,0.7)';
            warnBtnEl.style.borderRadius = '50%';
            warnBtnEl.style.animation    = 'rivet-warn-pulse 1.8s ease-in-out infinite';
        } else {
            // Muted: small gray dot the user can still click for the popup.
            warnBtnEl.style.width        = '14px';
            warnBtnEl.style.height       = '14px';
            warnBtnEl.style.fontSize     = '9px';
            warnBtnEl.style.background   = 'rgba(255,255,255,0.18)';
            warnBtnEl.style.color        = 'rgba(255,255,255,0.7)';
            warnBtnEl.style.border       = '1px solid rgba(255,255,255,0.25)';
            warnBtnEl.style.borderRadius = '50%';
            warnBtnEl.style.animation    = '';
        }
        // Opacity is hover-driven (set by the overlay's mouseenter/leave
        // handlers) so the badge fades in with the rest of the controls and
        // doesn't sit permanently on top of the word.
        if (warnPopupEl && warnPopupEl.style.display === 'block') renderWarnPopup();
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
            if (!dragging) return;
            dragging = false;

            // If the user dropped at the home position on BOTH axes (i.e. the
            // drag snapped to defaults), exit drag-mode entirely and return to
            // auto-anchor — that way the overlay tracks YouTube's caption
            // position dynamically again (controls reveal / hide, etc), rather
            // than staying locked to the saved fractions.
            const player = node.parentElement;
            if (!player) return;
            const pw = player.clientWidth;
            const ph = player.clientHeight;
            const ow = node.offsetWidth;
            const oh = node.offsetHeight;
            if (!pw || !ph) return;
            const left = parseFloat(node.style.left) || 0;
            const top  = parseFloat(node.style.top)  || 0;
            const defaultLeft = pw / 2 - ow / 2;
            const defaultTop  = getDefaultBottomY(player, ph) - oh;
            if (Math.abs(left - defaultLeft) < 1 && Math.abs(top - defaultTop) < 1) {
                userMovedOverlay = false;
                userPosFracX = null;
                userPosFracY = null;
                schedulePosition();
            }
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
        // Hide and bail on any non-watch page. Re-shows on next nav back to
        // a real watch page (the periodic schedulePosition tick picks it up).
        if (!isWatchPath()) { overlayEl.style.display = 'none'; return; }
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
        // If captions are flowing but we still don't have authoritative
        // track info, nudge the probe — tracklist often becomes available
        // only after the user has the CC track actively playing.
        if (probeReady && trackKind === null) {
            requestTrackInfo();
        }

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

        // Update chunk-pattern counters and re-evaluate the manual-captions
        // heuristic. See the declarations of singleWordChunks / multiWordChunks
        // for the rationale — short version: auto-captions can occasionally
        // arrive as small chunks but ALWAYS produce singles too, while manual
        // captions never produce singles.
        if (newWords.length === 1) singleWordChunks++;
        if (newWords.length >= CHUNK_THRESHOLD) multiWordChunks++;
        if (!manualCaptionsDetected) {
            const veryLargeChunk = newWords.length >= MANUAL_LARGE_CHUNK;
            const sustainedChunks = multiWordChunks >= MANUAL_REPEAT_CHUNKS
                                 && singleWordChunks === 0;
            if (veryLargeChunk || sustainedChunks) {
                manualCaptionsDetected = true;
                updateWarnBtn();
            }
        }

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
        // Detection resets per video; ack persists (it's a user preference).
        manualCaptionsDetected    = false;
        singleWordChunks          = 0;
        multiWordChunks           = 0;
        trackKind                 = null;
        availableTracks           = [];
        originalTrackBeforeSwitch = null;
        rivetAutoSwitched         = false;
        autoSwitchAttempted       = false;
        pendingAutoExplain        = false;
        _lastCurrentTrack         = null;
        if (warnPopupEl) warnPopupEl.style.display = 'none';
        updateWarnBtn();
        // Ask the probe for the new video's track info as soon as it's likely
        // to be ready. YouTube takes ~600ms to mount the new player state.
        if (probeReady) {
            setTimeout(requestTrackInfo,  800);
            setTimeout(requestTrackInfo, 1600);
            setTimeout(requestTrackInfo, 3000);
        }
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
        // Belt-and-suspenders: refuse to flip enabled=true on a non-watch
        // page. The open button is already hidden in those contexts, but a
        // stray Shift+S keypress shouldn't bring the overlay up either.
        if (on && !isWatchPath()) return;
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
            // The boot-time polling may have missed the window where the
            // tracklist became available (it only populates once captions
            // are actually playing). Re-poll now that we've turned CC on.
            if (probeReady) {
                setTimeout(requestTrackInfo,  500);
                setTimeout(requestTrackInfo, 1500);
                setTimeout(requestTrackInfo, 3500);
            }
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
        // Inject the page-context probe so we can call player.getOption /
        // setOption for caption tracks. The probe replies with the initial
        // snapshot via 'ready' message; we also poll for a few seconds since
        // the player API may not be initialized yet at script-idle time.
        injectProbe();
        setTimeout(requestTrackInfo, 800);
        setTimeout(requestTrackInfo, 2000);
        setTimeout(requestTrackInfo, 5000);

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
