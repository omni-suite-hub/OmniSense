import {
  MSG_TYPES, DEFAULT_LOCALE, STORES, DEFAULT_AUTO_RECORD, MIN_CAPTURE_CHARS,
  DEFAULT_MODEL_KEY, DEFAULT_RETENTION_DAYS, CAPSULE_RECENT_LIMIT
} from './shared/constants.js';
import { broadcastFromSW, sendToTab } from './shared/messaging.js';
import { loadLocale, ensureLocaleLoaded, t } from './shared/i18n.js';
import { getSetting, setSetting, SettingKeys } from './shared/settings.js';
// Static, not `await import(...)`: dynamic import is forbidden on a
// ServiceWorkerGlobalScope ("import() is disallowed on ServiceWorkerGlobalScope
// by the HTML specification"), so the previous dynamic imports made
// `capsuleStats()` and `clearCapsule()` fail outright — which is why the side
// panel showed "出错了，请重试" for the capsule count and why clearing local
// memory could never work.
import { idbStats, idbClear, idbPrune, idbGetAll, idbDelete, idbDeleteByIndex, idbCountDistinct } from './shared/idb.js';
// Rows in the capsule store are chunks, so both capsule routes fold them back
// into pages before replying. Pure module, shared with the browserless selftest.
import { groupByPage, supersededRowIds } from './shared/capsule-chunk.js';
import { scanAgreementRisks } from './shared/pattern-radar-core.js';

let offscreenPort = null;
let modelState = { status: 'idle', progress: 0, text: '' };
let lastKnownTabId = null;

// ---------------- Offscreen lifecycle ----------------
async function ensureOffscreen() {
  if (offscreenPort) return;
  try {
    if (typeof chrome.offscreen !== 'undefined') {
      const has = await chrome.offscreen.hasDocument?.().catch(() => false);
      if (!has && chrome.offscreen.createDocument) {
        await chrome.offscreen.createDocument({
          url: chrome.runtime.getURL('offscreen.html'),
          reasons: ['WORKERS'],
          justification: 'Runs local WebLLM/embedding models (WASM workers) for OmniSense'
        });
      }
    } else if (typeof document !== 'undefined') {
      // Firefox background page environment with DOM
      if (!document.getElementById('omni-offscreen-frame')) {
        const iframe = document.createElement('iframe');
        iframe.id = 'omni-offscreen-frame';
        iframe.src = chrome.runtime.getURL('offscreen.html');
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
      }
    }
  } catch (e) {
    // Document may already exist (race) — continue and connect to it.
  }
  const port = chrome.runtime.connect({ name: 'omni-offscreen' });
  port.onMessage.addListener(handleOffscreenMessage);
  port.onDisconnect.addListener(() => { offscreenPort = null; });
  offscreenPort = port;
}

function handleOffscreenMessage(m) {
  if (m.type === MSG_TYPES.MODEL_STATUS || m.type === MSG_TYPES.MODEL_PROGRESS) {
    modelState = { status: m.status, progress: m.progress, text: m.text };
    broadcastFromSW(m);
  }
  // Everything the inference host produces for a caller must be relayed back to
  // the UI contexts (side panel / popup / options). CAPSULE_QUERY is excluded on
  // purpose: it is returned on the dedicated request port instead.
  if (
    m.type === MSG_TYPES.INFER_START ||
    m.type === MSG_TYPES.INFER_STREAM ||
    m.type === MSG_TYPES.INFER_NOTICE ||
    m.type === MSG_TYPES.INFER_ERROR ||
    m.type === MSG_TYPES.INFER_END ||
    m.type === MSG_TYPES.EMBEDDING
  ) {
    broadcastFromSW(m);
  }
}

/**
 * Resolve the settings the inference host needs and attach them to the message.
 *
 * The offscreen document has no chrome.storage: reading it there throws
 *   TypeError: Cannot read properties of undefined (reading 'local')
 * Because that read sat inside the inference path, the first prompt after every
 * service-worker restart failed with that opaque string written into the result
 * box — which is exactly what the reported 「文章总结不好使」 was. A previously
 * loaded model masked it, since a resident model short-circuits the read.
 *
 * Read fresh on every message rather than caching, so a settings change applies
 * to the very next request.
 */
async function withOffscreenSettings(msg) {
  try {
    const [modelKey, retentionDays] = await Promise.all([
      getSetting(SettingKeys.modelKey, DEFAULT_MODEL_KEY),
      getSetting(SettingKeys.retentionDays, DEFAULT_RETENTION_DAYS)
    ]);
    return { ...msg, settings: { modelKey, retentionDays } };
  } catch (e) {
    return msg;
  }
}

