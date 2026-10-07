#!/usr/bin/env node
/*
 * Unit selftest for `shared/capsule-chunk.js`.
 *
 * No browser, no Chrome, no model. It imports the SAME module the inference host
 * imports, so nothing here can drift from the product, and it runs in about a
 * second — which is the point, because the defect it guards against is invisible
 * in the product's own UI. A Chinese article that was indexed as one truncated
 * chunk still reports a plausible chunk count ("4 段记忆") and still shows a
 * snippet; the only externally visible symptom is that searching for anything the
 * article said in its second half returns nothing.
 *
 * Usage: node e2e/selftest-capsule.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}\n      ${detail}`); }
};

/**
 * The implementation this module replaced, kept here ONLY as a control.
 *
 * An assertion like "more than one chunk" proves nothing on its own — it would
 * pass on a fixed machine and on a broken one for the wrong reason. Running the
 * old rule over the same fixture is what makes the comparison mean something:
 * the fixture must produce 1 chunk under the old rule and >1 under the new one.
 */
function legacyChunkCount(text, chunkSize = 128) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) chunks.push(words.slice(i, i + chunkSize).join(' '));
  return { words: words.length, chunks: chunks.length, longest: Math.max(0, ...chunks.map(c => c.length)) };
}

/** A realistic Chinese article: 30 paragraphs, no spaces inside a paragraph. */
function chineseArticle(paragraphs = 30) {
  const body = '这是一个关于本地推理与隐私保护的中文段落，用来模拟真实文章正文，每段大约六十个汉字，段落内部没有空格，只有段与段之间有换行符号。';
  return Array.from({ length: paragraphs }, (_, i) =>
    `第${i + 1}段是` + body.slice(3)).join('\n\n');
}

/** A realistic English article: 30 paragraphs of ordinary prose. */
function englishArticle(paragraphs = 30) {
  const body = 'Local inference keeps every byte of your data on your own machine which is the whole point of the product design here today.';
  return Array.from({ length: paragraphs }, (_, i) => `Para${i + 1} ${body}`).join('\n\n');
}

