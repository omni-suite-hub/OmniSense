import { loadLocale, t, applyI18n, getLocale } from '../shared/i18n.js';
import {
  MSG_TYPES, TABS, TONE_STYLES, WRITING_LENGTHS, WRITING_TONES, WRITING_LANGS,
  SUMMARY_LEVELS, TTS_RATES, DEFAULT_LOCALE, MIN_SUMMARY_CHARS
} from '../shared/constants.js';
import { setupModelStatusBar, showToast, makeTabs, formatTimeAgo, escapeHtml, formatModelError } from '../shared/ui.js';
import { sendToSW, postToSW, sendToTab } from '../shared/messaging.js';
import { getSetting, setSetting, SettingKeys } from '../shared/settings.js';
import { splitForSpeech, dominantScript, pickVoice, VOICE_LANG_LABEL } from '../shared/speech.js';
import {
  filterBriefingMemories, buildBriefingPromptInput, generateOfflineBriefingScript, formatRadioDate
} from '../shared/briefing-core.js';
import { renderMarkdown } from '../shared/markdown.js';

/**
 * The page the panel is about.
 *
 * These used to be assigned ONCE, in init(). A side panel is not reloaded when
 * the user navigates — it stays bound to the window while the document
 * underneath it is replaced — and there was no `chrome.tabs` listener anywhere,
 * so both values silently went stale the moment the user moved on.
 *
 * Measured consequence (`e2e/diag-listen.cjs`): with the panel open on an
 * English article, navigating the same tab to a Chinese page and even switching
 * to a different Chinese tab left `listenStatus` showing the ENGLISH title, and
 * 播放 kept reading that English article. That is the reported
 * 「明明是中文页面，为啥朗读的是英文」.
 *
 * The rule now is: never trust a cached tab id. `articleForActiveTab()` asks the
 * browser which tab is active, and reuses the cached article only when the tab
 * AND its URL are unchanged.
 */
let currentTabId = null;
let currentArticle = null;
let articleTabId = null;
let articleUrl = null;
/**
 * Bumped whenever the page the panel is about changes.
 *
 * Reading an article means injecting Readability and waiting for it, so a read
 * that started before a navigation can finish after it. Without an epoch that
 * late result would be cached and silently resurrect the stale article — the
 * very bug being fixed. Every read captures the epoch it started in and discards
 * its own result if the epoch moved.
 */
let articleEpoch = 0;
let activeInferenceId = null;
let runtimeListenersBound = false;
let pageFollowBound = false;

/** Ask the browser which tab the user is looking at. Never cache the answer. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/** Forget the cached article and invalidate any read that is still in flight. */
function invalidateArticle() {
  articleEpoch++;
  currentArticle = null;
  articleTabId = null;
  articleUrl = null;
}

/**
 * The article for the page the user is looking at RIGHT NOW.
 *
 * Cached per (tab, url) so repeated calls within one document do not re-inject
 * Readability. `force` is for explicit user actions ("读取本页"), where a fresh
 * read is the whole point.
 */
async function articleForActiveTab({ force = false } = {}) {
  const tab = await activeTab();
  if (!tab || tab.id == null) {
    invalidateArticle();
    currentTabId = null;
    return { isArticle: false, reason: 'no_tab' };
  }
  currentTabId = tab.id;
  if (!force && articleTabId === tab.id && articleUrl === tab.url && currentArticle) {
    return currentArticle;
  }

  const epoch = articleEpoch;
  const art = await sendToSW({ type: MSG_TYPES.GET_ARTICLE, tabId: tab.id });
  // A navigation during the read makes this result describe a page that is no
  // longer on screen. Dropping it is correct; caching it is the original bug.
  if (epoch !== articleEpoch) return art;
  currentArticle = art;
  articleTabId = tab.id;
  articleUrl = tab.url;
  return art;
}

/**
 * Notice when the page the panel is about changes.
 *
 * Neither listener existed before, which is precisely why 播放 read the wrong
 * page. Debounced because a single navigation produces several tab events
 * (`loading` → `complete` → title change), and each one would otherwise trigger
 * its own Readability injection.
 */
function bindPageFollow() {
  if (pageFollowBound) return;
  pageFollowBound = true;

  let timer = null;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { onPageChanged().catch(() => {}); }, 350);
  };
  chrome.tabs.onActivated.addListener(changed);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab || !tab.active) return;
    if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) changed();
  });
}

async function onPageChanged() {
  invalidateArticle();
  // Do not clobber a live read-out: while speaking, `listenStatus` describes the
  // text being read, not the page the user has just moved to. It is reconciled
  // in `u.onend` instead.
  if (!activeInferenceId && !ttsActive) await loadCurrentArticleForListen().catch(() => {});
  syncTabTTSState().catch(() => {});
  await loadCurrentArticle().catch(() => {});
  loadCurrentArticleForAsk().catch(() => {});
  checkRelatedCapsules().catch(() => {});
}

/**
 * Feature initialisers, each isolated in try/catch during init().
 *
 * A bare sequence of initX() calls means one throw silently disables every
 * feature declared after it: a failure inside initTone() left the summary and
 * capsule panels with no click handlers at all, so clicking their buttons did
 * literally nothing and the user could only report "点了没反应". Running them
 * one by one with per-step error capture turns that into a visible, diagnosable
 * failure. Declared as function declarations so hoisting makes this list valid
 * at call time.
 */
const FEATURE_INITS = [
  ['capsule', () => initCapsule()],
  ['ask', () => initAsk()],
  ['tabgroup', () => initTabGroup()],
  ['summary', () => initSummary()],
  ['listen', () => initListen()],
  ['writing', () => initWriting()],
  ['tone', () => initTone()],
  ['roast', () => initRoast()],
  ['privacy', () => initPrivacy()],
  ['adblock', () => initAdblock()]
];

async function init() {
  const savedLang = await getSetting(SettingKeys.locale, DEFAULT_LOCALE);
  await loadLocale(savedLang);
  applyI18n();

  setupModelStatusBar('modelStatus');
  makeTabs(document.getElementById('tabs'), onTabSwitch);

  const tab = await activeTab();
  currentTabId = tab ? tab.id : null;

  const failed = [];
  for (const [name, run] of FEATURE_INITS) {
    try {
      await run();
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
  }
  if (failed.length) {
    console.error('OmniSense panel init failures:', failed.join(' | '));
    showToast(t('global.error_retry'));
  }

  bindRuntimeListeners();
  bindPageFollow();

  const hadPending = await checkPendingView();
  if (!hadPending) {
    const defaultTab = await getSetting(SettingKeys.defaultTab, 'capsule');
    switchTab(defaultTab);
  }
}

/**
 * Every feature acts on the active tab, so a missing tab id must be surfaced
 * rather than swallowed. The previous `if (!currentTabId) return;` made the
 * button a no-op with no feedback of any kind.
 *
 * It re-queries rather than trusting `currentTabId`: the panel outlives both
 * navigations and tab switches, and a cached id is how the panel ended up
 * operating on — and reading from — a page the user had already left.
 */
async function requireTab() {
  const tab = await activeTab();
  currentTabId = tab ? tab.id : null;
  if (currentTabId != null) return true;
  showToast(t('global.no_active_tab'));
  return false;
}

function applyPendingView(msg) {
  if (!msg || !msg.view) return;
  switchTab(msg.view);
  if (msg.view === 'tone' && msg.selection) {
    const el = document.getElementById('toneInput');
    if (el) el.value = msg.selection;
  }
  if (msg.view === 'roast' && msg.selection) {
    const el = document.getElementById('roastInput');
    if (el) el.value = msg.selection;
  }
  if (msg.view === 'writing') {
    if (msg.selection) {
      const el = document.getElementById('writingInstruction');
      if (el) el.value = `${t('writing.instruction_placeholder')}（${msg.selection.slice(0, 40)}...）`; // i18n-allow-cjk
      const refBtn = document.querySelector('[data-wmode="ref"]');
      if (refBtn) refBtn.click();
    }
  }
  if (msg.view === 'capsule') {
    refreshCapsuleStats();
    if (msg.query) {
      const input = document.getElementById('capsuleInput');
      if (input) {
        input.value = msg.query;
        doCapsuleSearch(msg.query);
      }
    }
  }
}

async function checkPendingView() {
  try {
    const res = await chrome.storage.session.get('omnisense.pendingView');
    const pending = res?.['omnisense.pendingView'];
    if (pending && pending.view && (Date.now() - (pending.ts || 0) < 15000)) {
      await chrome.storage.session.remove('omnisense.pendingView');
      applyPendingView(pending);
      return true;
    }
  } catch (e) {}
  return false;
}

/**
 * Runtime listeners, registered after the dictionary is loaded (so `t()` works)
 * and exactly once.
 *
 * A single `{ once: true }` registration would be worse than useless here: it
 * would silently stop the right-click actions from opening their tab after the
 * first use. The guard flag gives the intended "never register twice" property
 * without that regression.
 */
function bindRuntimeListeners() {
  if (runtimeListenersBound) return;
  runtimeListenersBound = true;

  chrome.runtime.onMessage.addListener(handleBroadcast);

  // Tell the user when a multi-minute first-run download finishes (or fails).
  // Without this the only feedback was a small badge at the very top, while the
  // result box stayed empty and looked broken.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== MSG_TYPES.MODEL_STATUS) return;
    if (msg.status === 'ready') showToast(t('toast.model_ready'));
    else if (msg.status === 'error') showToast(t('toast.model_failed'));
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'OPEN_VIEW' || !msg.view) return;
    applyPendingView(msg);
  });

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes['omnisense.pendingView']?.newValue) {
        const pending = changes['omnisense.pendingView'].newValue;
        chrome.storage.session.remove('omnisense.pendingView').catch(() => {});
        applyPendingView(pending);
      }
    });
  }
}

function handleBroadcast(msg) {
  // Background-originated notices (e.g. a right-click capture, or the one-off
  // "we started indexing" hint). They arrive pre-translated by the sender.
  if (msg.type === MSG_TYPES.TOAST) {
    if (msg.text) showToast(msg.text);
    refreshCapsuleStats();
    return;
  }
  if (msg.type === MSG_TYPES.INFER_STREAM && msg.requestId === activeInferenceId) appendStreamText(msg.text);
  if (msg.type === MSG_TYPES.INFER_NOTICE && msg.requestId === activeInferenceId) showInferenceNotice(msg);
  if (msg.type === MSG_TYPES.INFER_END && msg.requestId === activeInferenceId) finishStream();
  if (msg.type === MSG_TYPES.INFER_ERROR && msg.requestId === activeInferenceId) {
    // Put the technical reason in the result box as well as the toast: a toast
    // disappears after two seconds, and the previous behaviour left the user
    // staring at an empty box with no idea what went wrong.
    const s = window._currentStream;
    if (s) {
      s.text = '';
      s.outputEl.textContent = `${t('global.error_retry')}\n${formatModelError(msg.error)}`.trim();
    }
    finishStream(true);
    showToast(t('global.error_retry'));
  }
}

function onTabSwitch(tab) {
  setSetting(SettingKeys.defaultTab, tab);
  if (tab === 'capsule') {
    checkRelatedCapsules().catch(() => {});
  }
}

function switchTab(tab) {
  const btn = document.querySelector(`#tabs [data-tab="${tab}"]`);
  if (btn) btn.click();
}

// ---------------- Inference helpers ----------------
/**
 * Long-input notices. The inference host emits a stable CODE, never UI copy, so
 * one host can serve any language.
 *
 * The `labelKey` field name is deliberate: e2e/check-i18n.cjs discovers keys that
 * are only reached indirectly by looking for exactly that property on a table
 * entry, so spelling it this way keeps the dictionary audit honest instead of
 * reporting these five keys as unused.
 */
const INFER_NOTICES = {
  truncated_head:  { labelKey: 'global.long_input_truncated' },
  truncated_tail:  { labelKey: 'global.long_input_tail' },
  summary_chunked: { labelKey: 'summary.long_hint' },
  writing_chunked: { labelKey: 'writing.long_hint' },
  podcast_chunked: { labelKey: 'listen.long_hint' },
  chunk_progress:  { labelKey: 'summary.chunk_progress', params: ['done', 'total'] }
};

function showInferenceNotice(msg) {
  const s = window._currentStream;
  if (!s || !s.noticeEl) return;
  const spec = INFER_NOTICES[msg.code];
  if (!spec) return;
  const vars = {};
  for (const p of spec.params || []) vars[p] = msg[p];
  s.noticeEl.textContent = t(spec.labelKey, vars);
}

