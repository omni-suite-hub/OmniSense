#!/usr/bin/env node
/*
 * OmniSense embedding backend diagnostic.
 * Loads the extension, opens the offscreen document, and probes which ORT
 * backend can actually be used (webgpu vs wasm), printing the real errors.
 *
 *   NODE_PATH=./node_modules \
 *   node e2e/_diag.cjs
 */
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..');
const PORT = 9345;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 1; this.pending = new Map(); this.sessionByTarget = new Map();
    this.ready = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', d => {
      const m = JSON.parse(d.toString('utf8'));
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
      if (m.method === 'Target.attachedToTarget') {
        const s = m.params.sessionId;
        this.sessionByTarget.set(m.params.targetInfo.targetId, s);
        this.send('Runtime.enable', {}, s);
        this.send('Log.enable', {}, s);
        this.send('Runtime.runIfWaitingForDebugger', {}, s);
      }
    });
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
    const id = r.result.targetId;
    for (let i = 0; i < 100; i++) {
      const s = this.sessionByTarget.get(id);
      if (s) return s;
      await sleep(100);
    }
    throw new Error('no session for ' + url);
  }
  async eval(sessionId, expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result ? r.result.result.value : undefined;
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-diag-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--user-data-dir=${tmp}`, `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-extension-debugging', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    let ver, t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try { ver = await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/json/version`, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej)); break; } catch { await sleep(200); }
    }
    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.setup();
    const load = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    const extId = load.result.id || load.result.extensionId;
    console.log('extId =', extId);

    const off = await cdp.openTarget(`chrome-extension://${extId}/offscreen.html`);
    await sleep(800);

    const probe = await cdp.eval(off, `(async () => {
      const out = {};
      out.hasGpu = !!navigator.gpu;
      out.crossOriginIsolated = self.crossOriginIsolated;
      out.hardwareConcurrency = navigator.hardwareConcurrency;
      if (navigator.gpu) {
        try { const a = await navigator.gpu.requestAdapter(); out.adapter = !!a; } catch (e) { out.adapter = 'ERR:' + e.message; }
      }
      try {
        const t = await import('./vendor/transformers/transformers.js');
        out.imported = true;
        out.versionWeb = t.env?.backends?.onnx?.versions?.web || null;
        out.deviceDefault = t.env?.backends?.onnx?.wasm ? 'hasWasmCfg' : 'none';
      } catch (e) { out.imported = 'ERR:' + e.message; }
      return out;
    })()`, true);
    console.log('PROBE:', JSON.stringify(probe, null, 2));

    for (const device of ['wasm', 'webgpu']) {
      const r = await cdp.eval(off, `(async () => {
        try {
          const { pipeline, env } = await import('./vendor/transformers/transformers.js');
          const dist = chrome.runtime.getURL('npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/');
          env.allowRemoteModels = true; env.allowLocalModels = false; env.useBrowserCache = true;
          env.backends.onnx.wasm.wasmPaths = { mjs: dist + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: dist + 'ort-wasm-simd-threaded.asyncify.wasm' };
          env.backends.onnx.wasm.numThreads = 1;
          env.backends.onnx.wasm.proxy = false;
          const t0 = performance.now();
          const p = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { device: ${JSON.stringify(device)}, dtype: 'fp32' });
          const o = await p('hello world', { pooling: 'mean', normalize: true });
          return { ok: true, ms: Math.round(performance.now() - t0), dim: o.data.length, first: o.data[0] };
        } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
      })()`, true);
      console.log('DEVICE ' + device + ' ->', JSON.stringify(r));
    }
  } catch (e) {
    console.log('DIAG FAILED:', e.message);
  } finally {
    try { chrome.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  process.exit(0);
})();
