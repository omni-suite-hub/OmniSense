/**
 * OmniSense Daily Capsule Briefing — Pure Core Module
 *
 * Provides pure logic for:
 * 1. Filtering capsule memories within the 24-48h window (or picking representative pages)
 * 2. Compiling structured memory snippets into model prompts
 * 3. High-quality offline oral morning radio script generation
 *
 * Zero DOM / Chrome runtime dependencies for easy unit testing.
 */

/**
 * Filters recent pages from the capsule store for the daily morning briefing.
 * Prefers articles visited in the last 48 hours; falls back to the top `maxPages`
 * newest pages if fewer than `minPages` are within 48h.
 */
export function filterBriefingMemories(pages, now = Date.now(), maxHours = 48, minPages = 2, maxPages = 5) {
  if (!Array.isArray(pages) || pages.length === 0) return [];

  const windowMs = maxHours * 3600 * 1000;
  const recent = pages.filter(p => (now - ((p && p.visitTime) || 0)) <= windowMs);

  if (recent.length >= minPages) {
    return recent.slice(0, maxPages);
  }

  // Fallback: take the top newest available pages
  return pages.slice(0, maxPages);
}

/**
 * Builds the text input sent to the WebLLM 'briefing' prompt.
 */
export function buildBriefingPromptInput(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return '';
  return pages.map((p, idx) => {
    const title = p.title || p.domain || '未命名文章'; // i18n-allow-cjk
    const snippet = p.snippet ? p.snippet.slice(0, 300) : '';
    return `【文章 ${idx + 1}】《${title}》\n来源：${p.domain || '网页'}\n核心要点：${snippet}`; // i18n-allow-cjk
  }).join('\n\n');
}

/**
 * Formats timestamp into a localized morning radio station date string.
 */
export function formatRadioDate(timestamp = Date.now(), locale = 'zh') {
  const d = new Date(timestamp);
  if (locale === 'en') {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']; // i18n-allow-cjk
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const w = weekdays[d.getDay()];
  return `${m}月${day}日 星期${w}`; // i18n-allow-cjk
}

/**
 * Generates an oral morning radio broadcast script in case WebLLM is offline or uninitialized.
 * Produces clean, punctuation-spaced sentences that sound natural with SpeechSynthesis.
 */
export function generateOfflineBriefingScript(pages, locale = 'zh', now = Date.now()) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return locale === 'en'
      ? 'Good morning! This is OmniSense 98.5 FM. Your capsule has no recorded articles yet. Save a few pages to unlock your morning briefing.'
      : '早上好！这里是 OmniSense FM 98.5 专属电台。您当前的时光胶囊中还没有收录文章。在浏览时收录几篇网页，明天早晨即可为您播报专属晨间要闻。'; // i18n-allow-cjk
  }

  const dateStr = formatRadioDate(now, locale);

  if (locale === 'en') {
    const intros = [
      `Good morning! Welcome to OmniSense FM 98.5, your personalized morning radio briefing for ${dateStr}.`,
      `Here is a recap of the key knowledge you captured in your capsule over the past few days.`
    ];

    const body = pages.map((p, i) => {
      const title = p.title || 'recent article';
      const snippet = p.snippet ? p.snippet.replace(/\s+/g, ' ').slice(0, 160) : 'interesting insights';
      return `Topic ${i + 1}: From "${title}". The core takeaway notes: ${snippet}.`;
    });

    const outro = [
      `That concludes your OmniSense morning briefing.`,
      `Stay curious and have a productive, wonderful day ahead!`
    ];

    return [...intros, ...body, ...outro].join('\n\n');
  }

  // Chinese broadcast script
  const intros = [ // i18n-allow-cjk
    `早上好！欢迎收听 OmniSense FM 98.5 专属早报电台。今天是 ${dateStr}。`, // i18n-allow-cjk
    `晨光熹微，为您奉上您知识胶囊中沉淀的核心要点汇编，让我们开始今天的知识之旅。` // i18n-allow-cjk
  ];

  const body = pages.map((p, i) => { // i18n-allow-cjk
    const title = p.title || p.domain || '精选网页'; // i18n-allow-cjk
    const cleanSnippet = (p.snippet || '') // i18n-allow-cjk
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[#*`_~]/g, '')
      .trim()
      .slice(0, 180);
    return `第 ${i + 1} 条关注。关于《${title}》，您先前记录的要点提到：${cleanSnippet}。这为我们提供了极具启发性的思路。`; // i18n-allow-cjk
  });

  const outro = [ // i18n-allow-cjk
    `以上就是今天的 OmniSense 专属晨报全部内容。`, // i18n-allow-cjk
    `温故而知新，愿您今天思维敏锐，收获满满，开启充实美好的一天！` // i18n-allow-cjk
  ];

  return [...intros, ...body, ...outro].join('\n\n'); // i18n-allow-cjk
}