function inferStream(promptKey, payload, outputId, actionsId, onDone, noticeId, onChunk) {
  const requestId = `${Date.now()}_${Math.random()}`;
  activeInferenceId = requestId;
  const outputEl = outputId ? document.getElementById(outputId) : null;
  const actionsEl = actionsId ? document.getElementById(actionsId) : null;
  if (outputEl) {
    outputEl.style.display = 'block';
    outputEl.classList.add('thinking');
    outputEl.textContent = t('global.thinking');
  }
  if (actionsEl) {
    actionsEl.style.display = 'none';
  }

  window._currentStream = {
    outputEl, actionsEl, text: '', onDone, onChunk,
    noticeEl: noticeId ? document.getElementById(noticeId) : null
  };

  // One retry rides out a cold-starting service worker. If it still fails we say
  // so in the result box instead of leaving an unexplained empty panel.
  const attempt = (retries) => sendToSW({
    type: MSG_TYPES.INFER_STREAM,
    requestId,
    promptKey,
    payload
  }).catch((e) => {
    if (requestId !== activeInferenceId) return;
    if (retries > 0) {
      return new Promise(r => setTimeout(r, 300)).then(() => attempt(retries - 1));
    }
    if (outputEl) {
      outputEl.classList.remove('thinking');
      outputEl.textContent = `${t('global.error_retry')}\n${formatModelError(e.message)}`.trim();
    }
    finishStream(true);
  });
  attempt(1);
}

function appendStreamText(text) {
  const s = window._currentStream;
  if (!s) return;
  s.text += text;
  if (s.outputEl) {
    s.outputEl.classList.remove('thinking');
    s.outputEl.innerHTML = renderMarkdown(s.text);
    s.outputEl.scrollTop = s.outputEl.scrollHeight;
  }
  if (s.onChunk) s.onChunk(s.text);
}

function finishStream(isError = false) {
  activeInferenceId = null;
  const s = window._currentStream;
  if (!s) return;
  if (s.outputEl) {
    s.outputEl.classList.remove('thinking');
    // Zero chunks without an error still deserves an explanation, not a blank box.
    if (!s.text && !s.outputEl.textContent) {
      s.outputEl.textContent = t('global.error_retry');
    } else if (s.text) {
      s.outputEl.innerHTML = renderMarkdown(s.text);
    }
  }
  if (s.actionsEl) s.actionsEl.style.display = 'flex';
  if (s.onDone) s.onDone(s.text, isError);
}

// ---------------- Capsule ----------------
/**
 * Bumped for every capsule render request, so a reply that arrives after a newer
 * request was issued is discarded instead of overwriting it.
 *
 * This is not hypothetical: two capsule routes can be in flight at once. The
 * panel auto-lists on open, 「收录本页」 re-runs whatever search is on screen when
 * it finishes, and either can be racing a search the user just typed. Whichever
 * reply happened to land last used to win, regardless of which was asked for
 * last. Same discard pattern as `articleEpoch` above, for the same reason.
 */
let capsuleEpoch = 0;

function initCapsule() {
  const input = document.getElementById('capsuleInput');
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = input.value.trim();
    // An empty box used to send `query: ''` to the embedder, which is not a
    // search anyone meant to run. Enter on an empty box now means the obvious
    // thing: show me everything that is stored.
    if (q) doCapsuleSearch(q);
    else doCapsuleBrowse();
  });
  document.getElementById('capsuleCaptureBtn').addEventListener('click', doCapsuleCapture);
  document.getElementById('capsuleBrowseBtn').addEventListener('click', doCapsuleBrowse);
  document.getElementById('capsuleRetry').addEventListener('click', () => { refreshCapsuleStats(); });
  // Show what is stored as soon as the panel opens. "如何查看所有的收录的文章"
  // should not require first knowing that a control for it exists.
  refreshCapsuleStats().then((count) => { if (count) doCapsuleBrowse(); });
  checkRelatedCapsules().catch(() => {});
  initDailyBriefing();
  initCapsuleGraph();
}

let currentBriefingScript = '';
let currentBriefingPages = [];

function initDailyBriefing() {
  const generateBtn = document.getElementById('briefingGenerateBtn');
  const statusEl = document.getElementById('briefingRadioStatus');
  const playerArea = document.getElementById('briefingPlayerArea');
  const dateBadge = document.getElementById('briefingDateBadge');
  const countBadge = document.getElementById('briefingCountBadge');
  const playBtn = document.getElementById('briefingPlayBtn');
  const pauseBtn = document.getElementById('briefingPauseBtn');
  const stopBtn = document.getElementById('briefingStopBtn');
  const viewScriptBtn = document.getElementById('briefingViewScriptBtn');
  const scriptBox = document.getElementById('briefingScriptBox');
  const waveBars = document.getElementById('briefingWaveBars');

  if (!generateBtn) return;

  generateBtn.addEventListener('click', async () => {
    generateBtn.disabled = true;
    statusEl.style.display = 'block';
    statusEl.textContent = t('briefing.generating');

    try {
      const recent = await sendToSW({ type: MSG_TYPES.CAPSULE_RECENT });
      const allPages = recent?.pages || [];
      if (!allPages.length) {
        statusEl.textContent = t('briefing.empty_hint');
        generateBtn.disabled = false;
        return;
      }

      currentBriefingPages = filterBriefingMemories(allPages, Date.now(), 48, 2, 5);
      const promptInput = buildBriefingPromptInput(currentBriefingPages);

      dateBadge.textContent = formatRadioDate(Date.now(), getLocale());
      countBadge.textContent = t('briefing.ready', { count: currentBriefingPages.length });

      inferStream(
        'briefing',
        { article: promptInput },
        'briefingScriptBox',
        null,
        (finalScript) => {
          generateBtn.disabled = false;
          statusEl.style.display = 'none';
          currentBriefingScript = (finalScript && finalScript.trim())
            ? finalScript.trim()
            : generateOfflineBriefingScript(currentBriefingPages, getLocale());
          scriptBox.innerHTML = renderMarkdown(currentBriefingScript);
          playerArea.style.display = 'block';
        },
        'briefingRadioStatus'
      );
    } catch (e) {
      generateBtn.disabled = false;
      if (currentBriefingPages.length) {
        currentBriefingScript = generateOfflineBriefingScript(currentBriefingPages, getLocale());
        scriptBox.innerHTML = renderMarkdown(currentBriefingScript);
        playerArea.style.display = 'block';
        statusEl.style.display = 'none';
      } else {
        statusEl.textContent = t('global.error_retry');
      }
    }
  });

  playBtn.addEventListener('click', () => {
    if (!currentBriefingScript) return;
    startTTS(currentBriefingScript, t('briefing.station_name'));
    playBtn.style.display = 'none';
    pauseBtn.style.display = '';
    stopBtn.style.display = '';
    if (waveBars) waveBars.style.display = 'flex';
  });

  pauseBtn.addEventListener('click', () => {
    const ttsPause = document.getElementById('ttsPause');
    if (ttsPause) ttsPause.click();
    playBtn.style.display = '';
    pauseBtn.style.display = 'none';
    if (waveBars) waveBars.style.display = 'none';
  });

  stopBtn.addEventListener('click', () => {
    const ttsStop = document.getElementById('ttsStop');
    if (ttsStop) ttsStop.click();
    playBtn.style.display = '';
    pauseBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    if (waveBars) waveBars.style.display = 'none';
  });

  viewScriptBtn.addEventListener('click', () => {
    const isHidden = scriptBox.style.display === 'none';
    scriptBox.style.display = isHidden ? 'block' : 'none';
    viewScriptBtn.textContent = isHidden ? t('briefing.hide_script') : t('briefing.view_script');
  });
}

// ---------------- Capsule Knowledge Graph ----------------
let graphCanvas = null;
let graphCtx = null;
let graphNodes = [];
let graphEdges = [];
let graphAnimId = null;
let isGraphRunning = false;
let draggedNode = null;
let hoveredNode = null;
let graphSearchQuery = '';

function initCapsuleGraph() {
  const listBtn = document.getElementById('capsuleViewListBtn');
  const graphBtn = document.getElementById('capsuleViewGraphBtn');
  const graphContainer = document.getElementById('capsuleGraphContainer');
  const resetBtn = document.getElementById('capsuleGraphResetBtn');
  const canvas = document.getElementById('capsuleGraphCanvas');
  const tooltip = document.getElementById('capsuleGraphTooltip');
  const searchInput = document.getElementById('capsuleInput');

  if (!listBtn || !graphBtn || !graphContainer || !canvas) return;

  graphCanvas = canvas;
  graphCtx = canvas.getContext('2d');

  function resizeCanvas() {
    if (!graphCanvas) return;
    const rect = graphCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (rect.width > 0 && rect.height > 0) {
      graphCanvas.width = Math.floor(rect.width * dpr);
      graphCanvas.height = Math.floor(rect.height * dpr);
      graphCtx.setTransform(1, 0, 0, 1, 0, 0);
      graphCtx.scale(dpr, dpr);
    }
  }

  window.addEventListener('resize', () => {
    if (graphContainer.style.display !== 'none') {
      resizeCanvas();
    }
  });

  listBtn.addEventListener('click', () => {
    listBtn.classList.add('active');
    graphBtn.classList.remove('active');
    graphContainer.style.display = 'none';
    stopGraphSimulation();
  });

  graphBtn.addEventListener('click', () => {
    graphBtn.classList.add('active');
    listBtn.classList.remove('active');
    graphContainer.style.display = 'block';
    resizeCanvas();
    loadAndStartGraph();
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      resetGraphLayout();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      graphSearchQuery = searchInput.value.trim().toLowerCase();
      if (!isGraphRunning) startGraphLoop();
    });
  }

  let isDragging = false;
  let hasMovedSignificantly = false;

  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  function findNodeAt(x, y) {
    for (let i = graphNodes.length - 1; i >= 0; i--) {
      const node = graphNodes[i];
      const dist = Math.hypot(node.x - x, node.y - y);
      if (dist <= node.radius + 6) return node;
    }
    return null;
  }

  canvas.addEventListener('mousemove', (e) => {
    const coords = getCanvasCoords(e);
    if (isDragging && draggedNode) {
      draggedNode.x = coords.x;
      draggedNode.y = coords.y;
      draggedNode.vx = 0;
      draggedNode.vy = 0;
      hasMovedSignificantly = true;
      if (!isGraphRunning) startGraphLoop();
      return;
    }

    const hit = findNodeAt(coords.x, coords.y);
    hoveredNode = hit;
    if (hit) {
      canvas.style.cursor = 'pointer';
      if (tooltip) {
        tooltip.style.display = 'block';
        tooltip.style.left = `${coords.x + 12}px`;
        tooltip.style.top = `${coords.y - 10}px`;
        const openHint = getLocale() === 'zh' ? '点击打开' : 'Click to open'; // i18n-allow-cjk
        tooltip.innerHTML = `<strong>${escapeHtml(hit.title || '')}</strong><br><span style="opacity:0.75; font-size:10px;">${escapeHtml(hit.domain || '')} · ${openHint}</span>`;
      }
    } else {
      canvas.style.cursor = 'grab';
      if (tooltip) tooltip.style.display = 'none';
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    const coords = getCanvasCoords(e);
    const hit = findNodeAt(coords.x, coords.y);
    if (hit) {
      isDragging = true;
      draggedNode = hit;
      hasMovedSignificantly = false;
      canvas.style.cursor = 'grabbing';
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging && draggedNode) {
      if (!hasMovedSignificantly && draggedNode.url) {
        chrome.tabs.create({ url: draggedNode.url });
      }
      isDragging = false;
      draggedNode = null;
      if (canvas) canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    hoveredNode = null;
    if (tooltip) tooltip.style.display = 'none';
  });
}

async function loadAndStartGraph() {
  try {
    const res = await sendToSW({ type: MSG_TYPES.CAPSULE_GRAPH });
    const graph = res?.graph || { nodes: [], edges: [] };
    const statsEl = document.getElementById('capsuleGraphStats');
    if (statsEl) {
      const unit = getLocale() === 'zh' ? '篇' : 'items'; // i18n-allow-cjk
      statsEl.textContent = `${graph.nodes.length} ${unit}`;
    }

    if (!graphCanvas) return;
    const rect = graphCanvas.getBoundingClientRect();
    const width = rect.width || 300;
    const height = rect.height || 260;
    const cx = width / 2;
    const cy = height / 2;

    graphNodes = (graph.nodes || []).map((n, idx, arr) => {
      const angle = (idx / (arr.length || 1)) * Math.PI * 2;
      const radiusDist = 30 + Math.random() * (Math.min(cx, cy) - 45);
      return {
        ...n,
        radius: Math.max(9, Math.min(20, 8 + Math.sqrt(n.chunkCount || 1) * 3)),
        x: cx + Math.cos(angle) * radiusDist,
        y: cy + Math.sin(angle) * radiusDist,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2
      };
    });

    const nodeMap = new Map();
    graphNodes.forEach(n => nodeMap.set(n.id, n));

    graphEdges = (graph.edges || []).map(e => ({
      source: nodeMap.get(e.source),
      target: nodeMap.get(e.target),
      weight: e.weight
    })).filter(e => e.source && e.target);

    startGraphLoop();
  } catch (e) {}
}

function stepGraphPhysics() {
  if (!graphCanvas) return 0;
  const rect = graphCanvas.getBoundingClientRect();
  const width = rect.width || 300;
  const height = rect.height || 260;
  const cx = width / 2;
  const cy = height / 2;

  const k_repulse = 420;
  const k_spring = 0.05;
  const idealDistance = 75;
  const k_center = 0.015;
  const damping = 0.88;

  for (let i = 0; i < graphNodes.length; i++) {
    const a = graphNodes[i];
    for (let j = i + 1; j < graphNodes.length; j++) {
      const b = graphNodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < 180) {
        const force = k_repulse / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (a !== draggedNode) { a.vx -= fx; a.vy -= fy; }
        if (b !== draggedNode) { b.vx += fx; b.vy += fy; }
      }
    }
  }

  for (const edge of graphEdges) {
    const a = edge.source;
    const b = edge.target;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const displacement = dist - idealDistance;
    const force = displacement * k_spring * (edge.weight || 0.5);
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if (a !== draggedNode) { a.vx -= fx; a.vy -= fy; }
    if (b !== draggedNode) { b.vx += fx; b.vy += fy; }
  }

  let totalVelocity = 0;
  for (const node of graphNodes) {
    if (node === draggedNode) continue;
    const dx = cx - node.x;
    const dy = cy - node.y;
    node.vx += dx * k_center;
    node.vy += dy * k_center;

    node.vx *= damping;
    node.vy *= damping;

    node.x += node.vx;
    node.y += node.vy;

    const pad = node.radius + 4;
    node.x = Math.max(pad, Math.min(width - pad, node.x));
    node.y = Math.max(pad, Math.min(height - pad, node.y));

    totalVelocity += Math.abs(node.vx) + Math.abs(node.vy);
  }

  return totalVelocity;
}

