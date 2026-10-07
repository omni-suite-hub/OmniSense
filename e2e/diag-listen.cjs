#!/usr/bin/env node
/*
 * Diagnostic: why does 听网页 (Listen) read the wrong content in the wrong voice?
 *
 * The report was:
 *   「明明是中文页面，为啥朗读的是英文，口齿还不清晰」
 * with a screenshot showing `listenStatus` = 「没有可读的正文。」 while
 * `ttsNote` said 「正在朗读…」, and the progress bar sitting at zero.
 *
 * Reading the code suggests four independent defects, and this script MEASURES
 * each one instead of arguing from the docs. It is therefore also the **before/after
 * probe** for this defect: run it on the buggy build and on the fixed build and
 * §C flips from ✘ to ✔. §A/§B report platform facts (they do not change), and
 * their printed conclusions name the fix that consumes them.
 *
 *   A. `speechSynthesis.getVoices()` is called synchronously inside startTTS().
 *      Chrome populates the voice list ASYNCHRONOUSLY, so the first call returns
 *      an empty array — meaning `find(v => v.lang.startsWith('zh'))` finds
 *      nothing and no voice is ever assigned. Measured by installing a
 *      document-start probe and reloading the panel, so we capture the list as
 *      it exists at the exact moment initListen() ran.
 *      → replaced by `voicesReady()`, which waits for `voiceschanged` (max 2s).
 *
 *   B. What voices actually exist on this machine, and which one the OLD
 *      hard-coded `zh` selection rule picks for any text whatsoever.
 *      → replaced by script detection + same-family voice lookup + explicit
 *        `utterance.lang`, with an honest refusal when no such voice exists.
 *
 *   C. Does the panel follow the page? `currentTabId` used to be assigned once in
 *      init() with no tabs.onActivated / onUpdated listener anywhere, so
 *      navigating could not refresh anything.
 *      → replaced by `activeTab()` + per-(tabId,url) caching + page-follow listeners.
 *      Asserted against the EXPECTED title, never against "the previous string":
 *      two tabs on the same page make an equality check meaningless.
 *
 *   D. Does headless Chrome fire speech events at all? (If it does not, the
 *      "正在朗读…" line can never be cleared here, which is an environment
 *      limitation to record rather than a product defect.)
 *      → measured: YES, `boundary` fires, so the progress bar was never broken.
 *
 * Usage:
 *   NODE_PATH=.../node_modules node e2e/diag-listen.cjs
 *   LISTEN_HEADED=1 node e2e/diag-listen.cjs
 *
 * Env: LISTEN_PROFILE (default /tmp/omni-listen-profile) · LISTEN_PORT (9341)
 *      LISTEN_HEADED=1 · LISTEN_FRESH=1
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { prepareProfile, stopChrome } = require('./lib/profile.cjs');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..');
const PORT = Number(process.env.LISTEN_PORT || 9341);
const PROFILE = process.env.LISTEN_PROFILE || '/tmp/omni-listen-profile';
const FRESH = process.env.LISTEN_FRESH === '1';
const HEADED = process.env.LISTEN_HEADED === '1';

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
    this.ready = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', d => this._onMessage(JSON.parse(d.toString('utf8'))));
  }
  _onMessage(m) {
    if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
    if (m.method === 'Target.attachedToTarget') {
      const s = m.params.sessionId, t = m.params.targetInfo;
      this.sessionByTarget.set(t.targetId, s);
      this.sessions.set(t.url, s);
      this.targets.set(t.targetId, t);
      this.send('Runtime.enable', {}, s);
      this.send('Page.enable', {}, s);
      this.send('Runtime.runIfWaitingForDebugger', {}, s);
    } else if (m.method === 'Target.detachedFromTarget') {
      const s = m.params.sessionId;
      for (const [k, v] of [...this.sessionByTarget]) if (v === s) this.sessionByTarget.delete(k);
      for (const [k, v] of [...this.sessions]) if (v === s) this.sessions.delete(k);
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
  async targetIdOf(sessionId) {
    for (const [tid, s] of this.sessionByTarget) if (s === sessionId) return tid;
    return null;
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
  async activate(sessionId) {
    const tid = await this.targetIdOf(sessionId);
    if (tid) await this.send('Target.activateTarget', { targetId: tid });
  }
  async navigate(sessionId, url) {
    await this.send('Page.navigate', { url }, sessionId);
  }
}

async function waitForPort(port, timeoutMs = 25000) {
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

// ---------------------------------------------------------------- test pages
const EN_PARAS = [
  'The OmniSense extension keeps every model on the local device, so the browser never uploads the page you are reading to a remote service. This is the promise the whole architecture is built around.',
  'An offscreen document hosts the inference engine, because a Manifest V3 service worker cannot hold a long-lived WebGPU context and is terminated aggressively whenever it goes idle.',
  'Embeddings come from a small sentence transformer executed through ONNX Runtime compiled to WebAssembly, vendor-bundled so nothing is fetched from a content delivery network at runtime.',
];
const ZH_PARAS = [
  'OmniSense 把全部模型都放在本机运行，浏览器不会把你正在阅读的页面内容上传到任何远程服务。这是整套架构围绕展开的核心承诺。',
  '推理引擎寄生在一个离屏文档里，因为清单第三版的服务工作线程无法长期持有图形加速上下文，而且一旦空闲就会被强制回收。',
  '离线语音朗读依赖操作系统自带的语音合成能力，因此可用音色、音质以及支持的语言，完全取决于用户本机安装了哪些语音包。',
  '如果本机没有安装中文语音，那么用英文音色去朗读中文正文就会显得含混不清，这不是扩展的缺陷，但界面上必须把这件事说清楚。',
];
const page = (title, paras) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><header><nav>noise</nav></header><main><article>
<h1 id="article-title">${title}</h1>
${paras.map(p => `<p>${p}</p>`).join('\n')}
</article></main><footer>footer noise</footer></body></html>`;

/* Deliberately three DISTINCT titles.
 *
 * §C used to compare "the status before" with "the status after" and report
 * 「没有跟随」when they matched. That is a false negative the moment the two pages
 * are the same: after the fix both tabs legitimately showed the same Chinese
 * title, and the script reported a defect that was not there. Comparing against
 * the EXPECTED title is the only version of this check that means anything. */
