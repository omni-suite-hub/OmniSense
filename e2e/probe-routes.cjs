#!/usr/bin/env node
/*
 * Route-level smoke test: does every service-worker route answer, in isolation?
 *
 * Why this exists
 * ---------------
 * "The message port closed before a response was received" has three very
 * different causes that are indistinguishable from the UI:
 *
 *   a) the running service worker has no `case` for that message type, so it
 *      falls through `default: return false` and never answers
 *   b) the handler is entered but its async body never settles -> same symptom
 *   c) the worker executing is a STALE cached script (see e2e/lib/profile.cjs)
 *
 * (c) is the killer: with a persistent --user-data-dir (kept so the ~290 MB of
 * cached MLC model weights are not re-downloaded) Chrome caches the extension's
 * service-worker script *in the profile*, and can keep running an older
 * background.js even though the extension is loaded fresh from disk and
 * `fetch(chrome.runtime.getURL('background.js'))` returns the current file.
 * That silently invalidated earlier "the code is still broken" conclusions.
 *
 * Usage:
 *   NODE_PATH=.../node_modules node e2e/probe-routes.cjs
 *   PROBE_FRESH=1 node e2e/probe-routes.cjs     # wipe the profile first
 *
 * Env:
 *   PROBE_PROFILE   profile dir (default /tmp/omni-probe-profile)
 *   PROBE_FRESH=1   delete the profile before launching
 *   PROBE_PORT      remote debugging port (default 9361)
 *   PROBE_TIMEOUT   per-route timeout, ms (default 12000)
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { prepareProfile, stopChrome } = require('./lib/profile.cjs');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PROBE_PORT || 9361);
const PROFILE = process.env.PROBE_PROFILE || '/tmp/omni-probe-profile';
const FRESH = process.env.PROBE_FRESH === '1';
const ROUTE_TIMEOUT = Number(process.env.PROBE_TIMEOUT || 12000);

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

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.pending = new Map();
    this.sessionByTarget = new Map();
    this.sessions = new Map();
    this.targets = new Map();
    this.problems = [];
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
      this.targets.set(t.targetId, t);
      this.send('Runtime.enable', {}, s);
      this.send('Log.enable', {}, s);
      this.send('Runtime.runIfWaitingForDebugger', {}, s);
    } else if (m.method === 'Target.targetDestroyed' || m.method === 'Target.targetCrashed') {
      const t = this.targets.get(m.params.targetId);
      this.problems.push(`${m.method} ${t ? this._url(t.url) : m.params.targetId}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const p = m.params.exceptionDetails;
      this.problems.push(`[exception] ${this._url(p.url)} :: ${(p.exception?.description || p.text || '').split('\n').slice(0, 3).join(' / ')}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      const txt = (m.params.args || []).map(a => a.description || a.value || a.type).join(' | ').slice(0, 300);
      this.problems.push(`[console.${m.params.type}] ${txt}`);
    } else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
      this.problems.push(`[Log.${m.params.entry.level}] ${m.params.entry.text} @ ${this._url(m.params.entry.url)}`);
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
  async eval(sessionId, expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
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

function probeExpr(msgJson) {
  return `new Promise((resolve) => {
    const to = setTimeout(() => resolve({ outcome: 'NO_RESPONSE' }), ${ROUTE_TIMEOUT});
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

/* `expectFail` is the control. Chrome reports a DIFFERENT error when a listener
 * received the message and answered nothing (our `default: return false`) than
 * when no listener exists at all. A type that exists nowhere must therefore
 * produce "The message port closed before a response was received." — if it
 * instead reports "Receiving end does not exist", no worker is running and every
 * other result in the run is meaningless. */
const ROUTES = [
  ['PING', { type: 'PING' }],
  ['GET_ADBLOCK_STATS', { type: 'GET_ADBLOCK_STATS' }],
  ['__UNKNOWN_CONTROL__', { type: '__UNKNOWN_CONTROL__' }, { expectFail: true }],
];

/* The routes that used to fail. Probed before AND after the offscreen inference
 * host exists, because the host imports the same shared/idb.js module and holds
 * its own long-lived connection to the `omnisense` database. */
const CAPSULE_ROUTES = [
  ['CAPSULE_STATS', { type: 'CAPSULE_STATS' }],
];

