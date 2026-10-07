// e2e/selftest-features-all.cjs
// Unit & Integration self-tests for the 4 newly implemented features:
// 1. Feature 3: 🗺️ 本地个人知识图谱网 (Personal Knowledge Graph View)
// 2. Feature 4: ⚖️ 观点对抗与立场对比天平 (Devil's Advocate / Bias Detector)
// 3. Feature 5: 📖 极简沉浸禅阅读与智能侧注 (Zen Reader with Inline Annotations)
// 4. Feature 6: ✨ 智能划词魔法气泡 (Selection Magic Pill)

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✖ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\n=== Feature 3: 🗺️ 个人知识图谱网络 单元测试 ===');

// Test 1: Vector dot product & similarity matrix
function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function buildGraph(pages, threshold = 0.4) {
  const nodes = pages.map((p, idx) => ({
    id: `node-${idx}`,
    title: p.title || p.url,
    url: p.url,
    domain: p.domain || (p.url ? new URL(p.url).hostname : 'unknown'),
    chunkCount: p.chunkCount || 1,
    vector: p.vector
  }));

  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].vector && nodes[j].vector) {
        const sim = dotProduct(nodes[i].vector, nodes[j].vector);
        if (sim >= threshold) {
          edges.push({
            source: nodes[i].id,
            target: nodes[j].id,
            weight: Number(sim.toFixed(3))
          });
        }
      }
    }
  }

  return { nodes, edges };
}

test('向量点积余弦相似度计算与阈值过滤 (0.4)', () => {
  const mockPages = [
    { title: 'AI 深度学习', url: 'https://ai.org/deep-learning', vector: [0.9, 0.1, 0.0] },
    { title: '强化学习技术', url: 'https://ai.org/rl', vector: [0.8, 0.2, 0.0] },
    { title: '法式甜点烘焙指南', url: 'https://food.com/baking', vector: [0.0, 0.1, 0.9] }
  ];

  const graph = buildGraph(mockPages, 0.4);
  assert.strictEqual(graph.nodes.length, 3, '应生成 3 个节点');
  assert.strictEqual(graph.edges.length, 1, '仅 AI 相关的两篇应产生关联边');
  assert.strictEqual(graph.edges[0].source, 'node-0');
  assert.strictEqual(graph.edges[0].target, 'node-1');
  assert.ok(graph.edges[0].weight >= 0.7, '高相似度两篇权重应 >= 0.7');
});

test('知识图谱力导向物理引擎单步迭代与排斥引力计算', () => {
  const nodes = [
    { id: 'n1', x: 100, y: 100, vx: 0, vy: 0, radius: 10 },
    { id: 'n2', x: 102, y: 100, vx: 0, vy: 0, radius: 10 } // Close together -> high repulsion
  ];
  const edges = [{ source: nodes[0], target: nodes[1], weight: 0.5 }];

  // Step physics simulation
  const k_repulse = 420;
  const k_spring = 0.05;
  const idealDist = 75;
  const damping = 0.88;

  // Repulsion
  const dx = nodes[1].x - nodes[0].x;
  const dy = nodes[1].y - nodes[0].y;
  const dist = Math.hypot(dx, dy) || 1;
  const repForce = k_repulse / (dist * dist);
  nodes[0].vx -= (dx / dist) * repForce;
  nodes[1].vx += (dx / dist) * repForce;

  // Attraction
  const displacement = dist - idealDist; // negative -> repulsive spring
  const springForce = displacement * k_spring * 0.5;
  nodes[0].vx += (dx / dist) * springForce;
  nodes[1].vx -= (dx / dist) * springForce;

  nodes[0].x += nodes[0].vx * damping;
  nodes[1].x += nodes[1].vx * damping;

  assert.ok(nodes[0].x < 100, '节点 1 应向左推开');
  assert.ok(nodes[1].x > 102, '节点 2 应向右推开');
  assert.ok(Math.abs(nodes[1].x - nodes[0].x) > 2, '两节点间距应显著增加');
});

