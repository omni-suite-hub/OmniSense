#!/usr/bin/env node
/**
 * Selftest for Read-Along (Karaoke sync) Precision Matching & Sequential Tracking
 *
 * Verifies:
 * 1. toCanonical preserves 1-to-1 character length across Chinese/English punctuation
 * 2. expandToFullSentence expands partial search candidates (e.g. 26 chars) to 100% full sentence boundaries
 * 3. Text matching across multiple text nodes (e.g. <strong>, <code>, <span>)
 * 4. Forward sequential reading progress (preventing Section 4 from matching Section 3 with duplicate keywords)
 */
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}\n      ${detail}`); }
}

console.log('\n=== 音画同步卡拉OK高亮与边界拓展自测 ===');

function toCanonical(str) {
  let res = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\uff1a') res += ':';
    else if (ch === '\uff1b') res += ';';
    else if (ch === '\uff0c') res += ',';
    else if (ch === '\uff08') res += '(';
    else if (ch === '\uff09') res += ')';
    else if (ch === '\u201c' || ch === '\u201d') res += '"';
    else if (ch === '\u2018' || ch === '\u2019') res += "'";
    else if (ch === '\u3010') res += '[';
    else if (ch === '\u3011') res += ']';
    else res += ch.toLowerCase();
  }
  return res;
}

function expandToFullSentence(blockText, anchorStart, anchorEnd, targetLength, anchorOffsetInTarget = 0) {
  let sentStart = Math.max(0, anchorStart - anchorOffsetInTarget);
  while (sentStart < anchorStart && /[\s\u2022\-\*\d\.]/.test(blockText[sentStart])) {
    sentStart++;
  }

  const endPunctuationRe = /[\u3002\uff01\uff1f!?\uff1b;\n]/;
  let sentEnd = -1;
  for (let i = anchorEnd; i < blockText.length; i++) {
    if (endPunctuationRe.test(blockText[i])) {
      let pEnd = i + 1;
      while (pEnd < blockText.length && /[\u2019\u201d"\uff09\]\)]/.test(blockText[pEnd])) {
        pEnd++;
      }
      sentEnd = pEnd;
      break;
    }
  }

  if (sentEnd === -1 || (targetLength > 0 && sentEnd - sentStart > targetLength + 25)) {
    if (targetLength > 0) {
      sentEnd = Math.min(blockText.length, sentStart + targetLength);
    } else {
      sentEnd = blockText.length;
    }
  }

  return { start: sentStart, end: sentEnd };
}

// 1. toCanonical length preservation
{
  const raw = '图像分类器：通过导入预训练模型（如 MobileNetV1）实现页面图片的分类。';
  const canon = toCanonical(raw);
  ok('toCanonical 保持字符映射长度 1:1 绝对一致',
    canon.length === raw.length,
    `raw=${raw.length}, canon=${canon.length}`);
}

// 2. Full sentence expansion from truncated 26-char search candidate
{
  const blockText = '• 图像分类器：通过导入预训练模型（如 MobileNetV1）实现页面图片的分类。';
  const spoken = '图像分类器：通过导入预训练模型（如 MobileNetV1）实现页面图片的分类。';
  const candidate26 = '图像分类器：通过导入预训练模型（如 MobileNe';

  const anchorIdx = toCanonical(blockText).indexOf(toCanonical(candidate26));
  ok('前缀候选词能成功定位到段落内起始偏移', anchorIdx === 2);

  const { start, end } = expandToFullSentence(blockText, anchorIdx, anchorIdx + candidate26.length, spoken.length, 0);
  const highlighted = blockText.slice(start, end);
  ok('26字截断搜索候选词能成功拓展为 100% 完整句子',
    highlighted === spoken,
    `实际高亮: "${highlighted}" vs 期望句子: "${spoken}"`);
  ok('高亮区间未包含列表前端圆点符号 "• "', start === 2);
  ok('高亮区间完整包含了末尾句号与定语从句', highlighted.endsWith('实现页面图片的分类。'));
}

// 3. Multi-node DOM text mapping simulation
{
  const nodes = [
    { text: '图像分类器' },
    { text: '：通过导入预训练模型（如 ' },
    { text: 'MobileNetV1' },
    { text: '）实现页面图片的分类。' }
  ];

  let full = '';
  const mapping = [];
  nodes.forEach((n, nodeIdx) => {
    for (let i = 0; i < n.text.length; i++) {
      mapping.push({ nodeIdx, offset: i });
      full += n.text[i];
    }
  });

  const startInfo = mapping[0];
  const endInfo = mapping[mapping.length - 1];
  ok('跨 DOM 文本节点映射无丢失',
    mapping.length === full.length &&
    startInfo.nodeIdx === 0 && startInfo.offset === 0 &&
    endInfo.nodeIdx === 3 && endInfo.offset === nodes[3].text.length - 1);
}

// 4. Sequential block tracking simulation
{
  const blocks = [
    { id: 'sec3_p1', text: '实时交互性：适用于实时交互场景，如图像分类、姿态识别等。' },
    { id: 'sec3_p2', text: '离线可用性：通过 Web Worker 和 Cache Storage 实现离线部署。' },
    { id: 'sec4_h',  text: '4. 实战案例' },
    { id: 'sec4_p1', text: '图像分类器：通过导入预训练模型（如 MobileNetV1）实现页面图片的分类。' }
  ];

  let lastMatchedBlock = blocks[2]; // Currently at sec4_h

  const currIdx = blocks.indexOf(lastMatchedBlock);
  const orderedBlocks = [...blocks.slice(currIdx), ...blocks.slice(0, currIdx)];

  // Next spoken text contains keyword "图像分类"
  const spoken = '图像分类器：通过导入预训练模型（如 MobileNetV1）实现页面图片的分类。';

  let foundBlock = null;
  for (const b of orderedBlocks) {
    if (b.text.includes('图像分类器')) {
      foundBlock = b;
      break;
    }
  }

  ok('顺序阅读追踪成功优先匹配当前章节段落，避免回跳至前文重复关键词段落',
    foundBlock && foundBlock.id === 'sec4_p1',
    `匹配到了 ${foundBlock?.id}`);
}

// 5. Rate change during playback maintains currentChunkIdx without restarting from 0
{
  let ttsSession = 1;
  let ttsActive = true;
  let ttsPaused = false;
  let currentTTSState = {
    currentChunkIdx: 4,
    endedCount: 4,
    rate: 1,
    session: 1,
    chunks: [{ text: '0' }, { text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }, { text: '5' }]
  };

  // User changes rate to 1.5x while playing
  const newRate = 1.5;
  const startIdx = Math.max(0, currentTTSState.currentChunkIdx || 0);
  currentTTSState.endedCount = startIdx;
  const nextSession = ++ttsSession;
  currentTTSState.session = nextSession;
  currentTTSState.rate = newRate;

  ok('朗读中切换语速准确保留当前句索引（不从头开始）',
    startIdx === 4 && currentTTSState.currentChunkIdx === 4);
  ok('切换语速递增会话版本以作废旧会话回调',
    ttsSession === 2 && currentTTSState.session === 2);
}

// 6. Pause -> Rate change -> Play resumes seamlessly from current chunk
{
  let ttsSession = 1;
  let ttsActive = true;
  let ttsPaused = false;
  let currentTTSState = {
    currentChunkIdx: 3,
    endedCount: 3,
    rate: 1,
    session: 1,
    chunks: [{ text: '0' }, { text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }]
  };

  // Step 1: User pauses
  ttsPaused = true;

  // Step 2: User changes rate while paused
  const newRate = 2.0;
  if (ttsPaused) {
    currentTTSState.rate = newRate; // updates rate without calling speak()+pause() deadlock
  }

  // Step 3: User clicks Play
  let resumedStartIdx = -1;
  let resumedRate = -1;
  if (ttsActive && ttsPaused && currentTTSState) {
    ttsPaused = false;
    resumedRate = currentTTSState.rate;
    resumedStartIdx = Math.max(0, currentTTSState.currentChunkIdx || 0);
    const session = ++ttsSession;
    currentTTSState.session = session;
    currentTTSState.endedCount = resumedStartIdx;
  }

  ok('暂停后切换语速再播放成功从原暂停句恢复',
    resumedStartIdx === 3 && resumedRate === 2.0);
  ok('恢复后状态正确标记为活跃发音且解除暂停标记',
    ttsActive === true && ttsPaused === false);
}

console.log(`\n==== 卡拉OK高亮自测：${pass} 通过 / ${fail} 失败 ====\n`);
if (fail > 0) process.exit(1);

