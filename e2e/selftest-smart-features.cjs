/**
 * Self-test for OmniSense Smart Features:
 * - Cosine similarity calculation & clustering
 * - Related memory filtering & scoring
 * - Read-along matching invariants
 */
const assert = require('assert');

function dotProduct(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function clusterItems(items, threshold = 0.6) {
  const clusters = [];
  const assigned = new Set();
  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [items[i]];
    assigned.add(i);
    for (let j = i + 1; j < items.length; j++) {
      if (assigned.has(j)) continue;
      if (dotProduct(items[i].vector, items[j].vector) >= threshold) {
        cluster.push(items[j]);
        assigned.add(j);
      }
    }
    if (cluster.length >= 2) clusters.push(cluster);
  }
  return clusters;
}

function filterRelatedChunks(rawChunks, currentUrl, minScore = 0.55) {
  const normCurrent = (currentUrl || '').split('#')[0].replace(/\/+$/, '');
  return (rawChunks || []).filter(c => {
    const norm = (c.url || '').split('#')[0].replace(/\/+$/, '');
    return norm && norm !== normCurrent && (c.score || 0) >= minScore;
  });
}

function runTests() {
  console.log('=== 智能标签归拢聚类单元测试 ===');
  // Two distinct clusters: AI topics and Travel topics
  // Unit vectors
  const vAI1 = [1, 0, 0, 0];
  const vAI2 = [0.95, 0.05, 0, 0];
  const vTravel1 = [0, 0, 1, 0];
  const vTravel2 = [0, 0, 0.9, 0.1];
  const vRandom = [0.2, 0.2, 0.2, 0.2];

  const tabs = [
    { id: 1, title: 'DeepSeek-V3 架构解析', vector: vAI1 },
    { id: 2, title: '东京旅游必备攻略指南', vector: vTravel1 },
    { id: 3, title: 'Qwen 模型推理实践与优化', vector: vAI2 },
    { id: 4, title: '京都自由行路线推荐', vector: vTravel2 },
    { id: 5, title: '无关标签页', vector: vRandom }
  ];

  const clusters = clusterItems(tabs, 0.8);
  assert.strictEqual(clusters.length, 2, '应识别出 2 个高相似度主题簇');
  assert.strictEqual(clusters[0].length, 2, 'AI 簇应包含 2 个标签页');
  assert.strictEqual(clusters[1].length, 2, '旅游簇应包含 2 个标签页');
  assert.strictEqual(clusters[0][0].id, 1);
  assert.strictEqual(clusters[0][1].id, 3);
  assert.strictEqual(clusters[1][0].id, 2);
  assert.strictEqual(clusters[1][1].id, 4);
  console.log('  ✔ 向量余弦聚类正确将 4 个标签归为 2 组，并剔除无关项');

  console.log('\n=== 时光胶囊相关记忆过滤单元测试 ===');
  const mockChunks = [
    { url: 'https://example.com/ai-1', score: 0.88, text: '文章 A' },
    { url: 'https://current.com/reading#anchor', score: 0.99, text: '当前页本页（必须排除）' },
    { url: 'https://current.com/reading/', score: 0.95, text: '当前页规范化变体（必须排除）' },
    { url: 'https://example.com/unrelated', score: 0.35, text: '低相似度项（必须排除）' },
    { url: 'https://example.com/ai-2', score: 0.72, text: '文章 B' }
  ];

  const filtered = filterRelatedChunks(mockChunks, 'https://current.com/reading');
  assert.strictEqual(filtered.length, 2, '应成功排除自身 URL 及低分项，只保留 2 个关联条目');
  assert.strictEqual(filtered[0].url, 'https://example.com/ai-1');
  assert.strictEqual(filtered[1].url, 'https://example.com/ai-2');
  console.log('  ✔ 成功排除当前浏览网址（含锚点/斜杠变体）与低分无关项');

  console.log('\n=== 音画同步高亮与文本匹配算法单元测试 ===');
  function cleanSearchString(str) {
    return String(str || '')
      .replace(/[\r\n\t\f\v\u00a0\u2000-\u200b]+/g, ' ')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .trim();
  }

  // 1. Non-breaking space & typography normalization
  const inputWithNbsp = 'TensorFlow.js\u00a0是\u2002Google“开源”的\n\t机器学习框架';
  const cleaned = cleanSearchString(inputWithNbsp);
  assert.strictEqual(cleaned, 'TensorFlow.js 是 Google"开源"的 机器学习框架');
  console.log('  ✔ 正确规范化不可见空白字符与全角中文引号');

  // 2. Anti-jitter viewport boundary calculations
  function shouldScroll(top, bottom, vh) {
    return top < vh * 0.18 || bottom > vh * 0.82;
  }
  const vh = 1000;
  assert.strictEqual(shouldScroll(300, 350, vh), false, '舒适视口中心阅读区不应触发任何抖动滚动');
  assert.strictEqual(shouldScroll(100, 150, vh), true, '靠近视口顶边缘 18% 时应触发平滑滚动');
  assert.strictEqual(shouldScroll(850, 900, vh), true, '靠近视口底边缘 82% 时应触发平滑滚动');
  console.log('  ✔ 防抖滚屏判据正确消除短句子连续跳动抖动');

  console.log('\n==== 智能新特性单元自测：全部通过 ====');
}

runTests();