const EN_TITLE = 'Local First Browser Assistant';
const ZH_TITLE = '本地优先的浏览器助手';
const THIRD_TITLE = '用于验证切换标签页的另一个中文页面';
const ZH_MORE = [
  '这个页面存在的唯一目的，是让"切到另一个标签页"这一步有一个与前一页**不同**的标题可比。',
  '如果两个标签页显示同一个标题，那么"跟随成功"与"完全没有跟随"在字符串上无法区分。',
  // Readability needs real body text: a two-paragraph page is not extracted as an
  // article at all, so the listening status would read 「没有可读的正文。」 and this
  // check would fail for a reason that has nothing to do with page following.
  '正文提取器对"文章"有最小长度判断，所以这个用于对照的页面必须像一篇真正的文章，'
    + '而不是两句话：否则状态行会因为提取失败而什么都不显示，与是否跟随毫无关系。',
  '同样的道理适用于所有关于"面板显示了哪一页"的断言：先确认那一页确实被当成正文提取出来了，'
    + '再去比较标题，否则失败原因会指向错误的地方。',
];

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (req.url.startsWith('/en')) return res.end(page(EN_TITLE, EN_PARAS));
      if (req.url.startsWith('/third')) return res.end(page(THIRD_TITLE, [...ZH_PARAS, ...ZH_MORE]));
      if (req.url.startsWith('/zh')) return res.end(page(ZH_TITLE, ZH_PARAS));
      res.end(page('Plain Page', ['just some text']));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* Installed via Page.addScriptToEvaluateOnNewDocument so it runs BEFORE any
 * document script — i.e. it captures the voice list at exactly the moment
 * initListen() would consult it. */
