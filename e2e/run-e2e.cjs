#!/usr/bin/env node
/*
 * OmniSense E2E harness — real browser, real build.
 *
 * Boots a real (headless) Chrome via the DevTools Protocol, loads this folder as
 * an unpacked MV3 extension, and drives the actual product surfaces. Scenarios,
 * in order:
 *
 *   load unpacked
 *   sidepanel: 8 tabs present
 *   sidepanel: every tab activates its panel
 *   sidepanel: tab bar has no scrollbar
 *   sidepanel: i18n switches to English
 *   sidepanel: i18n switches back to Chinese
 *   ui: no literal {{placeholder}} rendered in any panel
 *   sidepanel: Web Speech API available (听网页)
 *   popup: renders with all quick actions
 *   options: renders with populated selects
 *   onboarding: title and description differ
 *   onboarding: step advances on click
 *   content script: adblock cosmetic style injected + ad element hidden
 *   adblock: static DNR ruleset enabled
 *   privacy: scan returns a risk
 *   readability: GET_ARTICLE returns an article
 *   selection: GET_SELECTION returns the selected text
 *   insert: INSERT_TEXT writes into the page field
 *   capsule: embedding pipeline produces a 384-dim vector
 *   capsule: captured page chunked + embedded into IndexedDB
 *   capsule: semantic search returns the captured page
 *   capsule: passive capture is controlled by the autoRecord setting alone
 *   capsule: 收录本页 explains a non-web page instead of doing nothing
 *   capsule: 收录本页 stores the active article end-to-end
 *   capsule: the panel count matches storage and clears the empty state
 *   capsule: the page saved from the panel is findable by description
 *   capsule: a long Chinese article is stored as several chunks, not one truncated blob
 *   capsule: the Chinese regression fixture can actually tell the two implementations apart
 *   capsule: 全部收录 lists the stored articles without needing a query
 *   capsule: one article is one row, however many chunks it was stored as
 *   capsule: Enter on an empty search box lists everything instead of searching for nothing
 *   capsule: the listing route returns pages with the vectors stripped
 *   capsule: re-capturing a page REPLACES it instead of storing a second copy
 *   capsule: a page captured twice is still one row in the list
 *   capsule: 删除 removes the whole page — every chunk of it — after confirming
 *   ui: download banner interpolates a real size
 *   inference: two MODEL_LOAD messages load the model exactly once
 *   inference: tone click streams real text into the result box
 *   inference: a redundant MODEL_LOAD neither reloads nor breaks generation
 *   failing sendMessage is handled and leaks no unchecked lastError
 *   no unexpected runtime exceptions in any context
 *   no unchecked runtime.lastError (chrome://extensions stays clean)
 *
 * The three inference scenarios exist because an earlier version of this suite
 * only asserted that the offscreen host had *started* (`status !== 'idle'`) —
 * an assertion that an "error" status also satisfies. Together with a stray
 * `--disable-gpu` flag that removed the WebGPU adapter the whole suite reported
 * success while generation could not work at all. The suite now asserts the
 * observable user outcome: actual generated text in the result element.
 *
 * The service worker is deliberately NOT kept warm: cold starts are the exact
 * condition that used to leak a user-visible "Unchecked runtime.lastError:
 * Could not establish connection" entry into chrome://extensions, so the error
 * budget at the end doubles as a regression guard for that bug.
 *
 * Usage:
 *   NODE_PATH=./node_modules \
 *   node e2e/run-e2e.cjs
 *
 * Env:
 *   CHROME_BIN       override the Chrome binary
 *   E2E_HEADED=1     run with a visible window (debugging)
 *   E2E_PORT         remote debugging port (default 9333)
 *   E2E_FRESH=1      use a throwaway profile (re-downloads the model)
 *   E2E_PROFILE      custom profile dir (default /tmp/omni-e2e-profile, kept so
 *                    the WebLLM weight cache survives between runs)
 *   E2E_INFER_MODEL  model id used for the inference scenarios
 *                    (default SmolLM2-360M-Instruct-q4f16_1-MLC: ~380 MB, so the
 *                    suite exercises the real generation path without pulling
 *                    the 1.8 GB shipping default on every cold profile)
 *   E2E_LONG_LANG    'zh' swaps the over-long context-window fixture to Chinese.
 *                    The bug this covers was reported on a Chinese article, and
 *                    CJK costs ~3x the tokens per character, so a Chinese page
 *                    hits the limit at a third of the length.
 */
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');
const { prepareProfile, stopChrome } = require('./lib/profile.cjs');

/**
 * The chunking rule the capsule used before it was language-aware, kept ONLY as a
 * control for the Chinese regression fixture.
 *
 * "More than one chunk was stored" proves nothing on its own — it would also pass
 * on a fixture so short that the old code happened to split it. The fixture is
 * only able to tell the two implementations apart if it produces ONE chunk under
 * the old rule (and, because that chunk was longer than the embedder's window, the
 * article's second half was truncated away). Asserting the control is what makes
 * the fixture meaningful, and it is why this function is here rather than deleted.
 */
function legacyChunkCount(text, chunkSize = 128) {
  const words = String(text || '').split(/\s+/);
  const blocks = [];
  for (let i = 0; i < words.length; i += chunkSize) blocks.push(words.slice(i, i + chunkSize).join(' '));
  return { words: words.length, chunks: blocks.length, blocks };
}

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.resolve(__dirname, '..');
const DEBUG_PORT = Number(process.env.E2E_PORT || 9333);
const HEADED = process.env.E2E_HEADED === '1';
const FRESH = process.env.E2E_FRESH === '1';
const PROFILE = process.env.E2E_PROFILE || '/tmp/omni-e2e-profile';
// Small enough to fetch in ~40s from a cold cache, real enough to exercise the
// whole WebLLM generation path. Overridable so the suite can also be pointed at
// the 1.8 GB shipping model.
const INFER_MODEL = process.env.E2E_INFER_MODEL || 'SmolLM2-360M-Instruct-q4f16_1-MLC';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
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

// ---------------------------------------------------------------- test pages
const ARTICLE_PARAS = [
  'The OmniSense extension keeps every model on the local device, which means the browser never has to upload a single byte of the page you are reading to a remote service. This is the central promise of the product and the reason the architecture looks the way it does.',
  'A browser extension that performs inference locally has to solve three separate problems: where the model runs, how the weights are stored, and how the user interface stays responsive while a large model streams tokens back into a panel. Each of those problems has more than one acceptable answer.',
  'The inference host is an offscreen document. Manifest V3 service workers cannot hold a long-lived WebGPU context reliably, and they are terminated aggressively when idle, so putting a multi-gigabyte language model directly in the worker is a recipe for random mid-generation failures.',
  'Embeddings are produced by a much smaller sentence transformer that runs through ONNX Runtime compiled to WebAssembly. The runtime and its loader are vendored into the package so that nothing has to be fetched from a content delivery network at runtime, which the extension content security policy would block anyway.',
  'Retrieval works by chunking captured page text, embedding each chunk, and persisting the vectors in IndexedDB alongside the source URL, title and timestamp. A query is embedded the same way and ranked by cosine similarity against every stored vector.',
  'Advertising and tracker filtering is implemented with the declarative network request API for network level blocking and with a small cosmetic content script for element hiding. The cosmetic rules are shipped as a static subset of a public filter list.',
  'Privacy reporting is deliberately local and heuristic. The content script inspects script and link hosts, hidden form fields, cookie related code and the set of external domains, then assigns a coarse risk level. It never transmits the result anywhere.',
  'Text to speech uses the Web Speech API, so the available voices depend entirely on the operating system. There is no bundled speech model, and the extension is explicit about that limitation rather than pretending to ship one.',
];
const ARTICLE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>The OmniSense End-to-End Test Article</title>
<meta name="description" content="A long form article used to exercise the readability extractor.">
</head><body>
<header><nav><a href="/">Home</a><a href="/article">Article</a></nav></header>
<main>
<article>
  <h1 id="article-title">The OmniSense End-to-End Test Article</h1>
  <p class="byline">By The Test Suite</p>
  ${ARTICLE_PARAS.map(p => `<p>${p}</p>`).join('\n  ')}
</article>
</main>
<footer><p>Footer noise that Readability should discard.</p></footer>
</body></html>`;

const TRACKER_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OmniSense E2E - Tracker Page</title>
<script src="https://www.google-analytics.com/analytics.js"></script>
<script src="https://connect.facebook.net/en_US/fbevents.js"></script>
</head><body>
<h1 id="page-title">OmniSense Tracker Page</h1>
<p>${'This is a fairly long paragraph of readable article content used for testing the privacy scanner. '.repeat(10)}</p>
<form action="/"><input type="hidden" name="csrf_token" value="x"><input type="text" id="q" name="q"></form>
<div class="ad-banner">advertisement</div>
<div id="google_ads_iframe_1">advertisement</div>
</body></html>`;

/* A page on a topic NOTHING else in the index is about.
 *
 * The "saved page is findable by description" scenario cannot use the shared
 * test article: every fixture in this suite (and every fixture from previous
 * runs, since the profile keeps its IndexedDB) is about local inference, so a
 * description like "a long form article about local inference" legitimately
 * matches dozens of stored chunks and there is no reason the one just saved
 * would make the top 10. That made a healthy search look broken.
 *
 * A distinct topic makes the assertion mean what it says: describe a page you
 * saved, and get that page back. */
const UNIQUE_TOPIC_PARAS = [
  'The lighthouse keeper of Skerryvore records the wind every four hours in a ledger bound in green canvas, and has done so since the automated lamp was installed.',
  'Storm shutters on the west face are inspected each Tuesday, because salt spray works its way into the hinge barrels and stiffens them over a single winter season.',
  'A hand-cranked foghorn stands in the outbuilding as a backup to the electric siren, tested on the first Monday of every month for ninety seconds.',
  'Gulls nest on the northern ledge between April and July, so that stretch of the outer walkway is closed to visitors and marked with a painted stripe.'
];
const UNIQUE_TITLE = 'Skerryvore Lighthouse Maintenance Log';
const UNIQUE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${UNIQUE_TITLE}</title>
<meta name="description" content="Lighthouse maintenance notes for the Skerryvore light."></head>
<body><header><nav>noise</nav></header><main><article>
<h1 id="article-title">${UNIQUE_TITLE}</h1>
${UNIQUE_TOPIC_PARAS.concat(UNIQUE_TOPIC_PARAS).map(p => `<p>${p}</p>`).join('\n')}
</article></main><footer>footer noise</footer></body></html>`;

/* A Chinese article, so the two languages under test cannot be confused with one
 * another.
 *
 * 听网页 kept reading the ENGLISH article it captured when the panel first loaded
 * while the user was looking at a Chinese page, and it chose its voice with a
 * hard-coded `zh` lookup that matched regardless of the text. Asserting "the right
 * language was read with the right voice" requires two fixtures whose languages
 * differ, and whose titles are checkable by simple string search. */
const ZH_TITLE = '本地优先的浏览器助手实现记录';
const ZH_PARAS = [
  'OmniSense 把全部模型都放在本机运行，浏览器不会把你正在阅读的页面内容上传到任何远程服务，这是整套架构围绕展开的核心承诺。',
  '推理引擎寄生在一个离屏文档里，因为清单第三版的服务工作线程无法长期持有图形加速上下文，而且一旦空闲就会被强制回收。',
  '离线语音朗读依赖操作系统自带的语音合成能力，因此可用音色、音质以及支持的语言，完全取决于用户本机安装了哪些语音包。',
  '如果本机没有安装中文语音，那么用英文音色去朗读中文正文就会显得含混不清，这不是扩展本身的缺陷，但界面上必须把这件事说清楚。',
  '检索会先把抓取的正文切成块，为每一块生成向量，并把向量连同来源网址、页面标题和时间戳一起保存，查询时再按余弦相似度排序。'
];
const ZH_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${ZH_TITLE}</title>
<meta name="description" content="用于验证朗读语言选择的中文长文。"></head>
<body><header><nav>站点导航噪声</nav></header><main><article>
<h1 id="article-title">${ZH_TITLE}</h1>
<p class="byline">由测试套件提供</p>
${ZH_PARAS.map(p => `<p>${p}</p>`).join('\n')}
</article></main><footer><p>页脚噪声，正文提取应当丢弃这一段。</p></footer></body></html>`;

const ARTICLE_TITLE = 'The OmniSense End-to-End Test Article';

/* A LONG Chinese article whose memorable detail sits in its FINAL paragraph.
 *
 * This fixture exists for one specific regression, and only this shape of fixture
 * can catch it. The capsule used to chunk by whitespace — `text.split(/\s+/)`
 * grouped into 128-"word" blocks — and Chinese puts no spaces between words, so
 * the only `\s` in an article like this are its paragraph breaks. The whole page
 * therefore became ONE chunk, which the 512-token embedder then truncated: the
 * first quarter was indexed, the rest was never stored at all, and a search for
 * anything the article said later could not match it no matter how it was phrased.
 *
 * So a short Chinese fixture proves nothing here (it was one chunk before and one
 * chunk after), and a fixture with the distinctive content at the START would pass
 * under both implementations. The marker has to be at the END, and the article has
 * to be long enough to need several chunks. */
