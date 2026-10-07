#!/usr/bin/env node
/*
 * Per-feature diagnostic for OmniSense.
 *
 * Why this exists
 * ---------------
 * Two separate reports ("文章总结怎么不好使" and five failing capsule E2E cases)
 * produced the *same* signature: the side panel appears to send a message, no
 * user-visible result appears, and no error is surfaced. Guessing at the cause
 * was useless because several very different failures all look identical from
 * the outside:
 *
 *   - the service worker never answers (cold start / torn-down port)
 *   - the handler answers with an error payload the caller ignores
 *   - the handler never calls sendResponse at all (hangs forever)
 *   - an earlier init() step threw, so a later feature was never wired up
 *   - the click handler returns early without telling anyone
 *
 * So this script probes every service-worker route with a RAW round trip
 * (explicit timeout + the literal chrome.runtime.lastError message) and then
 * drives each feature through its real UI entry point, recording what the user
 * would actually see. It also records every exception and console error with
 * its source URL and stack, which the main harness does not.
 *
 * It is intentionally independent of the model download: every route probed
 * here either needs no model at all or only the small cached embedder.
 *
 * Usage:
 *   NODE_PATH=.../node_modules node e2e/diag-features.cjs
 *
 * Env:
 *   DIAG_PROFILE  profile dir (default /tmp/omni-e2e-profile — keeps caches)
 *   DIAG_PORT     remote debugging port (default 9356)
 *   DIAG_HEADED=1 visible window
 *   DIAG_LOG      also append the report to this file
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { prepareProfile, stopChrome } = require('./lib/profile.cjs');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..');
const PORT = Number(process.env.DIAG_PORT || 9356);
const PROFILE = process.env.DIAG_PROFILE || '/tmp/omni-e2e-profile';
const HEADED = process.env.DIAG_HEADED === '1';
const LOG_FILE = process.env.DIAG_LOG || '';
const ROUTE_TIMEOUT_MS = Number(process.env.DIAG_ROUTE_TIMEOUT || 25000);
// Small model, cached by a previous run of the main suite, so the generative
// features can be verified for real without pulling the 1.8 GB default.
const INFER_MODEL = process.env.DIAG_MODEL || 'SmolLM2-360M-Instruct-q4f16_1-MLC';
const GENERATION_BUDGET_MS = Number(process.env.DIAG_GEN_BUDGET || 240000);

const lines = [];
function out(s) {
  lines.push(s);
  console.log(s);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 10000, intervalMs = 150) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await fn(); if (last) return last; } catch (e) { last = 'ERR:' + e.message; }
    await sleep(intervalMs);
  }
  return last;
}

const ARTICLE_TITLE = 'Capsule Diagnostic Article';
const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${ARTICLE_TITLE}</title>
<meta name="description" content="Long form article for the reader pipeline."></head>
<body><header><nav>noise</nav></header><main><article>
<h1>${ARTICLE_TITLE}</h1>
${'<p>Local semantic search stores an embedding for every captured page chunk inside the browser, and a natural language query is ranked against those vectors with cosine similarity, so a page can be found again by describing what it said.</p>'.repeat(6)}
</article></main><footer>footer noise</footer></body></html>`;

const TRACKER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tracker Diagnostic Page</title>
<script src="https://www.google-analytics.com/analytics.js"></script>
<script src="https://connect.facebook.net/en_US/fbevents.js"></script>
</head><body><h1>Tracker Diagnostic Page</h1>
<p>${'A fairly long paragraph of readable article content used by the privacy scanner. '.repeat(10)}</p>
<form action="/"><input type="hidden" name="csrf_token" value="x"><input type="text" id="q" name="q"></form>
<div class="ad-banner">advertisement</div><div id="google_ads_iframe_1">advertisement</div>
</body></html>`;

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.url.startsWith('/tracker') ? TRACKER : ARTICLE);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.pending = new Map();
    this.sessionByTarget = new Map();
    this.sessions = new Map();
    this.exceptions = [];
    this.consoles = [];
    this._cur = null;
    this.ready = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', d => this._onMessage(JSON.parse(d.toString('utf8'))));
  }
  _url(u) { return String(u || '').replace(/^chrome-extension:\/\/[a-p]{32}/, ''); }
  _onMessage(m) {
    if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
    if (m.method === 'Target.attachedToTarget') {
      const s = m.params.sessionId, t = m.params.targetInfo;
      this.sessionByTarget.set(t.targetId, s);
      this.sessions.set(t.url, s);
      this.send('Runtime.enable', {}, s);
      this.send('Log.enable', {}, s);
      this.send('Runtime.runIfWaitingForDebugger', {}, s);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const p = m.params.exceptionDetails;
      const frames = (p.stackTrace?.callFrames || []).slice(0, 6)
        .map(f => `        ${f.functionName || '(anon)'} @ ${this._url(f.url)}:${(f.lineNumber ?? 0) + 1}:${f.columnNumber ?? 0}`)
        .join('\n');
      this.exceptions.push(
        `[exceptionThrown] at=${this._url(p.url)}\n` +
        `      ${(p.exception?.description || p.text || '').split('\n').slice(0, 4).join('\n      ')}\n${frames}`
      );
    } else if (m.method === 'Runtime.consoleAPICalled') {
      if (m.params.type !== 'error' && m.params.type !== 'warning') return;
      const txt = (m.params.args || []).map(a => a.description || a.value || a.type).join(' | ').slice(0, 400);
      const frames = (m.params.stackTrace?.callFrames || []).slice(0, 5)
        .map(f => `        ${f.functionName || '(anon)'} @ ${this._url(f.url)}:${(f.lineNumber ?? 0) + 1}`)
        .join('\n');
      this.consoles.push(`[console.${m.params.type}] ${txt}\n${frames}`);
    } else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
      this.consoles.push(`[Log.${m.params.entry.level}] ${m.params.entry.text} @ ${this._url(m.params.entry.url)}`);
    }
  }
  send(method, params, sessionId) {
    return new Promise(resolve => {
      const cur = this.id++; this.pending.set(cur, resolve);
      const p = { id: cur, method, params: params || {} };
      if (sessionId) p.sessionId = sessionId;
      this.ws.send(JSON.stringify(p));
    });
  }
  async setup() {
    await this.ready;
    await this.send('Target.setDiscoverTargets', { discover: true });
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }
  async openTarget(url) {
    const r = await this.send('Target.createTarget', { url });
    const targetId = r.result && r.result.targetId;
    for (let i = 0; i < 150; i++) {
      const s = this.sessionByTarget.get(targetId);
      if (s) { this._cur = s; return s; }
      await sleep(100);
    }
    throw new Error('target session not attached: ' + url);
  }
  async activate(sessionId) {
    for (const [targetId, s] of this.sessionByTarget) {
      if (s === sessionId) { await this.send('Target.activateTarget', { targetId }); return true; }
    }
    return false;
  }
  async eval(sessionId, expression, awaitPromise = true, userGesture = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture }, sessionId);
    if (r.error) throw new Error(`CDP ${r.error.code}: ${r.error.message}`);
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error((d.exception?.description || d.text || 'unknown').split('\n').slice(0, 2).join(' | '));
    }
    return r.result ? r.result.result.value : undefined;
  }
  async waitSession(substr, timeoutMs = 8000) {
    return waitFor(() => {
      for (const [url, s] of this.sessions) if (url.includes(substr)) return s;
      return null;
    }, timeoutMs, 100).catch(() => null);
  }
}

async function waitForPort(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      return await new Promise((res, rej) => {
        http.get(`http://127.0.0.1:${port}/json/version`, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
      });
    } catch { await sleep(200); }
  }
  throw new Error('Chrome debug port not ready');
}

const section = (t) => out(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`);

/** Raw round trip for one service-worker route, reporting the literal outcome. */
function probeExpr(msgJson) {
  return `new Promise((resolve) => {
    const to = setTimeout(() => resolve({ outcome: 'NO_RESPONSE' }), ${ROUTE_TIMEOUT_MS});
    try {
      chrome.runtime.sendMessage(${msgJson}, (resp) => {
        clearTimeout(to);
        resolve({
          outcome: 'reply',
          lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
          resp: resp === undefined ? '(undefined)' : resp
        });
      });
    } catch (e) { clearTimeout(to); resolve({ outcome: 'throw', error: e.message }); }
  })`;
}

