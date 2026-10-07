#!/usr/bin/env node
/*
 * Focused diagnostic for the "tone output box renders empty" defect.
 *
 * Phases (real browser, real extension build, real WebGPU):
 *   A  GPU probe in the side panel
 *   C  API-surface test: import the vendored WebLLM inside a real extension page
 *      and run `new MLCEngine() -> reload(smallModel) -> chat.completions.create({stream:true})`
 *      exactly the way offscreen.js does. Decides "is the WebLLM integration
 *      correct?" independently of our messaging plumbing.
 *   B  Plumbing test: click 开始改写 in the real panel and capture every message
 *      the panel receives (INFER_START / INFER_STREAM / INFER_END / INFER_ERROR).
 *   D  Console + exception dump for every attached context.
 *
 * Usage:
 *   NODE_PATH=... node e2e/diag-inference.cjs
 *   DIAG_SKIP_B=1 ...            # skip the long model download
 *   DIAG_SKIP_C=1 ...
 *   DIAG_TONE_MS=900000 ...      # how long phase B waits (default 600s)
 *   DIAG_MODEL=Qwen2.5-0.5B-Instruct-q4f16_1-MLC ...
 *   DIAG_PROFILE=/tmp/omni-diag-profile   # persistent profile (keep model cache)
 *   E2E_HEADED=1 ...
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..');
const DEBUG_PORT = Number(process.env.DIAG_PORT || 9444);
const HEADED = process.env.E2E_HEADED === '1';
const DIAG_MODEL = process.env.DIAG_MODEL || 'SmolLM2-360M-Instruct-q4f16_1-MLC';
const TONE_MS = Number(process.env.DIAG_TONE_MS || 600000);
const PROFILE = process.env.DIAG_PROFILE || '';
const SKIP_B = process.env.DIAG_SKIP_B === '1';
const SKIP_C = process.env.DIAG_SKIP_C === '1';

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
function log(tag, msg) { console.log(`[${tag}] ${msg}`); }
const t0All = Date.now();
const el = () => ((Date.now() - t0All) / 1000).toFixed(1) + 's';

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
      const txt = ((p.exception && p.exception.description) || p.text || '').split('\n').slice(0, 3).join(' | ');
      this.exceptions.push(txt); log('EXC/' + el(), txt);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 300);
      const line = `[${m.params.type}] ${txt}`;
      this.consoles.push(line);
      if (!/^(log|debug|info)$/.test(m.params.type)) log('CONSOLE/' + el(), line);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      const line = `[${e.level}] ${e.text} @ ${(e.url || '').split('/').pop()}:${e.lineNumber ?? ''}`;
      this.consoles.push(line);
      if (e.level === 'error') { this.exceptions.push(e.text + ' @ ' + (e.url || '')); log('LOG/' + el(), line); }
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
      if (s) return s;
      await sleep(100);
    }
    throw new Error('target session not attached: ' + url);
  }
  async eval(sessionId, expression, awaitPromise = true, userGesture = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture }, sessionId);
    if (r.error) throw new Error(`CDP ${r.error.code}: ${r.error.message}`);
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      const desc = (d.exception && d.exception.description) || d.text || 'unknown';
      throw new Error(String(desc).split('\n').slice(0, 3).join(' | '));
    }
    return r.result ? r.result.result.value : undefined;
  }
  async waitSession(urlSubstr, timeoutMs = 15000) {
    return waitFor(() => {
      for (const [url, s] of this.sessions) if (url.includes(urlSubstr)) return s;
      return null;
    }, timeoutMs, 150);
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

(async () => {
  const userDataDir = PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'omni-diag-'));
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    ...[HEADED ? [] : ['--headless=new']],
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--enable-unsafe-extension-debugging',
    'about:blank'
  ];
  log('boot', `profile=${userDataDir} headless=${!HEADED}`);
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  let cdp;
  try {
    const ver = await waitForPort(DEBUG_PORT);
    log('boot', ver.Browser);
    cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.setup();

    const load = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    const extId = load.result && (load.result.id || load.result.extensionId);
    log('ext', 'id=' + extId);
    if (!extId) throw new Error('extension failed to load: ' + JSON.stringify(load));
    const localUrl = p => `chrome-extension://${extId}/${p}`;

    const panel = await cdp.openTarget(localUrl('sidepanel/sidepanel.html'));
    await waitFor(() => cdp.eval(panel, `!!document.querySelector('#tabs [data-tab]')`, false), 10000);

    // ---------------------------------------------------------- A. GPU probe
    const gpuPanel = await cdp.eval(panel, `(async () => {
      if (!navigator.gpu) return { gpu: false };
      try {
        const a = await navigator.gpu.requestAdapter();
        if (!a) return { gpu: true, adapter: null };
        return { gpu: true, adapter: 'yes', vendor: a.info && a.info.vendor, arch: a.info && a.info.architecture };
      } catch (e) { return { gpu: true, error: e.message }; }
    })()`).catch(e => 'THROW:' + e.message);
    log('A/gpu-panel', JSON.stringify(gpuPanel));

    // ------------------------------------------- C. WebLLM API surface (fast)
    if (!SKIP_C) {
      const offPage = await cdp.openTarget(localUrl('offscreen.html'));
      await sleep(1200);
      log('C/start', `model=${DIAG_MODEL}`);
      const direct = await cdp.eval(offPage, `(async () => {
        const t0 = performance.now();
        const events = [];
        const stages = [];
        try {
          const mod = await import(chrome.runtime.getURL('vendor/web-llm/web-llm.js'));
          stages.push('import:' + Object.keys(mod).length + ' exports');
          const eng = new mod.MLCEngine();
          eng.setInitProgressCallback(r => {
            const s = (r.progress || 0).toFixed(3) + ' ' + String(r.text || '').slice(0, 70);
            if (stages[stages.length - 1] !== 'p:' + s) stages.push('p:' + s);
          });
          await eng.reload(${JSON.stringify(DIAG_MODEL)});
          const reloadSecs = ((performance.now() - t0) / 1000).toFixed(1);
          stages.push('reload ok ' + reloadSecs + 's');
          const stream = await eng.chat.completions.create({
            messages: [
              { role: 'system', content: 'You are terse.' },
              { role: 'user', content: 'Reply with exactly: hello from omnisense' }
            ],
            stream: true, temperature: 0.7, max_tokens: 32
          });
          let out = '', chunks = 0;
          for await (const ch of stream) {
            const d = ch.choices && ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content;
            if (d) { out += d; chunks++; }
          }
          return { ok: true, chunks, out, reloadSecs, totalSecs: ((performance.now()-t0)/1000).toFixed(1),
                   stages: stages.filter(x => !x.startsWith('p:') || /reload|import/.test(x)).slice(-10),
                   lastProgress: stages.filter(x => x.startsWith('p:')).slice(-2) };
        } catch (e) {
          return { ok: false, name: e && e.name, error: (e && e.message) || String(e),
                   stack: String(e && e.stack || '').split('\\n').slice(0,4),
                   stages: stages.slice(-14) };
        }
      })()`, true).catch(e => 'THROW:' + e.message);
      log('C/result', typeof direct === 'string' ? direct : JSON.stringify(direct, null, 2));
    }

    // ------------------------------------------------ B. real UI plumbing test
    if (!SKIP_B) {
      await cdp.eval(panel, `(() => {
        window.__msgs = [];
        chrome.runtime.onMessage.addListener((m) => {
          try { window.__msgs.push({ t: Date.now(), type: m.type, status: m.status || null,
            progress: m.progress ?? null, text: typeof m.text === 'string' ? m.text.slice(0, 90) : null,
            error: m.error || null, rid: m.requestId || null }); } catch (e) {}
        });
        return true;
      })()`, false);
      await cdp.eval(panel, `(() => {
        document.querySelector('#tabs [data-tab="tone"]').click();
        document.getElementById('toneInput').value = '今天下午三点开会，请准时参加。';
        document.getElementById('toneBtn').click();
        return { outputDisplay: document.getElementById('toneOutput').style.display };
      })()`, false).then(v => log('B/click', JSON.stringify(v))).catch(e => log('B/click', 'THROW ' + e.message));

      const t0 = Date.now();
      let sawStart = false, sawChunk = 0, sawEnd = false, sawErr = null, firstChunkAt = null;
      let lastStateLine = '';
      while (Date.now() - t0 < TONE_MS) {
        const snap = await cdp.eval(panel, `(() => ({
          msgs: window.__msgs.slice(-400),
          outLen: document.getElementById('toneOutput').textContent.length,
          out: document.getElementById('toneOutput').textContent.slice(0, 160),
          outDisplay: document.getElementById('toneOutput').style.display,
          actionsDisplay: document.getElementById('toneActions').style.display,
          badge: (document.getElementById('modelStatus') || {}).textContent || '',
          toast: (document.querySelector('.omni-toast') || {}).textContent || ''
        }))()`, false).catch(e => null);
        if (!snap) { await sleep(1000); continue; }
        for (const m of snap.msgs) {
          if (m.type === 'INFER_START' && !sawStart) { sawStart = true; log('B', `INFER_START @${((Date.now()-t0)/1000).toFixed(1)}s`); }
          if (m.type === 'INFER_STREAM') { sawChunk++; if (firstChunkAt == null) { firstChunkAt = (Date.now()-t0)/1000; log('B', `first INFER_STREAM @${firstChunkAt.toFixed(1)}s text=${JSON.stringify(m.text)}`); } }
          if (m.type === 'INFER_END' && !sawEnd) { sawEnd = true; log('B', `INFER_END @${((Date.now()-t0)/1000).toFixed(1)}s`); }
          if (m.type === 'INFER_ERROR' && !sawErr) { sawErr = m.error; log('B', `INFER_ERROR @${((Date.now()-t0)/1000).toFixed(1)}s :: ${m.error}`); }
        }
        const line = `t=${((Date.now()-t0)/1000).toFixed(0)}s badge="${snap.badge}" outLen=${snap.outLen} outDisplay=${snap.outDisplay} actions=${snap.actionsDisplay} toast="${snap.toast}"`;
        if (line.slice(0, 60) !== lastStateLine.slice(0, 60)) { log('B/state', line); lastStateLine = line; }
        if (snap.outLen > 0) log('B/out', JSON.stringify(snap.out));
        if (sawChunk > 3) break;
        await sleep(3000);
      }
      log('B/summary', JSON.stringify({ sawStart, streamChunks: sawChunk, sawEnd, sawErr, firstChunkAt }));
      const msgsFinal = await cdp.eval(panel, `(() => {
        const byType = {};
        for (const m of window.__msgs) byType[m.type] = (byType[m.type] || 0) + 1;
        const errs = window.__msgs.filter(m => m.type === 'INFER_ERROR');
        return { total: window.__msgs.length, byType, firstError: errs[0] || null, lastErr: errs.slice(-1)[0] || null };
      })()`, false).catch(e => 'THROW:' + e.message);
      log('B/msgs', JSON.stringify(msgsFinal));
    }

    // --------------------------- E. double-MODEL_LOAD race (aborted reload) ---
    // Hypothesis under test: a second `MODEL_LOAD` triggers `engine.reload()`,
    // whose first statement is `unload()`. unload() aborts the in-flight
    // reloadController, and the *first* reload() catches that AbortError and
    // RESOLVES NORMALLY — so offscreen.js broadcasts `status: ready` even though
    // no pipeline is loaded. Every later inference then throws
    // ModelNotLoadedError and the panel renders an empty box with only a
    // transient toast as feedback. Exactly what the user reported.
    if (process.env.DIAG_SKIP_E !== '1') {
      log('E/start', 'sending two MODEL_LOAD messages back to back (abort race)');
      await cdp.eval(panel, `(() => {
        window.__e = [];
        chrome.runtime.onMessage.addListener(m => { if (/MODEL_|INFER_/.test(m.type)) window.__e.push({t:Date.now(),type:m.type,status:m.status,text:(m.text||'').slice(0,70),error:m.error||null}); });
        return true;
      })()`, false).catch(() => {});
      await cdp.eval(panel, `chrome.runtime.sendMessage({ type: 'MODEL_LOAD', modelKey: 'qwen3b' }, () => void chrome.runtime.lastError)`).catch(e => log('E/send1', 'THROW ' + e.message));
      await sleep(60);
      await cdp.eval(panel, `chrome.runtime.sendMessage({ type: 'MODEL_LOAD', modelKey: 'qwen3b' }, () => void chrome.runtime.lastError)`).catch(e => log('E/send2', 'THROW ' + e.message));
      const tE = Date.now();
      let readySeen = false;
      while (Date.now() - tE < TONE_MS) {
        const st = await cdp.eval(panel, `(() => {
          const ev = window.__e || [];
          return { n: ev.length, ready: ev.filter(x => x.status === 'ready').length,
                   err: ev.filter(x => x.status === 'error').map(x => x.text).slice(0,2),
                   last: ev.slice(-2), badge: (document.getElementById('modelStatus')||{}).textContent || '' };
        })()`, false).catch(() => null);
        if (!st) { await sleep(1000); continue; }
        if (!readySeen && st.ready > 0) { readySeen = true; log('E/ready', `badge="${st.badge}" readyBroadcasts=${st.ready}`); break; }
        if (st.err && st.err.length) { log('E/error', JSON.stringify(st.err)); break; }
        await sleep(3000);
      }
      // Immediately try to generate. If the ready broadcast was false, the model
      // is absent from the pipeline map and this must fail.
      await cdp.eval(panel, `(() => {
        window.__msgs = [];
        document.querySelector('#tabs [data-tab="tone"]').click();
        document.getElementById('toneInput').value = '今天下午三点开会，请准时参加。';
        document.getElementById('toneBtn').click();
        return true;
      })()`, false).catch(() => {});
      const tE2 = Date.now();
      while (Date.now() - tE2 < 120000) {
        const r = await cdp.eval(panel, `(() => ({
          outLen: document.getElementById('toneOutput').textContent.length,
          out: document.getElementById('toneOutput').textContent.slice(0,120),
          msgs: (window.__msgs||[]).map(m => m.type + (m.error ? (':' + m.error) : ''))
        }))()`, false).catch(() => null);
        if (!r) { await sleep(1000); continue; }
        if (r.outLen > 0 || r.msgs.some(t => /INFER_ERROR|INFER_END/.test(t))) {
          log('E/after', JSON.stringify(r)); break;
        }
        await sleep(2500);
      }
    }

    // ------------------------------------------------------ D. targets / logs
    const tg = await cdp.send('Target.getTargets');
    log('D/targets', (tg.result.targetInfos || []).filter(t => /(chrome-extension|offscreen)/.test(t.url))
      .map(t => `${t.type}:${t.url.split('/').pop()}`).join(', '));
    log('D/consoles', `${cdp.consoles.length} entries`);
    cdp.consoles.slice(-25).forEach(l => console.log('   ' + l));
    log('D/exceptions', `${cdp.exceptions.length} entries`);
    cdp.exceptions.slice(-25).forEach(l => console.log('   ' + l));
  } catch (e) {
    log('FATAL', e.message + '\n' + (e.stack || ''));
  } finally {
    try { chrome.kill('SIGKILL'); } catch {}
    if (!PROFILE) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
  }
})();
