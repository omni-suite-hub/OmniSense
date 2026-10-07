/*
 * Profile preparation for the OmniSense E2E harnesses.
 *
 * The problem this exists to prevent
 * ----------------------------------
 * Chrome caches the extension's *service-worker script* inside the browser
 * profile, under
 *
 *     <profile>/Default/Service Worker/ScriptCache/
 *
 * not under the extension's install directory. When the E2E runs reuse a
 * persistent --user-data-dir (done on purpose, so the ~290 MB of cached MLC
 * model weights are not re-downloaded on every run) Chrome can keep executing a
 * service worker compiled from an OLDER background.js, even though
 *
 *   - the extension is loaded fresh from disk by Extensions.loadUnpacked, and
 *   - `fetch(chrome.runtime.getURL('background.js'))` returns the CURRENT file.
 *
 * The failure mode is nasty because it is invisible: newly added message routes
 * simply fall through the worker's `default: return false`, which the page sees
 * as `chrome.runtime.lastError = "The message port closed before a response was
 * received."` — byte-identical to the error a genuinely hanging handler
 * produces. It cost hours of bisecting correct code, and it silently invalidated
 * earlier "still broken" conclusions drawn from stale runs.
 *
 * `Default/Extension Scripts/` is NOT the culprit (clearing it changes nothing).
 * `Default/Service Worker/CacheStorage/` holds the model weights (hundreds of MB)
 * and must be left alone — this helper only ever touches ScriptCache.
 */
const fs = require('fs');
const path = require('path');

const SCRIPT_CACHE = path.join('Default', 'Service Worker', 'ScriptCache');
const SW_DATABASE = path.join('Default', 'Service Worker', 'Database');

/** Delete only the cached service-worker scripts. Model weights are untouched. */
function resetServiceWorkerScriptCache(profileDir) {
  const dir = path.join(profileDir, SCRIPT_CACHE);
  let removed = 0;
  try { removed = fs.readdirSync(dir).length; } catch (e) { removed = 0; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return removed;
}

/**
 * Reset the service-worker *registration* store.
 *
 * This is LevelDB, and a browser killed with SIGKILL can be torn down mid-write.
 * When that happens the profile is left in a state where the extension's service
 * worker **can never start again**, and nothing says so:
 *
 *   - `Target.getTargets()` still lists `service_worker:/background.js`
 *   - `chrome.runtime.getContexts()` reports NO `BACKGROUND` context
 *   - a message from the UI neither answers nor errors (it just hangs)
 *   - `Extensions.loadUnpacked` succeeds, the panel renders, the files on disk
 *     are correct, and the served `background.js` matches disk byte for byte
 *
 * It cost three consecutive runs before it was spotted, because the symptom is
 * indistinguishable from a hung handler. Deleting this directory restores the
 * worker; CacheStorage (the hundreds of MB of model weights) is a sibling
 * directory and is not affected.
 *
 * So: reset it defensively on every reuse, AND shut Chrome down gracefully in
 * the first place (`stopChrome` below) rather than SIGKILLing it.
 */
function resetServiceWorkerRegistration(profileDir) {
  const dir = path.join(profileDir, SW_DATABASE);
  let existed = false;
  try { existed = fs.existsSync(dir); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  return existed;
}

/**
 * Make a profile safe to launch against.
 *
 * Returns a human-readable line for the test log, because "which profile, and
 * was its script cache stale" is the first thing worth knowing when a route
 * mysteriously does not answer.
 */
function prepareProfile(profileDir, { fresh = false } = {}) {
  if (fresh) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
    fs.mkdirSync(profileDir, { recursive: true });
    return `profile: ${profileDir} (wiped)`;
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const removed = resetServiceWorkerScriptCache(profileDir);
  const hadReg = resetServiceWorkerRegistration(profileDir);
  let cacheSize = '';
  try {
    const cs = path.join(profileDir, 'Default', 'Service Worker', 'CacheStorage');
    if (fs.existsSync(cs)) cacheSize = ', model CacheStorage kept';
  } catch (e) {}
  return `profile: ${profileDir} (reused; dropped ${removed} cached worker script(s); `
    + `registration store ${hadReg ? 'reset' : 'absent'}${cacheSize})`;
}

/**
 * Shut Chrome down WITHOUT corrupting the profile.
 *
 * SIGKILL is what breaks `Service Worker/Database` in the first place. Ask
 * politely, give Chrome time to flush, and only escalate if it really will not
 * go — and never remove the profile directory in the same breath.
 */
function stopChrome(chromeProcess, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!chromeProcess || chromeProcess.exitCode !== null || chromeProcess.signalCode) { resolve('already exited'); return; }
    let done = false;
    const finish = (how) => { if (!done) { done = true; resolve(how); } };
    chromeProcess.once('exit', () => finish('exited cleanly on SIGTERM'));
    try { chromeProcess.kill('SIGTERM'); } catch (e) { finish('SIGTERM failed'); return; }
    setTimeout(() => {
      if (done) return;
      // Last resort. Anything already written is at risk, which is exactly why
      // the registration store is reset on the next launch.
      try { chromeProcess.kill('SIGKILL'); } catch (e) {}
      finish('needed SIGKILL (profile may need a registration reset)');
    }, timeoutMs);
  });
}

module.exports = {
  prepareProfile,
  resetServiceWorkerScriptCache,
  resetServiceWorkerRegistration,
  stopChrome,
  SCRIPT_CACHE,
  SW_DATABASE
};