async function sendToOffscreen(msg) {
  const enriched = await withOffscreenSettings(msg);
  try {
    await ensureOffscreen();
    offscreenPort?.postMessage(enriched);
  } catch (e) { /* host unavailable */ }
}

// ---------------- Context menus (localised) ----------------
// Keys live in the same dictionary the UI uses, so the right-click menu follows
// the language setting instead of being hard-wired to Chinese. Rebuilding also
// happens on every service worker start, which is what picks up a language
// change made while the worker was asleep.
const CONTEXT_MENUS = [
  { id: 'tone', key: 'ctx.tone', contexts: ['selection'] },
  { id: 'roast', key: 'ctx.roast', contexts: ['selection'] },
  { id: 'write-sel', key: 'ctx.write_sel', contexts: ['selection'] },
  { id: 'summary', key: 'ctx.summary', contexts: ['page'] },
  { id: 'capture', key: 'ctx.capture', contexts: ['page'] }
];

async function buildContextMenus() {
  try {
    await ensureLocaleLoaded(await getSetting(SettingKeys.locale, DEFAULT_LOCALE));
    const menus = CONTEXT_MENUS.map(m => ({ id: m.id, title: t(m.key), contexts: m.contexts }));
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      for (const m of menus) {
        try {
          chrome.contextMenus.create(m, () => { void chrome.runtime.lastError; });
        } catch (e) { /* duplicate id — ignore */ }
      }
    });
  } catch (e) { /* menus are a convenience, never fatal */ }
}
buildContextMenus();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SettingKeys.locale]) buildContextMenus();
});

// ---------------- Install / onboarding ----------------
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const onboarded = await getSetting(SettingKeys.onboarded, false);
    if (!onboarded) {
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
    }
  }
  buildContextMenus();
  const adblockOn = await getSetting(SettingKeys.adblockEnabled, true);
  if (!adblockOn && chrome.declarativeNetRequest?.updateEnabledRulesets) {
    chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ['easylist-subset'] }).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'capture') {
    // Right-click "add to time capsule" — no side panel needed, but tell the
    // user what happened through the panel when it is open.
    const r = await captureTab(tab.id).catch(() => ({ ok: false, reason: 'error' }));
    await ensureLocaleLoaded(await getSetting(SettingKeys.locale, DEFAULT_LOCALE));
    const key = r?.ok ? 'capsule.capture_ok' : (r?.reason === 'too_short' ? 'capsule.capture_too_short' : 'capsule.capture_failed');
    broadcastFromSW({ type: MSG_TYPES.TOAST, text: t(key, { n: r?.chunks || 0 }) });
    return;
  }
  if (chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  } else if (chrome.sidebarAction?.open) {
    await chrome.sidebarAction.open().catch(() => {});
  }
  const payload = { tabId: tab.id, url: tab.url, title: tab.title };
  if (info.menuItemId === 'tone') { payload.selection = info.selectionText; payload.view = 'tone'; }
  else if (info.menuItemId === 'roast') { payload.selection = info.selectionText; payload.view = 'roast'; }
  else if (info.menuItemId === 'write-sel') { payload.selection = info.selectionText; payload.view = 'writing'; }
  else if (info.menuItemId === 'summary') { payload.view = 'summary'; }
  setTimeout(() => broadcastFromSW({ type: 'OPEN_VIEW', ...payload }), 100);
});