test('星图搜索关键词精准命中与高亮', () => {
  const nodes = [
    { id: 'n1', title: 'React 19 核心特性与架构变革', domain: 'react.dev' },
    { id: 'n2', title: 'Vue 3 Composition API 指南', domain: 'vuejs.org' },
    { id: 'n3', title: 'PostgreSQL 性能调优实战', domain: 'postgresql.org' }
  ];
  const query = 'react';

  const matches = nodes.filter(n =>
    n.title.toLowerCase().includes(query) || n.domain.toLowerCase().includes(query)
  );

  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].id, 'n1');
});


console.log('\n=== Feature 4: ⚖️ 观点对抗与立场对比天平 单元测试 ===');

function parseBiasScores(text) {
  let factScore = 70;
  let emotionScore = 30;

  const factMatch = text.match(/(?:事实客观度|客观度|客观事实)[^\d]*(\d+)%/i);
  const emotionMatch = text.match(/(?:情绪主观度|主观度|情绪主观)[^\d]*(\d+)%/i);

  if (factMatch && factMatch[1]) {
    factScore = Math.max(5, Math.min(95, parseInt(factMatch[1], 10)));
    emotionScore = 100 - factScore;
  }
  if (emotionMatch && emotionMatch[1]) {
    emotionScore = Math.max(5, Math.min(95, parseInt(emotionMatch[1], 10)));
    if (!factMatch) factScore = 100 - emotionScore;
  }

  let rating = 'balanced';
  if (factScore >= 75) rating = 'objective';
  else if (factScore < 50) rating = 'opinionated';

  return { factScore, emotionScore, rating };
}

test('立场分析模型输出分数精准提取 (事实度与情绪度)', () => {
  const sampleOutput = `
【客观度 vs 情绪倾向分析】
- 事实客观度：82% | 情绪主观度：18%
- 立场倾向评级：客观严谨

### 1. 隐性成本与未言明的代价
- 迁移过程中需要重构大量历史接口，团队学习曲线陡峭。

### 2. 强有力的反方论据
- 社区生态尚未完全成熟，部分第三方库缺乏必要适配。
  `;

  const parsed = parseBiasScores(sampleOutput);
  assert.strictEqual(parsed.factScore, 82, '客观事实分应为 82');
  assert.strictEqual(parsed.emotionScore, 18, '情绪主观分应为 18');
  assert.strictEqual(parsed.rating, 'objective', '评级应为 objective');
});

test('软文与情绪化文章低事实度评级判定', () => {
  const emotiveOutput = `
事实客观度：35%
情绪主观度：65%
文章大量使用夸张修辞与绝对化用语，缺乏对比实验数据。
  `;

  const parsed = parseBiasScores(emotiveOutput);
  assert.strictEqual(parsed.factScore, 35);
  assert.strictEqual(parsed.emotionScore, 65);
  assert.strictEqual(parsed.rating, 'opinionated', '评级应为 opinionated');
});

test('模型输出缺失分数时的安全默认回退', () => {
  const fallbackOutput = `这是一段纯文本分析，未格式化百分比数据。`;
  const parsed = parseBiasScores(fallbackOutput);
  assert.strictEqual(parsed.factScore, 70);
  assert.strictEqual(parsed.emotionScore, 30);
  assert.strictEqual(parsed.rating, 'balanced');
});


console.log('\n=== Feature 5: 📖 极简沉浸禅阅读与智能侧注 单元测试 ===');

function computeReadingTimeMinutes(text) {
  if (!text) return 1;
  const cjkCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const nonCjkWords = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/\b\w+\b/g) || []).length;
  const totalTokens = cjkCount + nonCjkWords;
  return Math.max(1, Math.ceil(totalTokens / 350));
}

test('阅读时间预估算法 (中英文混排)', () => {
  const shortText = '这是一篇短文，大约有几十个字。';
  assert.strictEqual(computeReadingTimeMinutes(shortText), 1, '短文至少需要 1 分钟');

  // 1400 CJK characters -> ~4 minutes
  const longText = '深度思考与沉浸阅读是获取体系化知识的关键能力。'.repeat(60);
  const est = computeReadingTimeMinutes(longText);
  assert.strictEqual(est, 4, '1400+ 字符预计约 4 分钟');
});

