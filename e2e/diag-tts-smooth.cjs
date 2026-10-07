#!/usr/bin/env node
/*
 * Diagnostic: why is 听网页 playback 断断续续 (choppy / stuttering)?
 *
 * The user reported it AFTER the wrong-language defect was fixed, so this is a
 * different question from `diag-listen.cjs`: the right text is now read by a
 * right-language voice, and the read-out is still not smooth.
 *
 * Three candidate causes, each measured rather than argued:
 *
 *   §1 THE VOICE ITSELF. macOS ships "novelty" voices (Eddy / Flo / Grandma /
 *      Grandpa / Bad News / Bells ...) into the same `getVoices()` list as the
 *      proper locale voices (Ting-Ting / Mei-Jia / Sin-Ji ...). Novelty voices
 *      are deliberately robotic and DO sound choppy. `pickVoice` currently ranks
 *      by lang tag + localService + default, and **ties are broken by the order
 *      the engine happens to return**, which is arbitrary — so a novelty voice
 *      can win. This section dumps the whole inventory with its flags, and prints
 *      exactly which voice the product's own ranking selects.
 *
 *   §2 THE UTTERANCE LENGTH. Chrome's speech engine does not stream an arbitrarily
 *      long utterance smoothly: audio degrades into bursts and the utterance may
 *      never reach `end`. Measured as "how many characters advanced in 60 s",
 *      one-shot vs. chunked, same voice, same rate, same text.
 *
 *   §3 THE INTER-CHUNK GAP. Chunking fixes §2 but adds a scheduling gap between
 *      queued utterances. If that gap is audible, chunking *creates* the very
 *      choppiness it removes, so the chunk size has to be chosen from data:
 *      measured as the end→start silence between consecutive queued utterances.
 *
 * Nothing here needs the model, so the script starts in seconds.
 *
 * Usage:
 *   NODE_PATH=.../node_modules node e2e/diag-tts-smooth.cjs
 *   TTS_HEADED=1 node e2e/diag-tts-smooth.cjs      (watch it for real)
 *
 * Env: TTS_PROFILE (default /tmp/omni-tts-profile) · TTS_PORT (9342)
 *      TTS_HEADED=1 · TTS_FRESH=1 · TTS_BUDGET_MS (default 60000)
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const { prepareProfile, stopChrome } = require('./lib/profile.cjs');

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TTS_PORT || 9342);
const PROFILE = process.env.TTS_PROFILE || '/tmp/omni-tts-profile';
const FRESH = process.env.TTS_FRESH === '1';
const HEADED = process.env.TTS_HEADED === '1';
const BUDGET = Number(process.env.TTS_BUDGET_MS || 60000);

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

/* Text for §2/§3. Built here rather than scraped, because this measurement is
 * about the ENGINE, not about readability extraction. ~1200 CJK characters is
 * the same order as a real article body. */
const SENTENCES = [
  '离屏文档是清单第三版扩展里唯一能长时间持有图形加速设备的地方。',
  '服务工作线程会在空闲计时器到期时被回收，而这个计时器扩展完全无法干预。',
  '模型权重由运行时存放在浏览器缓存里，而不是打进扩展包内。',
  '因此首次使用需要下载，之后每次运行都直接读缓存。',
  '语音朗读通过网页语音接口交给操作系统完成，可用音色取决于用户本机装了什么。',
  '如果本机没有安装中文语音，那么用英文音色朗读中文正文就会显得含混不清。',
  '检索会先把抓取的正文切成块，为每一块生成向量，再按余弦相似度排序。',
  '过滤是分层的，网络层拦截使用声明式规则，元素隐藏由内容脚本完成。',
  '隐私报告是启发式的，完全在本地完成，不会把结果发送到任何地方。',
  '每一个耗时较长的操作都会报告进度，失败也会写进结果框而不是只弹一条提示。',
];
const LONG_TEXT = (() => {
  let out = '';
  while (out.length < 1200) out += SENTENCES[out.length % SENTENCES.length];
  return out;
})();