(async () => {
  const mod = await import(pathToFileURL(path.resolve(__dirname, '../shared/capsule-chunk.js')).href);
  const {
    chunkForEmbedding, groupByPage, pageKey, supersededRowIds,
    EMBED_MAX_CHARS_CJK, EMBED_MAX_CHARS_LATIN, EMBED_WORDS_PER_CHUNK, CAPSULE_MAX_CHUNKS
  } = mod;

  // ---------------- the regression itself ----------------
  console.log('\n=== 中文长文必须真的被切成多段（本模块存在的理由）===');
  {
    const zh = chineseArticle();
    const legacy = legacyChunkCount(zh);
    const chunks = chunkForEmbedding(zh);
    ok('夹具能复现旧规则：旧实现把整篇中文压成 1 段',
      legacy.chunks === 1 && legacy.longest === zh.replace(/\s+/g, ' ').trim().length,
      `旧规则得到 ${legacy.chunks} 段，最长 ${legacy.longest} 字（原文 ${zh.length} 字）`);
    ok('新实现切出多段', chunks.length > 1,
      `${zh.length} 字的中文文章只切出 ${chunks.length} 段`);
    ok('每一段都在嵌入窗口内（≤ ' + EMBED_MAX_CHARS_CJK + ' 字）',
      chunks.every(c => c.length <= EMBED_MAX_CHARS_CJK),
      JSON.stringify(chunks.map(c => c.length)));
    // The real substance of the fix: the END of the article is reachable.
    const tailMarker = '第30段是';
    ok('文章结尾的段落确实进了索引（旧实现永远丢掉的 3/4）',
      chunks.some(c => c.includes(tailMarker)),
      `没有任何一段包含 "${tailMarker}"；段落长度 ${JSON.stringify(chunks.map(c => c.length))}`);
    const covered = chunks.join('').replace(/\s+/g, '');
    ok('拼接后覆盖全文（逐字符比对）',
      covered === zh.replace(/\s+/g, ''),
      `覆盖 ${covered.length} / ${zh.replace(/\s+/g, '').length} 字`);
  }
  {
    // No paragraph breaks at all: the worst case for a whitespace-based splitter,
    // and the one a single long <div> of Chinese text actually produces.
    const blob = '汉'.repeat(2000);
    const chunks = chunkForEmbedding(blob);
    ok('完全无空白的中文 2000 字也被切开且不超限',
      chunks.length > 1 && chunks.every(c => c.length <= EMBED_MAX_CHARS_CJK),
      `${chunks.length} 段，长度 ${JSON.stringify(chunks.map(c => c.length))}`);
    ok('无空白中文的拼接覆盖不变',
      chunks.join('') === blob, `${chunks.join('').length} / ${blob.length}`);
  }

  // ---------------- Latin behaviour is preserved ----------------
  console.log('\n=== 拉丁文保持原行为（128 词一块）===');
  {
    const en = englishArticle();
    const chunks = chunkForEmbedding(en);
    const words = en.split(/\s+/).filter(Boolean);
    ok('按 128 词切块，块数符合预期',
      chunks.length === Math.ceil(words.length / EMBED_WORDS_PER_CHUNK),
      `${words.length} 词 → ${chunks.length} 段（期望 ${Math.ceil(words.length / EMBED_WORDS_PER_CHUNK)}）`);
    ok('每段都在拉丁字符上限内',
      chunks.every(c => c.length <= EMBED_MAX_CHARS_LATIN),
      JSON.stringify(chunks.map(c => c.length)));
    ok('拉丁文第一段与旧实现逐字一致（没有顺手改坏）',
      chunks[0] === words.slice(0, EMBED_WORDS_PER_CHUNK).join(' '),
      `"${chunks[0].slice(0, 60)}…"`);
  }
  {
    // A word-count budget bounds nothing when there is only one "word".
    const blob = 'x'.repeat(5000);
    const chunks = chunkForEmbedding(blob);
    ok('单个超长"词"（无空格的 5000 字符）仍被切开',
      chunks.length > 1 && chunks.every(c => c.length <= EMBED_MAX_CHARS_LATIN),
      `${chunks.length} 段，长度 ${JSON.stringify(chunks.map(c => c.length))}`);
    ok('超长词拼接覆盖不变', chunks.join('') === blob, `${chunks.join('').length} / ${blob.length}`);
  }

  // ---------------- cap / degenerate input ----------------
  console.log('\n=== 上限与退化输入 ===');
  {
    const huge = chineseArticle(400);
    const chunks = chunkForEmbedding(huge);
    ok(`超过 ${CAPSULE_MAX_CHUNKS} 段时被截断`, chunks.length === CAPSULE_MAX_CHUNKS,
      `${huge.length} 字 → ${chunks.length} 段`);
    ok('limit 参数生效', chunkForEmbedding(huge, 3).length === 3);
  }
  ok('空字符串得到空数组', chunkForEmbedding('').length === 0);
  ok('纯空白得到空数组', chunkForEmbedding('   \n\n  \t ').length === 0);
  ok('null / undefined 不抛异常',
    chunkForEmbedding(null).length === 0 && chunkForEmbedding(undefined).length === 0);
  ok('中英混排（中文为主）走字符预算',
    chunkForEmbedding('在 Chrome 里用 MV3 跑本地推理。'.repeat(40))
      .every(c => c.length <= EMBED_MAX_CHARS_CJK));

  // ---------------- page grouping ----------------
  console.log('\n=== groupByPage（段 → 文章）===');
  // `score` is optional and must actually land on the object when supplied — a
  // first draft declared the parameter and forgot to use it, so every fixture row
  // came out score-less and the ordering assertions were testing nothing.
  const row = (url, stamp, i, snippet, score) => ({
    id: `${url}_${stamp}_${i}`, url, title: 'T', domain: 'example.com',
    snippet, visitTime: stamp, vector: new Array(384).fill(0.1),
    ...(score == null ? null : { score })
  });
  {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row('https://a.test/x', 1000, i, `A${i}`)),
      ...Array.from({ length: 2 }, (_, i) => row('https://b.test/y', 2000, i, `B${i}`))
    ];
    const pages = groupByPage(rows);
    ok('六段一页 + 两段一页 → 两篇文章', pages.length === 2,
      JSON.stringify(pages.map(p => [p.url, p.chunks])));
    ok('段数统计正确',
      pages.find(p => p.url === 'https://a.test/x').chunks === 6 &&
      pages.find(p => p.url === 'https://b.test/y').chunks === 2,
      JSON.stringify(pages.map(p => [p.url, p.chunks])));
    ok('没有分数时按时间倒序（新的在前）', pages[0].url === 'https://b.test/y', pages[0].url);
    ok('向量没有被带出去（384 个 float 不应跨消息端口）',
      pages.every(p => p.vector === undefined && !JSON.stringify(p).includes('0.1,')),
      JSON.stringify(Object.keys(pages[0])));
  }
  {
    const rows = [
      row('https://a.test/x', 1000, 0, 'low', 0.21),
      row('https://a.test/x', 1000, 1, 'best', 0.77),
      row('https://a.test/x', 1000, 2, 'mid', 0.4),
      row('https://b.test/y', 2000, 0, 'other', 0.6)
    ];
    const pages = groupByPage(rows);
    ok('有分数时按最高分排序', pages[0].url === 'https://a.test/x' && pages[0].score === 0.77,
      JSON.stringify(pages.map(p => [p.url, p.score])));
    ok('片段取自得分最高的那一段（而不是第一段）', pages[0].snippet === 'best', pages[0].snippet);
  }
  {
    // The same page captured TWICE. This assertion is the exact opposite of what
    // this suite asserted one round earlier, and the inversion is the point: the
    // first version keyed a page by `url + visitTime` on the reasoning that a
    // re-save is a second visit worth keeping. In practice capturing an article
    // twice (which is what people do when unsure the first one worked) put two
    // identical rows in the list — same title, same domain, same snippet, one
    // "5 小时前" and one "刚刚" — and the report was 「收录的时候，去重吧」.
    const rows = [
      row('https://a.test/x', 1000, 0, 'old a', 0.9),
      row('https://a.test/x', 1000, 1, 'old b', 0.9),
      row('https://a.test/x', 1000, 2, 'old c', 0.9),
      row('https://a.test/x', 5000, 0, 'new a', 0.2),
      row('https://a.test/x', 5000, 1, 'new b', 0.2),
      row('https://b.test/y', 3000, 0, 'other', 0.5)
    ];
    const pages = groupByPage(rows);
    const a = pages.find(p => p.url === 'https://a.test/x');
    ok('同一网址收录两次 → 只有一篇文章', pages.length === 2,
      JSON.stringify(pages.map(p => [p.url, p.chunks])));
    ok('段数只算最新那一次收录，不把两次的段数相加',
      a.chunks === 2 && a.visitTime === 5000,
      `chunks=${a.chunks} visitTime=${a.visitTime}（旧副本 3 段不应计入）`);
    ok('片段取自最新副本（旧副本的 0.9 高分不能压过它）',
      a.snippet === 'new a' || a.snippet === 'new b', `snippet="${a.snippet}"`);
    ok('不同网址仍然各算一篇（去重按网址，不是全局塌缩）',
      pages.some(p => p.url === 'https://b.test/y'));

    const doomed = supersededRowIds(rows);
    ok('supersededRowIds 只列出被取代的旧副本', doomed.length === 3 &&
      doomed.every(id => id.includes('_1000_')), JSON.stringify(doomed));
    ok('supersededRowIds 不误删最新副本或其他页面',
      !doomed.includes('https://a.test/x_5000_0') && !doomed.includes('https://b.test/y_3000_0'));
    ok('没有重复时 supersededRowIds 返回空数组',
      supersededRowIds([row('https://a.test/x', 1000, 0, 'only', 0.3)]).length === 0);
    ok('supersededRowIds 对空/缺 id 输入不抛异常',
      supersededRowIds([]).length === 0 && supersededRowIds(null).length === 0 &&
      supersededRowIds([{ url: 'https://a.test/x', visitTime: 1 }]).length === 0);
  }
  {
    // page identity is the URL alone — the timestamp must NOT participate, or the
    // de-duplication above cannot work.
    const t1 = row('https://a.test/x', 1000, 0, 's', 0.3);
    const t2 = row('https://a.test/x', 9999, 0, 's', 0.3);
    const other = row('https://b.test/y', 1000, 0, 's', 0.3);
    ok('pageKey 只由网址决定（同一页不同时间戳是同一个 key）',
      pageKey(t1) === pageKey(t2), `${pageKey(t1)} vs ${pageKey(t2)}`);
    ok('pageKey 对不同网址给出不同 key', pageKey(t1) !== pageKey(other));
    ok('pageKey 对空输入不抛异常', pageKey(null) === '' && pageKey({}) === '');
  }
  ok('空输入得到空数组', groupByPage([]).length === 0 && groupByPage(null).length === 0);

  console.log(`\n==== 胶囊单元自测：${pass} 通过 / ${fail} 失败 ====`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('SELFTEST ERROR:', e && e.message);
  if (e && e.stack) console.log(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