const DOC_START_PROBE = `
window.__ttsProbe = { at0: null, at0Error: null, changes: [] };
try { window.__ttsProbe.at0 = speechSynthesis.getVoices().length; }
catch (e) { window.__ttsProbe.at0Error = String(e && e.message || e); }
try {
  speechSynthesis.addEventListener('voiceschanged', () => {
    window.__ttsProbe.changes.push(speechSynthesis.getVoices().length);
  });
} catch (e) {}
`;

(async () => {
  console.log(prepareProfile(PROFILE, { fresh: FRESH }));
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;

  const chrome = spawn(CHROME, [
    ...(HEADED ? [] : ['--headless=new']),
    '--no-sandbox', '--enable-unsafe-webgpu',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp;
  try {
    const ver = await waitForPort(PORT);
    console.log('Chrome:', ver.Browser.replace(/\s+/g, ' ').slice(0, 90));
    cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.setup();

    const load = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    const extId = load.result && (load.result.id || load.result.extensionId);
    if (!extId) throw new Error('load failed: ' + JSON.stringify(load));
    console.log('extension id:', extId);

    const panel = await cdp.openTarget(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await waitFor(() => cdp.eval(panel, `!!document.getElementById('listenStatus')`, false), 10000);

    // ============ A. the voice list at document start ============
    console.log('\n=== A. 音色在"决定的那一刻"是否可用 ===');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DOC_START_PROBE }, panel);
    await cdp.eval(panel, `location.reload()`, false).catch(() => {});
    await sleep(2500);
    const probe = await cdp.eval(panel, `JSON.stringify(window.__ttsProbe)`, false).catch(e => 'ERR:' + e.message);
    let p = null;
    try { p = JSON.parse(probe); } catch (e) {}
    if (!p) {
      console.log('  document-start probe missing:', probe);
    } else {
      console.log(`  getVoices() 在文档起始处返回 : ${p.at0 === null ? 'n/a ' + p.at0Error : p.at0 + ' 个音色'}`);
      console.log(`  voiceschanged 触发次数/数量  : ${p.changes.length} 次 ${JSON.stringify(p.changes)}`);
      console.log(`  ⇒ 平台事实：列表是异步填充的（起始为空 → 事件推送后才有）。`
        + `${p.at0 === 0 ? ' 所以"在点击处理里同步调用一次"必然可能读到空列表。' : ''}`);
      console.log('     现行代码已改为 voicesReady()：先等 voiceschanged（上限 2s）再决定。');
    }

    // ============ B. what voices exist, and what the shipped rule picks ============
    console.log('\n=== B. 本机音色清单与现行选择规则的结果 ===');
    const voices = await cdp.eval(panel, `(() => {
      const vs = speechSynthesis.getVoices();
      return {
        total: vs.length,
        local: vs.filter(v => v.localService).length,
        network: vs.filter(v => !v.localService).length,
        zh: vs.filter(v => (v.lang || '').toLowerCase().startsWith('zh')).map(v => v.name + ' [' + v.lang + ']' + (v.default ? ' (default)' : '')),
        en: vs.filter(v => (v.lang || '').toLowerCase().startsWith('en')).slice(0, 4).map(v => v.name + ' [' + v.lang + ']'),
        allLangs: [...new Set(vs.map(v => (v.lang || '').split('-')[0].toLowerCase()))].join(','),
        shippedPickZhText: (() => { const z = vs.find(v => v.lang && v.lang.startsWith('zh')); return z ? z.name : '(none — 不设音色，落到系统默认)'; })(),
      };
    })()`, false);
    console.log(`  总数 ${voices.total}（本地 ${voices.local} / 网络 ${voices.network}）`);
    console.log(`  覆盖语言前缀           : ${voices.allLangs}`);
    console.log(`  中文音色 (${voices.zh.length})           : ${voices.zh.length ? voices.zh.slice(0, 8).join(' ; ') : '【无】'}`);
    console.log(`  英文音色示例           : ${voices.en.join(' ; ') || '(none)'}`);
    console.log(`  修复前的规则（硬编码 zh）朗读中文会选中 : ${voices.shippedPickZhText}`);
    console.log('     ↳ 该规则与正文语言无关，所以它同样会用它去读英文正文 —— 这就是"口齿还不清晰"。');
    console.log('     ↳ 现行规则：先判语系，再挑同语系音色并设 u.lang；无同语系音色则拒绝朗读。'
      + '断言在 e2e/run-e2e.cjs（listen: Chinese/English text is read by …）。');

    // ============ C. does the panel follow the page? ============
    console.log('\n=== C. 换页/换标签后面板是否重新读取正文 ===');
    // Compare against the EXPECTED title, never against "the previous string".
    // Two tabs showing the same page make equality meaningless (see banner above).
    const statusOf = () => cdp.eval(panel, `document.getElementById('listenStatus').textContent.trim()`, false).catch(() => 'ERR');
    const waitTitle = async (title) => waitFor(async () => {
      const s = await statusOf();
      return s && s.includes(title) ? s : null;
    }, 12000, 600);

    const enTab = await cdp.openTarget(`${base}/en`);
    await cdp.activate(enTab);
    await sleep(800);
    await cdp.eval(panel, `location.reload()`, false).catch(() => {});
    await sleep(2200);
    const onEn = await waitTitle(EN_TITLE);
    console.log(`  打开面板，当前页 = /en   → listenStatus = "${onEn}"  ${onEn ? '✔' : '✘ 期望含英文标题'}`);

    // Same tab, navigated to a Chinese page. A side panel is not reloaded by a
    // page navigation, so this is exactly the user's situation.
    await cdp.navigate(enTab, `${base}/zh`);
    const afterNav = await waitTitle(ZH_TITLE);
    console.log(`  同一个标签页导航到 /zh  → listenStatus = "${afterNav}"  ${afterNav ? '✔ 有跟随' : '✘ 没有跟随（仍是旧标题）'}`);

    // A different tab entirely, showing a THIRD distinct page.
    const thirdTab = await cdp.openTarget(`${base}/third`);
    await cdp.activate(thirdTab);
    const afterSwitch = await waitTitle(THIRD_TITLE);
    console.log(`  切到另一个标签页 /third → listenStatus = "${afterSwitch}"  ${afterSwitch ? '✔ 有跟随' : '✘ 没有跟随（仍是旧标题）'}`);

    // ============ D. does headless fire speech events at all? ============
    console.log('\n=== D. 当前环境里 speak() 是否会走事件（决定"正在朗读…"能否被清掉） ===');
    const spoken = await cdp.eval(panel, `(async () => {
      const events = [];
      const u = new SpeechSynthesisUtterance('测试中文朗读 test');
      u.onstart = () => events.push('start');
      u.onend = () => events.push('end');
      u.onerror = (e) => events.push('error:' + (e && e.error));
      u.onboundary = () => events.push('boundary');
      speechSynthesis.speak(u);
      await new Promise(r => setTimeout(r, 2500));
      const out = { events, speaking: speechSynthesis.speaking, pending: speechSynthesis.pending };
      speechSynthesis.cancel();
      return out;
    })()`, true).catch(e => ({ events: ['EVAL-ERR:' + e.message] }));
    console.log(`  2.5s 内事件: ${JSON.stringify(spoken.events)}`);
    console.log(`  ⇒ boundary 事件 ${spoken.events.includes('boundary') ? '会触发（进度条有依据）' : '【不触发】进度条在现行实现下永远不会动'}`);

    console.log('\n==== 取证结束 ====');
  } catch (e) {
    console.log('DIAG ERROR:', e.message);
    if (e.stack) console.log(e.stack.split('\n').slice(0, 4).join('\n'));
  } finally {
    console.log(await stopChrome(chrome));
    try { srv.close(); } catch {}
    if (FRESH) { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} }
  }
})();