// ---------------- Message routing ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;
  if (!type) return false;

  switch (type) {
    case MSG_TYPES.PING:
      sendResponse({ ok: true, model: modelState });
      return false;

    case MSG_TYPES.MODEL_LOAD:
      sendToOffscreen(msg);
      sendResponse({ ok: true });
      return false;

    case MSG_TYPES.INFER_STREAM:
    case MSG_TYPES.EMBEDDING:
      sendToOffscreen({ ...msg, senderTabId: sender.tab?.id });
      sendResponse({ ok: true });
      return false;

    case MSG_TYPES.GET_ARTICLE:
      injectReadability(msg.tabId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case MSG_TYPES.GET_SELECTION:
      injectSelection(msg.tabId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case MSG_TYPES.SCAN_PRIVACY:
      injectPrivacyScan(msg.tabId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case MSG_TYPES.SCAN_PATTERNS:
      injectPatternScan(msg.tabId).then(sendResponse).catch(e => sendResponse({ error: e.message, countdowns: [], overlays: [], checkboxes: [] }));
      return true;

    case MSG_TYPES.CRUSH_OVERLAYS:
      injectCrushOverlays(msg.tabId).then(sendResponse).catch(e => sendResponse({ error: e.message, crushedCount: 0 }));
      return true;

    case MSG_TYPES.TOGGLE_COUNTDOWN_BADGES:
      injectToggleBadges(msg.tabId, msg.show).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case MSG_TYPES.SCAN_AGREEMENT:
      handleAgreementScan(msg).then(sendResponse).catch(e => sendResponse({ error: e.message, overallRisk: 'clean', findings: [] }));
      return true;

    case MSG_TYPES.INSERT_TEXT:
      insertTextAtSelection(msg.tabId, msg.text).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case MSG_TYPES.CAPTURE_PAGE:
      handleCapture(msg.data).catch(() => {});
      sendResponse({ ok: true });
      return false;

    case MSG_TYPES.CAPTURE_TAB:
      captureTab(msg.tabId).then(sendResponse).catch(e => sendResponse({ ok: false, reason: 'error', error: e.message }));
      return true;

    case MSG_TYPES.CAPSULE_STATS:
      // Report the real reason instead of collapsing every failure into a
      // generic "no data". A silent catch here is exactly why this route looked
      // like an unexplainable "port closed" for an entire debugging session.
      capsuleStats()
        .then(sendResponse)
        .catch(e => sendResponse({ count: 0, lastVisitTime: 0, error: errorText(e) }));
      return true;

    case MSG_TYPES.CAPSULE_QUERY:
      handleCapsuleQuery(msg.query).then(sendResponse).catch(e => sendResponse({ pages: [], error: errorText(e) }));
      return true;

    case MSG_TYPES.CAPSULE_RECENT:
      capsuleRecent()
        .then(sendResponse)
        .catch(e => sendResponse({ pages: [], total: 0, error: errorText(e) }));
      return true;

    case MSG_TYPES.CAPSULE_DELETE:
      capsuleDelete(msg.url)
        .then(sendResponse)
        .catch(e => sendResponse({ ok: false, removed: 0, error: errorText(e) }));
      return true;

    case MSG_TYPES.CAPSULE_CLEAR:
      clearCapsule().then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case MSG_TYPES.CAPSULE_GRAPH:
      handleCapsuleGraph().then(sendResponse).catch(e => sendResponse({ ok: false, nodes: [], edges: [], error: e.message }));
      return true;

    case MSG_TYPES.RUN_SELECTION_ACTION:
      handleSelectionAction(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case MSG_TYPES.CAPTURE_SELECTION:
      handleCaptureSelection(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case MSG_TYPES.OPEN_ZEN_READER:
      handleOpenZenReader(msg.tabId || sender.tab?.id).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case MSG_TYPES.GET_ADBLOCK_STATS:
      getAdblockStats().then(sendResponse).catch(() => sendResponse({ requests: 0, elements: 0 }));
      return true;

    case MSG_TYPES.TOGGLE_ADBLOCK:
      setSetting(SettingKeys.adblockEnabled, msg.enabled);
      if (chrome.declarativeNetRequest?.updateEnabledRulesets) {
        if (msg.enabled) {
          chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['easylist-subset'] }).catch(() => {});
        } else {
          chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ['easylist-subset'] }).catch(() => {});
        }
      }
      sendResponse({ enabled: msg.enabled });
      return false;

    case MSG_TYPES.ALLOWLIST_PAGE:
      allowlistPage(msg.domain).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case MSG_TYPES.GET_RELATED_CAPSULES:
      handleGetRelatedCapsules(msg.url, msg.text).then(sendResponse).catch(e => sendResponse({ pages: [], error: e.message }));
      return true;

    case MSG_TYPES.CLUSTER_TABS:
      handleClusterTabs(msg.windowId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case MSG_TYPES.DEDUPE_TABS:
      handleDedupeTabs(msg.windowId).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'OPEN_VIEW':
      broadcastFromSW(msg);
      sendResponse({ ok: true });
      return false;

    case MSG_TYPES.OPEN_SIDE_PANEL: {
      const targetTabId = msg.tabId || sender?.tab?.id || lastKnownTabId;
      if (chrome.sidePanel?.open) {
        if (targetTabId) chrome.sidePanel.open({ tabId: targetTabId }).catch(() => {});
      } else if (chrome.sidebarAction?.open) {
        chrome.sidebarAction.open().catch(() => {});
      }
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});

// ---------------- Content script injection ----------------
async function injectReadability(tabId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, files: ['content/readability-inject.js'] });
  return res?.result || { isArticle: false };
}

async function injectSelection(tabId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.getSelection()?.toString() || '' });
  return { selection: res?.result || '' };
}

async function injectPrivacyScan(tabId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, files: ['content/privacy-scan.js'] });
  return res?.result || {};
}