const ZH_LONG_TITLE = '离线优先架构的长期观测记录';
const ZH_LONG_MARK = '冬至之前必须更换全部灯芯';
const ZH_LONG_PARAS = [
  '把推理放进浏览器这件事，最初只是一个性能上的好奇心，后来才慢慢变成一条必须坚持的产品约束，因为凡是离开本机的内容都无法再声称属于用户。',
  '最早的一版实现把模型放在远端，界面响应很快，直到有人问起请求里到底带了什么，才发现整篇正文都被序列化后发了出去，而界面上没有任何提示。',
  '换成离屏文档承载模型之后，第一件要处理的事情是生命周期，服务工作线程会被浏览器随时回收，离屏文档却可以长期存在，两者的生命周期并不对齐。',
  '向量检索的部分比生成部分更早落地，因为嵌入模型体积小、启动快，而且它的输入输出都是确定性的，调试的时候不需要等待采样，问题定位要容易得多。',
  '分块策略最初沿用了一套按空白切词的通用做法，在英文语料上表现正常，却完全没有考虑中文书写里词与词之间并不使用分隔符这一基本事实。',
  '于是同一篇文章在两种语言下得到的表示截然不同，英文被切成大小均匀的若干段，中文则整篇挤进一段，超出窗口的部分被静默丢弃，没有任何日志。',
  '这种缺陷之所以难以发现，是因为界面上显示的数字依然合理，收录计数在增长，片段预览也总是文章开头那几行，看上去一切正常，只是搜不到后半篇的内容。',
  '真正的线索来自使用者的描述，他说明明收藏了那篇文章，却怎么也想不出该如何把它找回来，而这恰恰说明问题不在搜索，而在于那部分内容从未进入索引。',
  '修正的方向并不复杂，只要让切分规则认识语言差异即可，拉丁文继续按词计量，中日韩文本改按字符计量，并让每一段的长度落在模型窗口之内。',
  '窗口容量是需要认真对待的数字，嵌入模型的上下文长度是固定的，短文本按字符数估算大致准确，长文本一旦越界就会被截断，而截断本身不会有任何报错。',
  '另一个容易被忽略的细节是记录之间的去重，同一篇文章会被切成多段分别保存，如果不按来源网址与时间戳把它们归并，检索结果里就会出现好几条几乎一样的条目。',
  '归并之后，界面上的每一行才真正对应一个页面，段落数量作为附注显示在旁边，既不喧宾夺主，也让人能看懂上面那行统计数字究竟在数什么。',
  '回顾整个过程，最值得保留的经验是先把现象量化，再去改动实现，否则很容易在错误的方向上反复调整参数，把一个本来清晰的缺陷越改越模糊。',
  '守夜人的排班表贴在灯室门后，字迹被海风与油烟熏得发黄，但' + ZH_LONG_MARK + '这一条始终清晰可辨，因为它是整套维护流程里最不能出错的一步。'
];
const ZH_LONG_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${ZH_LONG_TITLE}</title>
<meta name="description" content="用于验证中文长文分块的中文长文。"></head>
<body><header><nav>站点导航噪声</nav></header><main><article>
<h1 id="article-title">${ZH_LONG_TITLE}</h1>
<p class="byline">由测试套件提供</p>
${ZH_LONG_PARAS.map(p => `<p>${p}</p>`).join('\n')}
</article></main><footer><p>页脚噪声，正文提取应当丢弃这一段。</p></footer></body></html>`;

/* An over-long article, for the context-window regression.
 *
 * The reported failure was
 *   Prompt tokens exceed context window size: number of prompt tokens: 4338;
 *   context window size: 4096
 * on an ordinary article, with the raw string rendered inside the 文章总结 result
 * box. The cause was that the prompt builder capped the article by CHARACTER
 * COUNT — `article.substring(0, 10000)` — which is not a token budget and, for
 * Chinese, is near enough a 1:1 token ratio. The prompt therefore could not fit
 * the window and the request was rejected before a single token was generated.
 *
 * ARTICLE_PARAS is only ~600 tokens: it fits comfortably and so never exercised
 * that cap, which is exactly why the suite was green while the feature was
 * broken for anyone reading a real article. This fixture is several times larger
 * so the long-input path is guaranteed to run — including against the small
 * model this suite uses, whose window (2048) is half the shipping model's.
 *
 * E2E_LONG_LANG=zh selects a Chinese fixture of comparable token weight. That
 * case matters on its own: the bug was reported on a Chinese article, and CJK
 * costs roughly three times as many tokens per character as ASCII, so a Chinese
 * page reaches the limit at a third of the length. */
const LONG_SECTIONS_EN = [
  'An offscreen document is the only place in a Manifest V3 extension where a WebGPU device can be kept alive for minutes at a time. Service workers are evicted on an idle timer that the extension cannot influence, and an eviction in the middle of a token stream leaves the user interface waiting forever for a completion that will never arrive.',
  'Model weights are stored by the runtime in the browser cache rather than in the extension package, because bundling several gigabytes into a store submission is not permitted. The first run therefore downloads, and every later run reads from the cache, which is why a persistent browser profile makes the difference between a forty second start and an instant one.',
  'Embeddings come from a small sentence transformer executed through ONNX Runtime compiled to WebAssembly. The runtime, its loader and the model are all vendored into the extension so that no request has to leave the device at inference time, and so that the content security policy does not silently block a runtime fetch that would otherwise succeed in a normal page.',
  'Retrieval chunks captured text, embeds each chunk, and stores the vector beside the source URL, the page title and a timestamp. A query is embedded through the same pipeline and ranked by cosine similarity against every stored vector, which makes recall depend on the quality of the sentence transformer rather than on keyword overlap.',
  'Filtering is layered. Network level blocking uses declarative rules that the browser evaluates before a request is issued, while element hiding is performed by a small content script that injects a stylesheet built from a static subset of a public filter list. Neither layer ever sees the text of a page.',
  'The privacy report is heuristic and entirely local. A content script inspects script and link hosts, hidden form fields, cookie related calls and the set of external domains, then assigns a coarse risk level. The report is advisory: a site can be flagged for a legitimate analytics deployment, and a site can be clean while still behaving badly.',
  'Speech synthesis is delegated to the operating system through the Web Speech API, so the available voices, their quality and their languages all depend on what the user has installed. There is no bundled acoustic model. The interface states this rather than implying a capability the extension does not have.',
  'Every long running operation reports progress. Downloads show a percentage, chunked summarisation shows which part is being processed, and a failure is written into the result box as well as shown as a transient notice, because a notice disappears after a couple of seconds and leaves the user looking at an empty panel with no explanation of what happened.'
];

const LONG_SECTIONS_ZH = [
  '离屏文档是清单第三版扩展里唯一能长时间持有图形加速设备的地方。服务工作线程会在空闲计时器到期时被回收，而这个计时器扩展完全无法干预；一旦回收发生在生成过程中，界面就会永远等待一个再也不会到来的结果。',
  '模型权重由运行时存放在浏览器缓存里，而不是打进扩展包内，因为把好几千兆的文件塞进应用商店的提交包是不被允许的。因此首次使用需要下载，之后每次运行都直接读缓存，这也是为什么保留浏览器配置目录会让启动时间从天壤之别。',
  '向量嵌入来自一个很小的句子变换器，它通过编译成网页汇编的推理运行时执行。运行时、加载器和模型全部随扩展一起分发，这样推理时不需要发出任何请求，内容安全策略也不会悄悄拦掉一个在普通页面里本来可以成功的资源加载。',
  '检索会先把抓取的正文切成块，为每一块生成向量，并把向量连同来源网址、页面标题和时间戳一起保存。查询用同一条流水线生成向量，再按余弦相似度与所有已存向量排序，因此召回效果取决于句子变换器的质量，而不是关键词是否重合。',
  '过滤是分层的。网络层拦截使用声明式规则，浏览器在请求发出之前就会判定；元素隐藏则由一个很小的内容脚本完成，它注入一张由公开过滤列表静态子集生成的样式表。两层都不会读取页面的正文内容。',
  '隐私报告是启发式的，而且完全在本地完成。内容脚本会检查脚本与链接的主机名、隐藏表单字段、与 Cookie 相关的调用以及外部域名集合，然后给出一个粗略的风险等级。报告仅供参考：一个站点可能因为合规的分析部署被标记，也可能表现很糟却看起来很干净。',
  '语音朗读通过网页语音接口交给操作系统完成，因此可用音色、质量以及支持的语言都取决于用户本机装了什么。扩展没有内置声学模型，界面上也是这么说明的，而不是暗示一个并不具备的能力。',
  '每一个耗时较长的操作都会报告进度：下载显示百分比，分段摘要显示正在处理第几部分，失败既写进结果框也弹一条即时提示，因为提示两秒后就消失了，只留下一个空面板和一个不知道为什么的用户。'
];

const LONG_LANG = process.env.E2E_LONG_LANG === 'zh' ? 'zh' : 'en';
const LONG_SECTIONS = LONG_LANG === 'zh' ? LONG_SECTIONS_ZH : LONG_SECTIONS_EN;
const LONG_TITLE = LONG_LANG === 'zh'
  ? '关于打造一个本地优先的浏览器助手的一些记录'
  : 'Notes on Building a Local-First Browser Assistant';
const LONG_PARAS = [];
for (let i = 0; i < 4; i++) {
  LONG_SECTIONS.forEach((s, j) => LONG_PARAS.push(LONG_LANG === 'zh'
    ? `第 ${i + 1} 部分第 ${j + 1} 节。${s}`
    : `Part ${i + 1}.${j + 1}. ${s}`));
}
const LONG_PAGE = `<!doctype html><html lang="${LONG_LANG}"><head><meta charset="utf-8"><title>${LONG_TITLE}</title>
<meta name="description" content="A deliberately over-long article used to exercise the context window budget."></head>
<body>
<header><nav><a href="/">Home</a><a href="/long">Notes</a></nav></header>
<main><article>
<h1 id="article-title">${LONG_TITLE}</h1>
<p class="byline">By The Test Suite</p>
${LONG_PARAS.map(p => `<p>${p}</p>`).join('\n')}
</article></main>
<footer><p>Footer noise that Readability should discard.</p></footer>
</body></html>`;

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (req.url.startsWith('/article')) return res.end(ARTICLE_PAGE);
      if (req.url.startsWith('/zh-long')) return res.end(ZH_LONG_PAGE);
      if (req.url.startsWith('/zh')) return res.end(ZH_PAGE);
      if (req.url.startsWith('/lighthouse')) return res.end(UNIQUE_PAGE);
      if (req.url.startsWith('/long')) return res.end(LONG_PAGE);
      res.end(TRACKER_PAGE);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------------------------------------------------------------- CDP client
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.pending = new Map();
    this.sessionByTarget = new Map();
    this.sessions = new Map();          // url -> sessionId (best effort)
    this.targets = new Map();           // targetId -> targetInfo
    this.exceptions = [];
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
      this.send('Log.enable', {}, s);
      // Enabling the Page domain lets a scenario navigate an existing tab in
      // place (Page.navigate). That is the only way to reproduce the reported
      // situation, where the side panel stays open across a navigation and must
      // notice that the page underneath it changed.
      this.send('Page.enable', {}, s);
      this.send('Runtime.runIfWaitingForDebugger', {}, s);
    } else if (m.method === 'Target.detachedFromTarget') {
      // MV3 recycles an idle service worker, which detaches its CDP session.
      // Without pruning, sessionByTarget/sessions keep handing out a dead
      // session id and every later Runtime.evaluate dies with
      // "-32001 Session with given id not found" — which is exactly how a whole
      // run used to collapse the moment the worker went idle.
      const s = m.params.sessionId;
      for (const [k, v] of [...this.sessionByTarget]) if (v === s) this.sessionByTarget.delete(k);
      for (const [k, v] of [...this.sessions]) if (v === s) this.sessions.delete(k);
      this.detaches = (this.detaches || 0) + 1;
    } else if (m.method === 'Runtime.exceptionThrown') {
      const p = m.params.exceptionDetails;
      const txt = (p.exception && p.exception.description || p.text || '').split('\n')[0];
      this.exceptions.push(txt);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      this.exceptions.push(m.params.entry.text + ' @ ' + (m.params.entry.url || ''));
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
      const desc = d.exception?.description || d.text || 'unknown';
      const frames = (d.stackTrace?.callFrames || [])
        .slice(0, 4)
        .map(f => `${f.functionName || '(anon)'}@${(f.url || '').split('/').pop()}:${(f.lineNumber ?? 0) + 1}`)
        .join(' <- ');
      throw new Error(`${desc}${frames ? ' [' + frames + ']' : ''}`);
    }
    return r.result ? r.result.result.value : undefined;
  }
  async waitSession(urlSubstr, timeoutMs = 8000) {
    return waitFor(() => {
      for (const [url, s] of this.sessions) if (url.includes(urlSubstr)) return s;
      return null;
    }, timeoutMs, 100).catch(() => null);
  }
  /** Drop a session we have proved dead, so waitSession re-resolves a live one. */
  forgetSession(urlSubstr) {
    const dead = new Set();
    for (const [url, s] of [...this.sessions]) {
      if (url.includes(urlSubstr)) { this.sessions.delete(url); dead.add(s); }
    }
    for (const [t, s] of [...this.sessionByTarget]) if (dead.has(s)) this.sessionByTarget.delete(t);
    return dead.size;
  }
  /**
   * Bring a target to the front in its window.
   *
   * Needed because the side panel resolves "the page I am acting on" with
   * chrome.tabs.query({active:true,currentWindow:true}) — i.e. whichever tab is
   * focused. Relying on the implicit focus that Target.createTarget happens to
   * apply would make those scenarios depend on undocumented behaviour, so the
   * focus is set explicitly instead.
   */
  async activate(sessionId) {
    for (const [targetId, s] of this.sessionByTarget) {
      if (s === sessionId) {
        await this.send('Target.activateTarget', { targetId });
        return true;
      }
    }
    return false;
  }
  /**
   * Navigate an EXISTING tab.
   *
   * Opening a second target is not the same thing: a side panel is not reloaded
   * by a page navigation, so moving the page underneath an already-open panel is
   * a distinct code path from the panel being opened on a fresh tab, and it is
   * the one the user reported.
   */
  async navigate(sessionId, url) {
    await this.send('Page.navigate', { url }, sessionId);
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

// ---------------------------------------------------------------- scenarios
const CAPTURE_MARKER = 'OmniSense capsule round trip marker';
const CAPTURE_TEXT = `${CAPTURE_MARKER}. ` + (
  'Local semantic search stores embeddings for every captured page chunk inside the browser, ' +
  'and a natural language query is ranked against them using cosine similarity, so the user can ' +
  'find a page again by describing roughly what it said instead of recalling an exact phrase. ' +
  'Nothing leaves the device at any point in this workflow.'
);
const PASSIVE_MARKER = 'OmniSense passive capture regression marker';
const PASSIVE_TEXT = `${PASSIVE_MARKER}. ` + (
  'The passive capture path must be gated by the autoRecord setting and by nothing else. ' +
  'It previously also required an optional browsing history permission that the product never ' +
  'used anywhere, so every passive capture was dropped silently with no error surfaced in any ' +
  'part of the interface.'
);

(async () => {
  // The product's own chunking rule, loaded from the module the inference host
  // imports — so the Chinese regression assertion compares what was stored against
  // the rule that produced it, not against a second copy of that rule living in
  // this harness. (A harness that re-guesses a unit the product owns is the bug
  // class TEST_REPORT.md §5.8 records.)
  const { chunkForEmbedding } = await import(
    pathToFileURL(path.resolve(__dirname, '../shared/capsule-chunk.js')).href);
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  // A persistent profile keeps the WebLLM weight cache between runs, so the
  // inference scenarios cost one download and then run in seconds. It must
  // however be scrubbed of Chrome's cached extension service-worker script
  // first, or the suite silently tests the PREVIOUS build's background.js:
  // that produced "port closed" errors for routes that exist on disk, and made
  // correct fixes look broken. See e2e/lib/profile.cjs.
  const userDataDir = FRESH ? fs.mkdtempSync(path.join(os.tmpdir(), 'omni-e2e-')) : PROFILE;
  const profileNote = FRESH ? `profile: ${userDataDir} (fresh)` : prepareProfile(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log(profileNote);

  const args = [
    ...[HEADED ? [] : ['--headless=new']],
    // NOTE: do NOT pass --disable-gpu. WebLLM needs a real WebGPU adapter, and
    // disabling the GPU made the inference scenario fail with
    // "WebGPUNotFoundError" while the old, weak assertion still passed because
    // it only checked that the status was not 'idle'.
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--enable-unsafe-extension-debugging',
    'about:blank'
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });

  let cdp;
  try {
    const ver = await waitForPort(DEBUG_PORT);
    console.log('Chrome:', ver.Browser);
    cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.setup();

    // ---- 1. load unpacked
    const load = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    const extId = load.result && (load.result.id || load.result.extensionId);
    record('load unpacked', !!extId, extId ? `id=${extId}` : JSON.stringify(load));
    if (!extId) throw new Error('extension failed to load');

    const localUrl = p => `chrome-extension://${extId}/${p}`;

    // ---- 2..4 sidepanel
    const panel = await cdp.openTarget(localUrl('sidepanel/sidepanel.html'));
    await waitFor(() => cdp.eval(panel, `!!document.querySelector('#tabs [data-tab]')`, false), 8000);

    const tabs = await cdp.eval(panel, `(() => {
      const btns = [...document.querySelectorAll('#tabs [data-tab]')];
      return { count: btns.length, ids: btns.map(b => b.dataset.tab) };
    })()`, false);
    record('sidepanel: 8 tabs', tabs && tabs.count === 8, JSON.stringify(tabs && tabs.ids));

    const switching = await cdp.eval(panel, `(() => {
      const ids = [...document.querySelectorAll('#tabs [data-tab]')].map(b => b.dataset.tab);
      const out = {};
      for (const id of ids) {
        document.querySelector('#tabs [data-tab="' + id + '"]').click();
        const active = document.querySelector('.panel.active');
        out[id] = active ? active.dataset.panel : null;
      }
      return out;
    })()`, false);
    const allSwitch = Object.entries(switching || {}).every(([k, v]) => k === v);
    record('sidepanel: every tab activates its panel', allSwitch, JSON.stringify(switching));

    const scroll = await cdp.eval(panel, `(() => {
      const el = document.getElementById('tabs');
      const cs = getComputedStyle(el);
      return { overflowX: cs.overflowX, scrollW: el.scrollWidth, clientW: el.clientWidth };
    })()`, false);
    record('sidepanel: tab bar has no scrollbar',
      scroll && !['auto', 'scroll'].includes(scroll.overflowX) && scroll.scrollW <= scroll.clientW + 1,
      JSON.stringify(scroll));

    // ---- 5..6 i18n both directions
    await cdp.eval(panel, `chrome.storage.local.set({'omnisense.locale':'en'}).then(()=>true)`);
    await cdp.eval(panel, `location.reload()`, false).catch(() => {});
    await sleep(1600);
    const enText = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => { const b = document.querySelector('#tabs [data-tab]'); return b ? b.textContent : ''; })()`, false);
      return s || null;
    }, 6000, 300);
    record('sidepanel: i18n switches to English', !!enText && !/[\u4e00-\u9fff]/.test(enText), `first tab = "${enText}"`);

    await cdp.eval(panel, `chrome.storage.local.set({'omnisense.locale':'zh'}).then(()=>true)`);
    await cdp.eval(panel, `location.reload()`, false).catch(() => {});
    await sleep(1600);
    const zhText = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => { const b = document.querySelector('#tabs [data-tab]'); return b ? b.textContent : ''; })()`, false);
      return s || null;
    }, 6000, 300);
    record('sidepanel: i18n switches back to Chinese', !!zhText && /[\u4e00-\u9fff]/.test(zhText), `first tab = "${zhText}"`);

    // ---- 7 no un-interpolated {{placeholder}} anywhere in the rendered UI
    // A data-i18n target whose dictionary value contains {{args}} but which
    // supplies no data-i18n-<arg> attributes renders the literal braces
    // ("本次已拦截：{{requests}} 个请求"). Walk every tab so each panel is
    // actually laid out, then look for braces in the visible text.
    const braceScan = await cdp.eval(panel, `(() => {
      const tabs = [...document.querySelectorAll('#tabs [data-tab]')].map(b => b.dataset.tab);
      const found = [];
      let total = 0;
      for (const id of tabs) {
        document.querySelector('#tabs [data-tab="' + id + '"]').click();
        for (const el of document.querySelectorAll('.panel.active, .panel.active *')) {
          const txt = (el.childElementCount === 0 ? el.textContent : '') || '';
          if (!txt.trim()) continue;
          const m = txt.match(/\\{\\{[^}]*\\}\\}/g);
          if (m) found.push(id + ': ' + m[0]);
        }
        total += document.querySelector('.panel.active').innerText.length;
      }
      return { tabs: tabs.length, chars: total, found: [...new Set(found)].slice(0, 6) };
    })()`, false).catch(e => 'THROW:' + e.message);
    record('ui: no literal {{placeholder}} rendered in any panel',
      !!braceScan && typeof braceScan === 'object' && braceScan.found.length === 0 && braceScan.chars > 200,
      JSON.stringify(braceScan));

    // ---- 8 Web Speech API available
    const tts = await cdp.eval(panel, `({
      speech: 'speechSynthesis' in window,
      utterance: typeof SpeechSynthesisUtterance === 'function',
      hasPlayer: !!document.getElementById('ttsPlayer'),
      rates: document.getElementById('ttsRate') ? document.getElementById('ttsRate').options.length : 0
    })`, false);
    record('sidepanel: Web Speech API wired (听网页)', tts && tts.speech && tts.utterance && tts.hasPlayer && tts.rates >= 3, JSON.stringify(tts));

    // ---- 9 popup
    const popup = await cdp.openTarget(localUrl('popup/popup.html'));
    const popupState = await waitFor(async () => {
      const s = await cdp.eval(popup, `(() => {
        const ids = ['btnSummary','btnListen','btnPrivacy','btnAdblock','btnOpenPanel','capsuleSearch','modelStatus'];
        return { present: ids.filter(i => document.getElementById(i)).length, total: ids.length,
                 body: document.body.innerText.trim().length };
      })()`, false);
      return s && s.present === s.total ? s : null;
    }, 8000, 300);
    record('popup: renders with all quick actions', !!popupState, JSON.stringify(popupState));

    // ---- 9 options
    const options = await cdp.openTarget(localUrl('options/options.html'));
    const optState = await waitFor(async () => {
      const s = await cdp.eval(options, `(() => {
        const ids = ['optLang','optDefaultTab','optAutoRecord','optRetention','optClearCapsule',
                     'optModelStatus','optModelGrade','optDownloadModel','optRemoveModel','optAdblock','optUpdateRules'];
        const present = ids.filter(i => document.getElementById(i));
        return { present: present.length, total: ids.length,
                 langOpts: document.getElementById('optLang')?.options.length || 0,
                 tabOpts: document.getElementById('optDefaultTab')?.options.length || 0,
                 gradeOpts: document.getElementById('optModelGrade')?.options.length || 0 };
      })()`, false);
      return s && s.present === s.total && s.langOpts >= 2 && s.tabOpts === 8 ? s : null;
    }, 8000, 300);
    record('options: renders with populated controls', !!optState, JSON.stringify(optState));

    // ---- 10 onboarding
    const onboard = await cdp.openTarget(localUrl('onboarding/onboarding.html'));
    const obBefore = await waitFor(async () => {
      const s = await cdp.eval(onboard, `(() => ({
        steps: document.querySelectorAll('#progress span').length,
        activeCount: document.querySelectorAll('#progress span.active').length,
        title: document.getElementById('obTitle')?.textContent || '',
        desc: document.getElementById('obDesc')?.textContent || '',
        btns: document.querySelectorAll('#obActions button').length
      }))()`, false);
      return s && s.steps === 4 && s.title && s.btns >= 1 ? s : null;
    }, 8000, 300);
    record('onboarding: title and description differ',
      !!obBefore && obBefore.title !== obBefore.desc,
      obBefore ? `title="${obBefore.title}" desc="${obBefore.desc.slice(0, 40)}"` : 'did not render');

    let obAfter = null;
    if (obBefore) {
      await cdp.eval(onboard, `document.querySelector('#obActions button').click()`, false, true).catch(() => {});
      await sleep(700);
      obAfter = await cdp.eval(onboard, `(() => ({
        activeCount: document.querySelectorAll('#progress span.active').length,
        title: document.getElementById('obTitle')?.textContent || ''
      }))()`, false).catch(() => null);
    }
    record('onboarding: step advances on click',
      !!obBefore && !!obAfter && obAfter.activeCount > obBefore.activeCount && obAfter.title !== obBefore.title,
      `before=${JSON.stringify(obBefore && { a: obBefore.activeCount, t: obBefore.title })} after=${JSON.stringify(obAfter && { a: obAfter.activeCount, t: obAfter.title })}`);

    // ---- 11..12 content scripts on a real page
    const page = await cdp.openTarget(`${base}/tracker`);
    await sleep(2500);
    const inject = await cdp.eval(page, `({
      hasCosmeticStyle: !!document.getElementById('omnisense-cosmetic-filter'),
      styleRules: (() => { const s = document.getElementById('omnisense-cosmetic-filter'); return s ? s.textContent.length : 0; })(),
      adHidden: (() => { const el = document.querySelector('.ad-banner'); return el ? getComputedStyle(el).display === 'none' : null; })()
    })`, false);
    record('content: adblock cosmetic style injected', inject && inject.hasCosmeticStyle === true && inject.styleRules > 0, JSON.stringify(inject));
    record('content: ad element hidden', inject && inject.adHidden === true, `ad display none = ${inject.adHidden}`);

    // ---- article page + shared SW handle
    const article = await cdp.openTarget(`${base}/article`);
    await sleep(1500);

    // The MV3 service worker is recycled on its own idle timer; re-resolve its
    // session on every call. We deliberately do NOT keep it warm — service worker
    // cold starts are exactly the condition that used to leak an
    // "Unchecked runtime.lastError" into chrome://extensions, and the error
    // budget assertion at the end must be able to catch a regression.
    //
    // An idle-recycled worker only restarts when an event arrives, and evaluating
    // against a dead session produces no event at all — so a dead session is
    // dropped and the worker is woken with a message from the side panel before
    // retrying. Without this the whole run collapsed at the first recycle.
    const wakeWorker = async () => {
      await cdp.eval(panel, `chrome.runtime.sendMessage({ type: 'PING' }, () => void chrome.runtime.lastError)`, false).catch(() => {});
      await sleep(400);
    };
    /**
     * Force a fresh debugger attach to the service worker.
     *
     * Relying on `Target.setAutoAttach` alone is not enough: once Chrome
     * idle-terminates the worker, its target remains in `Target.getTargets()` but
     * there is no BACKGROUND context any more, and the worker does not restart
     * for a message while a stale debugger attachment exists. The run then dies
     * at the first `swEval` after a quiet stretch with
     * "service worker session unavailable" — and a message sent from the UI gets
     * no reply at all.
     *
     * Attaching explicitly repairs that, and is also what brings the worker back
     * up. It does NOT keep the worker warm, so cold-start behaviour under test is
     * still a real cold start.
     */
    const attachToSW = async () => {
      const r = await cdp.send('Target.getTargets').catch(() => null);
      const infos = (r && r.result && r.result.targetInfos) || [];
      const t = infos.find(x => /background\.js/.test(x.url || ''));
      if (!t) return false;
      await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => {});
      return true;
    };
    const swEval = async (expr, awaitPromise = true) => {
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const s = await cdp.waitSession(`${extId}/background.js`, 5000);
        if (!s) {
          lastErr = new Error('service worker session unavailable');
          await attachToSW();
          await wakeWorker();
          continue;
        }
        try {
          return await cdp.eval(s, expr, awaitPromise);
        } catch (e) {
          if (!/Session with given id not found|Cannot find context|Inspected target navigated or closed/.test(e.message)) throw e;
          cdp.forgetSession(`${extId}/background.js`);
          lastErr = e;
          await attachToSW();
          await wakeWorker();
        }
      }
      // Never fail with a bare "unavailable": say what the worker's state actually
      // was. A missing SW target (Chrome refuses to restart it) and a present-but-
      // unattachable target need completely different fixes, and the error message
      // alone cannot tell them apart.
      const live = [...cdp.targets.values()].map(t => `${t.type}:${String(t.url).replace(/^chrome-extension:\/\/[a-p]{32}/, '')}`);
      const contexts = await cdp.eval(panel, `chrome.runtime.getContexts ? chrome.runtime.getContexts({}).then(cs => cs.map(c => c.contextType).join(',')) : '(unsupported)'`).catch(e => 'ERR ' + e.message);
      // Is the worker merely unattachable, or actually unreachable? A direct
      // PING answers that without needing a debugger session.
      const ping = await cdp.eval(panel, `new Promise((resolve) => {
        const to = setTimeout(() => resolve('NO_RESPONSE'), 8000);
        chrome.runtime.sendMessage({ type: 'PING' }, (r) => {
          clearTimeout(to);
          resolve(chrome.runtime.lastError ? 'ERR: ' + chrome.runtime.lastError.message : 'REPLIED ' + JSON.stringify(r).slice(0, 60));
        });
      })`).catch(e => 'ERR ' + e.message);
      throw new Error(`${lastErr && lastErr.message}\n`
        + `  targets seen by CDP : ${live.length ? live.join(' | ') : '(none)'}\n`
        + `  extension contexts  : ${contexts}\n`
        + `  sessions held       : ${[...cdp.sessions.keys()].join(' | ') || '(none)'}\n`
        + `  detach events       : ${cdp.detaches || 0}\n`
        + `  direct PING from UI : ${ping}`);
    };
    await swEval(`1`);
    const tabIdFor = (frag) => swEval(`(async () => { const ts = await chrome.tabs.query({}); const t = ts.find(x => (x.url||'').includes(${JSON.stringify(frag)})); return t ? t.id : null; })()`);

    // ---- 13 DNR ruleset enabled
    const dnr = await swEval(`chrome.declarativeNetRequest.getEnabledRulesets()`, true).catch(e => 'ERR:' + e.message);
    record('adblock: static DNR ruleset enabled', Array.isArray(dnr) && dnr.includes('easylist-subset'), JSON.stringify(dnr));

    // ---- 14 privacy scan
    const trackerTabId = await tabIdFor('/tracker');
    const privacyRisk = trackerTabId
      ? await swEval(`(async () => {
          const [res] = await chrome.scripting.executeScript({ target: { tabId: ${trackerTabId} }, files: ['content/privacy-scan.js'] });
          return res && res.result ? res.result.risk : 'NO_RESULT';
        })()`).catch(e => 'ERR:' + e.message)
      : 'NO_TAB';
    record('privacy: scan returns a risk', ['low', 'medium', 'high'].includes(privacyRisk), `risk = ${privacyRisk}`);

    // ---- 15 readability / GET_ARTICLE
    const articleTabId = await tabIdFor('/article');
    const art = articleTabId
      ? await swEval(`(async () => {
          const [res] = await chrome.scripting.executeScript({ target: { tabId: ${articleTabId} }, files: ['content/readability-inject.js'] });
          return res && res.result ? { isArticle: res.result.isArticle, len: (res.result.text||'').length, title: res.result.title } : { isArticle: false };
        })()`).catch(e => ({ isArticle: false, err: e.message }))
      : { isArticle: false, err: 'NO_TAB' };
    record('readability: GET_ARTICLE returns an article', art && art.isArticle === true && art.len > 400, JSON.stringify(art));

    // ---- 16 selection
    await cdp.eval(article, `(() => {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('article-title'));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return s.toString();
    })()`, false).catch(() => {});
    const sel = articleTabId
      ? await swEval(`(async () => {
          const [res] = await chrome.scripting.executeScript({ target: { tabId: ${articleTabId} }, func: () => window.getSelection()?.toString() || '' });
          return res && res.result;
        })()`).catch(e => 'ERR:' + e.message)
      : 'NO_TAB';
    record('selection: GET_SELECTION returns the selected text', typeof sel === 'string' && sel.includes('OmniSense End-to-End Test Article'), `selection = "${sel}"`);

    // ---- 17 insert text
    await cdp.eval(page, `document.getElementById('q').focus()`, false).catch(() => {});
    const inserted = trackerTabId
      ? await swEval(`(async () => {
          await chrome.scripting.executeScript({
            target: { tabId: ${trackerTabId} }, args: ['omnisense-e2e-inserted'],
            func: (t) => { const el = document.querySelector('#q'); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; }
          });
          const [check] = await chrome.scripting.executeScript({ target: { tabId: ${trackerTabId} }, func: () => document.querySelector('#q').value });
          return check && check.result;
        })()`).catch(e => 'ERR:' + e.message)
      : 'NO_TAB';
    record('insert: text reaches the page field', inserted === 'omnisense-e2e-inserted', `field value = "${inserted}"`);

    // ---- 18 embedding pipeline
    const panelAlive = await cdp.eval(panel, `({
      href: location.href,
      ready: document.readyState,
      onMessage: typeof chrome?.runtime?.onMessage?.addListener
    })`, false).catch(e => 'PANEL_DEAD: ' + e.message);
    const emb = await cdp.eval(panel, `new Promise((resolve) => {
      const rid = 'e2e_' + Date.now();
      const to = setTimeout(() => resolve('TIMEOUT'), 240000);
      const h = (m) => {
        if (m.type === 'EMBEDDING' && m.requestId === rid) { clearTimeout(to); chrome.runtime.onMessage.removeListener(h); resolve('OK:' + (m.vector ? m.vector.length : 0)); }
        if (m.type === 'INFER_ERROR' && m.requestId === rid) { clearTimeout(to); chrome.runtime.onMessage.removeListener(h); resolve('ERR:' + m.error); }
      };
      chrome.runtime.onMessage.addListener(h);
      chrome.runtime.sendMessage({ type: 'EMBEDDING', requestId: rid, text: 'hello world embedding test' });
    })`).catch(e => 'THROW:' + e.message);
    const embDim = typeof emb === 'string' && emb.startsWith('OK:') ? Number(emb.slice(3)) : 0;
    record('capsule: embedding pipeline produces a 384-dim vector', embDim === 384,
      `result = ${emb} | panel = ${JSON.stringify(panelAlive)}`);

    // ---- 19 capsule: capture -> persisted -> semantic search through the real UI
    const CAP_URL = 'https://example.com/capsule-e2e';
    // The profile (and therefore IndexedDB) survives between runs, so "the store is
    // not empty" is NOT evidence that THIS capture worked — it is equally true one
    // second after the previous run ended. Waiting on it returned immediately, the
    // search below then ran before the new rows landed, and because a search is a
    // one-shot render (the panel does not re-run it when the store changes) the
    // assertion read "no hits" forever. So: remember the newest stamp already on
    // disk for this URL, and wait for a row that is strictly newer than it. Only
    // this capture can produce such a row.
    const capStampBase = await cdp.eval(panel, `(async () => {
      const m = await import(${JSON.stringify(localUrl('shared/idb.js'))});
      const all = await m.idbGetAll('capsule');
      return all.filter(r => r.url === ${JSON.stringify(CAP_URL)})
        .reduce((max, r) => Math.max(max, r.visitTime || 0), 0);
    })()`).catch(() => 0);
    await cdp.eval(panel, `(() => {
      const p = chrome.runtime.connect({ name: 'omni-offscreen' });
      p.postMessage({ type: 'CAPTURE_PAGE', data: { url: ${JSON.stringify(CAP_URL)}, title: 'Capsule E2E Marker', text: ${JSON.stringify(CAPTURE_TEXT)} } });
      window.__capPort = p;
      return true;
    })()`, false).catch(() => {});

    const stored = await waitFor(async () => {
      const n = await cdp.eval(panel, `(async () => {
        const m = await import(${JSON.stringify(localUrl('shared/idb.js'))});
        const all = await m.idbGetAll('capsule');
        return all.filter(r => r.url === ${JSON.stringify(CAP_URL)} && (r.visitTime || 0) > ${capStampBase}).length;
      })()`).catch(() => 0);
      return typeof n === 'number' && n > 0 ? n : null;
    }, 180000, 1500);
    record('capsule: captured page chunked + embedded into IndexedDB', !!stored,
      `rows = ${stored} (for this URL, newer than the newest pre-existing stamp ${capStampBase})`);

    const triggerSearch = () => cdp.eval(panel, `(() => {
      const input = document.getElementById('capsuleInput');
      input.value = 'local semantic search over captured pages';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`, false).catch(() => {});

    await triggerSearch();
    const capHits = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => {
        const items = [...document.querySelectorAll('#capsuleResults .item')];
        return { count: items.length, text: document.getElementById('capsuleResults').innerText.slice(0, 200) };
      })()`, false);
      return s && s.count > 0 ? s : null;
    }, 45000, 1500);
    record('capsule: semantic search returns the captured page',
      !!capHits && capHits.count > 0 && capHits.text.includes('Capsule E2E Marker'),
      capHits ? `${capHits.count} hit(s): ${capHits.text.replace(/\n/g, ' | ').slice(0, 120)}` : 'no hits');

    // ---- 20 offscreen host + single-flight model loading
    //
    // Two MODEL_LOAD messages issued back to back used to start two reloads.
    // WebLLM's `reload()` begins with `unload()`, which aborts the in-flight
    // reload — and the aborted reload() then resolves exactly like a successful
    // one, so the panel received a green "模型已就绪" badge on top of an empty
    // pipeline. Asserting that exactly ONE ready broadcast is emitted is the
    // deterministic part of that bug; scenario 21 asserts the model then works.
    await cdp.eval(panel, `(() => {
      window.__load = { ready: 0, errors: [], progress: 0 };
      chrome.runtime.onMessage.addListener(m => {
        if (m.type === 'MODEL_PROGRESS') window.__load.progress++;
        if (m.type !== 'MODEL_STATUS') return;
        if (m.status === 'ready') window.__load.ready++;
        if (m.status === 'error') window.__load.errors.push(m.text);
      });
      const load = () => chrome.runtime.sendMessage(
        { type: 'MODEL_LOAD', modelId: ${JSON.stringify(INFER_MODEL)} },
        () => void chrome.runtime.lastError);
      load();
      setTimeout(load, 30);
      return true;
    })()`, false).catch(() => {});

    let downloadingBadge = null;
    const modelReady = await waitFor(async () => {
      // NOTE: chrome.runtime.sendMessage from the SW itself is not delivered back
      // to the SW's own onMessage, so PING has to be issued from the UI context.
      const offscreen = await swEval(`chrome.offscreen.hasDocument().catch(() => false)`).catch(() => false);
      const ping = await cdp.eval(panel, `chrome.runtime.sendMessage({ type: 'PING' }).catch(() => null)`).catch(() => null);
      const status = ping && ping.model && ping.model.status;
      const badge = await cdp.eval(panel, `(() => { const el = document.getElementById('modelStatus'); return el ? el.textContent : null; })()`, false).catch(() => null);
      if (status === 'downloading' && !downloadingBadge) downloadingBadge = badge;
      return offscreen && status === 'ready' ? { offscreen, status, badge } : null;
    }, 420000, 2000);
    record('ui: download banner interpolates a real size',
      !!downloadingBadge && /首次约\s*\S/.test(downloadingBadge) && !/首次约\s*，/.test(downloadingBadge),
      `badge="${downloadingBadge}"`);
    const loadStats = await cdp.eval(panel, `({ ready: window.__load.ready, errors: window.__load.errors, progress: window.__load.progress })`, false).catch(() => null);
    record('inference: two MODEL_LOAD messages load the model exactly once',
      !!modelReady && !!loadStats && loadStats.ready === 1 && loadStats.errors.length === 0,
      modelReady
        ? `readyBroadcasts=${loadStats && loadStats.ready} errors=${JSON.stringify(loadStats && loadStats.errors)} progress=${loadStats && loadStats.progress} badge="${modelReady.badge}"`
        : `never reported ready (stats=${JSON.stringify(loadStats)})`);

    // ---- 21 tone: REAL streamed text in the result element
    //
    // The previous version of this assertion only checked that the host had
    // started (`status !== 'idle'`), which an "error" status also satisfies.
    // Combined with a stray --disable-gpu flag in the launch arguments it meant
    // the suite reported success while generation could not work at all.
    await cdp.eval(panel, `(() => {
      document.querySelector('#tabs [data-tab="tone"]').click();
      document.getElementById('toneOutput').textContent = '';
      document.getElementById('toneInput').value = '把这句话改写得更正式一些：今天下午三点开会，请准时参加。';
      document.getElementById('toneBtn').click();
      return true;
    })()`, false, true).catch(() => {});

    const toneResult = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        out: document.getElementById('toneOutput').textContent.trim(),
        actions: getComputedStyle(document.getElementById('toneActions')).display,
        badge: (document.getElementById('modelStatus') || {}).textContent || ''
      }))()`, false).catch(() => null);
      // "本地模型思考中…" is the placeholder, not a result.
      return s && s.out.length > 0 && !/思考中|Thinking/.test(s.out) ? s : null;
    }, 240000, 2000);
    record('inference: tone click streams real text into the result box',
      !!toneResult, toneResult ? `${toneResult.out.length} chars: "${toneResult.out.slice(0, 80)}" actions=${toneResult.actions}` : 'result box stayed empty');

    // ---- 22 a duplicate MODEL_LOAD on a loaded model must be a no-op
    await cdp.eval(panel, `(() => {
      window.__dup = { ready: 0, ends: 0, errors: [] };
      chrome.runtime.onMessage.addListener(m => {
        if (m.type === 'MODEL_STATUS' && m.status === 'ready') window.__dup.ready++;
        if (m.type === 'INFER_END') window.__dup.ends++;
        if (m.type === 'INFER_ERROR') window.__dup.errors.push(m.error);
      });
      const load = () => chrome.runtime.sendMessage(
        { type: 'MODEL_LOAD', modelId: ${JSON.stringify(INFER_MODEL)} },
        () => void chrome.runtime.lastError);
      load();
      setTimeout(load, 30);
      return true;
    })()`, false).catch(() => {});
    await sleep(3000);
    await cdp.eval(panel, `(() => {
      document.getElementById('toneOutput').textContent = '';
      document.getElementById('toneInput').value = '把下面这句话说得更正式：模型可以在本地离线运行。';
      document.getElementById('toneBtn').click();
      return true;
    })()`, false, true).catch(() => {});
    const dupRes = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        ready: window.__dup.ready, ends: window.__dup.ends, errors: window.__dup.errors,
        out: document.getElementById('toneOutput').textContent.trim()
      }))()`, false).catch(() => null);
      return s && (s.ends > 0 || s.errors.length > 0) ? s : null;
    }, 240000, 3000);
    record('inference: a redundant MODEL_LOAD neither reloads nor breaks generation',
      !!dupRes && dupRes.ends > 0 && dupRes.out.length > 0 && dupRes.errors.length === 0 && dupRes.ready === 0,
      dupRes ? `extraReadyBroadcasts=${dupRes.ready} ends=${dupRes.ends} errors=${JSON.stringify(dupRes.errors.slice(0, 2))} out="${dupRes.out.slice(0, 60)}"` : 'no completion within budget');

    // ---------------- Time Capsule capture (regression suite) ----------------
    //
    // Everything below guards the reported question "我怎么添加到我的时光胶囊里面去呢?"
    // The answer had been "you can't": nothing in the product could put anything
    // into the capsule. The passive path additionally required an optional
    // `history` permission that no code ever used, so every capture was dropped
    // silently, and the panel rendered the same empty state whether it was
    // capturing nothing or merely new. There was also no `SettingKeys` entry for
    // `captureNotified`, so the one-off notice fired on every page.
    const capsuleRows = () => cdp.eval(panel, `(async () => {
      const m = await import(${JSON.stringify(localUrl('shared/idb.js'))});
      return (await m.idbGetAll('capsule')).length;
    })()`).catch(() => -1);

    // ---- 23 the passive path is gated by autoRecord alone
    const rowsBeforePassive = await capsuleRows();
    await cdp.eval(panel, `chrome.storage.local.set({'omnisense.autoRecord': false}).then(() => true)`);
    const sendPassive = () => cdp.eval(panel, `chrome.runtime.sendMessage(
      { type: 'CAPTURE_PAGE', data: ${JSON.stringify({ url: 'https://example.com/passive-e2e', title: 'Passive Capture Marker', text: PASSIVE_TEXT })} },
      () => void chrome.runtime.lastError)`, false).catch(() => {});
    await sendPassive();
    await sleep(5000);
    const rowsAutoOff = await capsuleRows();

    await cdp.eval(panel, `chrome.storage.local.set({'omnisense.autoRecord': true}).then(() => true)`);
    await sendPassive();
    const rowsAutoOn = await waitFor(async () => {
      const n = await capsuleRows();
      return n > rowsAutoOff ? n : null;
    }, 120000, 1500);

    record('capsule: passive capture is controlled by the autoRecord setting alone',
      rowsAutoOff === rowsBeforePassive && !!rowsAutoOn && rowsAutoOn > rowsAutoOff,
      `rows: start=${rowsBeforePassive} autoOff=${rowsAutoOff} autoOn=${rowsAutoOn}`);
    // Restore the shipped default so the remaining scenarios stay deterministic.
    await cdp.eval(panel, `chrome.storage.local.set({'omnisense.autoRecord': false}).then(() => true)`);

    // ---- 24..26 the explicit "收录本页" button, driven from the real UI
    //
    // The side panel resolves the page it acts on with
    // chrome.tabs.query({active:true,currentWindow:true}) at init time, so
    // focus the intended tab first and then reload the panel.
    const reloadPanel = async () => {
      await cdp.eval(panel, `location.reload()`, false).catch(() => {});
      await sleep(1800);
      // init() is async: the capture button and the tab handlers are only bound
      // once it reaches initCapsule(). refreshCapsuleStats() is what replaces the
      // literal "—" placeholder, so it doubles as the readiness signal.
      await waitFor(() => cdp.eval(panel,
        `document.getElementById('capsuleStats') && document.getElementById('capsuleStats').textContent !== '—'`,
        false), 10000);
      await cdp.eval(panel, `document.querySelector('#tabs [data-tab="capsule"]').click()`, false);
    };

    // ---- 24 a non-web page must produce an actionable, translated refusal
    const popup2 = await cdp.openTarget(localUrl('popup/popup.html'));
    await cdp.activate(popup2);
    await sleep(600);
    await reloadPanel();
    const activeUrlA = await cdp.eval(panel,
      `chrome.tabs.query({active:true,currentWindow:true}).then(([t]) => t && t.url)`, true).catch(() => null);
    await cdp.eval(panel, `document.getElementById('capsuleCaptureBtn').click()`, false, true).catch(() => {});
    const refusal = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        note: document.getElementById('capsuleCaptureNote').textContent.trim(),
        pending: document.getElementById('capsuleCaptureBtn').disabled
      }))()`, false).catch(() => null);
      return s && s.note && !s.pending ? s : null;
    }, 30000, 500);
    record('capsule: 收录本页 explains a non-web page instead of doing nothing',
      !!refusal && refusal.note.includes('不支持收录') && String(activeUrlA).startsWith('chrome-extension://'),
      refusal ? `note="${refusal.note}" activeTab=${String(activeUrlA).slice(0, 60)}` : 'no note rendered');

    // ---- 25 a real article must actually be stored through the button
    const rowsBeforeCapture = await capsuleRows();
    const article2 = await cdp.openTarget(`${base}/article`);
    await cdp.activate(article2);
    await sleep(1600);
    await reloadPanel();
    const activeUrlB = await cdp.eval(panel,
      `chrome.tabs.query({active:true,currentWindow:true}).then(([t]) => t && t.url)`, true).catch(() => null);
    await cdp.eval(panel, `document.getElementById('capsuleCaptureBtn').click()`, false, true).catch(() => {});
    const captured = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        note: document.getElementById('capsuleCaptureNote').textContent.trim(),
        stats: document.getElementById('capsuleStats').textContent.trim(),
        pending: document.getElementById('capsuleCaptureBtn').disabled,
        label: document.getElementById('capsuleCaptureBtn').textContent.trim()
      }))()`, false).catch(() => null);
      return s && s.note && !s.pending ? s : null;
    }, 240000, 1000);
    const okNote = !!captured && /已收录这一页（\d+ 段）/.test(captured.note);
    const rowsAfterCapture = await capsuleRows();
    record('capsule: 收录本页 stores the active article end-to-end',
      okNote && rowsAfterCapture > rowsBeforeCapture && !!captured && captured.label === '收录本页',
      captured
        ? `note="${captured.note}" rows ${rowsBeforeCapture} -> ${rowsAfterCapture} activeTab=${String(activeUrlB).slice(0, 48)} label="${captured.label}"`
        : 'no outcome within budget');

    // ---- 26 the on-screen count must agree with storage, and the page findable
    const panelState = await cdp.eval(panel, `(() => ({
      stats: document.getElementById('capsuleStats').textContent.trim(),
      emptyDisplay: getComputedStyle(document.getElementById('capsuleEmpty')).display
    }))()`, false).catch(() => null);
    record('capsule: the panel count matches storage and clears the empty state',
      !!panelState && panelState.stats.includes(String(rowsAfterCapture)) && panelState.emptyDisplay === 'none',
      JSON.stringify(panelState) + ` rows=${rowsAfterCapture}`);

    // Now the actual question a user asks next: "I saved it — can I find it
    // again?" Capture a page whose topic appears nowhere else in the index, then
    // describe it. A description of the shared test article could never be a fair
    // assertion, because the index holds dozens of near-identical chunks from
    // this and previous runs.
    const uniquePage = await cdp.openTarget(`${base}/lighthouse`);
    await cdp.activate(uniquePage);
    await sleep(1600);
    await reloadPanel();
    await cdp.eval(panel, `document.getElementById('capsuleCaptureBtn').click()`, false, true).catch(() => {});
    const uniqueCaptured = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        note: document.getElementById('capsuleCaptureNote').textContent.trim(),
        pending: document.getElementById('capsuleCaptureBtn').disabled
      }))()`, false).catch(() => null);
      return s && s.note && !s.pending ? s : null;
    }, 240000, 1000);

    await cdp.eval(panel, `(() => {
      const input = document.getElementById('capsuleInput');
      input.value = 'keeping a lighthouse in working order through the winter';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`, false).catch(() => {});
    const findable = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => {
        const items = [...document.querySelectorAll('#capsuleResults .item')];
        return { count: items.length, text: document.getElementById('capsuleResults').innerText.slice(0, 400) };
      })()`, false).catch(() => null);
      // Wait for the RIGHT result, not merely any result: an unrelated hit
      // arriving first is not the thing under test.
      return s && s.count > 0 && s.text.includes('Lighthouse') ? s : null;
    }, 90000, 1500);
    record('capsule: the page saved from the panel is findable by description',
      !!findable && findable.text.includes(UNIQUE_TITLE),
      (uniqueCaptured ? `captured "${uniqueCaptured.note}"; ` : 'capture note missing; ')
        + (findable ? `${findable.count} hit(s) incl. the saved page: ${findable.text.replace(/\n/g, ' | ').slice(0, 110)}` : 'the saved page never showed up in the results'));

    // ---- 26b the two halves of "我收藏了这篇文章，搜不到，也看不见"
    //
    //  1. A long Chinese article was indexed as ONE truncated chunk, so everything
    //     after its first ~500 characters was never stored. Asserted at the STORAGE
    //     level on purpose: the row that has to exist is the one holding the article's
    //     final paragraph, and whether the embedder then ranks it well is a separate
    //     question with a separate (human) verdict. Going through the embedding model
    //     would make this assertion depend on all-MiniLM-L6-v2's Chinese quality,
    //     which would be a different test wearing this one's name.
    //  2. There was no way to see what had been stored at all.
    const zhLongPage = await cdp.openTarget(`${base}/zh-long`);
    await cdp.activate(zhLongPage);
    await sleep(1600);
    await reloadPanel();
    // Clear the box first: 收录本页 re-runs whatever is on screen when it finishes,
    // which would race the listing assertions below.
    await cdp.eval(panel, `(() => { document.getElementById('capsuleInput').value = ''; return true; })()`, false).catch(() => {});
    // Empty the store first, on purpose.
    //
    // The profile is persistent, so the capsule accumulates across runs — by this
    // point it holds 140+ rows from previous runs, including rows for this very
    // fixture. The first version of these assertions counted rows without
    // accounting for that: it read 6 rows for a page whose capture had just stored
    // 3, and reported "the same article appears twice in the list" when the list was
    // in fact correctly showing TWO VISITS (two timestamps). Both of those were
    // assertion bugs that failed a correct build. Starting from a known-empty store
    // makes every number below exact, and exercises CAPSULE_CLEAR on the way.
    const cleared = await cdp.eval(panel, `new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'CAPSULE_CLEAR' }, (r) => {
        void chrome.runtime.lastError;
        resolve(r || null);
      });
    })`).catch(() => null);
    // Ask the PRODUCT for the text it is about to index, then evaluate the chunking
    // rule against that. Reading the stored rows' `snippet` instead would be wrong:
    // a snippet is only the first 240 characters of each chunk, so it cannot show
    // whether the article's END was indexed — which is the entire point here. (An
    // earlier draft made exactly that mistake and failed a correct build.)
    const zhLongRaw = await cdp.eval(panel, `new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.runtime.sendMessage({ type: 'GET_ARTICLE', tabId: tabs[0] && tabs[0].id }, (r) => {
          void chrome.runtime.lastError;
          resolve((r && r.text) || '');
        });
      });
    })`).catch(() => '');
    await cdp.eval(panel, `document.getElementById('capsuleCaptureBtn').click()`, false, true).catch(() => {});
    const zhCaptured = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        note: document.getElementById('capsuleCaptureNote').textContent.trim(),
        pending: document.getElementById('capsuleCaptureBtn').disabled
      }))()`, false).catch(() => null);
      return s && s.note && !s.pending ? s : null;
    }, 240000, 1000);

    const zhRows = await cdp.eval(panel, `(async () => {
      const m = await import(${JSON.stringify(localUrl('shared/idb.js'))});
      const all = await m.idbGetAll('capsule');
      return all.map(r => ({ id: r.id, url: String(r.url || ''), chunkIndex: r.chunkIndex, chunkTotal: r.chunkTotal }));
    })()`).catch(() => null);
    const allRows = Array.isArray(zhRows) ? zhRows : [];
    const zhStored = allRows.filter(r => r.url.endsWith('/zh-long'));
    const zhChunks = zhStored.length;
    const legacy = legacyChunkCount(zhLongRaw);
    const predicted = chunkForEmbedding(String(zhLongRaw || ''));
    const tailIndexed = predicted.some(c => c.includes(ZH_LONG_MARK));
    const legacyTruncatesTail = legacy.chunks === 1 &&
      (String(legacy.blocks[0] || '').slice(0, 512).includes(ZH_LONG_MARK) === false);
    record('capsule: the Chinese regression fixture can actually tell the two implementations apart',
      legacy.chunks === 1 && legacyTruncatesTail,
      `old rule: ${String(zhLongRaw || '').length} chars → ${legacy.chunks} chunk(s) of `
      + `${(legacy.blocks[0] || '').length} chars, and the final `
      + `paragraph would fall outside the embedder's 512-token window = ${legacyTruncatesTail}`);
    record('capsule: a long Chinese article is stored as several chunks, not one truncated blob',
      !!cleared && cleared.ok === true && allRows.length === predicted.length && zhChunks === predicted.length &&
      zhStored.every(r => r.chunkTotal === predicted.length) && tailIndexed,
      `store cleared = ${JSON.stringify(cleared)}; ${String(zhLongRaw || '').length} extracted chars → `
      + `rule predicts ${predicted.length} chunk(s) [${predicted.map(c => c.length)}]; `
      + `stored ${zhChunks} row(s) of ${allRows.length} total `
      + `[chunkTotal=${JSON.stringify(zhStored.map(r => r.chunkTotal))}]; the FINAL paragraph `
      + `falls inside a stored chunk = ${tailIndexed}`
      + (zhCaptured ? `; capture said "${zhCaptured.note}"` : '; no capture note'));

    // The listing. Before `CAPSULE_RECENT` existed, the only interaction in this
    // whole panel was typing a query and pressing Enter.
    await cdp.eval(panel, `document.getElementById('capsuleBrowseBtn').click()`, false, true).catch(() => {});
    const listing = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => {
        const items = [...document.querySelectorAll('#capsuleResults .item')];
        return {
          count: items.length,
          note: document.getElementById('capsuleBrowseNote').textContent.trim(),
          titles: items.map(i => ((i.querySelector('.title') || {}).textContent) || ''),
          metas: items.map(i => ((i.querySelector('.meta') || {}).innerText) || '')
        };
      })()`, false).catch(() => null);
      return s && s.count > 0 ? s : null;
    }, 60000, 1000);
    const zhLongRows = listing ? listing.titles.filter(x => x.includes(ZH_LONG_TITLE)).length : 0;
    record('capsule: 全部收录 lists the stored articles without needing a query',
      !!listing && listing.count === 1 && zhLongRows === 1 && !!listing.note,
      listing
        ? `${listing.count} row(s) in a store holding exactly one saved page, note="${listing.note}", `
          + `"${ZH_LONG_TITLE}" appears ${zhLongRows}x`
        : 'the listing never rendered');
    record('capsule: one article is one row, however many chunks it was stored as',
      zhLongRows === 1 && zhChunks === predicted.length && predicted.length > 1,
      `stored ${zhChunks} chunk(s) for "${ZH_LONG_TITLE}" but it is ${zhLongRows} row(s) in the list` +
        (listing ? `; its meta reads "${(listing.metas.find((m, i) => listing.titles[i].includes(ZH_LONG_TITLE)) || '').slice(0, 60)}"` : ''));

    // Enter on an empty box used to send `query: ''` to the embedder — not a search
    // anybody meant to run, and a wasted model call.
    await cdp.eval(panel, `(() => {
      const input = document.getElementById('capsuleInput');
      input.value = '';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`, false).catch(() => {});
    const emptyEnter = await waitFor(async () => {
      const n = await cdp.eval(panel,
        `document.querySelectorAll('#capsuleResults .item').length`, false).catch(() => 0);
      return typeof n === 'number' && n > 0 ? n : null;
    }, 60000, 1000);
    record('capsule: Enter on an empty search box lists everything instead of searching for nothing',
      typeof emptyEnter === 'number' && emptyEnter > 0,
      `rows after empty-Enter = ${emptyEnter}`);

    // The listing must not ship 384-float vectors across the message port: the
    // store holds one per chunk, and the panel renders no numbers from them.
    const recentReply = await cdp.eval(panel, `new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'CAPSULE_RECENT' }, (r) => {
        void chrome.runtime.lastError;
        resolve(r || null);
      });
    })`).catch(() => null);
    record('capsule: the listing route returns pages with the vectors stripped',
      !!recentReply && Array.isArray(recentReply.pages) && recentReply.pages.length > 0 &&
      typeof recentReply.total === 'number' &&
      recentReply.pages.every(p => !('vector' in p)),
      recentReply
        ? `pages=${recentReply.pages.length} total=${recentReply.total} keys=${JSON.stringify(Object.keys(recentReply.pages[0] || {}))}`
        : 'no reply');

    // ---- 26c 去重与删除（用户报告：「收录的时候，去重吧，并且支持删除」）
    //
    // The screenshot showed the SAME article twice — identical title, domain and
    // snippet, one "5 小时前" and one "刚刚". That was the shipped behaviour one
    // round earlier, and deliberately so: a page used to be identified by
    // `url + visitTime`, so re-capturing appended a second copy. Re-capturing is
    // exactly what someone does when they are unsure the first capture worked, so
    // the "feature" turned the most common user action into duplicate clutter.
    const readCapsule = () => cdp.eval(panel, `(async () => {
      const m = await import(${JSON.stringify(localUrl('shared/idb.js'))});
      const all = await m.idbGetAll('capsule');
      return all.map(r => ({ id: r.id, url: String(r.url || ''), visitTime: r.visitTime }));
    })()`).catch(() => null);

    // Blank the note first. The FIRST capture's note is still in the DOM and says
    // exactly the same thing, so waiting for "a note exists" would return
    // immediately from the stale text and read the store mid-capture.
    await cdp.eval(panel, `(() => { document.getElementById('capsuleCaptureNote').textContent = ''; return true; })()`, false).catch(() => {});
    await cdp.eval(panel, `document.getElementById('capsuleCaptureBtn').click()`, false, true).catch(() => {});
    const zhRecaptured = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        note: document.getElementById('capsuleCaptureNote').textContent.trim(),
        pending: document.getElementById('capsuleCaptureBtn').disabled
      }))()`, false).catch(() => null);
      return s && s.note && !s.pending ? s : null;
    }, 240000, 1000);
    const recapRows = await readCapsule();
    record('capsule: re-capturing a page REPLACES it instead of storing a second copy',
      !!zhRecaptured && Array.isArray(recapRows) && recapRows.length === predicted.length &&
      recapRows.every(r => r.url.endsWith('/zh-long')),
      `captured the same page twice → ${Array.isArray(recapRows) ? recapRows.length : '?'} row(s) `
      + `(expected ${predicted.length}; the duplicate bug stored ${predicted.length * 2})`
      + (zhRecaptured ? `; second capture said "${zhRecaptured.note}"` : '; no capture note'));

    // The same rule must hold in the UI, not only in the store.
    const oneRowAfterRecapture = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => {
        const items = [...document.querySelectorAll('#capsuleResults .item')];
        return { count: items.length, titles: items.map(i => ((i.querySelector('.title') || {}).textContent) || '') };
      })()`, false).catch(() => null);
      return s && s.count === 1 ? s : null;
    }, 60000, 1000);
    record('capsule: a page captured twice is still one row in the list',
      !!oneRowAfterRecapture && oneRowAfterRecapture.titles.filter(x => x.includes(ZH_LONG_TITLE)).length === 1,
      oneRowAfterRecapture
        ? `${oneRowAfterRecapture.count} row(s): ${JSON.stringify(oneRowAfterRecapture.titles.map(t => t.slice(0, 24)))}`
        : 'the list never settled on a single row');

    // Delete. `window.confirm` blocks a headless page forever, so it is replaced
    // for this one click — and the replacement counts its calls, which is how the
    // assertion knows the confirmation actually happened rather than being skipped.
    await cdp.eval(panel, `(() => { window.__confirmCalls = 0; window.confirm = () => { window.__confirmCalls++; return true; }; return true; })()`, false).catch(() => {});
    await cdp.eval(panel, `(() => { const b = document.querySelector('#capsuleResults .item [data-del]'); if (b) b.click(); return !!b; })()`, false, true).catch(() => {});
    const afterDelete = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        confirms: window.__confirmCalls,
        items: document.querySelectorAll('#capsuleResults .item').length,
        stats: document.getElementById('capsuleStats').textContent.trim(),
        emptyDisplay: getComputedStyle(document.getElementById('capsuleEmpty')).display
      }))()`, false).catch(() => null);
      return s && s.items === 0 ? s : null;
    }, 60000, 1000);
    const rowsAfterDelete = await readCapsule();
    record('capsule: 删除 removes the whole page — every chunk of it — after confirming',
      !!afterDelete && afterDelete.confirms === 1 &&
      Array.isArray(rowsAfterDelete) && rowsAfterDelete.length === 0 &&
      afterDelete.emptyDisplay !== 'none',
      `confirm() calls = ${afterDelete && afterDelete.confirms}; `
      + `${Array.isArray(rowsAfterDelete) ? rowsAfterDelete.length : '?'} row(s) left in the store `
      + `(was ${predicted.length} chunks); list rows = ${afterDelete && afterDelete.items}; `
      + `stats="${afterDelete && afterDelete.stats}"; empty state displayed = ${afterDelete && afterDelete.emptyDisplay !== 'none'}`);

    // Put the test article back in front. The feature scenarios below act on
    // whatever the panel considers the active tab, and they are about the
    // article — not the lighthouse page we just borrowed the focus for.
    await cdp.activate(article2);
    await sleep(1200);
    await reloadPanel();

    // ---- 27 the remaining features, driven through their real entry points
    //
    // Everything above verified that these panels RENDERED and that their buttons
    // EXISTED, which is a different question from whether the feature works. The
    // reported 「文章总结怎么不好使」 passed every pre-existing assertion, because the
    // click handler failed *after* the panel had already rendered correctly. Each
    // block below therefore asserts the user-visible product of the click.

    // 文章总结 — the resting status must not claim to be reading
    await cdp.eval(panel, `document.querySelector('#tabs [data-tab="summary"]').click()`, false).catch(() => {});
    const summaryIdle = await cdp.eval(panel,
      `document.getElementById('summaryStatus').textContent.trim()`, false).catch(() => null);
    record('summary: idle status does not claim to be reading a page',
      summaryIdle === '点下面的按钮，总结当前页正文。',
      `idle status = "${summaryIdle}"`);

    await cdp.eval(panel, `(() => {
      document.getElementById('summaryOutput').textContent = '';
      document.getElementById('summaryOutput').style.display = 'none';
      document.getElementById('summaryBtn').click();
      return true;
    })()`, false, true).catch(() => {});
    const summaryRes = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        status: document.getElementById('summaryStatus').textContent.trim(),
        out: document.getElementById('summaryOutput').textContent.trim(),
        actions: getComputedStyle(document.getElementById('summaryActions')).display,
        busy: document.getElementById('summaryOutput').classList.contains('thinking')
      }))()`, false).catch(() => null);
      // Wait for the COMPLETED state. "Non-empty and not the placeholder" reads
      // on the first streamed token — a mid-stream sample that can report a
      // fraction of the answer as if it were the whole thing (T4).
      return s && s.actions !== 'none' && !s.busy ? s : null;
    }, 240000, 2000);
    record('summary: 文章总结 produces a real summary in the result box',
      !!summaryRes && summaryRes.out.length > 20 && !/出错了/.test(summaryRes.status),
      summaryRes
        ? `${summaryRes.out.length} chars: "${summaryRes.out.slice(0, 90).replace(/\n/g, ' ')}" status="${summaryRes.status}"`
        : 'result box stayed empty');

    // ---- 27a the speech engine stub, shared by every listen assertion below.
    //
    // Three rules learned by getting this wrong:
    //
    //  1. Stub the ENGINE, not the voices. A hand-written `{name, lang}` literal is
    //     not a SpeechSynthesisVoice, and `utterance.voice = <literal>` throws
    //     "Failed to convert value to 'SpeechSynthesisVoice'" — a first draft did
    //     exactly that and produced four false failures plus a real exception.
    //     Restricting the REAL list keeps the platform's own conversion in play.
    //  2. Capture the real list BEFORE replacing `getVoices`, or the "real" read
    //     goes through your own stub and returns nothing. A second, near-duplicate
    //     stub made precisely that mistake — hence one helper, defined once.
    //  3. Do not end the utterance promptly. The product writes 「正在朗读（音色）」
    //     at speak time and 「已读完」 in onend, so ending immediately means every
    //     sample lands after the line was overwritten, which reads as a failure of
    //     the thing under test. 停止 is used to leave the speaking state instead.
    //
    // `selector` is a predicate source string applied to the real voice list, so
    // each case can present a system that ships only certain languages.
    //
    // The stub also counts `cancel()` calls and keeps each utterance's FULL text.
    // Both are needed by the smoothness assertions: "was the article queued as
    // several utterances" is a question about the whole `spoken` array, and "was
    // anything cancelled between them" is a question about that counter.
    const installVoices = selector => cdp.eval(panel, `(() => {
      const synth = window.speechSynthesis;
      // Read the REAL list before replacing anything. Reading it afterwards would
      // go through the stub installed below.
      if (!window.__ttsRealVoices || !window.__ttsRealVoices.length) {
        window.__ttsRealVoices = synth.getVoices() || [];
      }
      // Nothing to test with, and stubbing now would leave the empty list cached
      // behind our own stub for the rest of the document. Report and leave the
      // engine alone so a later case can try again.
      if (!window.__ttsRealVoices.length) return { real: 0, used: [] };
      if (!window.__ttsTest) window.__ttsTest = { spoken: [], cancels: 0 };
      window.__ttsTest.spoken.length = 0;
      window.__ttsTest.cancels = 0;
      window.__ttsTest.voices = window.__ttsRealVoices.filter(${selector});
      synth.getVoices = () => window.__ttsTest.voices;
      synth.cancel = () => { window.__ttsTest.cancels++; };
      synth.speak = (u) => {
        const i = window.__ttsTest.spoken.length;
        const text = String(u.text || '');
        window.__ttsTest.spoken.push({
          text, preview: text.slice(0, 24), len: text.length,
          lang: u.lang || '',
          voice: (u.voice && u.voice.name) || null,
          voiceLang: (u.voice && u.voice.lang) || null
        });
        // A real engine reports progress through its boundary handler. The first
        // utterance reports it almost immediately and the rest much later, so a
        // sample taken in between can tell an ABSOLUTE progress bar (about this
        // chunk's share of the article) from a per-chunk one (about 100% after one
        // chunk). No backticks in this comment: it lives inside a template literal.
        setTimeout(() => { try { u.onboundary && u.onboundary({ charIndex: text.length }); } catch (e) {} },
          i === 0 ? 50 : 4000);
        // Deliberately not ending: see rule 3 above.
        setTimeout(() => { try { u.onend && u.onend(); } catch (e) {} }, 60000);
      };
      return {
        real: window.__ttsRealVoices.length,
        used: window.__ttsTest.voices.map(v => v.name + '[' + v.lang + ']').slice(0, 3)
      };
    })()`, false, true);

    /** Leave the speaking state so the next case's page-following is not blocked. */
    const resetTts = async () => {
      await cdp.eval(panel, `(() => { document.getElementById('ttsStop').click(); return true; })()`, false, true).catch(() => {});
      await sleep(200);
    };

    const readTts = () => cdp.eval(panel, `(() => ({
      spoken: (window.__ttsTest && window.__ttsTest.spoken) || [],
      cancels: (window.__ttsTest && window.__ttsTest.cancels) || 0,
      available: ((window.__ttsTest && window.__ttsTest.voices) || []).length,
      progress: Number(document.getElementById('ttsProgress').value) || 0,
      status: document.getElementById('listenStatus').textContent.trim(),
      note: document.getElementById('ttsNote').textContent.trim()
    }))()`, false).catch(() => null);

    // ---- 27a 朗读这段: the listen tab must describe the text it is reading.
    //
    // Reported symptom: the listen panel said 「没有可读的正文。」 at the same time
    // as 「正在朗读…」. The two lines came from different code paths and had no
    // reason to agree: this button speaks the SUMMARY, which is not the page.
    if (summaryRes && summaryRes.out.length > 20) {
      // All real voices: the summary of an English fixture is English prose, but a
      // 360M model may still emit a stray Chinese phrase, and this assertion is
      // about the source line, not about the language.
      const summaryVoices = await installVoices('v => true');
      await cdp.eval(panel, `(() => { document.getElementById('summaryListen').click(); return true; })()`, false, true).catch(() => {});
      const spokeSummary = await waitFor(async () => {
        const s = await readTts();
        return s && s.spoken.length ? s : null;
      }, 20000, 500);
      const contradicts = !!spokeSummary &&
        /没有可读的正文|No readable content/.test(spokeSummary.status);
      record('listen: 朗读这段 names the summary as its source instead of contradicting itself',
        !!spokeSummary && !contradicts && /文章总结/.test(spokeSummary.status) && !!spokeSummary.spoken[0].voice,
        spokeSummary
          ? `status="${spokeSummary.status}" note="${spokeSummary.note}" voice=${spokeSummary.spoken[0].voice}(${spokeSummary.spoken[0].voiceLang})`
          : `nothing was spoken (real voices available = ${summaryVoices.real})`);
      await resetTts();
    }

    // ---- 27b the context window: a LONG article must summarise, not fail
    //
    // Regression for the raw runtime error that used to be rendered inside this
    // very result box:
    //   Prompt tokens exceed context window size: number of prompt tokens: 4338;
    //   context window size: 4096
    // The prompt builder capped the article by CHARACTER COUNT, which is not a
    // token budget — so beyond a certain page length the feature could not work
    // at all, and the suite stayed green because its fixtures were all short.
    //
    // Three assertions, deliberately separated so a failure says which half broke:
    //   a) the article was actually extracted (a Readability failure is not a
    //      context-window failure),
    //   b) a result exists and the overflow wording leaked into neither the result
    //      box nor the notice line,
    //   c) the long-input path really ran and told the user so.
    const longTab = await cdp.openTarget(`${base}/long`);
    await cdp.activate(longTab);
    await sleep(1500);

    const longArtText = await cdp.eval(panel, `(async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      const r = await chrome.runtime.sendMessage({ type: 'GET_ARTICLE', tabId: t && t.id });
      return (r && r.text) || '';
    })()`, true).catch(() => '');
    // Measure with the SHIPPED estimator, so this assertion quantifies the same
    // thing the inference host budgets against instead of a second guess that
    // could drift away from it.
    const { estimateTokens, contextWindowFor } = await import('../shared/token-budget.js');
    const longTokens = estimateTokens(longArtText);
    const longWindow = contextWindowFor(INFER_MODEL);
    record('readability: extracts the over-long fixture in full',
      longTokens > 1500 && longArtText.length > 2000,
      `${longArtText.length} chars = ~${longTokens} estimated tokens against a ${longWindow}-token window (single-shot budget is roughly window - 1200)`);

    await reloadPanel();
    await cdp.eval(panel, `document.querySelector('#tabs [data-tab="summary"]').click()`, false).catch(() => {});
    await cdp.eval(panel, `(() => {
      document.getElementById('summaryOutput').textContent = '';
      document.getElementById('summaryOutput').style.display = 'none';
      document.getElementById('summaryBtn').click();
      return true;
    })()`, false, true).catch(() => {});

    const longRes = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        status: document.getElementById('summaryStatus').textContent.trim(),
        out: document.getElementById('summaryOutput').textContent.trim(),
        actions: getComputedStyle(document.getElementById('summaryActions')).display,
        busy: document.getElementById('summaryOutput').classList.contains('thinking')
      }))()`, false).catch(() => null);
      // Wait for the COMPLETED state, not merely for a non-empty box. Waiting on
      // "some text and not the placeholder" samples on the first streamed token,
      // which is a mid-stream read: on a slow merge pass it captures a 5-character
      // answer and reports a false failure (this exact mistake has been made twice
      // in this suite — see T4). finishStream() removes `.thinking` and reveals the
      // action row, so those two together are the real end-of-stream signal.
      return s && s.actions !== 'none' && !s.busy ? s : null;
    }, 300000, 2000);

    const longErrored = !!longRes && /出错了|please try again/i.test(longRes.out);
    const overflowLeak = !!longRes &&
      /context window|number of prompt tokens|超出本地模型/i.test(`${longRes.out} ${longRes.status}`);
    // The contract under test is the plumbing, not the tiny model's verbosity:
    // the stream must END cleanly, produce something, and never surface the runtime
    // rejection. How MANY characters a 360M model writes is a quality question and
    // belongs in the manual-review list, not in a pass/fail assertion.
    record('summary: a long article is summarised instead of overflowing the context window',
      !!longRes && longRes.out.length > 0 && !longErrored && !overflowLeak,
      longRes
        ? `${longRes.out.length} chars, notice="${longRes.status}"${overflowLeak ? '  <-- OVERFLOW LEAKED' : ''}${longErrored ? '  <-- ERROR TEXT' : ''}`
        : 'the stream never reached a completed state');

    record('summary: the long article took the chunked path and announced it',
      !!longRes && /分段/.test(longRes.status),
      longRes ? `notice = "${longRes.status}"` : 'no notice line');

    // Hand the focus back to the ordinary article. Everything below acts on the
    // active tab and must not inherit the long fixture.
    await cdp.activate(article2);
    await sleep(1200);
    await reloadPanel();

    // 隐私体检 — a rendered report, not just a non-empty element
    await cdp.eval(panel, `(() => {
      document.querySelector('#tabs [data-tab="privacy"]').click();
      document.getElementById('privacyReport').innerHTML = '';
      document.getElementById('privacyBtn').click();
      return true;
    })()`, false, true).catch(() => {});
    const privacyUi = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => {
        const el = document.getElementById('privacyReport');
        return { text: el.innerText.trim(), badge: (el.querySelector('.risk-badge') || {}).textContent || '' };
      })()`, false).catch(() => null);
      return s && s.text.length > 20 ? s : null;
    }, 60000, 1000);
    record('privacy: 隐私体检 renders a full risk report for the page',
      !!privacyUi && /隐私风险/.test(privacyUi.badge),
      privacyUi ? `badge="${privacyUi.badge}" text="${privacyUi.text.replace(/\n/g, ' / ').slice(0, 80)}"` : 'no report rendered');

    // 毒舌点评 — real generated text
    await cdp.eval(panel, `(() => {
      document.querySelector('#tabs [data-tab="roast"]').click();
      document.getElementById('roastOutput').textContent = '';
      document.getElementById('roastInput').value =
        'This extension claims to run a large language model entirely on your own device and never upload anything.';
      document.getElementById('roastBtn').click();
      return true;
    })()`, false, true).catch(() => {});
    const roastRes = await waitFor(async () => {
      const s = await cdp.eval(panel, `document.getElementById('roastOutput').textContent.trim()`, false).catch(() => null);
      return s && s.length > 0 && !/思考中|Thinking/.test(s) ? s : null;
    }, 240000, 2000);
    record('roast: 毒舌点评 produces real text in the result box',
      !!roastRes && roastRes.length > 5,
      roastRes ? `${roastRes.length} chars: "${roastRes.slice(0, 80)}"` : 'result box stayed empty');

    // 写作助手 — blank draft mode, real generated text
    await cdp.eval(panel, `(() => {
      document.querySelector('#tabs [data-tab="writing"]').click();
      document.querySelector('#writingModes [data-wmode="blank"]').click();
      document.getElementById('writingOutput').textContent = '';
      document.getElementById('writingTopic').value = 'why running models locally matters';
      document.getElementById('writingBtn').click();
      return true;
    })()`, false, true).catch(() => {});
    const writingRes = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        out: document.getElementById('writingOutput').textContent.trim(),
        attribution: getComputedStyle(document.getElementById('writingAttribution')).display
      }))()`, false).catch(() => null);
      // Wait for the COMPLETED state, not the first token: the result box fills
      // as tokens stream, and the attribution line is only revealed by the
      // end-of-stream callback. Sampling the moment text appears therefore reads
      // `display:none` on a perfectly healthy run — an observed false failure.
      return s && s.out.length > 20 && !/思考中|Thinking/.test(s.out) && s.attribution !== 'none' ? s : null;
    }, 240000, 2000);
    record('writing: 写作助手 drafts real text and shows the attribution line',
      !!writingRes && writingRes.out.length > 20 && writingRes.attribution !== 'none',
      writingRes ? `${writingRes.out.length} chars: "${writingRes.out.slice(0, 80).replace(/\n/g, ' ')}"` : 'result box stayed empty');

    // 听网页 — must resolve a readable article for the current tab
    await cdp.eval(panel, `document.querySelector('#tabs [data-tab="listen"]').click()`, false).catch(() => {});
    const listenUi = await waitFor(async () => {
      const s = await cdp.eval(panel, `(() => ({
        status: document.getElementById('listenStatus').textContent.trim(),
        rates: document.getElementById('ttsRate').options.length
      }))()`, false).catch(() => null);
      return s && !/正在读取本页/.test(s.status) && !/出错了/.test(s.status) ? s : null;
    }, 60000, 1000);
    record('listen: 听网页 resolves the article and offers speech rates',
      !!listenUi && /Capsule Diagnostic|OmniSense End-to-End|article/i.test(listenUi.status) && listenUi.rates >= 3,
      listenUi ? `status="${listenUi.status}" rates=${listenUi.rates}` : 'never resolved');

    // ---- 27e the reported defect itself: 「明明是中文页面，为啥朗读的是英文，口齿还
    //         不清晰」. Two independent halves, asserted separately.
    //
    // (a) The panel never followed the page. `currentTabId` and the extracted
    //     article were assigned once in init() and there was no chrome.tabs
    //     listener anywhere, so after a navigation — or a tab switch — 播放 kept
    //     reading the article captured when the panel first loaded. That is the
    //     "reads English on a Chinese page" half.
    // (b) The voice was a hard-coded `zh` lookup, so the SAME Chinese voice was
    //     attached to English text, and `utterance.lang` was never set. That is
    //     the "口齿还不清晰" half.
    //
    // Both are checked against two fixtures whose languages differ, so a wrong
    // answer cannot pass by coincidence.
    const zhTab = await cdp.openTarget(`${base}/zh`);
    const enTab = await cdp.openTarget(`${base}/article`);

    const listenStatusNow = () => cdp.eval(panel,
      `document.getElementById('listenStatus').textContent.trim()`, false).catch(() => null);
    const waitListenStatus = test => waitFor(async () => {
      const s = await listenStatusNow();
      // The resting line is 「正在读取本页…」; wait for a settled value, and one that
      // names the expected title.
      return s && !/正在读取|出错了/.test(s) && test(s) ? s : null;
    }, 30000, 700);

    await cdp.activate(enTab);
    await sleep(1600);
    await reloadPanel();
    const statusEn = await waitListenStatus(s => s.includes(ARTICLE_TITLE));

    await cdp.activate(zhTab);
    await sleep(2600);
    const statusZh = await waitListenStatus(s => s.includes(ZH_TITLE));
    record('listen: the panel re-reads the article when the user switches tab',
      !!statusEn && !!statusZh && !statusZh.includes(ARTICLE_TITLE),
      `on /article → "${statusEn}" ; after switching to the Chinese tab → "${statusZh}"`);

    // Back to the English tab, then move THAT SAME tab to the Chinese fixture.
    // A side panel is not reloaded by a page navigation, so this is exactly the
    // situation the user was in, and it is a different code path from switching.
    await cdp.activate(enTab);
    await sleep(2600);
    const statusBack = await waitListenStatus(s => s.includes(ARTICLE_TITLE));
    await cdp.navigate(enTab, `${base}/zh`);
    await sleep(2600);
    const statusAfterNav = await waitListenStatus(s => s.includes(ZH_TITLE));
    record('listen: the panel re-reads the article when the same tab navigates',
      !!statusBack && !!statusAfterNav && !statusAfterNav.includes(ARTICLE_TITLE),
      `one tab, /article → /zh: "${statusBack}" → "${statusAfterNav}"`);

    // Stub the engine with real voice objects; see the doc comment on
    // `installVoices` above for the three traps this helper exists to avoid.
    const playAndCollect = async () => {
      await cdp.eval(panel, `(() => { document.getElementById('ttsPlay').click(); return true; })()`, false, true).catch(() => {});
      return waitFor(async () => {
        const s = await readTts();
        return s && (s.spoken.length || /没有.*音色/.test(s.note)) ? s : null;
      }, 20000, 400);
    };

    // Only Chinese voices installed. The active tab is `enTab`, which the
    // navigation above left on the Chinese fixture.
    const zhOnly = await installVoices(`v => /^zh/i.test(v.lang || '')`);
    const zhSpoken = await playAndCollect();
    record('listen: Chinese text is read by a Chinese voice, with lang set to match it',
      !!zhSpoken && !!zhSpoken.spoken.length
        && /^zh/i.test(zhSpoken.spoken[0].lang)
        && /^zh/i.test(zhSpoken.spoken[0].voiceLang || ''),
      zhSpoken
        ? `installed=${JSON.stringify(zhOnly.used)} → lang=${zhSpoken.spoken[0].lang} voice=${zhSpoken.spoken[0].voice}(${zhSpoken.spoken[0].voiceLang}) text="${zhSpoken.spoken[0].preview}"`
        : `nothing was spoken (real voices available = ${zhOnly.real})`);

    // While speaking, the two lines must describe the same thing. They used to
    // be written by different code paths, which is how the panel said
    // 「没有可读的正文」 and 「正在朗读…」 at once.
    const namedVoice = !!zhSpoken && !!zhSpoken.spoken[0] && !!zhSpoken.spoken[0].voice;
    record('listen: while speaking, the status names the source and the note names the voice',
      !!zhSpoken && namedVoice && zhSpoken.status.includes(ZH_TITLE)
        && zhSpoken.note.includes(zhSpoken.spoken[0].voice)
        && !/没有可读的正文/.test(zhSpoken.status),
      zhSpoken ? `status="${zhSpoken.status}" note="${zhSpoken.note}"` : 'nothing was spoken');

    await resetTts();
    await cdp.navigate(enTab, `${base}/article`);
    await sleep(2600);
    await waitListenStatus(s => s.includes(ARTICLE_TITLE));
    const enOnly = await installVoices(`v => /^en/i.test(v.lang || '')`);
    const enSpoken = await playAndCollect();
    record('listen: English text is read by an English voice, not the Chinese one',
      !!enSpoken && !!enSpoken.spoken.length
        && /^en/i.test(enSpoken.spoken[0].lang)
        && /^en/i.test(enSpoken.spoken[0].voiceLang || ''),
      enSpoken
        ? `installed=${JSON.stringify(enOnly.used)} → lang=${enSpoken.spoken[0].lang} voice=${enSpoken.spoken[0].voice}(${enSpoken.spoken[0].voiceLang}) text="${enSpoken.spoken[0].preview}"`
        : `nothing was spoken (real voices available = ${enOnly.real})`);

    // No Chinese voice installed, and a Chinese page. Reading it in English IS the
    // defect, so the correct behaviour is to refuse — and to say which language is
    // missing, rather than going silent or reading it wrongly.
    await resetTts();
    await cdp.navigate(enTab, `${base}/zh`);
    await sleep(2600);
    await waitListenStatus(s => s.includes(ZH_TITLE));
    const noZh = await installVoices(`v => !/^zh/i.test(v.lang || '')`);
    const noVoice = await playAndCollect();
    record('listen: with no Chinese voice installed it refuses instead of reading Chinese in English',
      !!noVoice && noVoice.spoken.length === 0 && /没有.*音色/.test(noVoice.note)
        && /中文/.test(noVoice.note) && !/没有可读的正文/.test(noVoice.status),
      noVoice
        ? `installed=${JSON.stringify(noZh.used)} spoken=${noVoice.spoken.length} note="${noVoice.note}" status="${noVoice.status}"`
        : `no refusal was shown (real voices available = ${noZh.real})`);

    // ---- 27f the smoothness fix: 「播放还是断断续续的，流畅一点的」
    //
    // The previous round made the right text be read by a right-language voice.
    // This one is about the read-out itself, and it has two halves:
    //
    // (a) THE SHAPE OF THE WORK. The whole article used to go to ONE `speak()`
    //     call. Chrome's engine does not stream an arbitrarily long utterance
    //     smoothly, so the article is now cut at sentence boundaries and the
    //     pieces are queued in a single synchronous pass — no `cancel()` between
    //     them, because cancelling is what makes an utterance fail with
    //     `interrupted` and would re-introduce a seam at every chunk.
    // (b) WHICH VOICE. Measured with `say` + `ffmpeg silencedetect` on the same
    //     110-character text: `Eddy`/`Flo`/`Rocko`/`Grandma`/`Grandpa` finish in
    //     21.0 s and hold 0.50 s of trailing dead air, while the dedicated Chinese
    //     voices `Tingting`/`Meijia`/`Sinji` take 24.8–25.2 s and hold 0.19–0.20 s.
    //     The old ranking tied 10 `zh-CN` voices and took whichever the engine
    //     returned first, which is `Eddy`. For English it was worse: it picked
    //     `Albert`, an Apple novelty voice whose duration on identical input is a
    //     +46% outlier. The ranking is now `default` → dedicated locale voice →
    //     not-novelty → preferred tag → local, and `e2e/selftest-speech.cjs` pins
    //     that rule down deterministically. Here we only check the real engine
    //     agrees.
    await resetTts();
    await cdp.navigate(enTab, `${base}/article`);
    await sleep(2600);
    await waitListenStatus(s => s.includes(ARTICLE_TITLE));
    await installVoices('v => true');
    await cdp.eval(panel, `(() => { document.getElementById('ttsPlay').click(); return true; })()`, false, true).catch(() => {});
    const queued = await waitFor(async () => {
      const s = await readTts();
      return s && s.spoken.length >= 2 ? s : null;
    }, 20000, 400);

    const chunks = queued ? queued.spoken : [];
    const joined = chunks.map(c => c.text).join('');
    record('listen: an article is queued as several sentence utterances, not one long one',
      chunks.length >= 2 && chunks.every(c => c.len > 0 && c.len <= 120) && joined.length > 300,
      `utterances=${chunks.length} lens=${JSON.stringify(chunks.map(c => c.len))} totalChars=${joined.length}（上限 120 = shared/speech.js 的 SPEECH_CHUNK_MAX_CHARS）`);

    record('listen: nothing cancels the read-out between its chunks',
      !!queued && queued.cancels === 1,
      queued
        ? `一次 播放 期间 cancel() 调用次数=${queued.cancels}（应为 1：只有开始那一次），共 ${chunks.length} 段`
        : 'nothing was spoken');

    // Progress must mean "how much of the article", not "how much of this chunk".
    // The stub fires chunk 0's boundary at ~50 ms and the rest at ~4 s, so a sample
    // taken in this window is unambiguous: an absolute bar reads ≈ one chunk's
    // share, a per-chunk bar reads ≈ 100%. Sampled as a SERIES rather than once,
    // because "still 0 after 2.5 s" and "rose and was reset" are different bugs and
    // a single sample cannot tell them apart.
    const series = [];
    for (let i = 0; i < 9; i++) {
      await sleep(300);
      const s = await readTts();
      if (s) series.push(s.progress);
    }
    const lastRead = await readTts();
    const peak = series.length ? Math.max(...series) : 0;
    record('listen: progress is measured against the whole article, not the current chunk',
      peak > 0 && peak < 50 && !!lastRead && lastRead.spoken.length >= 2,
      `progress 采样序列=[${series.join(', ')}] 峰值=${peak}%（整篇口径应 ≈${Math.round(100 / Math.max(1, chunks.length))}%，按段口径会是 100%）` +
      ` note="${lastRead ? lastRead.note : ''}" 已排队 ${lastRead ? lastRead.spoken.length : 0} 段`);

    // Only assertable on a machine that actually ships novelty voices. Said out
    // loud instead of passing vacuously when it does not.
    const noveltyCount = await cdp.eval(panel, `(() => {
      const base = n => String(n).replace(/\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*$/, '').trim().toLowerCase();
      const NOV = ['albert','bad news','bahh','bells','boing','bubbles','cellos','deranged',
        'fred','good news','hysterical','jester','junior','kathy','organ','pipe organ',
        'princess','ralph','superstar','trinoids','whisper','wobble','zarvox'];
      return (window.__ttsRealVoices || []).filter(v => NOV.includes(base(v.name))).length;
    })()`, false).catch(() => 0);
    const pickedVoice = chunks.length ? String(chunks[0].voice || '') : '';
    const pickedIsNovelty = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|fred|good news|hysterical|jester|junior|kathy|organ|pipe organ|princess|ralph|superstar|trinoids|whisper|wobble|zarvox)\b/i
      .test(pickedVoice);
    record('listen: a novelty voice is not chosen while a proper same-language voice exists',
      noveltyCount === 0 ? true : (!pickedIsNovelty && !!pickedVoice),
      noveltyCount === 0
        ? `本机本次没有暴露任何玩具音色（真实音色清单里 0 个），该项无可测对象——已由 selftest-speech.cjs 的确定性用例覆盖`
        : `本机有 ${noveltyCount} 个玩具音色，实际选中="${pickedVoice}"`);

    await resetTts();

    // ---- 28 a FAILING sendMessage must not leak an unchecked lastError.
    //
    // This is the regression guard for the entry the user actually reported in
    // chrome://extensions:
    //   "Unchecked runtime.lastError: Could not establish connection.
    //    Receiving end does not exist."
    // Chrome logs that whenever a send fails and `runtime.lastError` is never
    // read — which the promise form does not do for you. We force a guaranteed
    // API failure and check both that it really failed and that nothing leaked.
    //
    // Note: the original race (messaging while the extension's SW is still
    // cold-starting) is timing dependent and, unlike page service workers,
    // extension workers are not manageable through the CDP ServiceWorker domain,
    // so it cannot be forced here. Whole-run audit #25 covers the normal path.
    const failing = await cdp.eval(panel, `(async () => {
      const m = await import(chrome.runtime.getURL('shared/messaging.js'));
      let rejected = 0, resolvedUnexpectedly = 0;
      try { await m.sendToTab(99999999, { type: 'PING' }); resolvedUnexpectedly++; }
      catch (e) { rejected++; }
      try { await m.sendToSW({ type: '__OMNISENSE_E2E_NO_SUCH_TYPE__' }).then(() => {}, () => { rejected++; }); }
      catch (e) { rejected++; }
      await new Promise(r => setTimeout(r, 500));
      return { rejected, resolvedUnexpectedly };
    })()`).catch(e => 'THROW:' + e.message);
    await sleep(900);
    const leakedAfterFailure = cdp.exceptions.filter(e => /Unchecked runtime\.lastError/i.test(e)).length;
    const failureExercised = typeof failing === 'object' && failing.rejected >= 1;
    record('failing sendMessage is handled and leaks no unchecked lastError',
      leakedAfterFailure === 0 && failureExercised,
      `result=${JSON.stringify(failing)} exercised=${failureExercised} leaked=${leakedAfterFailure}`);

    // ---- 28 error budget
    await sleep(600);
    const benign = /ERR_BLOCKED_BY_CLIENT|ERR_FILE_NOT_FOUND.*favicon|\/favicon\.ico|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_FAILED|Failed to load resource|net::ERR_/i;
    const unexpected = cdp.exceptions.filter(e => !benign.test(e));
    record('no unexpected runtime exceptions', unexpected.length === 0,
      unexpected.length ? unexpected.slice(0, 6).join(' | ') : '0 exceptions');

    // ---- 29 explicit regression guard for the chrome://extensions error panel.
    // A failed sendMessage whose runtime.lastError is never read shows up here as
    // a user-visible extension error, so this must stay at zero.
    const unchecked = cdp.exceptions.filter(e => /Unchecked runtime\.lastError/i.test(e));
    record('no unchecked runtime.lastError (chrome://extensions stays clean)',
      unchecked.length === 0,
      unchecked.length ? unchecked.slice(0, 4).join(' | ') : '0 entries');

  } catch (e) {
    record('harness', false, e.message + '\n' + (e.stack || ''));
  } finally {
    // Graceful, not SIGKILL: a hard kill can tear the profile's LevelDB service
    // worker registration store mid-write, after which the worker can never
    // start again in that profile and every later run fails for no visible
    // reason. See e2e/lib/profile.cjs.
    console.log(await stopChrome(chrome));
    try { srv.close(); } catch {}
    // Keep the persistent profile (it holds the model weight cache) unless the
    // run explicitly asked for a throwaway one.
    if (FRESH) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n==== E2E SUMMARY: ${results.length - failed.length}/${results.length} passed ====`);
  if (failed.length) {
    console.log('Failed:');
    failed.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
  }
  process.exit(failed.length ? 1 : 0);
})();