function renderGraphCanvas() {
  if (!graphCtx || !graphCanvas) return;
  const rect = graphCanvas.getBoundingClientRect();
  const width = rect.width || 300;
  const height = rect.height || 260;

  graphCtx.clearRect(0, 0, width, height);

  if (graphNodes.length === 0) {
    graphCtx.save();
    graphCtx.font = '12px system-ui, sans-serif';
    graphCtx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    graphCtx.textAlign = 'center';
    const emptyMsg = getLocale() === 'zh' ? '暂无记忆节点，收录网页后自动生成星图' : 'No memory nodes yet'; // i18n-allow-cjk
    graphCtx.fillText(emptyMsg, width / 2, height / 2);
    graphCtx.restore();
    return;
  }

  for (const edge of graphEdges) {
    const a = edge.source;
    const b = edge.target;
    graphCtx.save();
    const alpha = Math.min(0.65, Math.max(0.12, (edge.weight || 0.4) * 0.75));
    graphCtx.strokeStyle = `rgba(16, 185, 129, ${alpha})`;
    graphCtx.lineWidth = Math.max(1, (edge.weight || 0.4) * 2.5);
    graphCtx.beginPath();
    graphCtx.moveTo(a.x, a.y);
    graphCtx.lineTo(b.x, b.y);
    graphCtx.stroke();
    graphCtx.restore();
  }

  for (const node of graphNodes) {
    const isHovered = hoveredNode === node || draggedNode === node;
    const isMatched = Boolean(graphSearchQuery && (
      (node.title && node.title.toLowerCase().includes(graphSearchQuery)) ||
      (node.domain && node.domain.toLowerCase().includes(graphSearchQuery))
    ));

    graphCtx.save();

    if (isHovered || isMatched) {
      graphCtx.beginPath();
      graphCtx.arc(node.x, node.y, node.radius + (isHovered ? 6 : 4), 0, Math.PI * 2);
      graphCtx.fillStyle = isMatched ? 'rgba(245, 158, 11, 0.35)' : 'rgba(52, 211, 153, 0.35)';
      graphCtx.fill();
    }

    const grad = graphCtx.createRadialGradient(
      node.x - node.radius * 0.3, node.y - node.radius * 0.3, 1,
      node.x, node.y, node.radius
    );
    if (isMatched) {
      grad.addColorStop(0, '#fbbf24');
      grad.addColorStop(1, '#d97706');
    } else {
      grad.addColorStop(0, '#34d399');
      grad.addColorStop(1, '#059669');
    }

    graphCtx.beginPath();
    graphCtx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    graphCtx.fillStyle = grad;
    graphCtx.fill();
    graphCtx.strokeStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.5)';
    graphCtx.lineWidth = 1.5;
    graphCtx.stroke();

    const label = (node.title || node.domain || '').slice(0, 8);
    if (label) {
      graphCtx.font = '10px system-ui, sans-serif';
      graphCtx.textAlign = 'center';
      graphCtx.fillStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.75)';
      graphCtx.fillText(label, node.x, node.y + node.radius + 12);
    }

    graphCtx.restore();
  }
}

function startGraphLoop() {
  if (isGraphRunning) return;
  isGraphRunning = true;

  function loop() {
    const totalVel = stepGraphPhysics();
    renderGraphCanvas();
    if (totalVel > 0.05 || draggedNode) {
      graphAnimId = requestAnimationFrame(loop);
    } else {
      isGraphRunning = false;
      graphAnimId = null;
    }
  }

  graphAnimId = requestAnimationFrame(loop);
}

function stopGraphSimulation() {
  if (graphAnimId) {
    cancelAnimationFrame(graphAnimId);
    graphAnimId = null;
  }
  isGraphRunning = false;
}

function resetGraphLayout() {
  if (!graphCanvas) return;
  const rect = graphCanvas.getBoundingClientRect();
  const cx = (rect.width || 300) / 2;
  const cy = (rect.height || 260) / 2;
  graphNodes.forEach((n, idx, arr) => {
    const angle = (idx / (arr.length || 1)) * Math.PI * 2;
    const r = 30 + Math.random() * (Math.min(cx, cy) - 45);
    n.x = cx + Math.cos(angle) * r;
    n.y = cy + Math.sin(angle) * r;
    n.vx = (Math.random() - 0.5) * 3;
    n.vy = (Math.random() - 0.5) * 3;
  });
  startGraphLoop();
}

async function checkRelatedCapsules() {
  const container = document.getElementById('capsuleRelated');
  const listEl = document.getElementById('capsuleRelatedList');
  const badgeEl = document.getElementById('capsuleRelatedBadge');
  if (!container || !listEl) return;

  const art = currentArticle || await articleForActiveTab().catch(() => null);
  if (!art?.isArticle || !art.text || art.text.length < 50) {
    container.style.display = 'none';
    return;
  }

  try {
    const res = await sendToSW({
      type: MSG_TYPES.GET_RELATED_CAPSULES,
      url: art.url,
      text: art.text.slice(0, 300)
    });
    const pages = res?.pages || [];
    if (!pages.length) {
      container.style.display = 'none';
      return;
    }

    listEl.innerHTML = '';
    if (badgeEl) badgeEl.textContent = `${pages.length}`;
    pages.forEach(p => {
      const item = document.createElement('div');
      item.className = 'item';
      item.style.marginBottom = '6px';
      item.style.padding = '8px 10px';
      item.style.cursor = 'pointer';

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.gap = '8px';

      const title = document.createElement('span');
      title.className = 'title';
      title.style.fontSize = '12px';
      title.textContent = p.title || p.url;

      const match = document.createElement('span');
      match.className = 'chunks';
      match.style.color = 'var(--accent)';
      match.style.backgroundColor = 'var(--accent-dim)';
      match.textContent = t('capsule.related_match', { percent: Math.round((p.score || 0) * 100) });

      row.appendChild(title);
      row.appendChild(match);

      const snippet = document.createElement('div');
      snippet.className = 'snippet';
      snippet.style.fontSize = '11.5px';
      snippet.style.marginTop = '4px';
      snippet.textContent = (p.snippet || '').slice(0, 90) + '...';

      item.appendChild(row);
      item.appendChild(snippet);

      item.addEventListener('click', () => {
        if (p.url) chrome.tabs.create({ url: p.url });
      });

      listEl.appendChild(item);
    });

    container.style.display = 'block';
  } catch (e) {
    container.style.display = 'none';
  }
}

/**
 * Report how much is actually stored.
 *
 * This is what makes "nothing is being recorded" distinguishable from "nothing
 * has been recorded yet". The panel previously rendered an identical empty state
 * in both cases, so a capsule that silently captured nothing was
 * indistinguishable from a capsule that was merely new — which is exactly why
 * the reported symptom was "how do I even put anything in here?".
 */
async function refreshCapsuleStats() {
  const statsEl = document.getElementById('capsuleStats');
  const emptyEl = document.getElementById('capsuleEmpty');
  try {
    const stats = await sendToSW({ type: MSG_TYPES.CAPSULE_STATS });
    const count = stats?.count || 0;
    statsEl.dataset.error = stats?.error || '';
    if (stats?.error) console.error('OmniSense capsule stats failed:', stats.error);
    statsEl.textContent = '';
    if (count > 0) {
      // Chunks AND pages. "8 段记忆" over a list of two identical articles was
      // exactly the number that made a user ask how to see what they had saved —
      // the chunk count is an implementation detail, the page count is the answer.
      statsEl.appendChild(document.createTextNode(
        t('capsule.stats', { n: count, pages: stats?.pages || 0 })));
      if (stats.lastVisitTime) {
        const last = document.createElement('span');
        last.className = 'capsule-last';
        last.textContent = t('capsule.stats_last', { when: formatTimeAgo(stats.lastVisitTime) });
        statsEl.appendChild(last);
      }
      // Hide the "nothing here" state, but do NOT unilaterally render a list from
      // in here. This function is called right after a capture, and the capture
      // handler immediately re-runs whatever search is on screen — two renders of
      // the same element racing each other. Listing is the CALLER's decision (see
      // initCapsule / doCapsuleCapture) and every render carries an epoch.
      emptyEl.style.display = 'none';
    } else if (stats?.error) {
      // Storage is broken, which is NOT the same as "you have not saved anything
      // yet" — say so instead of showing the friendly empty state over a fault.
      statsEl.textContent = t('global.error_retry');
      emptyEl.style.display = '';
    } else {
      // Separate "auto-record is off" from "on, but nothing stored yet". The
      // former is the common case and has a one-click answer right above.
      const autoOn = await getSetting(SettingKeys.autoRecord, false);
      statsEl.textContent = autoOn ? t('capsule.stats_empty') : t('capsule.auto_off_hint');
      emptyEl.style.display = '';
    }
    return count;
  } catch (e) {
    statsEl.dataset.error = `send failed: ${e.message}`;
    statsEl.textContent = t('global.error_retry');
    return 0;
  }
}

/**
 * Explicit "收录本页" — the answer to "how do I add anything to this?".
 *
 * Deliberately independent of the autoRecord setting: an explicit click is its
 * own consent, so this also works for someone who never opted into automatic
 * capture (which is now the default).
 */