async function injectPatternScan(tabId) {
  const id = tabId || lastKnownTabId;
  if (!id) return { countdowns: [], overlays: [], checkboxes: [] };
  try {
    return await sendToTab(id, { type: 'SCAN_PATTERNS' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/pattern-radar.js'] });
    return await sendToTab(id, { type: 'SCAN_PATTERNS' });
  }
}

async function injectCrushOverlays(tabId) {
  const id = tabId || lastKnownTabId;
  if (!id) return { crushedCount: 0 };
  try {
    return await sendToTab(id, { type: 'CRUSH_OVERLAYS' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/pattern-radar.js'] });
    return await sendToTab(id, { type: 'CRUSH_OVERLAYS' });
  }
}

async function injectToggleBadges(tabId, show) {
  const id = tabId || lastKnownTabId;
  if (!id) return { ok: false };
  try {
    return await sendToTab(id, { type: 'TOGGLE_COUNTDOWN_BADGES', show });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/pattern-radar.js'] });
    return await sendToTab(id, { type: 'TOGGLE_COUNTDOWN_BADGES', show });
  }
}

async function handleAgreementScan(msg) {
  let text = msg.text || '';
  if (!text && msg.tabId) {
    const articleRes = await injectReadability(msg.tabId);
    text = articleRes?.text || '';
  }
  const result = scanAgreementRisks(text);
  return { ...result, textLength: text.length };
}

async function insertTextAtSelection(tabId, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [text],
    func: (t) => {
      const el = document.activeElement;
      if (!el) return false;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const start = el.selectionStart || 0;
        const end = el.selectionEnd || 0;
        el.value = el.value.slice(0, start) + t + el.value.slice(end);
        el.selectionStart = el.selectionEnd = start + t.length;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) { document.execCommand('insertText', false, t); return true; }
      return false;
    }
  });
  return { ok: true };
}

// ---------------- Capsule ----------------
/**
 * Passive capture, driven by content/capsule-capture.js on every page.
 *
 * The ONLY gate is the user's explicit `autoRecord` switch (off by default, turned
 * on at onboarding step 2 or in the settings). This used to additionally require
 * the optional `history` permission — but nothing in the product ever calls
 * `chrome.history`, so that check only ever meant "the user declined a permission
 * we never use". The result was a capsule that stayed silently empty forever with
 * no error anywhere: exactly the reported "how do I put anything in here?".
 */
async function handleCapture(data) {
  if (!data?.text || data.text.length < MIN_CAPTURE_CHARS) return;
  const auto = await getSetting(SettingKeys.autoRecord, DEFAULT_AUTO_RECORD);
  if (!auto) return;
  sendToOffscreen({ type: MSG_TYPES.CAPTURE_PAGE, data });
  await notifyFirstCapture();
}

/** One-off notice so the automatic behaviour is discoverable (and disableable). */
async function notifyFirstCapture() {
  if (await getSetting(SettingKeys.captureNotified, false)) return;
  await setSetting(SettingKeys.captureNotified, true);
  await ensureLocaleLoaded(await getSetting(SettingKeys.locale, DEFAULT_LOCALE));
  broadcastFromSW({ type: MSG_TYPES.TOAST, text: t('capsule.captured_first') });
}

/**
 * Explicit, user-initiated capture of the tab in front of the user ("收录本页").
 * Deliberately independent of `autoRecord`: an explicit click is its own consent,
 * so this is also the answer for someone who never opted into automatic capture.
 */
async function captureTab(tabId) {
  const id = tabId || lastKnownTabId;
  if (!id) return { ok: false, reason: 'no_tab' };
  let tab;
  try {
    tab = await chrome.tabs.get(id);
  } catch (e) {
    return { ok: false, reason: 'no_tab' };
  }
  if (!tab.url || !/^https?:/i.test(tab.url)) return { ok: false, reason: 'unsupported' };

  let article = null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/readability-inject.js'] });
    article = res?.result || null;
  } catch (e) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!article?.text || article.text.length < MIN_CAPTURE_CHARS) return { ok: false, reason: 'too_short' };

  const result = await requestCapture({
    url: tab.url,
    title: article.title || tab.title || '',
    text: article.text
  });

  if (result.ok) {
    // Retention is enforced here, not in the inference host: the host cannot read
    // chrome.storage, so pruning there threw and silently did nothing.
    const days = await getSetting(SettingKeys.retentionDays, DEFAULT_RETENTION_DAYS);
    await idbPrune(STORES.CAPSULE, days).catch(() => 0);
  }
  return result;
}

/**
 * Capture over a dedicated port so the caller can await the real outcome.
 * The passive path stays fire-and-forget (no requestId, no reply, no toast).
 */
