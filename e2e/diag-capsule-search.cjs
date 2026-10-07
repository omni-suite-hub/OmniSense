#!/usr/bin/env node
/*
 * Measures Time Capsule retrieval quality with real numbers.
 *
 * Why this exists
 * ---------------
 * An E2E scenario asserted "the page saved from the panel is findable by
 * description" and got zero hits, while a different scenario's query matched
 * fine. Two very different explanations fit:
 *
 *   a) the search never ran (wiring / event / a hung embedder) — a real bug
 *   b) it ran and every chunk scored below the `score > 0.35` cut-off — a
 *      threshold/query-recall question, not a wiring bug
 *
 * The UI cannot tell those apart, because both render an empty result list. So
 * this script queries the inference host directly over its own port, where the
 * reply carries the raw `score` for every chunk, and prints the ranking.
 *
 * It also prints the score distribution over EVERY stored chunk (unfiltered), so
 * you can see how far the cut-off is from the data instead of guessing.
 *
 * Usage:
 *   NODE_PATH=.../node_modules node e2e/diag-capsule-search.cjs
 *
 * Env:
 *   CAP_PROFILE  profile dir (default /tmp/omni-e2e-profile, kept for the model cache)
 *   CAP_PORT     remote debugging port (default 9365)
 *
 * KNOWN LIMITATION (measured 2026-09-29) — read this before trusting a run
 * -----------------------------------------------------------------------
 * This probe drives ONE flattened auto-attached CDP session for the whole run and
 * has no session recovery. When the extension service worker is recycled
 * mid-run, that session goes stale and every later `Runtime.evaluate` goes
 * UNANSWERED — no reply, no error. Symptom: the output stops right after
 * `A. what the shipped cut-off (score > 0.35) returns` and nothing more appears.
 *
 * That is NOT a product bug, and it was proven so rather than assumed: on the
 * same hung instance, a *direct* CDP session to that same panel answered
 * `EMBEDDING` (384-dim vector), `PING` and `CAPSULE_QUERY` within seconds, and
 * the panel's own `document`/timers were alive. The E2E harness already grew
 * exactly this recovery (`waitSession()`: drop dead sessions, wake the SW with a
 * PING, force `Target.attachToTarget`) — see TEST_REPORT §3.1. This probe never
 * got it, so its numbers are only trustworthy when the run reaches section B.
 *
 * Two mitigations are in place: `send()` now has a hard timeout (a stale session
 * surfaces as an error instead of an unbounded silent hang), and the script
 * refuses to start if something is already answering its debug port (otherwise
 * it would silently drive a browser it did not launch).
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { prepareProfile, stopChrome } = require('./lib/profile.cjs');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..');
const PORT = Number(process.env.CAP_PORT || 9365);
const PROFILE = process.env.CAP_PROFILE || '/tmp/omni-e2e-profile';

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
    this.id = 1; this.pending = new Map();
    this.sessionByTarget = new Map(); this.sessions = new Map();
    this.dead = null;
    this.ready = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', d => this._onMessage(JSON.parse(d.toString('utf8'))));
    // A dropped socket used to be completely invisible: `send()` awaited a reply
    // that could never arrive, so the probe sat there printing nothing at all
    // (observed: 30+ minutes, no output, no error). Both handlers turn that into a
    // rejection the caller can act on.
    this.ws.on('close', () => this._die('CDP websocket closed'));
    this.ws.on('error', (e) => this._die('CDP websocket error: ' + (e && e.message)));
  }
  _die(reason) {
    if (this.dead) return;
    this.dead = new Error(reason);
    for (const [, slot] of this.pending) { try { slot.reject(this.dead); } catch (e) {} }
    this.pending.clear();
  }
  _onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const slot = this.pending.get(m.id);
      this.pending.delete(m.id);
      slot.resolve(m);
      return;
    }
    if (m.method === 'Target.attachedToTarget') {
      const s = m.params.sessionId, t = m.params.targetInfo;
      this.sessionByTarget.set(t.targetId, s); this.sessions.set(t.url, s);
      this.send('Runtime.enable', {}, s);
    } else if (m.method === 'Target.detachedFromTarget') {
      const s = m.params.sessionId;
      for (const [k, v] of [...this.sessionByTarget]) if (v === s) this.sessionByTarget.delete(k);
      for (const [k, v] of [...this.sessions]) if (v === s) this.sessions.delete(k);
    }
  }
  // 5-minute ceiling: comfortably above this probe's own longest budgets (240s
  // capture, 60s per query) yet finite, so an unanswered call can never hang the run.
  send(method, params, sessionId, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      if (this.dead) { reject(this.dead); return; }
      const cur = this.id++;
      const to = setTimeout(() => {
        this.pending.delete(cur);
        reject(new Error(`CDP ${method} got no reply within ${timeoutMs}ms — the session is probably stale`));
      }, timeoutMs);
      this.pending.set(cur, {
        resolve: (m) => { clearTimeout(to); resolve(m); },
        reject: (e) => { clearTimeout(to); reject(e); }
      });
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

/**
 * Is something ALREADY serving this debug port?
 *
 * Must be checked BEFORE spawning: `waitForPort()` cannot tell "my Chrome came up"
 * from "someone else's Chrome was already there", and a leftover Chrome from a
 * killed previous run answers immediately. The probe then silently drives a
 * browser it did not start — against a profile it did not prepare — and the
 * results look plausible while describing the wrong process. (This has bitten the
 * suite: a probe run attached to a stale Chrome left behind by an earlier probe
 * that had been killed with the node process, leaving the browser alive.)
 */