async function doCapsuleCapture() {
  const btn = document.getElementById('capsuleCaptureBtn');
  const note = document.getElementById('capsuleCaptureNote');
  if (btn.disabled) return;
  // Re-query instead of trusting the id captured at init(): the panel outlives
  // navigations and tab switches, and a stale id captured the WRONG PAGE.
  if (!(await requireTab())) return;
  btn.disabled = true;
  btn.textContent = t('capsule.capturing');
  note.style.display = '';
  note.textContent = t('capsule.capture_pending');
  try {
    const r = await sendToSW({ type: MSG_TYPES.CAPTURE_TAB, tabId: currentTabId });
    const text = r?.ok ? t('capsule.capture_ok', { n: r.chunks || 0 }) : captureFailureText(r?.reason);
    note.textContent = text;
    showToast(text);
    if (r?.ok) {
      await refreshCapsuleStats();
      // If a search is already on screen, re-run it so the page the user just
      // saved can actually appear in the results they are looking at. If nothing
      // is on screen, show the list — saving a page and being shown nothing is
      // how "I saved this article, where is it?" happens.
      const q = document.getElementById('capsuleInput').value.trim();
      if (q) doCapsuleSearch(q);
      else doCapsuleBrowse();
    }
  } catch (e) {
    note.textContent = t('capsule.capture_failed');
    showToast(note.textContent);
  } finally {
    btn.disabled = false;
    // Restore from the key rather than a captured string, so a language switch
    // while the capture was in flight cannot leave a stale label behind.
    btn.textContent = t('capsule.capture');
  }
}

/** Map the service worker's machine-readable failure reason to user-facing copy. */
function captureFailureText(reason) {
  switch (reason) {
    case 'too_short': return t('capsule.capture_too_short');
    case 'unsupported': return t('capsule.capture_unsupported');
    case 'no_tab': return t('capsule.capture_no_tab');
    default: return t('capsule.capture_failed');
  }
}

/** Shared "reading local memory…" placeholder. Returns the render epoch. */
function beginCapsuleRender() {
  const epoch = ++capsuleEpoch;
  const resultsEl = document.getElementById('capsuleResults');
  document.getElementById('capsuleEmpty').style.display = 'none';
  document.getElementById('capsuleBrowseNote').style.display = 'none';
  resultsEl.innerHTML = `<div class="empty-state">${t('capsule.loading')}</div>`;
  return epoch;
}

/**
 * Render one row per ARTICLE — the single renderer for both capsule routes.
 *
 * Rows in the store are chunks, not pages, so a long article arrives as several
 * near-identical entries; the service worker folds them with `groupByPage` and
 * strips the 384-float vectors before replying, so `pages` is already one entry
 * per saved page. `chunks` is surfaced as a badge because the stats bar above
 * counts chunks ("N 段"), and a user comparing the two numbers should be able to
 * see where they come from.
 */
