// dev-reloader.js
// DEV-ONLY service worker. Copied into dist/dev/ by tools/build.py for the
// dev target; never included in the production build.
//
// What it does: polls the local dev server at /dev/version every 2 seconds.
// When the version changes (because tools/dev.py rebuilt after a file save)
// it reloads any open YouTube tabs and then reloads the extension itself.

const DEV_SERVER_URL = 'http://localhost:8765/dev/version';
const POLL_INTERVAL_MS = 2000;

async function checkForChanges() {
  let payload;
  try {
    const res = await fetch(DEV_SERVER_URL, { cache: 'no-store' });
    if (!res.ok) return;
    payload = await res.json();
  } catch (_) {
    // Dev server not running — silently keep trying.
    return;
  }

  const version = String(payload && payload.version);
  if (!version || version === 'undefined') return;

  // Persist the last-seen version in chrome.storage so we survive service-
  // worker restarts (MV3 kills the SW after ~30s of idle).
  const stored = await chrome.storage.local.get('devVersion');
  const lastVersion = stored.devVersion;

  if (!lastVersion) {
    await chrome.storage.local.set({ devVersion: version });
    return;
  }

  if (version !== lastVersion) {
    console.log('[dev-reloader] build changed:', lastVersion, '→', version);
    await chrome.storage.local.set({ devVersion: version });

    // Reload any open YouTube tabs first so the new content script runs.
    try {
      const tabs = await chrome.tabs.query({
        url: ['https://*.youtube.com/*', 'https://youtube.com/*']
      });
      for (const tab of tabs) {
        try { await chrome.tabs.reload(tab.id); } catch (_) {}
      }
    } catch (_) {}

    // Then reload the extension itself (covers manifest / SW edits).
    chrome.runtime.reload();
  }
}

// Active fetches keep the SW alive, so a 2-second setInterval is fine here.
// (chrome.alarms has a 30-second floor in MV3, too slow for dev iteration.)
setInterval(checkForChanges, POLL_INTERVAL_MS);
checkForChanges();