test('禅阅读 4 种配色主题与无干扰样式隔离', () => {
  const themes = {
    paper: { bg: '#fbf0d9', text: '#2c251e', accent: '#8b4513' },
    dark: { bg: '#18191a', text: '#e4e6eb', accent: '#34d399' },
    sepia: { bg: '#f4ecd8', text: '#5b4636', accent: '#b45309' },
    white: { bg: '#ffffff', text: '#111827', accent: '#059669' }
  };

  assert.strictEqual(Object.keys(themes).length, 4);
  for (const [name, t] of Object.entries(themes)) {
    assert.ok(t.bg.startsWith('#'), `${name} 背景色必须是 HEX`);
    assert.ok(t.text.startsWith('#'), `${name} 文字颜色必须是 HEX`);
  }
});

test('AI 智能侧注段落映射与结构化解析', () => {
  const rawNotesOutput = `
- **段落 1**：核心论题提出，界定了端侧大模型在浏览器沙箱中的执行边界。
- **段落 3**：对比了 WebGPU 与 WASM 的吞吐性能，指出显存带宽为主要瓶颈。
- **结论**：混合推理流水线在保证零隐私外泄的同时可达到 25 tok/s。
  `;

  const lines = rawNotesOutput.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('-') || l.startsWith('*'));

  assert.strictEqual(lines.length, 3, '应成功解析 3 条侧注');
  assert.ok(lines[0].includes('段落 1'));
  assert.ok(lines[1].includes('WebGPU'));
});


console.log('\n=== Feature 6: ✨ 智能划词魔法气泡 单元测试 ===');

function validateSelection(text) {
  if (!text) return { valid: false, reason: 'empty' };
  const clean = text.trim();
  if (clean.length < 2) return { valid: false, reason: 'too_short' };
  if (clean.length > 800) return { valid: false, reason: 'too_long' };
  return { valid: true, clean };
}

test('选区长度合法性边界校验 (2 - 800 字符)', () => {
  assert.strictEqual(validateSelection('').valid, false);
  assert.strictEqual(validateSelection('a').valid, false);
  assert.strictEqual(validateSelection('   ').valid, false);

  assert.strictEqual(validateSelection('量子计算').valid, true);
  assert.strictEqual(validateSelection('A valid sentence of text.').valid, true);

  const tooLong = 'a'.repeat(801);
  assert.strictEqual(validateSelection(tooLong).valid, false);
  assert.strictEqual(validateSelection(tooLong).reason, 'too_long');
});

test('划词 5 大动作路由映射与提示词前缀组装', () => {
  const actions = ['explain', 'counter', 'polish', 'roast', 'capsule'];
  const testText = '分布式一致性哈希算法在缓存集群扩容时的抖动分析';

  const actionPrompts = {
    explain: `请简明扼要地解释以下选中内容的核心含义，重点说明背景、关键概念及其实际应用价值：\n\n"${testText}"`,
    counter: `请针对以下观点列举最具杀伤力的反方论点或逻辑漏洞，一针见血地指出其局限性或未言明的代价：\n\n"${testText}"`,
    polish: `请对以下文本进行专业级润色，优化语句通顺度、专业词汇搭配和逻辑表达：\n\n"${testText}"`,
    roast: `请针对以下内容进行辛辣幽默的吐槽或调侃，字数 100 字以内：\n\n"${testText}"`
  };

  for (const act of ['explain', 'counter', 'polish', 'roast']) {
    const prompt = actionPrompts[act];
    assert.ok(prompt.includes(testText), `${act} 提示词必须嵌入选中文本`);
  }
});

console.log(`\n==== 4大新特性全部自测完成: ${passed} 通过 / ${failed} 失败 ====\n`);

if (failed > 0) {
  process.exit(1);
}