async function requestCapture(data) {
  const requestId = `cap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    // The offscreen document has to exist BEFORE we open the port. A port opened
    // while nothing is listening on the other side is delivered nowhere and
    // never disconnects — the capture would just hang until the timeout.
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, reason: 'error' };
  }
  const port = chrome.runtime.connect({ name: 'omni-offscreen' });
  const payload = await withOffscreenSettings({ type: MSG_TYPES.CAPTURE_PAGE, data, requestId });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { port.disconnect(); } catch (e) {}
      resolve(v);
    };
    port.onMessage.addListener((m) => {
      if (m.type === MSG_TYPES.CAPTURE_RESULT && m.requestId === requestId) {
        finish({ ok: !!m.ok, chunks: m.chunks || 0, reason: m.reason || null });
      }
    });
    port.onDisconnect.addListener(() => finish({ ok: false, reason: 'disconnected' }));
    try { port.postMessage(payload); }
    catch (e) { finish({ ok: false, reason: 'error' }); }
    // Embedding the first chunk can require downloading the embedder, so be generous.
    setTimeout(() => finish({ ok: false, reason: 'timeout' }), 180000);
  });
}

function errorText(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  return `${e.name ? e.name + ': ' : ''}${e.message || e}`;
}

async function capsuleStats() {
  // Prune before counting: the number the user sees then already reflects the
  // retention setting, and an old capsule gets cleaned up simply by being looked
  // at, without needing a new capture.
  const days = await getSetting(SettingKeys.retentionDays, DEFAULT_RETENTION_DAYS);
  await idbPrune(STORES.CAPSULE, days).catch(() => 0);
  const stats = await idbStats(STORES.CAPSULE);
  // Report pages alongside chunks. The two differ exactly when one page was stored
  // more than once, which is the gap behind 「本地已收录 8 段记忆」 sitting above a
  // list of two identical articles. `idbCountDistinct` walks index keys only, so
  // this does not deserialise any embedding.
  let pages = 0;
  try { pages = (await idbCountDistinct(STORES.CAPSULE, 'url')).distinct; } catch (e) { pages = 0; }
  return { ...stats, pages };
}

/**
 * Remove one saved page — every chunk of it, by URL.
 *
 * The url index is what makes this exact and cheap; without it, deleting an entry
 * would mean reading the whole store and deserialising every 384-float embedding
 * to find the rows belonging to one page.
 */
async function capsuleDelete(url) {
  if (!url) return { ok: false, removed: 0, reason: 'no_url' };
  const removed = await idbDeleteByIndex(STORES.CAPSULE, 'url', url);
  return { ok: true, removed };
}

async function handleCapsuleQuery(query) {
  try {
    // Same ordering constraint as requestCapture: open the port only once the
    // offscreen listener exists, otherwise the reply is lost.
    await ensureOffscreen();
  } catch (e) {
    return { pages: [] };
  }
  const raw = await new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'omni-offscreen' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { port.disconnect(); } catch (e) {}
      resolve(v);
    };
    port.onMessage.addListener((m) => {
      if (m.type === MSG_TYPES.CAPSULE_QUERY) finish(m.results || []);
    });
    port.onDisconnect.addListener(() => finish([]));
    try { port.postMessage({ type: MSG_TYPES.CAPSULE_QUERY, query }); }
    catch (e) { finish([]); }
    // A first-ever search also has to download the embedder.
    setTimeout(() => finish([]), 180000);
  });
  // The store returns one row per CHUNK, so an article embedded as six chunks used
  // to come back as six near-identical results. Offscreen claimed in a comment
  // that results "can be de-duplicated by url" — nothing did it. Grouping here
  // also drops the 384-float vectors, which must not cross the message port.
  const pages = groupByPage(raw);
  return { pages: pages.slice(0, 20) };
}

/**
 * "What is actually in here?" — the listing the capsule never had.
 *
 * Until this existed the ONLY way to see anything in the capsule was to type a
 * query and press Enter, and with an empty box pressing Enter sent an empty
 * string to the embedder. Someone who had saved a handful of pages could see
 * "本地已收录 4 段记忆" and had no way at all to find out WHAT those four were —
 * which is exactly the reported question.
 *
 * Runs entirely in the service worker. `shared/idb.js` talks to IndexedDB
 * directly and a service worker has IndexedDB, so this needs neither the
 * inference host nor the embedder. That is deliberate: routing it through the
 * offscreen document would make "show me what I saved" wait on a 25 MB model
 * download, and would fail outright on a machine where the embedder cannot load
 * — which is precisely when a user most needs to see that their pages are there.
 *
 * Returns pages, not chunks, newest first. See CAPSULE_RECENT_LIMIT.
 */
async function capsuleRecent() {
  // Same prune-as-you-look contract as capsuleStats(): the list a user sees
  // already reflects their retention setting.
  const days = await getSetting(SettingKeys.retentionDays, DEFAULT_RETENTION_DAYS);
  await idbPrune(STORES.CAPSULE, days).catch(() => 0);
  const rows = await idbGetAll(STORES.CAPSULE);

  // Self-heal: drop rows that a newer capture of the same page has replaced.
  //
  // This is where it belongs rather than in the schema upgrade. `idbGetAll` has
  // already read every row, so identifying the stale ones costs nothing extra —
  // whereas doing it inside the version-change transaction would mean
  // deserialising every embedding mid-upgrade, where a failure is far more
  // expensive than leaving a hidden duplicate behind. Opening the list therefore
  // also tidies a profile written by the pre-index schema.
  const superseded = supersededRowIds(rows);
  if (superseded.length) {
    for (const id of superseded) await idbDelete(STORES.CAPSULE, id).catch(() => 0);
  }
  const doomed = new Set(superseded);
  const live = superseded.length ? rows.filter(r => !doomed.has(r.id)) : rows;

  const pages = groupByPage(live);
  return { pages: pages.slice(0, CAPSULE_RECENT_LIMIT), total: pages.length, cleaned: superseded.length };
}

async function clearCapsule() {
  await idbClear(STORES.CAPSULE);
  return { ok: true };
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

async function handleCapsuleGraph() {
  const days = await getSetting(SettingKeys.retentionDays, DEFAULT_RETENTION_DAYS);
  await idbPrune(STORES.CAPSULE, days).catch(() => 0);
  const rows = await idbGetAll(STORES.CAPSULE);
  const superseded = supersededRowIds(rows);
  const doomed = new Set(superseded);
  const live = superseded.length ? rows.filter(r => !doomed.has(r.id)) : rows;

  const pageMap = new Map();
  for (const r of live) {
    if (!r.url) continue;
    const key = r.url.split('#')[0].replace(/\/+$/, '');
    if (!pageMap.has(key)) {
      let domain = '';
      try { domain = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
      pageMap.set(key, {
        id: 'node_' + Math.abs(hashString(key)),
        url: r.url,
        title: r.title || domain || 'Untitled',
        domain,
        chunks: 0,
        time: r.createdAt || r.time || Date.now(),
        excerpt: (r.text || '').slice(0, 160),
        vector: r.vector || null
      });
    }
    const p = pageMap.get(key);
    p.chunks++;
    if (!p.vector && r.vector) p.vector = r.vector;
    if (r.createdAt && r.createdAt > p.time) p.time = r.createdAt;
  }

  const nodes = Array.from(pageMap.values());
  const edges = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      let sim = 0;
      if (a.vector && b.vector && a.vector.length === b.vector.length) {
        sim = dotProduct(a.vector, b.vector);
      } else if (a.domain && b.domain && a.domain === b.domain) {
        sim = 0.62;
      }
      if (sim >= 0.52) {
        edges.push({
          source: a.id,
          target: b.id,
          weight: Math.round(sim * 100) / 100
        });
      }
    }
  }

  const cleanNodes = nodes.map(n => ({
    id: n.id,
    url: n.url,
    title: n.title,
    domain: n.domain,
    chunks: n.chunks,
    time: n.time,
    excerpt: n.excerpt
  }));

  return { ok: true, nodes: cleanNodes, edges };
}

async function handleSelectionAction(msg) {
  const { mode, text } = msg;
  if (!text || !text.trim()) return { ok: false, error: 'no_text' };
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: 'offscreen_error' };
  }

  const requestId = `sel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const port = chrome.runtime.connect({ name: 'omni-offscreen' });
  const payload = await withOffscreenSettings({
    type: MSG_TYPES.INFER_STREAM,
    promptKey: 'selection_act',
    payload: { mode, text },
    requestId
  });

  return new Promise((resolve) => {
    let done = false;
    let fullText = '';
    const finish = (result) => {
      if (done) return;
      done = true;
      try { port.disconnect(); } catch (e) {}
      resolve(result);
    };

    port.onMessage.addListener((m) => {
      if (m.requestId !== requestId) return;
      if (m.type === MSG_TYPES.INFER_STREAM) {
        fullText += (m.text || '');
      } else if (m.type === MSG_TYPES.INFER_END) {
        finish({ ok: true, text: fullText.trim() });
      } else if (m.type === MSG_TYPES.INFER_ERROR) {
        finish({ ok: false, error: m.error || 'inference_error' });
      }
    });

    port.onDisconnect.addListener(() => {
      if (fullText) finish({ ok: true, text: fullText.trim() });
      else finish({ ok: false, error: 'disconnected' });
    });

    try { port.postMessage(payload); }
    catch (e) { finish({ ok: false, error: e.message }); }

    setTimeout(() => {
      if (fullText) finish({ ok: true, text: fullText.trim() });
      else finish({ ok: false, error: 'timeout' });
    }, 45000);
  });
}

