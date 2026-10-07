#!/usr/bin/env node
/*
 * Diagnostic: what the SYSTEM voices actually sound like.
 *
 * This is the other half of `diag-tts-smooth.cjs`. That script asks Chrome what
 * it does with the text; this one asks the operating system what the audio it
 * produces looks like — and unlike Chrome, this one CAN see the result, because
 * `say` writes a file instead of needing an audio device.
 *
 * It exists because the two decisions in `shared/speech.js` were both made from
 * measurements that otherwise lived in a throwaway shell session:
 *
 *   §1 WHICH VOICE. `pickVoice` used to fall through to "first in the order the
 *      engine returned". Rendering one identical sentence through every candidate
 *      shows what that lands on: the novelty voices are duration outliers, because
 *      they are not really speaking the text.
 *
 *   §2 HOW BIG A CHUNK. Chrome's engine segments a long utterance by itself, and
 *      every segment boundary is a silence. Rendering the same text at increasing
 *      lengths, with NO punctuation at all, makes those engine-inserted breaks
 *      visible as silences — nothing else can produce a gap in an unpunctuated run.
 *      The engine's segmentation interval is what `SPEECH_CHUNK_MAX_CHARS` is
 *      chosen to stay under.
 *
 * macOS only: it drives `/usr/bin/say` and needs `ffmpeg`/`ffprobe`.
 *
 * Usage: node e2e/diag-voice-audio.cjs
 * Env:   VOICE_KEEP_DIR (default a temp dir, removed on exit)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const KEEP = process.env.VOICE_KEEP_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'omni-voice-'));
const NOISE_DB = '-42dB';
const MIN_SILENCE = '0.15';

function have(bin) {
  try { execFileSync('/usr/bin/env', ['sh', '-c', `command -v ${bin}`], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

/** `say -v '?'` → [{ name, lang }]. The name column can itself contain spaces. */
function listVoices() {
  const out = execFileSync('say', ['-v', '?'], { encoding: 'utf8', maxBuffer: 8 << 20 });
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)\s+([a-z]{2}(?:_[A-Z]{2})?)\s+#\s*(.*)$/);
    if (m) rows.push({ name: m[1].trim(), lang: m[2], sample: m[3] });
  }
  return rows;
}

/** Strip a trailing locale suffix, including the nested form Chrome uses. */
const baseName = n => String(n).replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '').trim();

const fmt = n => `${n.toFixed(2)}s`;

/** Render `text` with `voiceName` and analyse the resulting audio file. */
function render(voiceName, text, tag) {
  const file = path.join(KEEP, `${tag}.aiff`);
  try {
    execFileSync('say', ['-v', voiceName, '-o', file, text], { stdio: 'pipe' });
  } catch (e) {
    return { error: 'say failed' };
  }
  let duration = 0;
  try {
    duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
  } catch { return { error: 'ffprobe failed' }; }

  // silencedetect reports on stderr and ffmpeg exits 0, so the shell form (with
  // 2>&1) is the simple way to capture it. Reading only execFileSync's rejected
  // branch silently produced an empty analysis on the first draft.
  const report = execFileSync('/usr/bin/env', ['sh', '-c',
    `ffmpeg -hide_banner -i "${file}" -af silencedetect=noise=${NOISE_DB}:d=${MIN_SILENCE} -f null - 2>&1`],
    { encoding: 'utf8', maxBuffer: 32 << 20 });

  const silences = [];
  let pending = null;
  for (const line of report.split('\n')) {
    const s = line.match(/silence_start:\s*([0-9.]+)/);
    if (s) { pending = Number(s[1]); continue; }
    const d = line.match(/silence_duration:\s*([0-9.]+)/);
    if (d && pending !== null) {
      silences.push({ start: pending, dur: Number(d[1]), inner: pending < duration * 0.97 });
      pending = null;
    }
  }
  return { duration, silences, file };
}

const EN_TEXT = 'the quick brown fox jumps over the lazy dog and then runs across the wide green field until it reaches the tall trees';
const ZH_UNIT = '今天天气很好我们一起去公园散步吧那里的花开得特别漂亮而且空气也非常清新适合拍照留念然后我们坐在长椅上聊了很久关于未来的一些想法孩子们在草地上跑来跑去笑声传得很远';

