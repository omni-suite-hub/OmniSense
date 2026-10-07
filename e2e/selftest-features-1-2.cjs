#!/usr/bin/env node
/**
 * Self-test suite for OmniSense Feature 1 & Feature 2:
 * 1. 网页套路识别与协议审查雷达 (Web Pattern & Agreement Radar)
 * 2. 时光胶囊 · 今日专属早报电台 (Daily Capsule Briefing)
 *
 * Usage: node e2e/selftest-features-1-2.cjs
 */
const assert = require('assert');
const path = require('path');

// ESM dynamic import helper for shared pure modules
async function run() {
  console.log('=== Feature 1: 网页套路识别与协议审查雷达单元测试 ===');

  const radarModulePath = path.resolve(__dirname, '../shared/pattern-radar-core.js');
  const radar = await import(`file://${radarModulePath}`);

  // --- 1.1 倒计时解析测试 ---
  const t1 = radar.parseCountdownText('距特惠结束仅剩 14:59');
  assert.ok(t1, '应解析出时钟格式倒计时');
  assert.strictEqual(t1.totalSeconds, 14 * 60 + 59);

  const t2 = radar.parseCountdownText('01:23:45 剩余');
  assert.ok(t2, '应解析出时分秒格式');
  assert.strictEqual(t2.totalSeconds, 1 * 3600 + 23 * 60 + 45);

  const t3 = radar.parseCountdownText('限时 15 分钟');
  assert.ok(t3, '应解析出文字单位格式');
  assert.strictEqual(t3.totalSeconds, 15 * 60);

  const t4 = radar.parseCountdownText('普通网页普通文字无倒计时');
  assert.strictEqual(t4, null, '普通文字应返回 null');
  console.log('  ✔ 倒计时文本格式精准提取（分秒、时分秒、中文单位）');

  // --- 1.2 虚假倒计时（刷新重置）判定测试 ---
  const firstSeen = 1000000;
  const historyRecord = {
    firstSeen,
    initialSeconds: 900, // 15:00
    observedCount: 1
  };

  // 用户 10 秒后刷新网页，如果真实计时应该是 890，但网页倒计时重置回 900
  const evalReset = radar.evaluateCountdownAuthenticity(historyRecord, 900, firstSeen + 10000);
  assert.strictEqual(evalReset.isFake, true);
  assert.strictEqual(evalReset.reason, 'reset_on_reload');
  console.log('  ✔ 成功识别跨页面/刷新重置的虚假心理促单倒计时');

  // 正常倒计时走表：10秒后为 890 秒
  const evalNormal = radar.evaluateCountdownAuthenticity(historyRecord, 890, firstSeen + 10000);
  assert.strictEqual(evalNormal.isFake, false);
  console.log('  ✔ 真实同步走表计时器不被误判');

  // --- 1.3 拒绝 Cookie / 弹窗粉碎判定测试 ---
  assert.strictEqual(radar.isRejectCookieButton('Reject All'), true);
  assert.strictEqual(radar.isRejectCookieButton('Essential only'), true);
  assert.strictEqual(radar.isRejectCookieButton('仅接受必要'), true);
  assert.strictEqual(radar.isRejectCookieButton('不同意'), true);
  assert.strictEqual(radar.isRejectCookieButton('拒绝全部'), true);
  // Negative override
  assert.strictEqual(radar.isRejectCookieButton('Accept all'), false);
  assert.strictEqual(radar.isRejectCookieButton('全部同意并继续'), false);
  assert.strictEqual(radar.isRejectCookieButton('Agree'), false);
  console.log('  ✔ Cookie 遮罩拒绝按钮与同意按钮高精度语义辨识');

  // --- 1.4 服务协议 5 大风险维度排查测试 ---
  const riskyTerms = `
    欢迎使用本服务。
    【第一条】服务到期前24小时将自动续费扣款，连续包月不可随时中途退款。
    【第二条】用户在平台上传的全部文字与图片内容，其知识产权与版权均永久无偿归平台所有，包含不可撤销的独占许可。
    【第三条】平台有权将用户的生物识别与个人画像信息共享给第三方商业伙伴用于商业化变现与定向推送。
    【第四条】平台在法律允许的最大范围内对任何数据丢失概不负责，免除责任，单方修改协议而无需通知用户。
    【第五条】若发生争议，用户同意放弃集体诉讼权利，由平台所在地仲裁委员会进行专属管辖。
  `;

  const report = radar.scanAgreementRisks(riskyTerms);
  assert.strictEqual(report.overallRisk, 'high', '应判定为高危协议');
  assert.strictEqual(report.findings.length, 5, '应完整排查出全部 5 大风险维度');

  const dimsFound = new Set(report.findings.map(f => f.dimension));
  assert.ok(dimsFound.has('auto_renewal'), '应命中自动续费');
  assert.ok(dimsFound.has('ip_assignment'), '应命中版权让渡');
  assert.ok(dimsFound.has('privacy_sharing'), '应命中隐私共享');
  assert.ok(dimsFound.has('disclaimer'), '应命中单方免责');
  assert.ok(dimsFound.has('jurisdiction'), '应命中管辖限制');
  console.log('  ✔ 5 大维度协议霸王条款精准命中与证据摘录');

  // 干净协议
  const cleanTerms = `本网站为开源学术技术交流分享，用户保有个人创作之全部署名与著作权益，不收集个人生物特征。`;
  const cleanReport = radar.scanAgreementRisks(cleanTerms);
  assert.strictEqual(cleanReport.overallRisk, 'clean');
  assert.strictEqual(cleanReport.findings.length, 0);
  console.log('  ✔ 规范协议判定为干净零风险');

  console.log('\n=== Feature 2: 时光胶囊 · 今日专属早报电台单元测试 ===');

  const briefingModulePath = path.resolve(__dirname, '../shared/briefing-core.js');
  const briefing = await import(`file://${briefingModulePath}`);

  // --- 2.1 胶囊文章时间窗口筛选 ---
  const now = 1700000000000;
  const hour = 3600 * 1000;
  const mockPages = [
    { title: '文章 1 (10h前)', visitTime: now - 10 * hour, domain: 'tech.com', snippet: '大模型量化技术取得新突破。' },
    { title: '文章 2 (20h前)', visitTime: now - 20 * hour, domain: 'ai.org', snippet: '注意力机制的内存占用下降 40%。' },
    { title: '文章 3 (60h前)', visitTime: now - 60 * hour, domain: 'old.com', snippet: '历史旧文章。' },
    { title: '文章 4 (80h前)', visitTime: now - 80 * hour, domain: 'older.com', snippet: '更早的记忆。' }
  ];

  const selected = briefing.filterBriefingMemories(mockPages, now, 48, 2, 5);
  assert.strictEqual(selected.length, 2, '48小时窗口内应筛选出 2 篇最新收录');
  assert.strictEqual(selected[0].title, '文章 1 (10h前)');
  assert.strictEqual(selected[1].title, '文章 2 (20h前)');
  console.log('  ✔ 48 小时记忆时间窗口过滤正确筛选目标网页');

  // 测试 fallback：若 48h 内不足 2 篇，自动回退取最新可用文章
  const oldOnlyPages = [
    { title: '旧文章 A', visitTime: now - 100 * hour, snippet: 'A 内容' },
    { title: '旧文章 B', visitTime: now - 110 * hour, snippet: 'B 内容' },
    { title: '旧文章 C', visitTime: now - 120 * hour, snippet: 'C 内容' }
  ];
  const fallbackSelected = briefing.filterBriefingMemories(oldOnlyPages, now, 48, 2, 5);
  assert.strictEqual(fallbackSelected.length, 3, '48h无新文章时应平滑回退取最新记忆');
  console.log('  ✔ 无近期记忆时优雅回退保证电台播报不留空');

  // --- 2.2 早报电台提示词结构生成 ---
  const promptInput = briefing.buildBriefingPromptInput(selected);
  assert.ok(promptInput.includes('【文章 1】《文章 1 (10h前)》'));
  assert.ok(promptInput.includes('大模型量化技术取得新突破'));
  console.log('  ✔ 晨间早报结构化知识提示词拼接正确');

  // --- 2.3 离线口语广播串联稿生成 ---
  const offlineScriptZh = briefing.generateOfflineBriefingScript(selected, 'zh', now);
  assert.ok(offlineScriptZh.includes('OmniSense FM 98.5'));
  assert.ok(offlineScriptZh.includes('文章 1 (10h前)'));
  assert.ok(offlineScriptZh.includes('文章 2 (20h前)'));
  assert.ok(offlineScriptZh.includes('早上好'));
  assert.strictEqual(offlineScriptZh.includes('#'), false, '口语广播稿不能出现 markdown 井号');
  assert.strictEqual(offlineScriptZh.includes('*'), false, '口语广播稿不能出现 markdown 星号');
  console.log('  ✔ 离线播音主持人口语化串联稿生成（无Markdown噪音，适合语音合成）');

  const offlineScriptEn = briefing.generateOfflineBriefingScript(selected, 'en', now);
  assert.ok(offlineScriptEn.includes('Good morning'));
  assert.ok(offlineScriptEn.includes('OmniSense FM 98.5'));
  console.log('  ✔ 英文早报广播稿口语化转换正常');

  console.log('\n==== Feature 1 & 2 单元自测：全部通过！====');
}

run().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