async function handleCaptureSelection(msg) {
  const { text, url, title } = msg;
  if (!text || text.length < 2) return { ok: false, reason: 'too_short' };
  const result = await requestCapture({
    url: url || 'https://omnisense.local/selection',
    title: title || 'Selection Excerpt',
    text
  });
  return result;
}

async function handleOpenZenReader(tabId) {
  const id = tabId || lastKnownTabId;
  if (!id) return { ok: false, reason: 'no_tab' };
  try {
    await sendToTab(id, { type: 'OMNI_OPEN_ZEN_READER' });
    return { ok: true };
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        files: ['content/zen-reader.js']
      });
      await sendToTab(id, { type: 'OMNI_OPEN_ZEN_READER' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

// ---------------- Adblock ----------------
async function getAdblockStats() {
  return await getSetting(SettingKeys.stats, { requests: 0, elements: 0 });
}

async function allowlistPage(domain) {
  if (!domain) return { ok: false };
  const key = 'omnisense.adblock.allowlist';
  const list = await getSetting(key, []);
  if (!list.includes(domain)) {
    list.push(domain);
    await setSetting(key, list);
  }
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map(r => r.id);
    const addRules = list.map((d, idx) => ({
      id: 9000001 + idx,
      priority: 100,
      condition: { urlFilter: `||${d}`, resourceTypes: ['script', 'image', 'xmlhttprequest'] },
      action: { type: 'allow' }
    }));
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules, removeRuleIds });
  } catch (e) {}
  return { ok: true };
}