(async () => {
  if (process.platform !== 'darwin') {
    console.log('仅支持 macOS（需要 say / ffmpeg）。当前平台：' + process.platform);
    process.exit(0);
  }
  if (!have('say') || !have('ffmpeg') || !have('ffprobe')) {
    console.log('缺少依赖：需要 say / ffmpeg / ffprobe 都在 PATH 里。');
    process.exit(0);
  }
  console.log(`临时目录：${KEEP}`);

  const voices = listVoices();
  const byBase = new Map();
  for (const v of voices) {
    const b = baseName(v.name);
    if (!byBase.has(b)) byBase.set(b, new Set());
    byBase.get(b).add(v.lang);
  }
  const localeCount = b => (byBase.get(b) || new Set()).size;

  // ================= §1 which voice, and what it sounds like =================
  console.log(`\n=== §1 英文音色：同一句话（${EN_TEXT.length} 字）的渲染时长与静音 ===`);
  console.log('    时长离群 = 它没有在"读"这段文字。这正是旧规则会踩到的坑。');
  const enNames = voices.filter(v => /^en/.test(v.lang)).map(v => v.name);
  const rows = [];
  for (const name of enNames) {
    const r = render(name, EN_TEXT, `en-${rows.length}`);
    if (r.error) continue;
    const trailing = r.silences.filter(s => !s.inner).reduce((a, s) => a + s.dur, 0);
    rows.push({ name, duration: r.duration, trailing, locales: localeCount(baseName(name)) });
  }
  rows.sort((a, b) => a.duration - b.duration);
  const proper = rows.filter(r => r.duration <= 8);
  const median = proper.length ? proper[Math.floor(proper.length / 2)].duration : (rows[0] ? rows[0].duration : 0);
  for (const r of rows) {
    const ratio = median ? r.duration / median : 1;
    const flag = ratio > 1.25 ? `  ← 离群 ×${ratio.toFixed(2)}（不是正常朗读）` : '';
    console.log(`  ${r.name.padEnd(26)} 时长=${fmt(r.duration)}  拖尾静音=${fmt(r.trailing)}  语种数=${r.locales}${flag}`);
  }
  console.log(`  正常朗读时长中位数=${fmt(median)}；离群音色 ${rows.filter(r => median && r.duration / median > 1.25).length} 个`);

  // Cross-check the hand-written list in the product against the measurement
  // above, so the list cannot quietly become folklore. `shared/speech.js` is the
  // module the panel imports; importing it here is what keeps the two honest.
  const { isNoveltyVoice, NOVELTY_VOICES } = await import(pathToFileURL(path.resolve(__dirname, '../shared/speech.js')).href);
  const outlierNames = rows.filter(r => median && r.duration / median > 1.25).map(r => baseName(r.name));
  const listedOutliers = outlierNames.filter(n => isNoveltyVoice({ name: n }));
  const unlistedOutliers = outlierNames.filter(n => !isNoveltyVoice({ name: n }));
  console.log(`\n  产品清单 NOVELTY_VOICES 共 ${NOVELTY_VOICES.size} 个名字；本机装到 ${rows.filter(r => isNoveltyVoice({ name: baseName(r.name) })).length} 个`);
  console.log(`  实测离群 ${outlierNames.length} 个，其中在清单内 ${listedOutliers.length} 个：${listedOutliers.join(', ') || '(无)'}`);
  console.log(`  实测离群但**不在**清单内 ${unlistedOutliers.length} 个：${unlistedOutliers.join(', ') || '(无 —— 清单没有漏掉任何实测到的异常音色)'}`);

  // ================= §2 how long a single utterance may be =================
  console.log('\n=== §2 单条 utterance 的长度上限：无标点文本里的"句中静音" ===');
  console.log('    文本里没有任何标点，所以任何 >=0.15s 的句中静音都是**引擎自己**插入的分段。');
  const LENGTHS = [60, 120, 250, 500, 1000];
  const probes = [
    { label: '专用中文音色', pick: voices.find(v => /^zh_CN$/.test(v.lang) && localeCount(baseName(v.name)) === 1) },
    { label: '跨语种角色音色', pick: voices.find(v => /^zh_CN$/.test(v.lang) && localeCount(baseName(v.name)) > 1) }
  ];
  for (const p of probes) {
    if (!p.pick) { console.log(`  ${p.label}: 本机没有可用样本`); continue; }
    console.log(`  ${p.label}：${p.pick.name}（语种数=${localeCount(baseName(p.pick.name))}）`);
    for (const n of LENGTHS) {
      let text = '';
      while (text.length < n) text += ZH_UNIT;
      text = text.slice(0, n);
      const r = render(p.pick.name, text, `len-${p.label}-${n}`);
      if (r.error) { console.log(`    ${String(n).padStart(4)} 字  ${r.error}`); continue; }
      const inner = r.silences.filter(s => s.inner);
      const total = inner.reduce((a, s) => a + s.dur, 0);
      const maxLen = inner.reduce((a, s) => Math.max(a, s.dur), 0);
      console.log(`    ${String(n).padStart(4)} 字  时长=${fmt(r.duration).padEnd(8)} 句中静音=${String(inner.length).padStart(2)} 处`
        + `  合计=${fmt(total)}  最长=${fmt(maxLen)}`
        + (inner.length ? `  位置=${inner.map(s => s.start.toFixed(1) + 's').join(',')}` : ''));
    }
  }
  console.log('\n  ⇒ 判定：');
  console.log('     若"句中静音"随长度线性增加，说明引擎按固定间隔自行分段 —— 每段边界都是一次可听的停顿。');
  console.log('     SPEECH_CHUNK_MAX_CHARS 的取值就是让每块的音频时长**短于**这个间隔，');
  console.log('     于是引擎不必自己插段，唯一的静音就落在句末（那里本来就该有停顿）。');

  if (!process.env.VOICE_KEEP_DIR) {
    try { fs.rmSync(KEEP, { recursive: true, force: true }); } catch {}
  }
  console.log('\n==== 取证结束 ====');
})().catch(e => {
  console.log('DIAG ERROR:', e && e.message);
  process.exit(1);
});