/* Runs INSIDE the panel (an extension page, same CSP as production).
 *
 * `__ttsStart(texts, rate, offsets, lens)` queues the pieces back to back WITHOUT
 * cancelling in between — exactly how the product should do it — and records every
 * event with a timestamp so the caller can compute gaps.
 *
 * It writes its state to `window.__ttsLog` and returns a promise that settles when
 * the series finishes. The caller must NOT rely on that promise to observe
 * progress: the first version of this probe did, and reported "0 boundary events"
 * for both variants — which looked like "the engine never fired anything" but
 * actually meant "the promise never resolved, so the log was never read". Progress
 * has to be SAMPLED live, because "it never finished within the budget" is itself
 * the finding.
 */
const SPEAK_SERIES = `
window.__ttsStart = (texts, rate, offsets, lens) => {
  const synth = window.speechSynthesis;
  synth.cancel();
  const st = {
    log: [], chars: 0, done: 0, total: texts.length,
    offsets, lens, t0: performance.now(), finished: false
  };
  window.__ttsLog = st;
  const voice = window.__ttsVoice;
  const push = (e) => { if (st.log.length < 600) st.log.push(e); };
  return new Promise((resolve) => {
    let idx = 0;
    const next = () => {
      if (idx >= texts.length) { st.finished = true; resolve(st); return; }
      const i = idx++;
      const u = new SpeechSynthesisUtterance(texts[i]);
      u.lang = voice ? voice.lang : 'zh-CN';
      if (voice) u.voice = voice;
      u.rate = rate;
      const T = () => Math.round(performance.now() - st.t0);
      u.onstart = () => push({ t: T(), k: 'start', i });
      u.onboundary = (e) => {
        st.chars = offsets[i] + (e.charIndex || 0);
        push({ t: T(), k: 'boundary', i, c: e.charIndex || 0 });
      };
      u.onend = () => {
        st.done++;
        st.chars = offsets[i] + lens[i];
        push({ t: T(), k: 'end', i, c: lens[i] || 0 });
        setTimeout(next, 0);
      };
      // A failed utterance must end the series too, or the promise hangs and the
      // caller cannot tell "it errored" from "it is still speaking".
      u.onerror = (e) => {
        push({ t: T(), k: 'error', i, why: String((e && e.error) || '') });
        setTimeout(next, 0);
      };
      synth.speak(u);
    };
    next();
  });
};
window.__ttsSnap = () => {
  const st = window.__ttsLog;
  if (!st) return null;
  return {
    chars: st.chars, done: st.done, total: st.total, ev: st.log.length,
    finished: st.finished, speaking: speechSynthesis.speaking,
    pending: speechSynthesis.pending, paused: speechSynthesis.paused
  };
};
`;