async function portAlreadyServing(port, timeoutMs = 1500) {
  try {
    await new Promise((res, rej) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, r => { r.resume(); r.on('end', res); });
      req.on('error', rej);
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    });
    return true;
  } catch { return false; }
}

const ARTICLE_TITLE = 'A Long Form Article About Local Inference';
const ARTICLE_TEXT = ('Running a language model on the device you are already using changes what a browser extension can promise. '
  + 'Nothing the reader opens has to be uploaded to a remote service, because the weights live in the browser profile and the '
  + 'arithmetic happens on the local GPU. That single architectural choice removes a whole category of privacy concerns and '
  + 'replaces them with a different set of engineering problems: where the weights are stored, how the interface stays '
  + 'responsive while tokens stream, and what happens on a machine that has no usable accelerator. ').repeat(4);

/* Queries a *user* would plausibly type, ordered from "close to the text" to the
 * vague phrasing the E2E suite happened to use. The last two are deliberate
 * controls: a query with no relation to the index tells us what "unrelated"
 * scores, which is the only way to choose the cut-off on evidence. */
const QUERIES = [
  'running a language model on your own device',
  'local inference privacy',
  'why running models locally matters',
  'a long form article about local inference',
  'webgpu accelerator weights stored in the browser profile',
  'CONTROL: chocolate cake recipe with butter',
  'CONTROL: how to repair a bicycle gear shifter',
];

/** Embed one string through the product's own embedding route. */
const embedExpr = (text) => `new Promise((resolve) => {
  const rid = 'e_' + Date.now() + Math.random();
  const to = setTimeout(() => resolve('TIMEOUT'), 60000);
  const h = (m) => {
    if (m.type !== 'EMBEDDING' || m.requestId !== rid) return;
    clearTimeout(to); chrome.runtime.onMessage.removeListener(h); resolve(m.vector);
  };
  chrome.runtime.onMessage.addListener(h);
  chrome.runtime.sendMessage({ type: 'EMBEDDING', requestId: rid, text: ${JSON.stringify(text)} });
})`;

/** Every stored chunk with its vector, straight out of the shared database. */
const ALL_ROWS_EXPR = `new Promise((resolve) => {
  // No version argument: the schema is owned by shared/idb.js, and pinning it here
  // means this probe throws VersionError the moment the product bumps the version
  // (it did, v1 -> v2). Opening without a version always gets the current schema.
  const req = indexedDB.open('omnisense');
  req.onerror = () => resolve(null);
  req.onsuccess = () => {
    const tx = req.result.transaction('capsule', 'readonly');
    const r = tx.objectStore('capsule').getAll();
    r.onerror = () => resolve(null);
    r.onsuccess = () => resolve(r.result.map(x => ({ title: x.title, vector: x.vector })));
  };
})`;

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/** Ask through the real product route (side panel → SW → host → SW → panel),
 *  which returns the same scored rows the UI ranks. */
function queryExpr(query) {
  return `new Promise((resolve) => {
    const to = setTimeout(() => resolve({ outcome: 'TIMEOUT' }), 60000);
    chrome.runtime.sendMessage({ type: 'CAPSULE_QUERY', query: ${JSON.stringify(query)} }, (resp) => {
      clearTimeout(to);
      if (chrome.runtime.lastError) { resolve({ outcome: 'ERR:' + chrome.runtime.lastError.message }); return; }
      resolve({ outcome: 'ok', results: (resp || []).map(r => ({ score: Number((r.score || 0).toFixed(4)), title: r.title })) });
    });
  })`;
}