(async () => {
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  // Reusing this profile keeps the ~290 MB of cached model weights, so the
  // generative features can be exercised for real. It also means Chrome may be
  // holding a stale cached copy of background.js — see e2e/lib/profile.cjs.
  out(prepareProfile(PROFILE));
  const chrome = spawn(CHROME, [
    ...(HEADED ? [] : ['--headless=new']),
    '--no-sandbox', '--enable-unsafe-webgpu',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let exitCode = 0;
  try {
    const ver = await waitForPort(PORT);
    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.setup();
    const load = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    const extId = load.result && (load.result.id || load.result.extensionId);
    if (!extId) throw new Error('extension failed to load: ' + JSON.stringify(load));
    const localUrl = p => `chrome-extension://${extId}/${p}`;

    const swEval = async (expr, awaitPromise = true) => {
      const s = await cdp.waitSession(`${extId}/background.js`, 6000);
      if (!s) throw new Error('SW session unavailable');
      return cdp.eval(s, expr, awaitPromise);
    };

    section('A. environment');
    out(`Chrome: ${ver.Browser}`);
    out(`extension id: ${extId}`);

    // Real web pages first, so the panel can resolve a genuine active tab.
    const tracker = await cdp.openTarget(`${base}/tracker`);
    const article = await cdp.openTarget(`${base}/article`);
    await sleep(2000);

    const tabIdFor = (frag) => swEval(`(async () => { const ts = await chrome.tabs.query({}); const t = ts.find(x => (x.url||'').includes(${JSON.stringify(frag)})); return t ? t.id : null; })()`);
    const articleTabId = await tabIdFor('/article');
    const trackerTabId = await tabIdFor('/tracker');
    out(`articleTabId=${articleTabId}  trackerTabId=${trackerTabId}`);

    const panel = await cdp.openTarget(localUrl('sidepanel/sidepanel.html'));
    await waitFor(() => cdp.eval(panel, `!!document.getElementById('capsuleStats')`, false), 10000);
    await sleep(2000);

    section('B. service worker top-level health');
    out(`typeof chrome.storage in SW        : ${await swEval(`typeof chrome.storage`).catch(e => 'ERR:' + e.message)}`);
    out(`typeof chrome.scripting in SW      : ${await swEval(`typeof chrome.scripting`).catch(e => 'ERR:' + e.message)}`);
    // The capsule routes are the only ones that touch IndexedDB from the worker,
    // and they are the only ones that fail. Non-destructive probes first.
    out(`typeof indexedDB in SW            : ${await swEval(`typeof indexedDB`).catch(e => 'ERR:' + e.message)}`);
    out(`SW indexedDB.databases()           : ${await swEval(`indexedDB.databases ? indexedDB.databases().then(d => JSON.stringify(d)) : 'databases() unsupported'`).catch(e => 'ERR:' + e.message)}`);
    out(`SW opens omnisense (no upgrade)    : ${await swEval(`(async () => {
      try {
        const list = await indexedDB.databases();
        const mine = (list || []).find(d => d.name === 'omnisense');
        if (!mine) return 'omnisense NOT VISIBLE from the service worker';
        return await new Promise((resolve) => {
          const t = setTimeout(() => resolve('TIMEOUT — open never settled'), 6000);
          const req = indexedDB.open('omnisense', mine.version || 1);
          req.onsuccess = () => { clearTimeout(t); resolve('ok v' + req.result.version + ' stores=[' + [...req.result.objectStoreNames].join(',') + ']'); };
          req.onerror = () => { clearTimeout(t); resolve('error: ' + (req.error && req.error.message)); };
          req.onblocked = () => { clearTimeout(t); resolve('BLOCKED by another context'); };
        });
      } catch (e) { return 'threw: ' + e.message; }
    })()`).catch(e => 'ERR:' + e.message)}`);
    out(`dynamic import works in SW         : ${await swEval(`import(chrome.runtime.getURL('shared/idb.js')).then(m => typeof m.idbStats)`).catch(e => 'ERR:' + e.message)}`);
    out(`dynamic import of settings in SW   : ${await swEval(`import(chrome.runtime.getURL('shared/settings.js')).then(m => Object.keys(m.SettingKeys).length)`).catch(e => 'ERR:' + e.message)}`);

    section('C. side panel: can it resolve the page it should act on?');
    // The panel is a tab here, so bring the article tab to the front and reload
    // the panel — that is what its init-time tabs.query will pick up.
    await cdp.activate(article);
    await sleep(500);
    await cdp.eval(panel, `location.reload()`, false).catch(() => {});
    await sleep(2200);
    const activeFromPanel = await cdp.eval(panel,
      `chrome.tabs.query({active:true,currentWindow:true}).then(([t]) => t ? { id: t.id, url: String(t.url).slice(0, 60) } : null)`, true).catch(e => 'ERR:' + e.message);
    out(`panel sees active tab              : ${JSON.stringify(activeFromPanel)}`);
    const wiring = await cdp.eval(panel, `(() => ({
      summaryBtn: !!document.getElementById('summaryBtn'),
      capsuleBtn: !!document.getElementById('capsuleCaptureBtn'),
      summaryStatus: document.getElementById('summaryStatus').textContent.trim(),
      capsuleStats: document.getElementById('capsuleStats').textContent.trim(),
      adblockStats: document.getElementById('adblockStats').textContent.trim(),
      listenStatus: document.getElementById('listenStatus').textContent.trim()
    }))()`, false).catch(e => 'ERR:' + e.message);
    out(`panel initial DOM state            : ${JSON.stringify(wiring)}`);

    section('C2. warm the model so the generative features can be verified for real');
    await cdp.eval(panel, `chrome.runtime.sendMessage({ type: 'MODEL_LOAD', modelId: ${JSON.stringify(INFER_MODEL)} }, () => void chrome.runtime.lastError)`, false).catch(() => {});
    const modelState = await waitFor(async () => {
      const ping = await cdp.eval(panel, `chrome.runtime.sendMessage({ type: 'PING' }).catch(() => null)`).catch(() => null);
      const st = ping && ping.model && ping.model.status;
      if (st === 'ready') return 'ready';
      if (st === 'error') return 'ERROR: ' + (ping.model.text || '');
      return null;
    }, GENERATION_BUDGET_MS, 2000);
    out(`model status                       : ${modelState}`);

    section('D. RAW service-worker route round trips (the decisive data)');    const routes = [
      ['PING', { type: 'PING' }],
      ['GET_ARTICLE', { type: 'GET_ARTICLE', tabId: articleTabId }],
      ['GET_SELECTION', { type: 'GET_SELECTION', tabId: articleTabId }],
      ['SCAN_PRIVACY', { type: 'SCAN_PRIVACY', tabId: trackerTabId }],
      ['GET_ADBLOCK_STATS', { type: 'GET_ADBLOCK_STATS' }],
      ['CAPSULE_STATS', { type: 'CAPSULE_STATS' }],
      ['__UNKNOWN_CONTROL__', { type: '__UNKNOWN_CONTROL__' }],
      ['CAPTURE_TAB', { type: 'CAPTURE_TAB', tabId: articleTabId }]
    ];
    const routeResults = {};
    for (const [name, msg] of routes) {
      const r = await cdp.eval(panel, probeExpr(JSON.stringify(msg))).catch(e => ({ outcome: 'EVAL_THROW', error: e.message }));
      routeResults[name] = r;
      const brief = r && r.outcome === 'reply'
        ? `reply lastError=${r.lastError} resp=${JSON.stringify(r.resp).slice(0, 180)}`
        : JSON.stringify(r);
      out(`${name.padEnd(18)} -> ${brief}`);
    }
    // Chrome distinguishes "a listener answered nothing" (falls through
    // `default: return false`) from "no listener at all". If the deliberate
    // control does NOT report the same error as the failing routes, the worker
    // is not running at all and nothing above can be interpreted.
    const ctl = routeResults['__UNKNOWN_CONTROL__'];
    out(`control error                : ${ctl && ctl.lastError}`);

    section('E. feature entry points, driven through the real UI');
    const clickTab = (id) => cdp.eval(panel, `document.querySelector('#tabs [data-tab="${id}"]').click()`, false);

    // --- 文章总结
    await clickTab('summary');
    await cdp.eval(panel, `document.getElementById('summaryBtn').click()`, false, true).catch(() => {});
    const summaryUi = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        status: document.getElementById('summaryStatus').textContent.trim(),
        out: document.getElementById('summaryOutput').textContent.trim().slice(0, 60)
      }))()`, false).catch(() => null);
      // "点下面的按钮，总结当前页正文。" is the idle resting line, and
      // "本地模型思考中…" is the in-flight placeholder — neither is a result.
      return s && s.out.length > 0 && !/思考中|Thinking/.test(s.out) ? s : null;
    }, GENERATION_BUDGET_MS, 2000);
    out(`文章总结   status="${summaryUi && summaryUi.status}" output="${summaryUi && summaryUi.out}"`);

    // --- 隐私体检
    await clickTab('privacy');
    await cdp.eval(panel, `document.getElementById('privacyBtn').click()`, false, true).catch(() => {});
    const privacyUi = await waitFor(async () => {
      const s = await cdp.eval(panel, `document.getElementById('privacyReport').innerText.trim()`, false).catch(() => null);
      return s && s.length > 10 ? s : null;
    }, 40000, 1000);
    out(`隐私体检   report="${String(privacyUi).replace(/\n/g, ' / ').slice(0, 140)}"`);

    // --- 去广告
    await clickTab('adblock');
    await sleep(1200);
    out(`去广告     stats="${await cdp.eval(panel, `document.getElementById('adblockStats').textContent.trim() + ' | ' + document.querySelector('[data-i18n="adblock.stats"]').textContent.trim()`, false).catch(e => 'ERR:' + e.message)}"`);

    // --- 听网页
    await clickTab('listen');
    await sleep(1200);
    out(`听网页     status="${await cdp.eval(panel, `document.getElementById('listenStatus').textContent.trim()`, false).catch(e => 'ERR:' + e.message)}"`);

    // --- 毒舌点评（仅验证接线，不触发推理）
    await clickTab('roast');
    await cdp.eval(panel, `(() => { document.getElementById('roastInput').value=''; document.getElementById('roastBtn').click(); return document.getElementById('roastInput').value; })()`, false, true).catch(() => {});
    await sleep(700);
    out(`毒舌点评   empty-input toast="${await cdp.eval(panel, `(document.querySelector('.omni-toast') || {}).textContent || '(none)'`, false).catch(e => 'ERR:' + e.message)}"`);

    // --- 语气魔改（同上）
    await clickTab('tone');
    await cdp.eval(panel, `(() => { document.getElementById('toneInput').value=''; document.getElementById('toneBtn').click(); return true; })()`, false, true).catch(() => {});
    await sleep(700);
    out(`语气魔改   empty-input toast="${await cdp.eval(panel, `(document.querySelector('.omni-toast') || {}).textContent || '(none)'`, false).catch(e => 'ERR:' + e.message)}"`);

    // --- 写作助手（参考当前页分支，走 GET_ARTICLE）
    await clickTab('writing');
    await cdp.eval(panel, `document.querySelector('[data-wmode="ref"]').click()`, false, true).catch(() => {});
    const writingUi = await waitFor(async () => {
      const s = await cdp.eval(panel, `document.getElementById('writingRefStatus').textContent.trim()`, false).catch(() => null);
      return s && !/正在读取本页/.test(s) ? s : null;
    }, 40000, 1000);
    out(`写作助手   refStatus="${writingUi}"`);

    // --- 时光胶囊（按钮）
    await clickTab('capsule');
    await cdp.eval(panel, `document.getElementById('capsuleCaptureBtn').click()`, false, true).catch(() => {});
    const capUi = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        note: document.getElementById('capsuleCaptureNote').textContent.trim(),
        stats: document.getElementById('capsuleStats').textContent.trim(),
        pending: document.getElementById('capsuleCaptureBtn').disabled
      }))()`, false).catch(() => null);
      return s && s.note && !s.pending ? s : null;
    }, 240000, 1500);
    out(`时光胶囊   note="${capUi && capUi.note}" stats="${capUi && capUi.stats}"`);
    out(`时光胶囊   rows=${await cdp.eval(panel, `(async () => { const m = await import(${JSON.stringify(localUrl('shared/idb.js'))}); return (await m.idbGetAll('capsule')).length; })()`).catch(e => 'ERR:' + e.message)}`);

    section('E2. the offscreen inference host, probed in its own context');
    // Can the WORKER open a port to the host? Every failing route depends on
    // this, and handleCapsuleQuery is known to work, so a failure here would
    // point at port creation rather than at the capture logic.
    out(`SW -> offscreen port round trip    : ${await swEval(`(async () => {
      try {
        const has = await chrome.offscreen.hasDocument();
        if (!has) return 'no offscreen document exists';
        return await new Promise((resolve) => {
          const p = chrome.runtime.connect({ name: 'omni-offscreen' });
          let settled = false;
          const done = (v) => { if (!settled) { settled = true; resolve(v); } };
          p.onMessage.addListener((m) => done('reply type=' + m.type));
          p.onDisconnect.addListener(() => done('DISCONNECTED without any reply'));
          try { p.postMessage({ type: 'CAPSULE_QUERY', query: 'port probe' }); }
          catch (e) { done('postMessage threw: ' + e.message); }
          setTimeout(() => done('no reply within 15s'), 15000);
        });
      } catch (e) { return 'threw: ' + e.message; }
    })()`).catch(e => 'ERR:' + e.message)}`);
    // Verifies the claim in offscreen.js that this document has no chrome.storage.
    const allTargets = await cdp.send('Target.getTargets');
    const offTargets = ((allTargets.result && allTargets.result.targetInfos) || [])
      .filter(t => String(t.url || '').includes('offscreen.html'));
    out(`offscreen targets seen by CDP     : ${JSON.stringify(offTargets.map(t => ({ type: t.type, attached: t.attached })))}`);
    if (!offTargets.length) {
      out('offscreen document is not exposed as a CDP target — cannot probe its API surface directly.');
      out('indirect evidence: the inference path itself reports "Cannot read properties of undefined (reading \'local\')" whenever it needs a setting.');
    }
    for (const t of offTargets) {
      const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const s = att.result && att.result.sessionId;
      if (!s) { out('  attach failed'); continue; }
      await cdp.send('Runtime.enable', {}, s);
      const probe = await cdp.eval(s, `({
        chromeType: typeof chrome,
        hasStorage: typeof chrome.storage,
        hasStorageLocal: typeof (chrome.storage && chrome.storage.local),
        runtimeId: (chrome.runtime && chrome.runtime.id) || null,
        apiKeys: (typeof chrome === 'object' && chrome) ? Object.keys(chrome).length : -1
      })`, false).catch(e => 'ERR:' + e.message);
      out(`  offscreen document API surface  : ${JSON.stringify(probe)}`);
      try { await cdp.send('Target.detachFromTarget', { sessionId: s }); } catch {}
    }

    section('F. exceptions and console errors (with source location)');
    if (!cdp.exceptions.length && !cdp.consoles.length) out('(none)');
    cdp.exceptions.slice(0, 15).forEach(e => out(e));
    cdp.consoles.slice(0, 30).forEach(c => out(c));

    section('G. summary of raw route outcomes');
    for (const [name, r] of Object.entries(routeResults)) {
      const verdict = !r ? 'NO_DATA'
        : r.outcome === 'reply' && !r.lastError && !(r.resp && r.resp.error) ? 'OK'
        : r.outcome === 'NO_RESPONSE' ? 'HANG — handler never called sendResponse'
        : r.outcome === 'reply' && r.lastError ? 'REJECTED — ' + r.lastError
        : r.outcome === 'reply' && r.resp && r.resp.error ? 'HANDLER ERROR — ' + r.resp.error
        : JSON.stringify(r).slice(0, 120);
      out(`${name.padEnd(18)} ${verdict}`);
    }
  } catch (e) {
    out(`\nDIAG ABORTED: ${e.message}\n${e.stack}`);
    exitCode = 1;
  } finally {
    console.log(await stopChrome(chrome));
    try { srv.close(); } catch {}
    if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n'); } catch {} }
  }
  process.exit(exitCode);
})();
