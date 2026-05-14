// Page-context probe for YouTube's player API. Loaded via the manifest's
// web_accessible_resources by content.js, which injects a <script> tag with
// src=chrome-extension://.../probe.js. Running in the page world (not the
// content-script's isolated world) is what lets us call player.getOption /
// setOption — those methods live on the player element in the page's JS.
//
// Communication is plain window.postMessage. Content script sends messages
// tagged {source: 'rivet-cs', op, ...}; we reply {source: 'rivet-probe', ...}.
// Both ends ignore other sources, and we ignore cross-frame messages.

(function () {
    if (window.__rivetProbeInstalled) return;
    window.__rivetProbeInstalled = true;

    // Debug logger — silent unless the user opts in:
    //   localStorage.setItem('rivet-debug', '1'); location.reload();
    function pdbg() {
        try {
            if (localStorage.getItem('rivet-debug') !== '1') return;
            const args = Array.prototype.slice.call(arguments);
            console.log.apply(console, ['[Rivet probe]'].concat(args));
        } catch (_) {}
    }
    pdbg('installed');

    function getPlayer() {
        return document.getElementById('movie_player');
    }

    // The two calls that matter: the currently selected caption track, and the
    // full list of tracks available on this video. Both return JS objects in
    // the page world — they're safely cloneable across postMessage.
    //
    // Track shape (observed): { languageCode, displayName, kind?, ... }
    //   - kind === 'asr'  → auto-generated (speech-recognition)
    //   - kind missing/'' → editor-uploaded (manual / pro captions)
    function getCurrentTrack() {
        try {
            const p = getPlayer();
            if (!p || typeof p.getOption !== 'function') return null;
            return p.getOption('captions', 'track') || null;
        } catch (_) { return null; }
    }

    function getTrackList() {
        try {
            const p = getPlayer();
            if (!p || typeof p.getOption !== 'function') return [];
            // YouTube hides ASR (auto-generated) tracks from the default
            // tracklist call. Several known signatures for opting in — try
            // them all and use whichever returns the longest array, so we're
            // robust against the player API changing the param shape.
            let best = [];
            const tries = [
                function () { return p.getOption('captions', 'tracklist', { includeAsr: 1 }); },
                function () { return p.getOption('captions', 'tracklist', { includeAsr: true }); },
                function () { return p.getOption('captions', 'tracklist', { includeAsr: '1' }); },
                function () { return p.getOption('captions', 'tracklist'); },
            ];
            for (let i = 0; i < tries.length; i++) {
                try {
                    const r = tries[i]();
                    if (Array.isArray(r) && r.length > best.length) best = r;
                } catch (_) { /* try the next signature */ }
            }
            return best;
        } catch (_) { return []; }
    }

    function setTrack(track) {
        try {
            const p = getPlayer();
            if (!p || typeof p.setOption !== 'function') return false;
            p.setOption('captions', 'track', track);
            return true;
        } catch (_) { return false; }
    }

    function reply(op, data) {
        try {
            let s;
            try { s = JSON.stringify(data); } catch (_) { s = '<unstringifiable>'; }
            pdbg('→', op, s);
            window.postMessage({ source: 'rivet-probe', op: op, data: data || null }, '*');
        } catch (_) {}
    }

    function snapshot() {
        return { current: getCurrentTrack(), available: getTrackList() };
    }

    function handle(msg) {
        if (!msg || msg.source !== 'rivet-cs') return;
        switch (msg.op) {
            case 'getTrackInfo':
                reply('trackInfo', snapshot());
                break;
            case 'switchToTrack': {
                const ok = setTrack(msg.track || null);
                // Report the post-switch state so the content script can update
                // its mirror of "current track" without an extra round-trip.
                reply('switched', { ok: ok, snapshot: snapshot() });
                break;
            }
        }
    }

    window.addEventListener('message', function (e) {
        // Only accept messages from this same window — postMessage from other
        // frames could spoof our source field otherwise.
        if (e.source !== window) return;
        handle(e.data);
    });

    // Announce readiness so the content script can immediately query without
    // having to poll. The player API itself may not be ready yet, but we'll
    // still reply (with nulls) and the CS can retry.
    reply('ready', snapshot());
})();