(async () => {
  console.log(prepareProfile(PROFILE));
  if (await portAlreadyServing(PORT)) {
    console.error(`\nABORT: something is already serving debug port ${PORT}.\n`
      + 'Refusing to drive a browser this probe did not start — a leftover Chrome from a\n'
      + 'killed earlier run would answer `waitForPort()` and every measurement below would\n'
      + 'describe that process instead. Free the port (or set CAP_PORT to a free one) and retry.');
    process.exit(2);
  }
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--enable-unsafe-webgpu',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, 'about:blank'
  ], { stdio: 'ignore' });

  try {
    const ver = await waitForPort(PORT);
    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.setup();
    const load = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    const extId = load.result && (load.result.id || load.result.extensionId);
    if (!extId) throw new Error('extension failed to load: ' + JSON.stringify(load));
    const panel = await cdp.openTarget(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await waitFor(() => cdp.eval(panel, `!!document.getElementById('capsuleStats')`, false), 10000);
    await sleep(1500);

    // The offscreen document only exists once something asks for it, and
    // `chrome.runtime.connect({name:'omni-offscreen'})` from a page does NOT
    // create it — the port then has no listener at all and the postMessage is
    // simply dropped (no disconnect, no error, no timeout callback). So warm the
    // host through the service worker first; CAPSULE_QUERY calls ensureOffscreen()
    // before opening its own port.
    console.log('\nwarming the inference host through the service worker…');
    const warm = await cdp.eval(panel, `new Promise((resolve) => {
      const to = setTimeout(() => resolve('NO_RESPONSE'), 300000);
      chrome.runtime.sendMessage({ type: 'CAPSULE_QUERY', query: 'warm up the embedder' }, (resp) => {
        clearTimeout(to);
        resolve(chrome.runtime.lastError ? 'ERR:' + chrome.runtime.lastError.message : 'ok:' + JSON.stringify(resp).slice(0, 60));
      });
    })`).catch(e => 'ERR:' + e.message);
    console.log(`host warm-up: ${warm}`);
    await sleep(1000);

    // Index a known document through the same path the UI uses.
    console.log('\nindexing a known article through the offscreen host…');
    const stored = await cdp.eval(panel, `new Promise((resolve) => {
      const rid = 'cap_' + Date.now();
      const to = setTimeout(() => resolve(-1), 240000);
      const p = chrome.runtime.connect({ name: 'omni-offscreen' });
      p.onMessage.addListener(m => {
        if (m.type !== 'CAPTURE_RESULT' || m.requestId !== rid) return;
        clearTimeout(to); resolve(m.ok ? (m.chunks || 0) : -2);
        try { p.disconnect(); } catch (e) {}
      });
      p.postMessage({ type: 'CAPTURE_PAGE', requestId: rid, data: {
        url: 'https://example.com/local-inference-article',
        title: ${JSON.stringify(ARTICLE_TITLE)},
        text: ${JSON.stringify(ARTICLE_TEXT)}
      } });
    })`, true).catch(e => 'ERR:' + e.message);
    console.log(`capture result: ${stored} chunk(s)   (240s budget, first run also downloads the embedder)`);
    if (typeof stored !== 'number' || stored <= 0) {
      console.log('could not index — aborting, nothing to measure');
      await stopChrome(chrome);
      process.exit(1);
    }

    console.log('\n' + '='.repeat(74));
    console.log('A. what the shipped cut-off (score > 0.35) returns');
    console.log('='.repeat(74));
    for (const q of QUERIES) {
      const r = await cdp.eval(panel, queryExpr(q)).catch(e => ({ outcome: 'ERR:' + e.message }));
      if (r.outcome !== 'ok') { console.log(`\n"${q}"\n   -> ${r.outcome}`); continue; }
      console.log(`\n"${q}"\n   -> ${r.results.length} hit(s)`);
      for (const h of r.results.slice(0, 3)) console.log(`      ${h.score}  ${h.title}`);
    }

    // The cut-off can only be judged against the full score distribution, which
    // the shipped filter hides by construction.
    console.log('\n' + '='.repeat(74));
    console.log('B. the same queries WITHOUT the filter — what the cut-off throws away');
    console.log('='.repeat(74));
    const rows = await cdp.eval(panel, ALL_ROWS_EXPR).catch(() => null);
    if (!rows || !rows.length) {
      console.log('could not read stored vectors');
    } else {
      console.log(`(${rows.length} chunk(s) in the index; top score per query)`);
      for (const q of QUERIES) {
        const v = await cdp.eval(panel, embedExpr(q)).catch(() => null);
        if (!v || !Array.isArray(v)) { console.log(`\n"${q}"\n   -> embed failed: ${v}`); continue; }
        const scored = rows.map(r => cosine(v, r.vector)).sort((a, b) => b - a);
        const top = scored.slice(0, 3).map(s => s.toFixed(4)).join(', ');
        console.log(`   top=${top}   "${q}"`);
      }
      console.log('\nRead it like this: the highest "CONTROL:" score is the noise floor.');
      console.log('Anything above it is a real, rankable match that the cut-off is discarding.');
    }
  } catch (e) {
    console.error('diag crashed: ' + e.message);
  } finally {
    console.log(await stopChrome(chrome));
  }
  process.exit(0);
})();
