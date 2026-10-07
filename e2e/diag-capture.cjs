#!/usr/bin/env node
/*
 * Focused diagnostic for the Time Capsule capture path.
 *
 * Written because the full suite reported five capsule failures whose details
 * were all consistent with `chrome.runtime.sendMessage` *rejecting* rather than
 * the service worker returning an error — but a rejection has several possible
 * causes (cold service worker, torn-down port, invalidated extension context,
 * a handler that never calls sendResponse). This script distinguishes them by
 * dumping the raw outcome of each call plus every exception/console error WITH
 * its source URL and stack, which the main harness does not record.
 *
 * Usage:
 *   NODE_PATH=.../node_modules node e2e/diag-capture.cjs
 *
 * Env: DIAG_PROFILE (default /tmp/omni-e2e-profile), DIAG_PORT (default 9355),
 *      DIAG_HEADED=1
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..');
const PORT = Number(process.env.DIAG_PORT || 9355);
const PROFILE = process.env.DIAG_PROFILE || '/tmp/omni-e2e-profile';
const HEADED = process.env.DIAG_HEADED === '1';

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

const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Capsule Diagnostic Article</title></head>
<body><article><h1>Capsule Diagnostic Article</h1>
${'<p>Local semantic search stores an embedding for every captured page chunk inside the browser, and a natural language query is ranked against those vectors with cosine similarity.</p>'.repeat(6)}
</article></body></html>`;

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
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
    this.ready = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', d => this._onMessage(JSON.parse(d.toString('utf8'))));
  }
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
      const frames = (p.stackTrace?.callFrames || []).slice(0, 5)
        .map(f => `      ${f.functionName || '(anon)'} @ ${(f.url || '').replace(/^chrome-extension:\/\/[a-z]+/, '')}:${(f.lineNumber ?? 0) + 1}:${f.columnNumber ?? 0}`)
        .join('\n');
      const target = [...this.sessionByTarget.entries()].find(([, s]) => s === this._curSession);
      this.exceptions.push(
        `[exceptionThrown] url=${p.url || '(none)'} target=${target ? target[0] : '?'}\n` +
        `      ${(p.exception?.description || p.text || '').split('\n').slice(0, 3).join('\n      ')}\n${frames}`
      );
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const lvl = m.params.type;
      if (lvl !== 'error' && lvl !== 'warning') return;
      const txt = (m.params.args || []).map(a => a.description || a.value || a.type).join(' | ');
      const frames = (m.params.stackTrace?.callFrames || []).slice(0, 4)
        .map(f => `      ${f.functionName || '(anon)'} @ ${(f.url || '').replace(/^chrome-extension:\/\/[a-z]+/, '')}:${(f.lineNumber ?? 0) + 1}`)
        .join('\n');
      this.consoles.push(`[console.${lvl}] ${txt}\n${frames}`);
    } else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
      this.consoles.push(`[Log.${m.params.entry.level}] ${m.params.entry.text} @ ${m.params.entry.url || ''}`);
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
    for (let i = 0; i < 120; i++) {
      const s = this.sessionByTarget.get(targetId);
      if (s) { this._curSession = s; return s; }
      await sleep(100);
    }
    throw new Error('target session not attached: ' + url);
  }
  async eval(sessionId, expression, awaitPromise = true, userGesture = false) {
    this._curSession = sessionId;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture }, sessionId);
    if (r.error) throw new Error(`CDP ${r.error.code}: ${r.error.message}`);
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error((d.exception?.description || d.text || 'unknown').split('\n')[0]);
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

const section = (t) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);
const show = (label, v) => console.log(`${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

(async () => {
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, [
    ...(HEADED ? [] : ['--headless=new']),
    '--no-sandbox', '--enable-unsafe-webgpu',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    const ver = await waitForPort(PORT);
    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.setup();

    const load = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    const extId = load.result && (load.result.id || load.result.extensionId);
    const localUrl = p => `chrome-extension://${extId}/${p}`;
    section('A. extension load');
    show('extId', extId);

    const swEval = async (expr, awaitPromise = true) => {
      const s = await cdp.waitSession(`${extId}/background.js`, 6000);
      if (!s) throw new Error('SW session unavailable');
      return cdp.eval(s, expr, awaitPromise);
    };

    const panel = await cdp.openTarget(localUrl('sidepanel/sidepanel.html'));
    await waitFor(() => cdp.eval(panel, `!!document.getElementById('capsuleStats')`, false), 10000);
    await sleep(2500);

    section('B. service worker health');
    show('typeof chrome.storage in SW', await swEval(`typeof chrome.storage`).catch(e => 'ERR:' + e.message));
    show('SettingKeys has captureNotified',
      await swEval(`import(chrome.runtime.getURL('shared/settings.js')).then(m => !!m.SettingKeys.captureNotified)`).catch(e => 'ERR:' + e.message));
    show('modelState via PING from SW', await swEval(`({ ok: true })`).catch(e => 'ERR:' + e.message));

    section('C. panel: does a plain sendMessage work?');
    show('typeof chrome.storage (panel)', await cdp.eval(panel, `typeof chrome.storage`, false));
    show('capsuleStats textContent',
      await cdp.eval(panel, `document.getElementById('capsuleStats').textContent`, false));
    show('raw CAPSULE_STATS round trip', await cdp.eval(panel, `new Promise((resolve) => {
      const to = setTimeout(() => resolve({ outcome: 'NO_RESPONSE_WITHIN_15s' }), 15000);
      try {
        chrome.runtime.sendMessage({ type: 'CAPSULE_STATS' }, (resp) => {
          clearTimeout(to);
          resolve({ outcome: 'callback', lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, resp });
        });
      } catch (e) { clearTimeout(to); resolve({ outcome: 'throw', error: e.message }); }
    })`).catch(e => 'EVAL_THROW:' + e.message));

    section('D. CAPSULE_STATS after an explicit wake-up call');
    await cdp.eval(panel, `new Promise(r => chrome.runtime.sendMessage({ type: 'PING' }, () => { void chrome.runtime.lastError; r(true); }))`).catch(() => {});
    await sleep(400);
    show('raw CAPSULE_STATS (2nd try)', await cdp.eval(panel, `new Promise((resolve) => {
      const to = setTimeout(() => resolve({ outcome: 'NO_RESPONSE_WITHIN_15s' }), 15000);
      try {
        chrome.runtime.sendMessage({ type: 'CAPSULE_STATS' }, (resp) => {
          clearTimeout(to);
          resolve({ outcome: 'callback', lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, resp });
        });
      } catch (e) { clearTimeout(to); resolve({ outcome: 'throw', error: e.message }); }
    })`).catch(e => 'EVAL_THROW:' + e.message));

    section('E. CAPTURE_TAB against a real article tab');
    const article = await cdp.openTarget(`${base}/article`);
    await sleep(2000);
    const articleTabId = await swEval(`(async () => { const ts = await chrome.tabs.query({}); const t = ts.find(x => (x.url||'').includes('/article')); return t ? t.id : null; })()`).catch(e => 'ERR:' + e.message);
    show('articleTabId', articleTabId);
    show('raw CAPTURE_TAB round trip', await cdp.eval(panel, `new Promise((resolve) => {
      const to = setTimeout(() => resolve({ outcome: 'NO_RESPONSE_WITHIN_120s' }), 120000);
      try {
        chrome.runtime.sendMessage({ type: 'CAPTURE_TAB', tabId: ${articleTabId} }, (resp) => {
          clearTimeout(to);
          resolve({ outcome: 'callback', lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, resp });
        });
      } catch (e) { clearTimeout(to); resolve({ outcome: 'throw', error: e.message }); }
    })`).catch(e => 'EVAL_THROW:' + e.message));

    section('F. row count after the capture attempt');
    show('capsule rows', await cdp.eval(panel, `(async () => {
      const m = await import(${JSON.stringify(localUrl('shared/idb.js'))});
      return (await m.idbGetAll('capsule')).length;
    })()`).catch(e => 'ERR:' + e.message));

    section('G. exceptions / console errors (with source location)');
    if (!cdp.exceptions.length && !cdp.consoles.length) console.log('(none)');
    cdp.exceptions.slice(0, 12).forEach(e => console.log(e + '\n'));
    cdp.consoles.slice(0, 25).forEach(c => console.log(c + '\n'));

    await sleep(500);
  } catch (e) {
    console.log('DIAG FAILED:', e.message, '\n', e.stack);
  } finally {
    try { chrome.kill('SIGKILL'); } catch {}
    try { srv.close(); } catch {}
  }
})();