function renderCapsulePages(res, mode) {
  const resultsEl = document.getElementById('capsuleResults');
  const noteEl = document.getElementById('capsuleBrowseNote');
  const pages = (res && res.pages) || [];
  const total = (res && res.total) || pages.length;

  resultsEl.innerHTML = '';
  if (mode === 'recent' && pages.length) {
    noteEl.style.display = '';
    noteEl.textContent = t('capsule.recent_note', { n: total });
  } else {
    noteEl.style.display = 'none';
    noteEl.textContent = '';
  }

  if (!pages.length) {
    // An empty capsule shows the stats block's empty state (the one with the retry
    // button) and leaves the results area clean, rather than stacking a second
    // "nothing here" message under it.
    if (mode === 'recent' && !(res && res.error)) {
      resultsEl.innerHTML = '';
      document.getElementById('capsuleEmpty').style.display = '';
      return;
    }
    // Both branches call t() with a LITERAL key rather than a variable holding
    // one: e2e/check-i18n.cjs discovers used keys by pattern-matching the source,
    // so `t(someVar)` makes a key that is very much in use look unused.
    const text = res && res.error ? t('global.error_retry') : t('capsule.no_result');
    resultsEl.innerHTML = `<div class="empty-state">${text}</div>`;
    return;
  }

  if (mode === 'search') {
    const head = document.createElement('div');
    head.className = 'list-head';
    head.textContent = t('capsule.results_head', { n: pages.length });
    resultsEl.appendChild(head);
  }

  for (const p of pages) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="title">${escapeHtml(p.title || p.domain || 'Untitled')}</div>
      <div class="meta">${escapeHtml(p.domain || '')} · ${formatTimeAgo(p.visitTime)}<span class="chunks">${escapeHtml(t('capsule.chunk_badge', { n: p.chunks }))}</span></div>
      <div class="row-actions" style="margin-top:8px;">
        <button data-url="${escapeHtml(p.url)}">${t('capsule.open')}</button>
        <button class="danger" data-del="1">${t('capsule.delete')}</button>
      </div>
    `;
    div.querySelector('[data-url]').addEventListener('click', () => chrome.tabs.create({ url: p.url }));
    // The url is captured in the closure rather than written into an attribute:
    // it is the page's identity, and round-tripping it through HTML escaping is
    // one more place it can be mangled.
    div.querySelector('[data-del]').addEventListener('click', () => doCapsuleDelete(p));
    resultsEl.appendChild(div);
  }
}

/**
 * Delete one saved page.
 *
 * Confirmed first, because there is no undo and the row carries no other hint that
 * it is about to disappear. The service worker removes every chunk of that URL in
 * one indexed transaction, so a page that was stored as six chunks goes entirely
 * rather than leaving orphans behind.
 */
async function doCapsuleDelete(page) {
  if (!page || !page.url) return;
  const label = (page.title || page.domain || page.url).slice(0, 60);
  if (!window.confirm(t('capsule.confirm_delete', { title: label }))) return;
  try {
    const r = await sendToSW({ type: MSG_TYPES.CAPSULE_DELETE, url: page.url });
    if (!r || !r.ok) { showToast(t('global.error_retry')); return; }
    showToast(t('capsule.deleted', { n: r.removed || 0 }));
    await refreshCapsuleStats();
    // Re-render whatever was on screen, so the row actually goes away and — when a
    // query is present — the remaining results reorder to match.
    const q = document.getElementById('capsuleInput').value.trim();
    if (q) doCapsuleSearch(q);
    else doCapsuleBrowse();
  } catch (e) {
    showToast(t('global.error_retry'));
  }
}

/**
 * List everything stored, newest first.
 *
 * Answered by the service worker straight out of IndexedDB, so unlike a search
 * this needs no embedding model: it works on a fresh profile, works offline, and
 * works on a machine where the embedder cannot load — which is exactly when
 * someone most wants to confirm their pages were saved at all.
 */
async function doCapsuleBrowse() {
  const epoch = beginCapsuleRender();
  try {
    const res = await sendToSW({ type: MSG_TYPES.CAPSULE_RECENT });
    if (epoch !== capsuleEpoch) return;      // a newer request already took over
    renderCapsulePages(res, 'recent');
  } catch (e) {
    if (epoch !== capsuleEpoch) return;
    document.getElementById('capsuleResults').innerHTML =
      `<div class="empty-state">${t('global.error_retry')}</div>`;
  }
}

async function doCapsuleSearch(query) {
  const epoch = beginCapsuleRender();
  try {
    const res = await sendToSW({ type: MSG_TYPES.CAPSULE_QUERY, query });
    if (epoch !== capsuleEpoch) return;
    renderCapsulePages(res, 'search');
  } catch (e) {
    if (epoch !== capsuleEpoch) return;
    document.getElementById('capsuleResults').innerHTML =
      `<div class="empty-state">${t('global.error_retry')}</div>`;
  }
}

// ---------------- Tone ----------------
function initTone() {
  const container = document.getElementById('toneStyles');
  TONE_STYLES.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = t(s.labelKey);
    btn.dataset.key = s.key;
    btn.addEventListener('click', () => btn.classList.toggle('active'));
    container.appendChild(btn);
  });

  document.getElementById('toneBtn').addEventListener('click', () => {
    const text = document.getElementById('toneInput').value.trim();
    if (!text) return showToast(t('tone.empty'));
    const active = Array.from(container.querySelectorAll('.chip.active')).map(b => ({ key: b.dataset.key, label: b.textContent }));
    inferStream('tone', { text, styles: active.length ? active : [{ key: 'plain', label: t('tone.style.plain') }] }, 'toneOutput', 'toneActions');
  });

  document.getElementById('toneCopy').addEventListener('click', () => copyCurrentStream());
  document.getElementById('toneAgain').addEventListener('click', () => document.getElementById('toneBtn').click());
  document.getElementById('toneInsert').addEventListener('click', async () => {
    const text = window._currentStream?.text;
    if (!text) return showToast(t('tone.empty'));
    if (!(await requireTab())) return;
    try {
      await sendToSW({ type: MSG_TYPES.INSERT_TEXT, tabId: currentTabId, text });
      showToast(t('global.copied'));
    } catch (e) {
      showToast(t('global.error_retry'));
    }
  });
}

// ---------------- Roast ----------------
function initRoast() {
  document.getElementById('roastBtn').addEventListener('click', () => {
    const text = document.getElementById('roastInput').value.trim();
    if (!text) return showToast(t('roast.empty'));
    inferStream('roast', { text }, 'roastOutput', 'roastActions');
  });
  document.getElementById('roastCopy').addEventListener('click', () => copyCurrentStream());
  document.getElementById('roastAgain').addEventListener('click', () => document.getElementById('roastBtn').click());
}

// ---------------- Privacy, Radar & Agreement ----------------
let lastAgreementText = '';

function initPrivacy() {
  initPrivacyTabs();
  initPatternRadar();
  initAgreementScanner();
  initTrackersScan();
}

function initPrivacyTabs() {
  const tabs = document.querySelectorAll('#privacySubTabs button');
  const panels = {
    radar: document.getElementById('subpanelRadar'),
    agreement: document.getElementById('subpanelAgreement'),
    trackers: document.getElementById('subpanelTrackers')
  };

  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.subtab;
      Object.entries(panels).forEach(([k, el]) => {
        if (el) el.style.display = (k === target ? 'block' : 'none');
      });
    });
  });
}

function initPatternRadar() {
  const scanBtn = document.getElementById('radarScanBtn');
  const reportEl = document.getElementById('radarReport');
  const countdownStatus = document.getElementById('radarCountdownStatus');
  const countdownList = document.getElementById('radarCountdownList');
  const badgeToggleLabel = document.getElementById('radarBadgeToggleLabel');
  const badgeToggle = document.getElementById('radarBadgeToggle');
  const overlayStatus = document.getElementById('radarOverlayStatus');
  const crushBtn = document.getElementById('radarCrushBtn');
  const crushFeedback = document.getElementById('radarCrushFeedback');
  const checkboxStatus = document.getElementById('radarCheckboxStatus');
  const checkboxList = document.getElementById('radarCheckboxList');

  if (!scanBtn) return;

  scanBtn.addEventListener('click', async () => {
    if (!(await requireTab())) return;
    scanBtn.disabled = true;
    scanBtn.textContent = t('radar.scanning');
    reportEl.style.display = 'none';
    crushFeedback.style.display = 'none';

    try {
      const res = await sendToSW({ type: MSG_TYPES.SCAN_PATTERNS, tabId: currentTabId });
      scanBtn.disabled = false;
      scanBtn.textContent = t('radar.scan_btn');
      reportEl.style.display = 'block';

      // 1. Countdowns
      const countdowns = res?.countdowns || [];
      if (countdowns.length > 0) {
        countdownStatus.textContent = t('radar.countdown_found', { n: countdowns.length });
        countdownList.innerHTML = countdowns.map(c => `
          <div class="radar-item">
            <span class="dim-badge dim-badge-high">⏱️ ${escapeHtml(c.text)}</span>
            <span>${escapeHtml(c.fullText)}</span>
          </div>
        `).join('');
        badgeToggleLabel.style.display = 'inline-flex';
        badgeToggle.checked = true;
        sendToSW({ type: MSG_TYPES.TOGGLE_COUNTDOWN_BADGES, tabId: currentTabId, show: true }).catch(() => {});
      } else {
        countdownStatus.textContent = t('radar.countdown_none');
        countdownList.innerHTML = '';
        badgeToggleLabel.style.display = 'none';
      }

      // 2. Overlays
      const overlays = res?.overlays || [];
      const scrollLocked = !!res?.scrollLocked;
      if (overlays.length > 0 || scrollLocked) {
        overlayStatus.textContent = t('radar.overlay_found', { n: Math.max(1, overlays.length) });
        crushBtn.style.display = 'inline-block';
      } else {
        overlayStatus.textContent = t('radar.overlay_none');
        crushBtn.style.display = 'none';
      }

      // 3. Pre-checked checkboxes
      const checkboxes = res?.checkboxes || [];
      if (checkboxes.length > 0) {
        checkboxStatus.textContent = t('radar.checkbox_found', { n: checkboxes.length });
        checkboxList.innerHTML = checkboxes.map(cb => `
          <div class="radar-item">
            <span class="dim-badge ${cb.isPromo ? 'dim-badge-high' : 'dim-badge-medium'}">☑️</span>
            <span>${escapeHtml(cb.text)}</span>
          </div>
        `).join('');
      } else {
        checkboxStatus.textContent = t('radar.checkbox_none');
        checkboxList.innerHTML = '';
      }
    } catch (e) {
      scanBtn.disabled = false;
      scanBtn.textContent = t('radar.scan_btn');
      showToast(t('global.error_retry'));
    }
  });

  badgeToggle.addEventListener('change', async (e) => {
    if (!currentTabId) return;
    await sendToSW({ type: MSG_TYPES.TOGGLE_COUNTDOWN_BADGES, tabId: currentTabId, show: e.target.checked }).catch(() => {});
  });

  crushBtn.addEventListener('click', async () => {
    if (!currentTabId) return;
    crushBtn.disabled = true;
    try {
      const res = await sendToSW({ type: MSG_TYPES.CRUSH_OVERLAYS, tabId: currentTabId });
      crushBtn.disabled = false;
      crushFeedback.style.display = 'block';
      crushFeedback.textContent = t('radar.crush_done', { count: res?.crushedCount || 1 });
      overlayStatus.textContent = t('radar.overlay_none');
      crushBtn.style.display = 'none';
    } catch (e) {
      crushBtn.disabled = false;
      showToast(t('global.error_retry'));
    }
  });
}

function initAgreementScanner() {
  const scanCurrentBtn = document.getElementById('agreementScanCurrentBtn');
  const toggleCustomBtn = document.getElementById('agreementToggleCustomBtn');
  const customBox = document.getElementById('agreementCustomBox');
  const customInput = document.getElementById('agreementCustomInput');
  const scanCustomBtn = document.getElementById('agreementScanCustomBtn');
  const statusEl = document.getElementById('agreementStatus');
  const reportEl = document.getElementById('agreementReport');
  const riskBadge = document.getElementById('agreementRiskBadge');
  const findingsList = document.getElementById('agreementFindingsList');
  const aiTriggerBtn = document.getElementById('agreementAiTriggerBtn');

  if (!scanCurrentBtn) return;

  toggleCustomBtn.addEventListener('click', () => {
    const isHidden = customBox.style.display === 'none';
    customBox.style.display = isHidden ? 'block' : 'none';
  });

  const renderAgreementReport = (result, text) => {
    lastAgreementText = text;
    statusEl.style.display = 'none';
    reportEl.style.display = 'block';

    const risk = result?.overallRisk || 'clean';
    const riskLabel = t(`privacy.risk_${risk === 'clean' ? 'low' : risk}`);
    riskBadge.className = `risk-badge risk-${risk === 'clean' ? 'low' : risk}`;
    riskBadge.textContent = t('agreement.risk_score', { level: riskLabel });

    const findings = result?.findings || [];
    if (!findings.length) {
      findingsList.innerHTML = `<div class="radar-item" style="color:var(--accent); font-weight:600;">${t('agreement.risk_clean')}</div>`;
    } else {
      findingsList.innerHTML = findings.map(f => {
        const dimLabel = t(`agreement.dim_${f.dimension}`);
        const badgeClass = f.score >= 3 ? 'dim-badge-high' : 'dim-badge-medium';
        const excerptsHtml = f.excerpts.map(ex => `
          <div class="radar-quote-box">“${escapeHtml(ex.sentence)}”</div>
        `).join('');
        return `
          <div class="radar-item">
            <div style="font-weight:700; margin-bottom:4px;">
              <span class="dim-badge ${badgeClass}">${dimLabel}</span>
            </div>
            ${excerptsHtml}
          </div>
        `;
      }).join('');
    }
  };

  scanCurrentBtn.addEventListener('click', async () => {
    if (!(await requireTab())) return;
    scanCurrentBtn.disabled = true;
    statusEl.style.display = 'block';
    statusEl.textContent = t('agreement.analyzing');
    reportEl.style.display = 'none';

    try {
      const art = currentArticle || await articleForActiveTab().catch(() => null);
      const text = art?.text || '';
      if (!text || text.length < 50) {
        statusEl.textContent = t('agreement.no_article');
        scanCurrentBtn.disabled = false;
        return;
      }
      const res = await sendToSW({ type: MSG_TYPES.SCAN_AGREEMENT, tabId: currentTabId, text });
      scanCurrentBtn.disabled = false;
      renderAgreementReport(res, text);
    } catch (e) {
      scanCurrentBtn.disabled = false;
      statusEl.textContent = t('global.error_retry');
    }
  });

  scanCustomBtn.addEventListener('click', async () => {
    const text = customInput.value.trim();
    if (!text || text.length < 20) {
      showToast(t('agreement.placeholder'));
      return;
    }
    scanCustomBtn.disabled = true;
    statusEl.style.display = 'block';
    statusEl.textContent = t('agreement.analyzing');
    reportEl.style.display = 'none';

    try {
      const res = await sendToSW({ type: MSG_TYPES.SCAN_AGREEMENT, text });
      scanCustomBtn.disabled = false;
      renderAgreementReport(res, text);
    } catch (e) {
      scanCustomBtn.disabled = false;
      statusEl.textContent = t('global.error_retry');
    }
  });

  aiTriggerBtn.addEventListener('click', () => {
    if (!lastAgreementText) return;
    const outputEl = document.getElementById('agreementAiOutput');
    outputEl.style.display = 'block';
    aiTriggerBtn.disabled = true;
    inferStream(
      'agreement',
      { article: lastAgreementText },
      'agreementAiOutput',
      null,
      () => { aiTriggerBtn.disabled = false; },
      'agreementStatus'
    );
  });
}

function initTrackersScan() {
  document.getElementById('privacyBtn').addEventListener('click', async () => {
    if (!(await requireTab())) return;
    const reportEl = document.getElementById('privacyReport');
    reportEl.innerHTML = `<div class="empty-state">${t('global.thinking')}</div>`;
    try {
      const r = await sendToSW({ type: MSG_TYPES.SCAN_PRIVACY, tabId: currentTabId });
      renderPrivacyReport(r);
    } catch (e) {
      reportEl.innerHTML = `<div class="empty-state">${t('global.error_retry')}</div>`;
    }
  });
}

function renderPrivacyReport(r) {
  const el = document.getElementById('privacyReport');
  const levelLabel = t(`privacy.risk_${r.risk}`);
  const levelDesc = t(`privacy.risk_${r.risk}_desc`);
  const riskHtml = `<div class="risk-badge risk-${r.risk}">${t('privacy.risk', { level: levelLabel })}</div><p class="desc">${levelDesc}</p>`;

  const section = (title, count, details, note) => `
    <details class="privacy-section">
      <summary>${title} · ${count > 0 ? t('privacy.count', { n: count }) : t('privacy.none')}</summary>
      ${note ? `<p class="desc">${note}</p>` : ''}
      ${details.length ? `<ul>${details.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : ''}
    </details>
  `;

  el.innerHTML = riskHtml +
    section(t('privacy.trackers'), r.trackers?.length || 0, r.trackers || []) +
    section(t('privacy.hidden_fields'), r.hiddenFields || 0, r.hiddenFieldNames || []) +
    section(t('privacy.cookies'), r.cookieSetters?.length || 0, r.cookieSetters || []) +
    section(t('privacy.external'), r.externalDomains?.length || 0, r.externalDomains || [],
      t('privacy.external_detail', { total: r.externalDomains?.length || 0, known: r.knownAdDomains || 0 })) +
    `<p class="desc" style="margin-top:10px;">${t('privacy.disclaimer')}</p>`;
}

// ---------------- Adblock ----------------
function initAdblock() {
  refreshAdblock();
  document.getElementById('adblockToggle').addEventListener('change', async (e) => {
    await setSetting(SettingKeys.adblockEnabled, e.target.checked);
    postToSW({ type: MSG_TYPES.TOGGLE_ADBLOCK, enabled: e.target.checked });
    showToast(e.target.checked ? t('adblock.on') : t('adblock.off'));
  });
  document.getElementById('allowlistBtn').addEventListener('click', async () => {
    if (!(await requireTab())) return;
    try {
      const tab = await chrome.tabs.get(currentTabId);
      if (!tab?.url) { showToast(t('global.no_active_tab')); return; }
      const domain = new URL(tab.url).hostname;
      await sendToSW({ type: MSG_TYPES.ALLOWLIST_PAGE, domain });
      showToast(t('adblock.allowlisted'));
    } catch (e) {
      showToast(t('global.error_retry'));
    }
  });
}

async function refreshAdblock() {
  try {
    const stats = await sendToSW({ type: MSG_TYPES.GET_ADBLOCK_STATS });
    const requests = stats?.requests || 0;
    const elements = stats?.elements || 0;
    document.getElementById('adblockStats').textContent = `${requests} · ${elements}`;
    // Fill the sentence with real numbers. It used to be a static data-i18n
    // string whose dictionary value contains {{requests}}/{{elements}}, so the
    // UI rendered the literal braces.
    const label = document.querySelector('[data-i18n="adblock.stats"]');
    if (label) label.textContent = t('adblock.stats', { requests, elements });
  } catch (e) {}
}

// ---------------- Writing ----------------
function initWriting() {
  fillSelect('writingLength', WRITING_LENGTHS, 'medium');
  fillSelect('writingTone', WRITING_TONES, 'neutral');
  fillSelect('writingLang', WRITING_LANGS, 'zh');

  document.querySelectorAll('#writingModes .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#writingModes .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.wmode;
      document.getElementById('writingBlank').style.display = mode === 'blank' ? 'block' : 'none';
      document.getElementById('writingRef').style.display = mode === 'ref' ? 'block' : 'none';
      if (mode === 'ref') loadCurrentArticle();
    });
  });

  document.getElementById('writingBtn').addEventListener('click', async () => {
    const mode = document.querySelector('#writingModes .chip.active').dataset.wmode;
    if (mode === 'blank') {
      const topic = document.getElementById('writingTopic').value.trim();
      if (!topic) return showToast(t('writing.empty'));
      inferStream('writing_blank', {
        topic,
        length: document.getElementById('writingLength').value,
        tone: document.getElementById('writingTone').value,
        lang: document.getElementById('writingLang').value
      }, 'writingOutput', 'writingActions', () => document.getElementById('writingAttribution').style.display = 'block');
    } else {
      if (!currentArticle?.isArticle) return showToast(t('reader.no_article'));
      const instruction = document.getElementById('writingInstruction').value.trim();
      if (!instruction) return showToast(t('writing.empty'));
      // `writingRefStatus` is the notice line as well as the read status, so a
      // long article announces that it was condensed to notes before writing.
      inferStream('writing_ref', {
        article: currentArticle.text,
        instruction,
        lang: document.getElementById('writingLang').value
      }, 'writingOutput', 'writingActions',
      () => document.getElementById('writingAttribution').style.display = 'block', 'writingRefStatus');
    }
  });

  document.getElementById('writingCopy').addEventListener('click', () => copyCurrentStream());
  document.getElementById('writingExport').addEventListener('click', () => {
    const text = window._currentStream?.text || '';
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'omnisense-writing.md'; a.click();
    URL.revokeObjectURL(url);
  });
  document.getElementById('writingContinue').addEventListener('click', () => {
    const text = window._currentStream?.text || '';
    // This is a prompt for the local model, not UI copy, so it is intentionally
    // not routed through the i18n dictionary (hence the marker below).
    const lang = document.getElementById('writingLang').value || 'zh';
    const instruction = lang === 'en' ? 'Continue writing from here.' : '继续写下去'; // i18n-allow-cjk
    // Same completion callback as the two main paths: the continuation is still
    // model output, so it must carry the "generated locally" attribution. It was
    // missing here, so the line vanished after pressing 接着写.
    //
    // `continuation: true` matters for the budget: a draft that no longer fits
    // the context window has to keep its ENDING (that is where the pen is), not
    // its opening, so the host switches from head-truncation to tail-truncation.
    inferStream('writing_ref', { article: text, instruction, lang, continuation: true }, 'writingOutput', 'writingActions',
      () => document.getElementById('writingAttribution').style.display = 'block', 'writingRefStatus');
  });
}