// Adblock stats: count newly matched declarativeNetRequest rules (requires
// the declarativeNetRequestFeedback permission). Uses a running delta persisted
// across Service Worker cold-starts so we don't double count.
let lastMatchedCount = 0;
getSetting('omnisense.adblock.lastMatched', 0).then(v => { lastMatchedCount = v || 0; }).catch(() => {});

chrome.alarms?.create?.('adblock-stats', { periodInMinutes: 1 });
chrome.alarms?.onAlarm?.addListener(async (alarm) => {
  if (alarm.name !== 'adblock-stats') return;
    if (!chrome.declarativeNetRequest?.getMatchedRules) return;
    const res = await chrome.declarativeNetRequest.getMatchedRules().catch(() => ({}));
    const total = res?.rulesMatchedInfo?.length || 0;
    const delta = total - lastMatchedCount;
    if (delta > 0) {
      lastMatchedCount = total;
      await setSetting('omnisense.adblock.lastMatched', total);
      const stats = await getSetting(SettingKeys.stats, { requests: 0, elements: 0 });
      stats.requests = (stats.requests || 0) + delta;
      await setSetting(SettingKeys.stats, stats);
    } else if (total < lastMatchedCount) {
      lastMatchedCount = total;
      await setSetting('omnisense.adblock.lastMatched', total);
    }
  } catch (e) {}
});

// ---------------- Tabs ----------------
chrome.tabs.onActivated.addListener(({ tabId }) => { lastKnownTabId = tabId; });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (tab.active) lastKnownTabId = tabId; });

// ---------------- Related Memories & Smart Tab Grouping ----------------
async function handleGetRelatedCapsules(currentUrl, text) {
  if (!text || !text.trim()) return { pages: [] };
  const query = text.slice(0, 200).trim();
  try {
    await ensureOffscreen();
  } catch (e) {
    return { pages: [] };
  }

  const raw = await new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'omni-offscreen' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { port.disconnect(); } catch (err) {}
      resolve(v);
    };
    port.onMessage.addListener((m) => {
      if (m.type === MSG_TYPES.CAPSULE_QUERY) finish(m.results || []);
    });
    port.onDisconnect.addListener(() => finish([]));
    try { port.postMessage({ type: MSG_TYPES.CAPSULE_QUERY, query }); }
    catch (err) { finish([]); }
    setTimeout(() => finish([]), 15000);
  });

  const normCurrent = (currentUrl || '').split('#')[0].replace(/\/+$/, '');
  const otherChunks = (raw || []).filter(c => {
    const norm = (c.url || '').split('#')[0].replace(/\/+$/, '');
    return norm && norm !== normCurrent && (c.score || 0) >= 0.55;
  });

  const pages = groupByPage(otherChunks);
  return { pages: pages.slice(0, 3) };
}