(async () => {
  console.log(prepareProfile(PROFILE, { fresh: FRESH }));

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--enable-unsafe-webgpu',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let failed = 0;
  try {
    const ver = await waitForPort(PORT);
    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.setup();
    const load = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    const extId = load.result && (load.result.id || load.result.extensionId);
    if (!extId) throw new Error('extension failed to load: ' + JSON.stringify(load));
    console.log(`extension id: ${extId}`);

    const panel = await cdp.openTarget(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await waitFor(() => cdp.eval(panel, `!!document.getElementById('capsuleStats')`, false), 10000);
    await sleep(1500);

    // A brand new profile wakes the worker lazily, and the very first message
    // can legitimately race the worker's own listener registration. Wait for the
    // worker to answer before asserting anything about routes.
    let woke = null;
    for (let i = 0; i < 20 && !woke; i++) {
      const r = await cdp.eval(panel, probeExpr(JSON.stringify({ type: 'PING' }))).catch(() => null);
      if (r && r.outcome === 'reply' && !r.lastError) woke = r;
      else await sleep(500);
    }
    console.log(`worker reachable             : ${woke ? 'YES (' + JSON.stringify(woke.resp).slice(0, 70) + ')' : 'NO — nothing answered PING for 10 s'}`);
    if (!woke) failed++;

    const swTargets = [...cdp.targets.values()].filter(t => /background\.js/.test(t.url || ''));
    console.log(`service worker targets       : ${swTargets.length ? swTargets.map(t => t.type + ' ' + cdp._url(t.url)).join(', ') : '(none)'}`);

    const sw = await cdp.waitSession(`${extId}/background.js`, 8000);
    if (sw) {
      const v = await cdp.eval(sw, `chrome.runtime.getManifest().version`, false).catch(e => 'ERR:' + e.message);
      console.log(`running worker manifest      : ${v}`);
    }

    // The one failure that makes every other line of this report a lie.
    const diskSrc = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
    const served = await cdp.eval(panel, `fetch(chrome.runtime.getURL('background.js')).then(r => r.text())`).catch(e => 'ERR:' + e.message);
    const fresh = served === diskSrc;
    if (!fresh) failed++;
    console.log(`background.js served == disk : ${fresh ? 'YES' : 'NO — worker may be running stale code'} (${diskSrc.length} chars on disk)`);

    const runRoutes = async (routes) => {
      let bad = 0;
      for (const [name, msg, opts] of routes) {
        const r = await cdp.eval(panel, probeExpr(JSON.stringify(msg))).catch(e => ({ outcome: 'EVAL_THROW', error: e.message }));
        const answered = !!(r && r.outcome === 'reply' && !r.lastError);
        const ok = opts && opts.expectFail ? !answered : answered;
        if (!ok) bad++;
        const brief = r && r.outcome === 'reply'
          ? `lastError=${r.lastError} resp=${JSON.stringify(r.resp).slice(0, 130)}`
          : JSON.stringify(r);
        console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(20)} ${brief}${opts && opts.expectFail ? '   (refusal expected)' : ''}`);
      }
      return bad;
    };

    console.log('');
    console.log('--- round 1: cold worker ---');
    failed += await runRoutes(ROUTES);

    // The count the worker reports is not the same question as "what is actually
    // in the store". Retention pruning runs inside capsuleStats(), so a wrong
    // retention value can make a populated capsule report zero — and the UI
    // cannot tell that apart from an empty one.
    const rawExpr = `(async () => {
      const open = () => new Promise((res) => {
        // No version argument — see diag-capsule-search.cjs: pinning the version
        // here makes the probe fail with VersionError whenever the product's
        // schema moves (it did, v1 -> v2).
        const r = indexedDB.open('omnisense');
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      });
      const db = await open();
      const rows = await new Promise((res) => {
        if (!db) return res(null);
        const tx = db.transaction('capsule', 'readonly');
        const q = tx.objectStore('capsule').getAll();
        q.onsuccess = () => res(q.result.map(x => ({ id: x.id, visitTime: x.visitTime, hasVector: Array.isArray(x.vector) })));
        q.onerror = () => res(null);
      });
      const st = await chrome.storage.local.get(null);
      return JSON.stringify({
        rows: rows === null ? 'UNAVAILABLE' : rows.length,
        oldest: rows && rows.length ? Math.min(...rows.map(r => r.visitTime || 0)) : null,
        newest: rows && rows.length ? Math.max(...rows.map(r => r.visitTime || 0)) : null,
        missingVector: rows ? rows.filter(r => !r.hasVector).length : null,
        retentionDays: st['omnisense.retentionDays'],
        autoRecord: st['omnisense.autoRecord']
      });
    })()`;
    console.log(`store as seen by the UI   : ${await cdp.eval(panel, rawExpr).catch(e => 'ERR:' + e.message)}`);

    console.log('');
    console.log('--- round 2: offscreen inference host resident ---');
    const hostUp = await cdp.eval(panel, probeExpr(JSON.stringify({ type: 'CAPSULE_QUERY', query: 'warm the host' }))).catch(e => ({ outcome: 'EVAL_THROW', error: e.message }));
    console.log(`host warm-up               : ${hostUp.outcome === 'reply' ? 'answered, lastError=' + hostUp.lastError : JSON.stringify(hostUp)}`);
    console.log(`extension contexts alive   : ${await cdp.eval(panel, `chrome.runtime.getContexts ? chrome.runtime.getContexts({}).then(cs => cs.length) : '(unsupported)'`).catch(e => 'ERR:' + e.message)}`);
    await sleep(1000);
    failed += await runRoutes(CAPSULE_ROUTES);

    console.log(`\n==== PROBE RESULT: ${failed === 0 ? 'all checks passed' : failed + ' check(s) FAILED'} ====`);
    if (cdp.problems.length) {
      console.log('\n--- worker / extension problems captured ---');
      for (const p of cdp.problems.slice(0, 25)) console.log('  ' + p);
    }
  } catch (e) {
    console.error('probe crashed: ' + e.message);
    failed = 1;
  } finally {
    console.log(await stopChrome(chrome));
  }
  process.exit(failed ? 1 : 0);
})();