async function loadCurrentArticle({ force = false } = {}) {
  const statusEl = document.getElementById('writingRefStatus');
  statusEl.textContent = t('reader.reading');
  try {
    const art = await articleForActiveTab({ force });
    if (!art || art.reason === 'no_tab') { statusEl.textContent = t('global.no_active_tab'); return null; }
    if (art.isArticle) {
      const words = Math.round(art.text.length / 2);
      statusEl.textContent = t('writing.ref_read', { title: art.title, words });
    } else {
      statusEl.textContent = t('reader.no_article');
    }
    return art;
  } catch (e) {
    statusEl.textContent = t('global.error_retry');
    return null;
  }
}

// ---------------- Ask This Page ----------------
function initAsk() {
  loadCurrentArticleForAsk();
  const input = document.getElementById('askInput');
  const btn = document.getElementById('askBtn');
  const presets = document.getElementById('askPresets');

  if (presets) {
    presets.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        input.value = chip.dataset.q || '';
        btn.click();
      });
    });
  }

  btn?.addEventListener('click', async () => {
    const q = input.value.trim();
    if (!q) return showToast(t('ask.empty_q'));
    const statusEl = document.getElementById('askStatus');
    const art = currentArticle || await articleForActiveTab().catch(() => null);
    if (!art?.isArticle || !art.text) {
      statusEl.textContent = t('reader.no_article');
      return showToast(t('reader.no_article'));
    }
    const lang = (await getSetting(SettingKeys.locale, 'zh')) === 'en' ? 'en' : 'zh';
    inferStream('ask', {
      article: art.text,
      question: q,
      lang
    }, 'askOutput', 'askActions', null, 'askStatus');
  });

  document.getElementById('askCopy')?.addEventListener('click', copyCurrentStream);
  document.getElementById('askClear')?.addEventListener('click', () => {
    document.getElementById('askOutput').style.display = 'none';
    document.getElementById('askActions').style.display = 'none';
    input.value = '';
  });
}

async function loadCurrentArticleForAsk() {
  const statusEl = document.getElementById('askStatus');
  if (!statusEl) return;
  try {
    const art = await articleForActiveTab();
    if (!art || art.reason === 'no_tab') { statusEl.textContent = t('global.no_active_tab'); return; }
    if (art.isArticle) statusEl.textContent = t('ask.status', { title: art.title });
    else statusEl.textContent = t('reader.no_article');
  } catch (e) {
    statusEl.textContent = t('global.error_retry');
  }
}

// ---------------- Smart Tab Grouping ----------------
function initTabGroup() {
  refreshTabGroupList();
  document.getElementById('tabGroupRefresh')?.addEventListener('click', refreshTabGroupList);

  document.getElementById('tabGroupClusterBtn')?.addEventListener('click', async () => {
    showToast(t('global.thinking'));
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      const res = await sendToSW({ type: MSG_TYPES.CLUSTER_TABS, windowId: activeTab?.windowId });
      if (res?.ok) {
        showToast(t('toast.tab_grouped', { count: res.count, groups: res.groups }));
        refreshTabGroupList();
      } else if (res?.reason === 'too_few') {
        showToast(t('toast.tab_too_few'));
      } else if (res?.reason === 'no_clusters') {
        showToast(t('toast.tab_no_clusters'));
      } else {
        showToast(t('global.error_retry'));
      }
    } catch (e) {
      showToast(t('global.error_retry'));
    }
  });

  document.getElementById('tabGroupDedupeBtn')?.addEventListener('click', async () => {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      const res = await sendToSW({ type: MSG_TYPES.DEDUPE_TABS, windowId: activeTab?.windowId });
      if (res?.ok && res.removed > 0) {
        showToast(t('toast.tab_deduped', { count: res.removed }));
        refreshTabGroupList();
      } else {
        showToast(t('toast.tab_no_dupes'));
      }
    } catch (e) {
      showToast(t('global.error_retry'));
    }
  });
}

async function refreshTabGroupList() {
  const statsEl = document.getElementById('tabGroupStats');
  const listEl = document.getElementById('tabGroupList');
  if (!statsEl || !listEl) return;

  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const eligible = tabs.filter(t => !t.pinned && t.url && !t.url.startsWith('chrome-extension://'));
    const grouped = eligible.filter(t => t.groupId !== -1 && t.groupId !== undefined);

    statsEl.textContent = t('tabgroup.stats', { total: eligible.length, grouped: grouped.length });
    listEl.innerHTML = '';

    for (const t of eligible.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = 'item';
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.padding = '8px 10px';
      row.style.marginBottom = '6px';
      row.style.cursor = 'pointer';

      if (t.favIconUrl) {
        const icon = document.createElement('img');
        icon.src = t.favIconUrl;
        icon.style.width = '14px';
        icon.style.height = '14px';
        icon.style.borderRadius = '3px';
        icon.style.flex = 'none';
        icon.onerror = () => { icon.style.display = 'none'; };
        row.appendChild(icon);
      }

      const title = document.createElement('span');
      title.className = 'title';
      title.style.fontSize = '12px';
      title.style.flex = '1';
      title.style.whiteSpace = 'nowrap';
      title.style.overflow = 'hidden';
      title.style.textOverflow = 'ellipsis';
      title.textContent = t.title || t.url;
      row.appendChild(title);

      if (t.groupId !== -1 && t.groupId !== undefined) {
        const badge = document.createElement('span');
        badge.className = 'chunks';
        badge.style.fontSize = '10px';
        badge.textContent = `#${t.groupId}`;
        row.appendChild(badge);
      }

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.padding = '2px 6px';
      closeBtn.style.fontSize = '10px';
      closeBtn.style.background = 'transparent';
      closeBtn.style.border = 'none';
      closeBtn.style.color = 'var(--text-3)';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.remove(t.id).then(() => refreshTabGroupList()).catch(() => {});
      });
      row.appendChild(closeBtn);

      row.addEventListener('click', () => {
        chrome.tabs.update(t.id, { active: true });
      });

      listEl.appendChild(row);
    }
  } catch (e) {
    statsEl.textContent = t('global.error_retry');
  }
}

// ---------------- Summary ----------------
function initSummary() {
  // Rest on a truthful idle line. The status used to sit on
  // "正在读取本页正文…" from page load — claiming to read a page it had never
  // started reading, which reads exactly like a feature that is stuck.
  document.getElementById('summaryStatus').textContent = t('summary.idle');

  // Wire Zen Reader button
  const summaryZenBtn = document.getElementById('summaryZenBtn');
  if (summaryZenBtn) {
    summaryZenBtn.addEventListener('click', async () => {
      try {
        await sendToSW({ type: MSG_TYPES.OPEN_ZEN_READER });
      } catch (e) {
        showToast(t('global.error_retry'));
      }
    });
  }

  // Summary mode tabs: Summary vs Bias Advocate
  const summaryModeTabs = document.getElementById('summaryModeTabs');
  const summaryModeNormal = document.getElementById('summaryModeNormal');
  const summaryModeBias = document.getElementById('summaryModeBias');

  if (summaryModeTabs && summaryModeNormal && summaryModeBias) {
    summaryModeTabs.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        summaryModeTabs.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        if (mode === 'bias') {
          summaryModeNormal.style.display = 'none';
          summaryModeBias.style.display = 'block';
        } else {
          summaryModeBias.style.display = 'none';
          summaryModeNormal.style.display = 'block';
        }
      });
    });
  }

  const levels = document.getElementById('summaryLevels');
  SUMMARY_LEVELS.forEach((lvl, idx) => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (idx === 0 ? ' active' : '');
    btn.textContent = t(lvl.labelKey);
    btn.dataset.key = lvl.key;
    btn.addEventListener('click', () => {
      levels.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    levels.appendChild(btn);
  });

  document.getElementById('summaryBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('summaryStatus');
    statusEl.textContent = t('reader.reading');
    try {
      // Read from the tab that is active NOW. This used to read `currentTabId`,
      // captured once in init(), so after a navigation the summary described the
      // page the user had already left.
      const art = await articleForActiveTab();
      if (!art || art.reason === 'no_tab') { statusEl.textContent = t('global.no_active_tab'); return; }
      // Pages where Readability finds a "title" but no real body (home pages,
      // login walls, image galleries) used to fall through to the model and
      // produce an apology. Say so up front instead.
      if (!art.isArticle || !art.text || art.text.trim().length < MIN_SUMMARY_CHARS) {
        statusEl.textContent = t('summary.no_content');
        return;
      }
      statusEl.textContent = t('reader.read_done', { title: art.title });
      const level = levels.querySelector('.chip.active').dataset.key;
      // `summaryStatus` doubles as the long-article notice line: the host tells
      // us when it had to switch to the chunked path, and the user sees why the
      // answer is taking longer than one pass.
      inferStream('summary', { article: art.text, level }, 'summaryOutput', 'summaryActions', null, 'summaryStatus');
    } catch (e) {
      statusEl.textContent = t('global.error_retry');
    }
  });

  document.getElementById('summaryCopy').addEventListener('click', () => copyCurrentStream());
  document.getElementById('summaryListen').addEventListener('click', () => {
    const text = window._currentStream?.text;
    // The label matters: this text did NOT come from the page, so without it the
    // listen tab would keep whatever line it had — which is how it ended up
    // claiming 「没有可读的正文」 while speaking this very text.
    if (text) startTTS(text, t('listen.from_summary'));
    switchTab('listen');
  });
  document.getElementById('summaryWrite').addEventListener('click', () => {
    switchTab('writing');
    document.querySelector('[data-wmode="ref"]').click();
  });

  initBiasAdvocate();
}

function initBiasAdvocate() {
  const analyzeBtn = document.getElementById('biasAnalyzeBtn');
  const statusEl = document.getElementById('biasStatus');
  const resultContainer = document.getElementById('biasResultContainer');
  const outputEl = document.getElementById('biasOutput');
  const factBar = document.getElementById('biasFactBar');
  const emotionBar = document.getElementById('biasEmotionBar');
  const factLabel = document.getElementById('biasFactLabel');
  const emotionLabel = document.getElementById('biasEmotionLabel');
  const biasBadge = document.getElementById('biasBadge');
  const copyBtn = document.getElementById('biasCopyBtn');

  if (!analyzeBtn) return;

  function updateBiasMeter(text) {
    let factScore = 70;
    let emotionScore = 30;

    const factMatch = text.match(/(?:事实客观度|客观度|客观事实)[^\d]*(\d+)%/i); // i18n-allow-cjk
    const emotionMatch = text.match(/(?:情绪主观度|主观度|情绪主观)[^\d]*(\d+)%/i); // i18n-allow-cjk

    if (factMatch && factMatch[1]) {
      factScore = Math.max(5, Math.min(95, parseInt(factMatch[1], 10)));
      emotionScore = 100 - factScore;
    }
    if (emotionMatch && emotionMatch[1]) {
      emotionScore = Math.max(5, Math.min(95, parseInt(emotionMatch[1], 10)));
      if (!factMatch) factScore = 100 - emotionScore;
    }

    if (factBar) factBar.style.width = `${factScore}%`;
    if (emotionBar) emotionBar.style.width = `${emotionScore}%`;
    if (factLabel) factLabel.textContent = t('bias.fact_label', { percent: factScore });
    if (emotionLabel) emotionLabel.textContent = t('bias.emotion_label', { percent: emotionScore });

    if (biasBadge) {
      let ratingKey = 'bias.badge_moderate';
      if (factScore >= 75) ratingKey = 'bias.badge_objective';
      else if (factScore < 50) ratingKey = 'bias.badge_opinionated';
      biasBadge.textContent = t(ratingKey);
      biasBadge.style.color = factScore >= 70 ? 'var(--accent)' : (factScore < 50 ? '#ef4444' : '#f59e0b');
    }
  }

  analyzeBtn.addEventListener('click', async () => {
    statusEl.textContent = t('bias.analyzing');
    analyzeBtn.disabled = true;

    try {
      const art = await articleForActiveTab();
      if (!art || art.reason === 'no_tab') {
        statusEl.textContent = t('global.no_active_tab');
        analyzeBtn.disabled = false;
        return;
      }
      if (!art.isArticle || !art.text || art.text.trim().length < MIN_SUMMARY_CHARS) {
        statusEl.textContent = t('summary.no_content');
        analyzeBtn.disabled = false;
        return;
      }

      resultContainer.style.display = 'block';
      updateBiasMeter('');

      inferStream(
        'bias_advocate',
        { article: art.text },
        'biasOutput',
        'biasActions',
        (fullText, isError) => {
          analyzeBtn.disabled = false;
          if (!isError) {
            statusEl.textContent = t('reader.read_done', { title: art.title });
            updateBiasMeter(fullText || '');
          } else {
            statusEl.textContent = t('global.error_retry');
          }
        },
        'biasStatus',
        (chunkText) => {
          updateBiasMeter(chunkText || '');
        }
      );
    } catch (e) {
      analyzeBtn.disabled = false;
      statusEl.textContent = t('global.error_retry');
    }
  });

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const text = outputEl ? outputEl.textContent : '';
      if (text) {
        navigator.clipboard.writeText(text).then(() => showToast(t('global.copied')));
      }
    });
  }
}