(async () => {
  console.log(prepareProfile(PROFILE, { fresh: FRESH }));

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
    // Give the engine time to publish the voice list (it is asynchronous, and the
    // LOCAL macOS voices appear noticeably later than the network ones — a short
    // wait reports a machine with 19 network voices and no local ones, which is
    // exactly the wrong thing to reason about). Wait for a local voice, then fall
    // back, and SAY which happened.
    const voiceWait = await cdp.eval(panel, `(() => new Promise(r => {
      const t0 = Date.now();
      const has = () => speechSynthesis.getVoices() || [];
      if (has().some(v => v.localService)) return r({ why: 'already', n: has().length, ms: 0 });
      const tick = () => {
        const vs = has();
        if (vs.some(v => v.localService)) return r({ why: 'local appeared', n: vs.length, ms: Date.now() - t0 });
        if (Date.now() - t0 > 12000) return r({ why: 'timeout, NO local voice', n: vs.length, ms: Date.now() - t0 });
        setTimeout(tick, 250);
      };
      speechSynthesis.addEventListener('voiceschanged', tick);
      tick();
    }))()`, true).catch(() => ({ why: 'eval failed', n: 0, ms: 0 }));
    console.log(`音色表就绪：${voiceWait.why}，共 ${voiceWait.n} 个，等待 ${voiceWait.ms}ms`);

    // ================= §1 the voice inventory =================
    //
    // `localesOf(name)` is the piece of evidence that does not come from a
    // hand-written blacklist: a voice mounted for ONE locale is that locale's
    // dedicated voice (Tingting / Mei-Jia / Sin-Ji), while a voice mounted for
    // dozens of locales is a cross-language persona (Eddy / Grandma / Grandpa).
    // The macOS table agrees exactly (`say -v '?'` lists each persona once per
    // language, and lists Tingting once, for zh_CN only).
    console.log('\n=== §1 音色清单：产品会选中谁、有没有"玩具音色" ===');
    const inv = await cdp.eval(panel, `(() => {
      const vs = speechSynthesis.getVoices();
      const count = {};
      for (const v of vs) {
        const base = String(v.name).replace(/\\s*\\([^)]*\\)\\s*$/, '').trim();
        count[base] = (count[base] || 0) + 1;
      }
      const brief = v => ({
        name: v.name, lang: v.lang, local: !!v.localService, def: !!v.default,
        locales: count[String(v.name).replace(/\\s*\\([^)]*\\)\\s*$/, '').trim()] || 1
      });
      return {
        total: vs.length,
        local: vs.filter(v => v.localService).length,
        network: vs.filter(v => !v.localService).length,
        zh: vs.filter(v => /^zh/i.test(v.lang || '')).map(brief),
        en: vs.filter(v => /^en/i.test(v.lang || '')).map(brief)
      };
    })()`, false);
    console.log(`  总数 ${inv.total}（本地 ${inv.local} / 网络 ${inv.network}）`);
    const tag = v => `[${v.lang}]${v.local ? ' local' : ' NETWORK'}${v.def ? ' DEFAULT' : ''}` +
      ` 语种数=${v.locales}${v.locales === 1 ? ' ←单语种专用' : ' ←跨语种角色'}`;
    console.log(`  中文音色 ${inv.zh.length} 个：`);
    inv.zh.forEach((v, i) => console.log(`    ${String(i + 1).padStart(2)}. ${v.name.padEnd(30)} ${tag(v)}`));
    console.log(`  英文音色 ${inv.en.length} 个（前 10）：`);
    inv.en.slice(0, 10).forEach((v, i) => console.log(`    ${String(i + 1).padStart(2)}. ${v.name.padEnd(30)} ${tag(v)}`));
    console.log(`  单语种专用英文音色: ${
      inv.en.filter(v => v.locales === 1).map(v => v.name + tag(v).replace(/^/, '')).join(' | ') || '(无)'}`);

    // Rank with the SAME module the panel uses, so this prints the real answer
    // instead of a second guess that can drift away from the product.
    const { pickVoice, dominantScript, isNoveltyVoice } = await import('../shared/speech.js');

    // The rule that shipped, kept here ONLY so this one run shows the before and
    // the after side by side. It is the shipped ranking verbatim: preferred tag,
    // then localService, then `default`, and ties resolved by the order the engine
    // returned. `Array.prototype.sort` is stable, so the tie really does fall
    // through to engine order — which is how `Albert` and `Eddy` won.
    const legacyPick = (list, script) => {
      const want = script === 'han' ? 'zh' : 'en';
      const prefs = script === 'han' ? ['zh-cn', 'zh-hans', 'zh'] : ['en-us', 'en-gb', 'en'];
      const tagOf = v => String(v.lang || '').toLowerCase().replace(/_/g, '-');
      const eligible = list.filter(v => tagOf(v).split('-')[0] === want);
      if (!eligible.length) return null;
      return eligible.slice().sort((a, b) => {
        const sc = v => {
          const at = prefs.indexOf(tagOf(v));
          let s = at >= 0 ? (prefs.length - at) * 10 : 1;
          if (v.localService) s += 3;
          if (v.default) s += 1;
          return s;
        };
        return sc(b) - sc(a);
      })[0];
    };

    const show = v => (v ? `${v.name} [${v.lang}]${v.locales !== undefined ? ` 语种数=${v.locales}` : ''}` : '(无 → 拒绝朗读)');
    const zhPick = pickVoice(inv.zh.length ? inv.zh : inv.en, 'han');
    const enPick = pickVoice(inv.en, 'latin');
    console.log('  旧规则（本轮已修）中文 → ' + show(legacyPick(inv.zh, 'han')) +
                '   英文 → ' + show(legacyPick(inv.en, 'latin')));
    console.log('  新规则（现行）    中文 → ' + show(zhPick) +
                '   英文 → ' + show(enPick));
    console.log(`  中文并列同分（旧规则按引擎返回顺序取第一个）: ${inv.zh.filter(v => v.lang === (legacyPick(inv.zh, 'han') || {}).lang).length} 个`);
    // How many of the Chinese candidates are cross-language personas rather than
    // the locale's own voice? This is the number that decides the ranking rule.
    const zhPersonas = inv.zh.filter(v => v.locales > 1).length;
    console.log(`  其中跨语种角色音色: ${zhPersonas} / ${inv.zh.length}；单语种专用: ${inv.zh.length - zhPersonas}`);
    console.log(`  英文候选里的玩具音色: ${inv.en.filter(isNoveltyVoice).length} 个`);
    console.log(`  dominantScript(中文样本) = ${dominantScript(LONG_TEXT)}`);

    // The voice every measurement below uses: the product's own pick for Chinese.
    await cdp.eval(panel, `(() => {
      const vs = speechSynthesis.getVoices();
      const want = ${JSON.stringify(zhPick && zhPick.name)};
      window.__ttsVoice = vs.find(v => v.name === want) || vs.find(v => /^zh/i.test(v.lang || '')) || null;
      return !!window.__ttsVoice;
    })()`, false, true);
    const usedVoice = await cdp.eval(panel, `window.__ttsVoice ? window.__ttsVoice.name + ' [' + window.__ttsVoice.lang + ']' : '(none)'`, false);
    console.log(`  §2/§3 使用的音色: ${usedVoice}`);

    // Measure harness: offsets let us report "characters advanced" for a series.
    await cdp.eval(panel, `(() => { ${SPEAK_SERIES} return true; })()`, false, true);
    const setupSeries = (texts) => cdp.eval(panel, `(() => {
      window.__ttsOffsets = ${JSON.stringify(texts.map((_, i) => texts.slice(0, i).reduce((a, s) => a + s.length, 0)))};
      window.__ttsLens = ${JSON.stringify(texts.map(t => t.length))};
      return true;
    })()`, false, true);

    // ================= §2 short control, long one-shot, chunked =================
    //
    // The SHORT control is not decoration. Without it, "nothing advanced in 60 s"
    // has two indistinguishable readings: the environment cannot synthesise at
    // all (headless Chrome with no audio device), or long utterances specifically
    // stall. One 12-character sentence separates them, and the whole conclusion
    // below depends on that separation.
    const { splitForSpeech } = await import('../shared/speech.js');
    const { chunks } = splitForSpeech(LONG_TEXT);
    const chunkTexts = chunks.map(c => c.text);
    const RATE = 1;
    console.log(`\n=== §2 短句对照 / 整篇一条 / 切成 ${chunkTexts.length} 段（各自最多跑 ${Math.round(BUDGET / 1000)}s，rate=${RATE}）===`);
    console.log(`  分块长度: ${chunkTexts.map(t => t.length).join(', ')}`);

    const offsetsOf = texts => texts.map((_, i) => texts.slice(0, i).reduce((a, s) => a + s.length, 0));

    const runVariant = async (label, texts) => {
      const offsets = offsetsOf(texts);
      const lens = texts.map(t => t.length);
      const totalChars = lens.reduce((a, b) => a + b, 0);
      await cdp.eval(panel, `(() => { window.__ttsOffsets = ${JSON.stringify(offsets)};
        window.__ttsLens = ${JSON.stringify(lens)}; return true; })()`, false, true);
      // Fire and forget: the promise resolves only when the whole series ends, so
      // it must never gate observation (see the note above SPEAK_SERIES).
      cdp.eval(panel, `window.__ttsStart(${JSON.stringify(texts)}, ${RATE}, window.__ttsOffsets, window.__ttsLens)`, false).catch(() => {});
      const t0 = Date.now();
      const samples = [];
      while (Date.now() - t0 < BUDGET) {
        await sleep(2500);
        const s = await cdp.eval(panel, `window.__ttsSnap && window.__ttsSnap()`, false).catch(() => null);
        if (!s) continue;
        samples.push(s);
        if (s.finished) break;
      }
      const snap = await cdp.eval(panel, `(() => {
        const st = window.__ttsLog || { log: [] };
        const r = { ev: st.log.length };
        speechSynthesis.cancel();
        return r;
      })()`, false).catch(() => ({ ev: 0 }));
      await sleep(250);
      const log = await cdp.eval(panel, `(window.__ttsLog && window.__ttsLog.log) || []`, false).catch(() => []);
      const gaps = [];
      for (let i = 1; i < log.length; i++) gaps.push(log[i].t - log[i - 1].t);
      const sorted = gaps.slice().sort((a, b) => a - b);
      const last = samples[samples.length - 1] || {};
      const info = {
        label, totalChars, texts: texts.length,
        advancedChars: last.chars || 0,
        utterancesEnded: last.done || 0,
        boundaryEvents: log.filter(e => e.k === 'boundary').length,
        starts: log.filter(e => e.k === 'start').length,
        errors: log.filter(e => e.k === 'error').map(e => e.why),
        maxGapMs: gaps.length ? Math.max(...gaps) : 0,
        p90GapMs: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0,
        finished: !!last.finished,
        speakingAtEnd: !!last.speaking
      };
      console.log(`  ${label}`);
      console.log(`    窗口内推进字数 : ${info.advancedChars} / ${totalChars}`);
      console.log(`    已完成 / 总段数: ${info.utterancesEnded} / ${texts.length}`);
      console.log(`    start / boundary 事件: ${info.starts} / ${info.boundaryEvents}`);
      console.log(`    事件间隔 max/p90: ${info.maxGapMs}ms / ${info.p90GapMs}ms`);
      console.log(`    窗口内读完: ${info.finished}；窗口结束时仍在校读: ${info.speakingAtEnd}`);
      if (info.errors.length) console.log(`    error 事件: ${info.errors.slice(0, 4).join(', ')}`);
      return info;
    };

    const short = await runVariant('【短句对照】12 字', ['你好，这是一句很短的话。']);
    const oneShot = await runVariant('【A】整篇作为一条 utterance', [LONG_TEXT]);
    const chunked = await runVariant(`【B】按句切成 ${chunkTexts.length} 段排队`, chunkTexts);

    console.log('\n  ⇒ 判定：');
    // Three outcomes, and the third one matters: with no audio device the engine
    // accepts an utterance and reports `speaking`, but `onboundary` never fires and
    // nothing ever reaches `end`, so "0 characters advanced" says nothing at all
    // about long utterances. The first version of this script treated that as
    // evidence against the length hypothesis and printed a conclusion — a probe
    // that cannot distinguish "not measured" from "measured as false" is worse
    // than no probe.
    const shortOk = short.utterancesEnded >= 1 || short.advancedChars > 0;
    const observedSize = short.totalChars;
    if (!shortOk) {
      console.log('     连 12 字的短句都没有产生任何 start/推进 ⇒ 本环境的 Chrome 根本没能合成');
      console.log('     （headless 无声卡）。§2/§3 的"没推进"是环境属性，不是产品缺陷的证据。');
    } else if (oneShot.utterancesEnded === 0 && chunked.utterancesEnded === 0) {
      console.log(`     短句（${observedSize} 字）能读完，但两个变体在预算内一段都没读完。`);
      console.log(`     原因不是"长 utterance 没问题"，而是**预算比一段音频还短**：`);
      console.log(`     整篇 ${LONG_TEXT.length} 字 ≈ 数分钟，分块后的首段 ${chunkTexts[0].length} 字也 ≈ 30 秒以上，`);
      console.log(`     而本次预算只有 ${Math.round(BUDGET / 1000)} 秒 ⇒ 本环境对 §2 无观测能力。`);
      console.log('     取代它的证据：e2e/diag-voice-audio.cjs —— 直接对系统语音渲染出的音频做');
      console.log('     静音检测，量出引擎自身的分段间隔（这正是分块上限的依据）。');
    } else if (chunked.utterancesEnded > oneShot.utterancesEnded) {
      console.log(`     分块在窗口内读完了 ${chunked.utterancesEnded} 段，整篇读完了 ${oneShot.utterancesEnded} 段`);
      console.log('     ⇒ 长 utterance 确实更慢，分块有效。');
    } else {
      console.log(`     整篇与分块在窗口内各完成 ${oneShot.utterancesEnded} / ${chunked.utterancesEnded} 段`);
      console.log('     ⇒ 在本预算下看不出差别，长 utterance 不是主因；流畅度问题更可能来自音色选择（§1）。');
    }

    // ================= §3 inter-chunk gap =================
    console.log('\n=== §3 排队分块之间的"接缝"有多长 ===');
    const probeChunks = chunkTexts.slice(0, 6);
    const W3 = Math.min(BUDGET, 45000);
    await cdp.eval(panel, `(() => { window.__ttsOffsets = ${JSON.stringify(offsetsOf(probeChunks))};
      window.__ttsLens = ${JSON.stringify(probeChunks.map(t => t.length))}; return true; })()`, false, true);
    cdp.eval(panel, `window.__ttsStart(${JSON.stringify(probeChunks)}, ${RATE}, window.__ttsOffsets, window.__ttsLens)`, false).catch(() => {});
    const t3 = Date.now();
    let last3 = {};
    while (Date.now() - t3 < W3) {
      await sleep(2500);
      last3 = await cdp.eval(panel, `window.__ttsSnap && window.__ttsSnap()`, false).catch(() => null) || last3;
      if (last3.finished) break;
    }
    await cdp.eval(panel, `(() => { speechSynthesis.cancel(); return true; })()`, false).catch(() => {});
    await sleep(250);
    const log3 = await cdp.eval(panel, `(window.__ttsLog && window.__ttsLog.log) || []`, false).catch(() => []);
    const seams = [];
    let lastEnd = null;
    for (const e of log3) {
      if (e.k === 'end') lastEnd = e;
      else if (e.k === 'start' && lastEnd) { seams.push(e.t - lastEnd.t); lastEnd = null; }
    }
    console.log(`  分块 ${probeChunks.length} 段（各 ${probeChunks.map(t => t.length).join('/')} 字），窗口 ${W3 / 1000}s`);
    console.log(`  完成的接缝数 : ${seams.length}`);
    console.log(`  接缝时长     : ${seams.length ? seams.join('ms, ') + 'ms' : '(无接缝可测)'}`);
    if (seams.length) {
      const avg = Math.round(seams.reduce((a, b) => a + b, 0) / seams.length);
      const max = Math.max(...seams);
      console.log(`  平均 / 最大  : ${avg}ms / ${max}ms`);
      console.log(`  ⇒ ${avg <= 120 ? '接缝基本听不出来，可以放心用小分块。' : '接缝可听（>120ms）——分块不能太碎，否则"分块"本身就会变成新的断断续续。'}`);
    }
    console.log(`  （窗口结束时仍在读: ${!!last3.speaking}）`);

    console.log('\n==== 取证结束 ====');
  } catch (e) {
    console.log('DIAG ERROR:', e.message);
    if (e.stack) console.log(e.stack.split('\n').slice(0, 5).join('\n'));
  } finally {
    console.log(await stopChrome(chrome));
    if (FRESH) { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} }
  }
})();