function dotProduct(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function getTargetTabs(windowId) {
  let tabs = [];
  if (typeof windowId === 'number' && windowId > 0) {
    try {
      tabs = await chrome.tabs.query({ windowId });
      if (tabs && tabs.length > 0) return tabs;
    } catch (e) {}
  }
  try {
    tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    if (tabs && tabs.length > 0) return tabs;
  } catch (e) {}
  try {
    tabs = await chrome.tabs.query({ currentWindow: true });
    if (tabs && tabs.length > 0) return tabs;
  } catch (e) {}
  try {
    tabs = await chrome.tabs.query({});
    return tabs || [];
  } catch (e) {
    return [];
  }
}

async function handleClusterTabs(windowId) {
  try {
    const tabs = await getTargetTabs(windowId);
    const eligible = tabs.filter(t => !t.pinned && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('about:'));
    if (eligible.length < 2) {
      return { ok: false, reason: 'too_few', count: eligible.length };
    }

    let vectors = null;
    try {
      await ensureOffscreen();
      const titles = eligible.map(t => {
        const title = (t.title || '').trim().slice(0, 80);
        if (title) return title;
        try { return new URL(t.url).hostname; } catch (e) { return 'Page'; }
      });
      vectors = await new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'omni-offscreen' });
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          try { port.disconnect(); } catch (err) {}
          resolve(v);
        };
        port.onMessage.addListener((m) => {
          if (m.type === MSG_TYPES.EMBEDDING && (m.vectors || m.vector)) {
            finish(m.vectors || [m.vector]);
          } else if (m.type === MSG_TYPES.INFER_ERROR) {
            finish(null);
          }
        });
        port.onDisconnect.addListener(() => finish(null));
        try { port.postMessage({ type: MSG_TYPES.EMBEDDING, texts: titles, requestId: 'tabs_' + Date.now() }); }
        catch (err) { finish(null); }
        setTimeout(() => finish(null), 10000);
      });
    } catch (err) {
      vectors = null;
    }

    const clusters = [];
    if (vectors && vectors.length === eligible.length) {
      const assigned = new Set();
      for (let i = 0; i < eligible.length; i++) {
        if (assigned.has(i)) continue;
        const cluster = [eligible[i]];
        assigned.add(i);
        for (let j = i + 1; j < eligible.length; j++) {
          if (assigned.has(j)) continue;
          if (dotProduct(vectors[i], vectors[j]) >= 0.58) {
            cluster.push(eligible[j]);
            assigned.add(j);
          }
        }
        if (cluster.length >= 2) clusters.push(cluster);
      }
    }

    if (clusters.length === 0) {
      const domainMap = new Map();
      for (const t of eligible) {
        try {
          const u = new URL(t.url);
          const domain = u.hostname.replace(/^www\./, '');
          if (!domainMap.has(domain)) domainMap.set(domain, []);
          domainMap.get(domain).push(t);
        } catch (err) {}
      }
      for (const [, dTabs] of domainMap.entries()) {
        if (dTabs.length >= 2) clusters.push(dTabs);
      }
    }

    if (!clusters.length) {
      return { ok: false, reason: 'no_clusters', count: 0 };
    }

    const COLORS = ['blue', 'green', 'yellow', 'purple', 'cyan', 'orange', 'pink'];
    let groupedCount = 0;
    let actualGroups = 0;
    for (let cIdx = 0; cIdx < clusters.length; cIdx++) {
      const cluster = clusters[cIdx];
      const tabIds = cluster.map(t => t.id).filter(id => typeof id === 'number');
      if (tabIds.length < 2) continue;

      let groupTitle = '';
      try {
        const u = new URL(cluster[0].url);
        groupTitle = u.hostname.replace(/^www\./, '').split('.')[0];
      } catch (err) {}
      const cleanTitle = (cluster[0].title || '').replace(/[-_–|].*$/, '').trim();
      if (cleanTitle && cleanTitle.length >= 2 && cleanTitle.length <= 15) {
        groupTitle = cleanTitle;
      }

      const color = COLORS[cIdx % COLORS.length];
      try {
        if (chrome.tabs.group) {
          const groupId = await chrome.tabs.group({ tabIds });
          if (chrome.tabGroups?.update) {
            await chrome.tabGroups.update(groupId, {
              title: groupTitle || 'Group',
              color,
              collapsed: false
            }).catch(() => {});
          }
          groupedCount += tabIds.length;
          actualGroups++;
        }
      } catch (groupErr) {
        console.warn('Group tabs cluster failed:', groupErr);
      }
    }

    if (groupedCount > 0) {
      return { ok: true, count: groupedCount, groups: actualGroups };
    }
    return { ok: false, reason: 'no_clusters' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleDedupeTabs(windowId) {
  try {
    const tabs = await getTargetTabs(windowId);
    const seen = new Set();
    const duplicateIds = [];
    for (const t of tabs) {
      if (!t.url || t.pinned) continue;
      const cleanUrl = t.url.split('#')[0].replace(/\/+$/, '');
      if (seen.has(cleanUrl)) {
        duplicateIds.push(t.id);
      } else {
        seen.add(cleanUrl);
      }
    }
    if (duplicateIds.length > 0) {
      await chrome.tabs.remove(duplicateIds);
    }
    return { ok: true, removed: duplicateIds.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