// ---------------- Listen / TTS ----------------

/* The two decisions — how to cut the text, and which voice may read it — live in
 * `shared/speech.js` and are imported at the top of this file.
 *
 * They used to be re-implemented here, next to the panel's DOM code. That is the
 * arrangement `TEST_REPORT.md` §5.8 warns about: a harness then has to choose
 * between duplicating the logic (and drifting from it) or not testing it at all.
 * Keeping them pure means `e2e/selftest-speech.cjs` and `e2e/diag-tts-smooth.cjs`
 * exercise the exact code the panel runs.
 *
 * What stays here is only what genuinely needs a document: waiting for the
 * asynchronous voice list, and the queue that feeds the engine.
 */

/** How long to wait for the asynchronous voice list before giving up on it. */
const VOICES_READY_TIMEOUT_MS = 2000;

/**
 * `speechSynthesis.getVoices()` is populated ASYNCHRONOUSLY.
 *
 * Measured (`e2e/diag-listen.cjs` §A): at document start it returns **0** voices;
 * `voiceschanged` then fires twice, growing the list 19 → 199. The shipped code
 * read it synchronously inside a click handler, so it was deciding from a list
 * that could still be empty — and when the lookup found nothing it silently
 * attached no voice at all. This waits for the list the first time it is needed.
 */
function voicesReady() {
  const synth = window.speechSynthesis;
  const now = synth.getVoices() || [];
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(synth.getVoices() || []);
    };
    const timer = setTimeout(done, VOICES_READY_TIMEOUT_MS);
    synth.addEventListener('voiceschanged', done);
  });
}

/**
 * One read-out at a time.
 *
 * `speechSynthesis.cancel()` makes the previous utterance fail with
 * `error: 'interrupted'`, so handlers must be able to tell "the user replaced
 * me" from "speech genuinely broke" — otherwise every new press reports a
 * failure. The counter is that discriminator, and it also stops a slow async
 * voice lookup from speaking after the user already pressed 停止.
 */
let ttsSession = 0;
let ttsActive = false;
let ttsPaused = false;
let currentTTSState = null;

function initListen() {
  const statusEl = document.getElementById('listenStatus');
  if (!('speechSynthesis' in window)) {
    statusEl.textContent = t('listen.no_tts');
    return;
  }
  // Warm the voice list now: `getVoices()` is filled in asynchronously and
  // `voiceschanged` may not have fired yet, so a click arriving before that
  // would otherwise have to wait for yet another event.
  voicesReady().catch(() => {});
  loadCurrentArticleForListen();

  // Listen for speech state updates broadcasted from tab (floating ball & tab engine)
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'OMNI_TTS_STATE_UPDATE') {
        handleTabTTSStateUpdate(msg);
      }
    });
  } catch (e) {}

  // Sync state if active tab is already reading
  syncTabTTSState().catch(() => {});

  document.getElementById('ttsPlay').addEventListener('click', async () => {
    // 1. Check if tab speech synthesis is running or paused
    const tabId = await getTargetArticleTabId();
    if (tabId) {
      try {
        const tabState = await sendToTab(tabId, { type: 'OMNI_TTS_GET_STATE' });
        if (tabState && tabState.isPlaying) {
          if (tabState.isPaused) {
            await sendToTab(tabId, { type: 'OMNI_TTS_RESUME' });
            ttsPaused = false;
            ttsActive = true;
            return;
          } else {
            return; // already playing in tab
          }
        }
      } catch (e) {}
    }

    const synth = window.speechSynthesis;
    // Resuming from pause state
    if (ttsActive && ttsPaused && currentTTSState) {
      ttsPaused = false;
      const rate = parseFloat(document.getElementById('ttsRate').value) || 1;
      const startIdx = Math.max(0, currentTTSState.currentChunkIdx || 0);

      if (currentTTSState.tabDelegated && tabId) {
        try {
          await sendToTab(tabId, { type: 'OMNI_TTS_RESUME' });
          return;
        } catch (e) {}
      }

      // Clean launch from current chunk without getting stuck in Chrome audio pause deadlock
      synth.cancel();
      const session = ++ttsSession;
      currentTTSState.session = session;
      currentTTSState.endedCount = startIdx;
      queueTTSUtterances(startIdx, rate);

      notifyTabResume();
      const liveCard = document.getElementById('ttsLiveCard');
      if (liveCard) liveCard.classList.remove('paused');
      const badge = document.getElementById('ttsLiveBadge');
      if (badge) badge.textContent = t('listen.reading_now');
      const noteEl = document.getElementById('ttsNote');
      if (noteEl && currentTTSState.voice) {
        noteEl.textContent = t('listen.speaking_voice', { voice: currentTTSState.voice.name });
      }
      return;
    }
    if (synth.paused) {
      synth.resume();
      notifyTabResume();
      const liveCard = document.getElementById('ttsLiveCard');
      if (liveCard) liveCard.classList.remove('paused');
      const badge = document.getElementById('ttsLiveBadge');
      if (badge) badge.textContent = t('listen.reading_now');
      return;
    }
    if (ttsActive && !ttsPaused && synth.speaking) {
      return;
    }
    // Read from the tab that is active NOW rather than from a cached article.
    const art = await articleForActiveTab();
    if (!art?.isArticle) { showToast(t('reader.no_article')); return; }
    startTTS(art.text);
  });
  document.getElementById('ttsPause').addEventListener('click', async () => {
    const tabId = await getTargetArticleTabId();
    if (tabId) {
      try {
        await sendToTab(tabId, { type: 'OMNI_TTS_PAUSE' });
      } catch (e) {}
    }
    if (ttsActive && !ttsPaused) {
      ttsPaused = true;
      window.speechSynthesis.pause();
      notifyTabPause();
      const liveCard = document.getElementById('ttsLiveCard');
      if (liveCard) liveCard.classList.add('paused');
      const badge = document.getElementById('ttsLiveBadge');
      if (badge) badge.textContent = t('listen.reading_paused');
    }
  });
  document.getElementById('ttsStop').addEventListener('click', () => {
    stopTTS();
  });

  document.getElementById('ttsPrev')?.addEventListener('click', async () => {
    const tabId = await getTargetArticleTabId();
    if (tabId) {
      try {
        const state = await sendToTab(tabId, { type: 'OMNI_TTS_GET_STATE' });
        if (state && state.isPlaying) {
          const prevIdx = Math.max(0, (state.currentIdx || 0) - 1);
          await sendToTab(tabId, { type: 'OMNI_TTS_JUMP', index: prevIdx });
          return;
        }
      } catch (e) {}
    }
    if (ttsActive && currentTTSState && currentTTSState.chunks?.length) {
      const prevIdx = Math.max(0, (currentTTSState.currentChunkIdx || 0) - 1);
      jumpToTTSChunk(prevIdx);
    }
  });

  document.getElementById('ttsNext')?.addEventListener('click', async () => {
    const tabId = await getTargetArticleTabId();
    if (tabId) {
      try {
        const state = await sendToTab(tabId, { type: 'OMNI_TTS_GET_STATE' });
        if (state && state.isPlaying) {
          const nextIdx = Math.min(Math.max(0, (state.total || 1) - 1), (state.currentIdx || 0) + 1);
          await sendToTab(tabId, { type: 'OMNI_TTS_JUMP', index: nextIdx });
          return;
        }
      } catch (e) {}
    }
    if (ttsActive && currentTTSState && currentTTSState.chunks?.length) {
      const nextIdx = Math.min(currentTTSState.chunks.length - 1, (currentTTSState.currentChunkIdx || 0) + 1);
      jumpToTTSChunk(nextIdx);
    }
  });

  const rateSelect = document.getElementById('ttsRate');
  rateSelect.innerHTML = '';
  TTS_RATES.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r; opt.textContent = `${r}x`;
    rateSelect.appendChild(opt);
  });
  rateSelect.value = '1';

  rateSelect.addEventListener('change', async () => {
    const newRate = parseFloat(rateSelect.value) || 1;
    const tabId = await getTargetArticleTabId();
    if (tabId) {
      try {
        await sendToTab(tabId, { type: 'OMNI_TTS_SET_RATE', rate: newRate });
      } catch (e) {}
    }
    if (ttsActive && currentTTSState && !currentTTSState.tabDelegated && currentTTSState.chunks?.length) {
      const startIdx = Math.max(0, currentTTSState.currentChunkIdx || 0);
      currentTTSState.endedCount = startIdx;

      if (ttsPaused) {
        // Paused state: do NOT queue audio to native synth immediately (avoids Chromium pause deadlock).
        // Update highlight and preview card at the current chunk, staying paused.
        if (currentTTSState.chunks[startIdx]) {
          notifyTabHighlight(currentTTSState.chunks[startIdx].text, startIdx, currentTTSState.chunks.length);
          notifyTabPause();
        }
      } else {
        // Active speaking state: invalidate previous in-flight callbacks, cancel, and continue from startIdx at newRate
        const session = ++ttsSession;
        currentTTSState.session = session;
        window.speechSynthesis.cancel();
        queueTTSUtterances(startIdx, newRate);
      }
    }
  });
}

function handleTabTTSStateUpdate(msg) {
  if (!msg) return;
  const liveCard = document.getElementById('ttsLiveCard');
  const sentenceEl = document.getElementById('ttsLiveSentence');
  const badgeEl = document.getElementById('ttsLiveBadge');
  const progressEl = document.getElementById('ttsProgress');
  const noteEl = document.getElementById('ttsNote');

  if (msg.state === 'playing') {
    ttsActive = true;
    ttsPaused = false;
    if (liveCard) {
      liveCard.style.display = 'flex';
      liveCard.classList.remove('paused');
    }
    if (badgeEl) badgeEl.textContent = t('listen.reading_now');
    if (sentenceEl && msg.text) sentenceEl.textContent = msg.text;
    if (progressEl && msg.total > 0) {
      progressEl.value = Math.min(99, Math.round(((msg.currentIdx + 1) / msg.total) * 100));
    }
    if (noteEl) noteEl.textContent = t('listen.reading_now');
  } else if (msg.state === 'paused') {
    ttsActive = true;
    ttsPaused = true;
    if (liveCard) {
      liveCard.style.display = 'flex';
      liveCard.classList.add('paused');
    }
    if (badgeEl) badgeEl.textContent = t('listen.reading_paused');
    if (sentenceEl && msg.text) sentenceEl.textContent = msg.text;
    if (noteEl) noteEl.textContent = t('listen.reading_paused');
  } else if (msg.state === 'stopped') {
    ttsActive = false;
    ttsPaused = false;
    if (liveCard) liveCard.style.display = 'none';
    if (progressEl) progressEl.value = 0;
    if (noteEl) noteEl.textContent = t('listen.stopped');
  }
}

async function syncTabTTSState() {
  const tabId = await getTargetArticleTabId();
  if (!tabId) return;
  try {
    const state = await sendToTab(tabId, { type: 'OMNI_TTS_GET_STATE' });
    if (state && state.isPlaying) {
      handleTabTTSStateUpdate({
        state: state.isPaused ? 'paused' : 'playing',
        currentIdx: state.currentIdx,
        total: state.total,
        text: state.currentText
      });
      if (state.rate) {
        const rateEl = document.getElementById('ttsRate');
        if (rateEl) rateEl.value = String(state.rate);
      }
    }
  } catch (e) {}
}

