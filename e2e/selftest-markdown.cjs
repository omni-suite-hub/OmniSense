// e2e/selftest-markdown.cjs
// Unit tests for shared/markdown.js

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

async function run() {
  const { renderMarkdown } = await import('../shared/markdown.js');

  console.log('\n=== Markdown 自动识别与渲染 单元测试 ===');

test('空输入或非字符串安全返回', () => {
  assert.strictEqual(renderMarkdown(''), '');
  assert.strictEqual(renderMarkdown(null), '');
  assert.strictEqual(renderMarkdown(undefined), '');
});

test('XSS 实体转义安全性', () => {
  const dangerous = '<script>alert(1)</script><img src="x" onerror="steal()">';
  const out = renderMarkdown(dangerous);
  assert.ok(!out.includes('<script>'), '不得包含未转义 script');
  assert.ok(!out.includes('<img '), '不得包含未转义 img');
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('&lt;img'));
});

test('中文特征括号标题解析 (【天平倾向指标】)', () => {
  const input = '【天平倾向指标】\n- 事实客观度：[60%] | - 情绪主观度：[30%]';
  const out = renderMarkdown(input);
  assert.ok(out.includes('class="md-section-badge"'), '应生成 section badge');
  assert.ok(out.includes('【天平倾向指标】'));
  assert.ok(out.includes('<span class="md-tag">60%</span>'), '应提取 60% 标签');
  assert.ok(out.includes('<span class="md-tag">30%</span>'), '应提取 30% 标签');
});

test('标准 Markdown 标题 (#, ##, ###)', () => {
  const input = '# 大标题\n## 二级标题\n### 三级标题';
  const out = renderMarkdown(input);
  assert.ok(out.includes('<h1 class="md-h1">大标题</h1>'));
  assert.ok(out.includes('<h2 class="md-h2">二级标题</h2>'));
  assert.ok(out.includes('<h3 class="md-h3">三级标题</h3>'));
});

test('无序列表与有序列表成组合并', () => {
  const input = '- 论点 1\n- 论点 2\n\n1. 步骤 A\n2. 步骤 B';
  const out = renderMarkdown(input);
  assert.ok(out.includes('<ul class="md-ul"><li class="md-li">论点 1</li><li class="md-li">论点 2</li></ul>'));
  assert.ok(out.includes('<ol class="md-ol"><li class="md-li">步骤 A</li><li class="md-li">步骤 B</li></ol>'));
});

test('行内加粗、斜体与删除线', () => {
  const input = '这是 **核心论据**，还有 *强调内容* 和 ~~作废观点~~。';
  const out = renderMarkdown(input);
  assert.ok(out.includes('<strong class="md-strong">核心论据</strong>'));
  assert.ok(out.includes('<em class="md-em">强调内容</em>'));
  assert.ok(out.includes('<del class="md-del">作废观点</del>'));
});

test('行内代码与围栏代码块保护', () => {
  const input = '执行 `npm test` 命令：\n\n```bash\ngit status\necho "hello"\n```';
  const out = renderMarkdown(input);
  assert.ok(out.includes('<code class="md-inline-code">npm test</code>'));
  assert.ok(out.includes('<div class="md-code-wrap">'));
  assert.ok(out.includes('<code class="language-bash">git status\necho &quot;hello&quot;</code>'));
});

test('块引用与分割线', () => {
  const input = '> 本文总结了AI前沿动态。\n\n---';
  const out = renderMarkdown(input);
  assert.ok(out.includes('<blockquote class="md-quote">本文总结了AI前沿动态。</blockquote>'));
  assert.ok(out.includes('<hr class="md-hr">'));
});

test('GFM 表格渲染', () => {
  const input = '| 维度 | 评分 |\n| --- | --- |\n| 客观度 | 85% |\n| 严谨度 | 90% |';
  const out = renderMarkdown(input);
  assert.ok(out.includes('<table class="md-table">'));
  assert.ok(out.includes('<th>维度</th>'));
  assert.ok(out.includes('<td>85%</td>'));
});

  console.log(`\n==== Markdown 单元自测: ${passed} 通过 / ${failed} 失败 ====\n`);

  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
