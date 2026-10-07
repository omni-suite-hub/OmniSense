#!/usr/bin/env node
/*
 * Unit selftest for `shared/speech.js`.
 *
 * No browser, no Chrome, no model: this file imports the SAME module the side
 * panel imports, so nothing here can drift away from the product. It runs in
 * about a second, which is why it exists next to the full E2E rather than inside
 * it — the E2E takes minutes and needs a real Chrome, so a ranking regression
 * found only there would be found late.
 *
 * What it pins down, and why each one is here:
 *
 *   · splitForSpeech's concatenation invariant. "It read something" is not the
 *     contract; "it read the whole text, once, in order" is. If a chunk is ever
 *     dropped or duplicated, this fails immediately.
 *   · Sentence-end preference and the ASCII '.' guard. A splitter that cuts
 *     inside `127.0.0.1` mispronounces the address, which is a silent quality
 *     regression no assertion on "did it speak" would catch.
 *   · dominantScript's weighting, including the mixed-script case.
 *   · pickVoice's tiers, with a synthetic voice list that reproduces the machine
 *     this was diagnosed on (199 voices, novelty voices among them).
 *
 * Usage: node e2e/selftest-speech.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}\n      ${detail}`); }
};

(async () => {
  const mod = await import(pathToFileURL(path.resolve(__dirname, '../shared/speech.js')).href);
  const {
    splitForSpeech, normalizeForSpeech, dominantScript, pickVoice, rankVoices,
    voiceBaseName, localeCounts, isNoveltyVoice, SPEECH_CHUNK_MAX_CHARS
  } = mod;

  // ---------------- splitForSpeech ----------------
  console.log('\n=== splitForSpeech ===');
  {
    const text = '第一句。第二句！第三句？第四句，还在继续，ABCDEFG 12345 v1.2 127.0.0.1 结束。';
    const { normalized, chunks } = splitForSpeech(text);
    ok('拼接不变式：chunks 拼回原文',
      chunks.map(c => c.text).join('') === normalized,
      `"${chunks.map(c => c.text).join('')}" !== "${normalized}"`);
    ok('没有空块', chunks.every(c => c.text.length > 0),
      JSON.stringify(chunks.map(c => c.text)));
    ok('块边界单调且首尾吻合',
      chunks[0].start === 0 && chunks[chunks.length - 1].end === normalized.length &&
      chunks.every((c, i) => i === 0 || c.start === chunks[i - 1].end),
      JSON.stringify(chunks.map(c => [c.start, c.end])));
    // The ASCII '.' guard: neither dotted token may be cut, in any chunking.
    for (const token of ['127.0.0.1', 'v1.2']) {
      ok(`不切断 ${token}`, chunks.some(c => c.text.includes(token)),
        `"${token}" 未完整出现在任何块里：${JSON.stringify(chunks.map(c => c.text))}`);
    }
    ok('每块不超过上限', chunks.every(c => c.text.length <= SPEECH_CHUNK_MAX_CHARS),
      JSON.stringify(chunks.map(c => c.text.length)));
  }
  {
    const long = '甲'.repeat(1000);
    const { normalized, chunks } = splitForSpeech(long);
    ok('1000 字无标点也能切，且拼接不变式成立',
      chunks.map(c => c.text).join('') === normalized &&
      chunks.every(c => c.text.length <= SPEECH_CHUNK_MAX_CHARS),
      `${chunks.length} 块，长度 ${chunks.map(c => c.text.length).join(',')}`);
  }
  {
    const { chunks } = splitForSpeech('   \n\n  你好   世界  \n  ');
    ok('空白规范化后不留空白块',
      chunks.length > 0 && chunks.every(c => c.text.trim().length > 0),
      JSON.stringify(chunks.map(c => c.text)));
  }
  ok('normalizeForSpeech 压缩空白', normalizeForSpeech('a \n\n\n  b') === 'a\n\nb',
    JSON.stringify(normalizeForSpeech('a \n\n\n  b')));
  {
    const { chunks } = splitForSpeech('');
    ok('空输入得到空块数组', chunks.length === 0, JSON.stringify(chunks));
  }

  // ---------------- dominantScript ----------------
  console.log('\n=== dominantScript ===');
  ok('纯中文 → han', dominantScript('这是一段中文正文') === 'han');
  ok('纯英文 → latin', dominantScript('this is an english sentence') === 'latin');
  ok('中英混排（中文占主体）→ han', dominantScript('在 Chrome 里用 MV3 跑本地推理') === 'han');
  ok('英文正文里的少量中文 → latin',
    dominantScript('The extension is called 时光胶囊 and it stores text') === 'latin');
  ok('没有字母也没有汉字 → latin（不抛异常）', dominantScript('123 456 !!!') === 'latin');

  // ---------------- voice names / locale counts ----------------
  console.log('\n=== voiceBaseName / localeCounts ===');
  ok('去掉 ASCII 地区后缀',
    voiceBaseName({ name: 'Eddy (Chinese (China mainland))' }) === 'Eddy',
    voiceBaseName({ name: 'Eddy (Chinese (China mainland))' }));
  ok('去掉全角括号地区后缀',
    voiceBaseName({ name: 'Daniel (英语（英国）)' }) === 'Daniel',
    voiceBaseName({ name: 'Daniel (英语（英国）)' }));
  ok('没有后缀时原样返回', voiceBaseName({ name: 'Tingting' }) === 'Tingting');
  {
    const vs = [
      { name: 'Eddy (Chinese (China mainland))', lang: 'zh-CN' },
      { name: 'Eddy (Chinese (Taiwan))', lang: 'zh-TW' },
      { name: 'Eddy (English (United States))', lang: 'en-US' },
      { name: 'Tingting', lang: 'zh-CN' }
    ];
    const c = localeCounts(vs);
    ok('同一音色跨语种被计数为 3', c.get('Eddy') === 3, String(c.get('Eddy')));
    ok('专用音色计数为 1', c.get('Tingting') === 1, String(c.get('Tingting')));
  }
  ok('Albert 被识别为玩具音色', isNoveltyVoice({ name: 'Albert' }) === true);
  ok('Samantha 不是玩具音色', isNoveltyVoice({ name: 'Samantha' }) === false);

  // ---------------- pickVoice ----------------
  //
  // Faithful to the machine the defect was diagnosed on. Two properties matter
  // and neither is decoration:
  //   · ORDER reproduces the engine's return order, which is what the OLD rule
  //     fell through to — Albert is the first `en-US` entry.
  //   · the personas appear under SEVERAL locales, because that is what makes
  //     them personas. A fixture that lists `Eddy` once would call it a dedicated
  //     voice and the ranking would look correct while being wrong.
  console.log('\n=== pickVoice（复刻出问题的那台机器）===');
  const PERSONAS = ['Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley'];
  const personaAcross = locales => PERSONAS.flatMap(base =>
    locales.map(l => ({ name: `${base} (${l.place})`, lang: l.lang, localService: true })));
  const VOICES = [
    { name: 'Daniel (English (United Kingdom))', lang: 'en-GB', localService: true, default: true },
    { name: 'Albert', lang: 'en-US', localService: true },
    { name: 'Bad News', lang: 'en-US', localService: true },
    { name: 'Bells', lang: 'en-US', localService: true },
    { name: 'Fred', lang: 'en-US', localService: true },
    { name: 'Kathy', lang: 'en-US', localService: true },
    { name: 'Samantha', lang: 'en-US', localService: true },
    ...personaAcross([
      { place: 'English (United States)', lang: 'en-US' },
      { place: 'English (United Kingdom)', lang: 'en-GB' },
      { place: 'Chinese (China mainland)', lang: 'zh-CN' },
      { place: 'Chinese (Taiwan)', lang: 'zh-TW' },
      { place: 'German (Germany)', lang: 'de-DE' },
      { place: 'French (France)', lang: 'fr-FR' }
    ]),
    { name: 'Tingting', lang: 'zh-CN', localService: true },
    { name: 'Meijia', lang: 'zh-TW', localService: true },
    { name: 'Sinji', lang: 'zh-HK', localService: true },
    { name: 'Google 普通话（中国大陆）', lang: 'zh-CN', localService: false },
    { name: 'Google US English', lang: 'en-US', localService: false }
  ];
  ok('夹具里每个角色音色都跨多个语种（否则判据失真）',
    PERSONAS.every(b => localeCounts(VOICES).get(b) === 6),
    JSON.stringify(PERSONAS.map(b => [b, localeCounts(VOICES).get(b)])));
  {
    const en = pickVoice(VOICES, 'latin');
    ok('英文选中系统默认音色（不是玩具音色 Albert）',
      en && !isNoveltyVoice(en) && en.name.startsWith('Daniel'),
      `选中 ${en && en.name}`);
  }
  {
    const zh = pickVoice(VOICES, 'han');
    ok('中文选中专用中文音色（不是角色音色 Eddy/Flo）',
      zh && isNoveltyVoice(zh) === false && zh.lang === 'zh-CN' &&
      !new RegExp(`^(${PERSONAS.join('|')})\\b`).test(zh.name),
      `选中 ${zh && zh.name}`);
  }
  {
    // No `default` anywhere and no dedicated voice: a persona must still win over
    // nothing at all — refusing is only for the cross-writing-system case.
    const onlyPersonas = personaAcross([
      { place: 'Chinese (China mainland)', lang: 'zh-CN' },
      { place: 'Chinese (Taiwan)', lang: 'zh-TW' }
    ]);
    const zh = pickVoice(onlyPersonas, 'han');
    ok('只有角色音色时仍然朗读（不越界拒绝）', !!zh && zh.lang === 'zh-CN',
      `选中 ${zh && zh.name}`);
  }
  {
    const ranked = rankVoices(VOICES, 'latin');
    ok('rankVoices 附带判据，且赢家不是玩具音色',
      ranked.length > 0 && !!ranked[0].why && !/NOVELTY/.test(ranked[0].why),
      JSON.stringify(ranked.slice(0, 3).map(r => [r.voice.name, r.score, r.why])));
    ok('玩具音色被排在同语种非玩具之后',
      ranked.findIndex(r => r.voice.name === 'Samantha') <
      ranked.findIndex(r => r.voice.name === 'Albert'),
      JSON.stringify(ranked.map(r => r.voice.name)));
  }
  ok('没有任何同语种音色时返回 null（拒绝而不是越界）',
    pickVoice([{ name: 'Tingting', lang: 'zh-CN' }], 'latin') === null);
  ok('空列表返回 null', pickVoice([], 'han') === null && pickVoice(null, 'latin') === null);

  console.log(`\n==== 单元自测：${pass} 通过 / ${fail} 失败 ====`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('SELFTEST ERROR:', e && e.message);
  if (e && e.stack) console.log(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