function jumpToTTSChunk(idx) {
  if (!ttsActive || !currentTTSState || !currentTTSState.chunks) return;
  const rate = parseFloat(document.getElementById('ttsRate').value) || 1;
  const targetIdx = Math.max(0, Math.min(idx, currentTTSState.chunks.length - 1));
  currentTTSState.endedCount = targetIdx;
  currentTTSState.currentChunkIdx = targetIdx;

  if (ttsPaused) {
    if (currentTTSState.chunks[targetIdx]) {
      notifyTabHighlight(currentTTSState.chunks[targetIdx].text, targetIdx, currentTTSState.chunks.length);
      notifyTabPause();
    }
  } else {
    const session = ++ttsSession;
    currentTTSState.session = session;
    window.speechSynthesis.cancel();
    queueTTSUtterances(targetIdx, rate);
  }
}

async function loadCurrentArticleForListen() {
  const statusEl = document.getElementById('listenStatus');
  try {
    const art = await articleForActiveTab();
    if (!art || art.reason === 'no_tab') { statusEl.textContent = t('global.no_active_tab'); return null; }
    if (art.isArticle) statusEl.textContent = t('listen.status', { title: art.title });
    else statusEl.textContent = t('listen.no_content');
    return art;
  } catch (e) {
    statusEl.textContent = t('global.error_retry');
    return null;
  }
}

async function getTargetArticleTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) return tab.id;
  } catch (e) {}
  return articleTabId || currentTabId || null;
}

async function notifyTabHighlight(text, index = 0, total = 1) {
  const liveCard = document.getElementById('ttsLiveCard');
  const sentenceEl = document.getElementById('ttsLiveSentence');
  const badgeEl = document.getElementById('ttsLiveBadge');
  if (liveCard && sentenceEl) {
    liveCard.style.display = 'flex';
    liveCard.classList.remove('paused');
    if (badgeEl) badgeEl.textContent = t('listen.reading_now');
    sentenceEl.textContent = text;
  }

  const syncCheck = document.getElementById('ttsSyncHighlight');
  if (syncCheck && !syncCheck.checked) return;
  const tabId = await getTargetArticleTabId();
  if (!tabId) return;
  try {
    await sendToTab(tabId, { type: 'OMNI_TTS_HIGHLIGHT', text, index, total });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/read-along.js']
      });
      await sendToTab(tabId, { type: 'OMNI_TTS_HIGHLIGHT', text, index, total });
    } catch (err) {}
  }
}

async function notifyTabPause() {
  const tabId = await getTargetArticleTabId();
  if (!tabId) return;
  try {
    await sendToTab(tabId, { type: 'OMNI_TTS_PAUSE' });
  } catch (e) {}
}

async function notifyTabResume() {
  const tabId = await getTargetArticleTabId();
  if (!tabId) return;
  try {
    await sendToTab(tabId, { type: 'OMNI_TTS_RESUME' });
  } catch (e) {}
}

async function clearTabHighlight() {
  const liveCard = document.getElementById('ttsLiveCard');
  if (liveCard) liveCard.style.display = 'none';

  const tabId = await getTargetArticleTabId();
  if (!tabId) return;
  try {
    await sendToTab(tabId, { type: 'OMNI_TTS_CLEAR_HIGHLIGHT' });
  } catch (e) {}
}

function stopTTS() {
  ttsSession++;   // invalidate every in-flight callback below
  ttsActive = false;
  ttsPaused = false;
  currentTTSState = null;
  clearTabHighlight();
  window.speechSynthesis.cancel();
  document.getElementById('ttsProgress').value = 0;
  document.getElementById('ttsNote').textContent = t('listen.stopped');

  getTargetArticleTabId().then(tabId => {
    if (tabId) {
      sendToTab(tabId, { type: 'OMNI_TTS_STOP' }).catch(() => {});
    }
  }).catch(() => {});
}

function queueTTSUtterances(startIdx, rate) {
  if (!currentTTSState || currentTTSState.session !== ttsSession) return;
  const { chunks, total, voice, fallbackLang, script, session } = currentTTSState;
  const progressEl = document.getElementById('ttsProgress');
  const noteEl = document.getElementById('ttsNote');

  // Immediately notify starting chunk
  if (chunks[startIdx]) {
    notifyTabHighlight(chunks[startIdx].text, startIdx, chunks.length);
  }

  for (let i = startIdx; i < chunks.length; i++) {
    const c = chunks[i];
    const u = new SpeechSynthesisUtterance(c.text);
    try {
      if (voice) u.voice = voice;
    } catch (e) {
      ttsActive = false;
      ttsPaused = false;
      currentTTSState = null;
      noteEl.textContent = t('listen.no_voice', { lang: t(VOICE_LANG_LABEL[script].labelKey) });
      return;
    }
    u.lang = voice ? (voice.lang || fallbackLang) : fallbackLang;
    u.rate = rate;

    u.onstart = () => {
      if (session !== ttsSession || !currentTTSState) return;
      currentTTSState.currentChunkIdx = i;
      notifyTabHighlight(c.text, i, chunks.length);
    };
    u.onboundary = (e) => {
      if (session !== ttsSession) return;
      const at = c.start + (e.charIndex || 0);
      progressEl.value = Math.min(99, Math.round((at / total) * 100));
    };
    u.onend = () => {
      if (session !== ttsSession || !currentTTSState) return;
      progressEl.value = Math.min(99, Math.round((c.end / total) * 100));
      currentTTSState.endedCount++;
      if (currentTTSState.endedCount >= chunks.length) {
        ttsActive = false;
        ttsPaused = false;
        currentTTSState = null;
        clearTabHighlight();
        progressEl.value = 100;
        noteEl.textContent = t('listen.done');
        loadCurrentArticleForListen().catch(() => {});
      }
    };
    u.onerror = (e) => {
      const kind = (e && e.error) || 'unknown';
      if (kind === 'interrupted' || kind === 'canceled') return;
      if (session !== ttsSession) return;
      ttsActive = false;
      ttsPaused = false;
      currentTTSState = null;
      progressEl.value = 0;
      noteEl.textContent = t('listen.tts_error', { reason: kind });
      window.speechSynthesis.cancel();
    };
    try {
      window.speechSynthesis.speak(u);
    } catch (e) {
      if (session !== ttsSession) return;
      ttsActive = false;
      ttsPaused = false;
      currentTTSState = null;
      progressEl.value = 0;
      noteEl.textContent = t('listen.tts_error', { reason: (e && e.message) || 'unknown' });
      return;
    }
  }
}

/**
 * Read `text` aloud, choosing the voice from the text itself.
 *
 * `label` names the source when the text did not come from the page (the
 * 文章总结 tab calls this with its own result). The status line and the note
 * line are written together, from here, on purpose: they used to be written by
 * different code paths, which is how the panel managed to say
 * 「没有可读的正文」 and 「正在朗读…」 in the same breath.
 */
function startTTS(text, label) {
  const statusEl = document.getElementById('listenStatus');
  const noteEl = document.getElementById('ttsNote');
  const progressEl = document.getElementById('ttsProgress');
  const scriptEl = document.getElementById('listenScript');

  if (!text || !text.trim()) {
    statusEl.textContent = t('listen.no_content');
    noteEl.textContent = t('listen.voice_note');
    return;
  }

  window.speechSynthesis.cancel();
  const session = ++ttsSession;
  ttsActive = false;
  ttsPaused = false;
  currentTTSState = null;
  progressEl.value = 0;

  // Captured now: by the time speech starts the page may have moved on, and the
  // status line must keep describing what is being read, not what replaced it.
  const source = label || t('listen.status', { title: currentArticle?.title || '' });

  const speak = async (spoken) => {
    // `voicesReady()` may resolve after the user pressed 停止 or started
    // something else; speaking then would be a ghost read-out.
    const voices = await voicesReady();
    if (session !== ttsSession) return;
    if (!spoken || !spoken.trim()) {
      statusEl.textContent = t('listen.no_content');
      noteEl.textContent = t('listen.voice_note');
      return;
    }

    // Cut the article into sentence-sized utterances BEFORE handing anything to
    // the engine. This is the smoothness fix, and the reasoning is in
    // `shared/speech.js`; the part that belongs here is the queuing:
    //
    //  · Every chunk is `speak()`-ed in the SAME synchronous pass, so the engine
    //    holds the whole queue and there is no JavaScript scheduling gap between
    //    two utterances. Handing over one chunk at a time from `onend` would put
    //    a task-queue round trip in every seam — i.e. build the choppiness back in.
    //  · Nothing cancels between chunks. `speechSynthesis.cancel()` is what makes
    //    the previous utterance fail with `interrupted`, and it must only ever be
    //    the user's own 停止 / a new read-out that triggers it.
    //  · Progress is computed from the chunk's offset into the whole text, so the
    //    bar keeps meaning "how much of the article", not "how much of chunk 3".
    const { normalized, chunks } = splitForSpeech(spoken);
    if (!chunks.length) {
      statusEl.textContent = t('listen.no_content');
      noteEl.textContent = t('listen.voice_note');
      return;
    }

    const script = dominantScript(normalized);
    const voice = pickVoice(voices, script);
    statusEl.textContent = source;
    if (!voice) {
      noteEl.textContent = t('listen.no_voice', {
        lang: t(VOICE_LANG_LABEL[script].labelKey)
      });
      return;
    }

    const rate = parseFloat(document.getElementById('ttsRate').value) || 1;
    const total = normalized.length || 1;
    const fallbackLang = script === 'han' ? 'zh-CN' : 'en-US';

    ttsActive = true;
    ttsPaused = false;
    // Naming the voice turns "口齿还不清晰" into something the user can act on:
    // it says which system voice is speaking, so a bad one is identifiable.
    noteEl.textContent = t('listen.speaking_voice', { voice: voice.name });

    currentTTSState = {
      spoken,
      source,
      chunks,
      total,
      currentChunkIdx: 0,
      endedCount: 0,
      voice,
      fallbackLang,
      script,
      session,
      tabDelegated: false
    };

    // First attempt: delegate playback to webpage tab so audio continues even when side panel is closed!
    const tabId = await getTargetArticleTabId();
    let tabDelegated = false;
    if (tabId) {
      try {
        const resp = await sendToTab(tabId, {
          type: 'OMNI_TTS_START_PLAYBACK',
          chunks,
          rate,
          voiceName: voice ? voice.name : null,
          lang: fallbackLang,
          script,
          startIndex: 0
        });
        if (resp && resp.ok) {
          tabDelegated = true;
          currentTTSState.tabDelegated = true;
        }
      } catch (e) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content/read-along.js']
          });
          const retryResp = await sendToTab(tabId, {
            type: 'OMNI_TTS_START_PLAYBACK',
            chunks,
            rate,
            voiceName: voice ? voice.name : null,
            lang: fallbackLang,
            script,
            startIndex: 0
          });
          if (retryResp && retryResp.ok) {
            tabDelegated = true;
            currentTTSState.tabDelegated = true;
          }
        } catch (err) {}
      }
    }

    if (!tabDelegated) {
      queueTTSUtterances(0, rate);
    }
  };

  // `speak()` is async, and nothing above awaits it: an unhandled rejection here
  // would be an invisible failure for the user plus a console error in the panel.
  // Every launch goes through here so that cannot happen.
  const launch = (spoken) => {
    speak(spoken).catch(() => {
      if (session !== ttsSession) return;
      ttsActive = false;
      ttsPaused = false;
      currentTTSState = null;
      noteEl.textContent = t('global.error_retry');
    });
  };

  if (document.getElementById('listenPodcast').checked) {
    if (scriptEl) { scriptEl.style.display = 'block'; scriptEl.textContent = t('global.thinking'); }
    inferStream('podcast', { article: text }, 'listenScript', 'listenActions', (rewritten) => {
      if (session !== ttsSession) return;
      if (scriptEl) scriptEl.innerHTML = renderMarkdown(rewritten || t('global.error_retry'));
      launch(rewritten);
    }, 'ttsNote');
  } else {
    if (scriptEl) scriptEl.style.display = 'none';
    launch(text);
  }
}

// ---------------- Utilities ----------------
function fillSelect(id, options, defaultKey) {
  const sel = document.getElementById(id);
  sel.innerHTML = '';
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.key; opt.textContent = o.label || t(o.labelKey);
    sel.appendChild(opt);
  });
  sel.value = defaultKey;
}

function copyCurrentStream() {
  const text = window._currentStream?.text;
  if (text) {
    navigator.clipboard.writeText(text);
    showToast(t('global.copied'));
  }
}

init().catch(e => console.error('sidepanel init error', e));
