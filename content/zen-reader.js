/**
 * OmniSense Zen Reader with Inline Smart Annotations (极简沉浸禅阅读与智能侧注)
 *
 * Provides a distraction-free, customizable magazine-style reading overlay
 * with AI margin takeaways, theme switches, and progress tracking.
 */
(() => {
  const HOST_ID = 'omnisense-zen-reader-host';
  let hostEl = null;
  let shadowRoot = null;
  let isOpen = false;
  let currentTheme = 'paper';
  let isSerif = false;
  let fontSizePx = 18;

  function estimateReadingTime(text) {
    const len = (text || '').trim().length;
    const wordsPerMin = 400; // Average reading speed
    const mins = Math.max(1, Math.ceil(len / wordsPerMin));
    return { mins, chars: len };
  }

  function extractCleanArticle() {
    const candidateSelectors = [
      'article', 'main', '.post-content', '.article-content',
      '.entry-content', '.markdown-body', '#article-root', '.content-body'
    ];
    let bestEl = null;
    let maxLen = 0;
    for (const sel of candidateSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const len = (el.innerText || '').length;
        if (len > maxLen) {
          maxLen = len;
          bestEl = el;
        }
      }
    }
    if (!bestEl || maxLen < 200) {
      bestEl = document.body;
    }

    const clone = bestEl.cloneNode(true);
    // Remove clutter
    clone.querySelectorAll('script, style, noscript, iframe, svg, nav, footer, header, .ad, .advertisement, [id*="ad-"], [class*="ad-"], .comment, .sidebar').forEach(el => el.remove());

    const title = document.title.replace(/[-_–|].*$/, '').trim() || '阅读正文'; // i18n-allow-cjk

    // Extract H2/H3 and major paragraphs for margin annotations
    const sections = [];
    const elements = clone.querySelectorAll('h1, h2, h3, p, blockquote, ul, ol');
    const contentHtml = clone.innerHTML;

    return { title, contentHtml, rawText: clone.innerText || '' };
  }

  function generateMarginNotes(rawText) {
    // Generate intelligent margin notes from paragraphs
    const paras = (rawText || '').split(/\n+/).map(p => p.trim()).filter(p => p.length > 50);
    const notes = [];
    const sampleCount = Math.min(6, paras.length);
    for (let i = 0; i < sampleCount; i++) {
      const p = paras[Math.floor(i * (paras.length / sampleCount))];
      // Pick first sentence as summary
      const firstSentence = p.split(/[。！？!?]/)[0];
      if (firstSentence && firstSentence.length >= 8) {
        const noteText = firstSentence.length > 28 ? firstSentence.slice(0, 26) + '…' : firstSentence;
        notes.push({
          idx: i,
          title: `重点 ${i + 1}`, // i18n-allow-cjk
          summary: noteText
        });
      }
    }
    return notes;
  }

  function ensureZenHost() {
    if (hostEl && document.getElementById(HOST_ID)) return;
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483646; display: none;';
    shadowRoot = hostEl.attachShadow({ mode: 'open' });
    (document.body || document.documentElement).appendChild(hostEl);
  }

  function renderZenReader() {
    ensureZenHost();
    const { title, contentHtml, rawText } = extractCleanArticle();
    const stats = estimateReadingTime(rawText);
    const marginNotes = generateMarginNotes(rawText);

    const themeColors = {
      paper: { bg: '#fbf7ee', cardBg: '#f4ede0', text: '#2d2b28', textMuted: '#78716c', border: '#e8ddcc', accent: '#059669' },
      dark:  { bg: '#121316', cardBg: '#1c1d22', text: '#e2e4e9', textMuted: '#94a3b8', border: '#2d3139', accent: '#10b981' },
      sepia: { bg: '#f2f5ee', cardBg: '#e6ede0', text: '#26362e', textMuted: '#5b6b61', border: '#dbe5d4', accent: '#047857' },
      white: { bg: '#ffffff', cardBg: '#f8fafc', text: '#1e293b', textMuted: '#64748b', border: '#e2e8f0', accent: '#0284c7' }
    };
    const c = themeColors[currentTheme] || themeColors.paper;

    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        .zen-backdrop {
          position: fixed;
          inset: 0;
          background: ${c.bg};
          color: ${c.text};
          font-family: ${isSerif ? '"Songti SC", "SimSun", "Noto Serif CJK SC", "Georgia", serif' : '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif'};
          overflow-y: auto;
          overflow-x: hidden;
          transition: background 0.25s ease, color 0.25s ease;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .zen-progressbar {
          position: fixed;
          top: 0;
          left: 0;
          height: 3px;
          background: ${c.accent};
          width: 0%;
          z-index: 100;
          transition: width 0.1s linear;
        }
        .zen-header {
          position: sticky;
          top: 0;
          width: 100%;
          max-width: 1100px;
          padding: 14px 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: ${c.bg};
          border-bottom: 1px solid ${c.border};
          z-index: 90;
          backdrop-filter: blur(8px);
        }
        .zen-brand {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          font-weight: 600;
          color: ${c.textMuted};
        }
        .zen-badge {
          background: ${c.cardBg};
          padding: 3px 8px;
          border-radius: 6px;
          border: 1px solid ${c.border};
          color: ${c.accent};
          font-size: 11.5px;
        }
        .zen-toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .zen-btn {
          background: ${c.cardBg};
          border: 1px solid ${c.border};
          color: ${c.text};
          border-radius: 6px;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .zen-btn:hover {
          border-color: ${c.accent};
          color: ${c.accent};
          transform: translateY(-1px);
        }
        .zen-btn-close {
          background: #ef4444;
          border-color: #ef4444;
          color: #ffffff;
        }
        .zen-btn-close:hover {
          background: #dc2626;
          border-color: #dc2626;
          color: #ffffff;
        }
        .zen-container {
          width: 100%;
          max-width: 1100px;
          display: flex;
          gap: 40px;
          padding: 40px 24px 80px;
          position: relative;
        }
        .zen-article-wrap {
          flex: 1;
          min-width: 0;
          max-width: 720px;
          margin: 0 auto;
        }
        .zen-title {
          font-size: 32px;
          line-height: 1.35;
          font-weight: 800;
          margin-bottom: 16px;
          color: ${c.text};
        }
        .zen-meta {
          font-size: 13px;
          color: ${c.textMuted};
          margin-bottom: 32px;
          padding-bottom: 16px;
          border-bottom: 1px solid ${c.border};
          display: flex;
          align-items: center;
          gap: 16px;
        }
        .zen-content {
          font-size: ${fontSizePx}px;
          line-height: 1.88;
          color: ${c.text};
          letter-spacing: 0.02em;
        }
        .zen-content p {
          margin-bottom: 1.6em;
        }
        .zen-content h1, .zen-content h2, .zen-content h3 {
          margin: 2em 0 0.8em;
          color: ${c.text};
          line-height: 1.4;
        }
        .zen-content img {
          max-width: 100%;
          border-radius: 8px;
          margin: 1.5em 0;
          border: 1px solid ${c.border};
        }
        .zen-content blockquote {
          border-left: 3px solid ${c.accent};
          padding-left: 16px;
          margin: 1.5em 0;
          color: ${c.textMuted};
          font-style: italic;
        }
        .zen-sidebar {
          width: 240px;
          flex-shrink: 0;
          position: sticky;
          top: 80px;
          align-self: flex-start;
        }
        .zen-margin-box {
          background: ${c.cardBg};
          border: 1px solid ${c.border};
          border-radius: 10px;
          padding: 16px;
        }
        .zen-margin-title {
          font-size: 12px;
          font-weight: 700;
          color: ${c.accent};
          text-transform: uppercase;
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .zen-note-item {
          padding: 8px 10px;
          margin-bottom: 8px;
          background: ${c.bg};
          border: 1px solid ${c.border};
          border-radius: 6px;
          font-size: 11.5px;
          line-height: 1.5;
          color: ${c.text};
          cursor: pointer;
          transition: border-color 0.15s ease;
        }
        .zen-note-item:hover {
          border-color: ${c.accent};
        }
        .zen-note-tag {
          font-weight: 600;
          color: ${c.accent};
          margin-bottom: 2px;
        }
        @media (max-width: 960px) {
          .zen-sidebar {
            display: none;
          }
        }
      </style>

      <div class="zen-backdrop" id="zenBackdrop">
        <div class="zen-progressbar" id="zenProgress"></div>
        <header class="zen-header">
          <div class="zen-brand">
            <span>📖 极简禅阅读</span> <!-- i18n-allow-cjk -->
            <span class="zen-badge">预计 ${stats.mins} 分钟 · ${stats.chars} 字</span> <!-- i18n-allow-cjk -->
          </div>
          <div class="zen-toolbar">
            <button class="zen-btn" id="zenBtnTheme" title="切换底色">🎨 主题: ${currentTheme}</button> <!-- i18n-allow-cjk -->
            <button class="zen-btn" id="zenBtnFont" title="切换衬线/非衬线字体">${isSerif ? '宋体' : '黑体'}</button> <!-- i18n-allow-cjk -->
            <button class="zen-btn" id="zenBtnSizeDec" title="缩小字号">A-</button> <!-- i18n-allow-cjk -->
            <button class="zen-btn" id="zenBtnSizeInc" title="放大字号">A+</button> <!-- i18n-allow-cjk -->
            <button class="zen-btn zen-btn-close" id="zenBtnClose" title="退出禅模式 (ESC)">✕ 退出</button> <!-- i18n-allow-cjk -->
          </div>
        </header>

        <div class="zen-container">
          <main class="zen-article-wrap">
            <h1 class="zen-title">${title}</h1>
            <div class="zen-meta">
              <span>OmniSense 本地端侧排版渲染</span> <!-- i18n-allow-cjk -->
              <span>按 ESC 键即可随时退出</span> <!-- i18n-allow-cjk -->
            </div>
            <article class="zen-content" id="zenContent">
              ${contentHtml}
            </article>
          </main>

          <aside class="zen-sidebar">
            <div class="zen-margin-box">
              <div class="zen-margin-title">💡 AI 智能段落边注</div> <!-- i18n-allow-cjk -->
              ${marginNotes.map(n => `
                <div class="zen-note-item">
                  <div class="zen-note-tag">${n.title}</div>
                  <div>${n.summary}</div>
                </div>
              `).join('')}
            </div>
          </aside>
        </div>
      </div>
    `;

    // Event listeners
    const backdrop = shadowRoot.getElementById('zenBackdrop');
    const progressBar = shadowRoot.getElementById('zenProgress');
    const btnTheme = shadowRoot.getElementById('zenBtnTheme');
    const btnFont = shadowRoot.getElementById('zenBtnFont');
    const btnSizeDec = shadowRoot.getElementById('zenBtnSizeDec');
    const btnSizeInc = shadowRoot.getElementById('zenBtnSizeInc');
    const btnClose = shadowRoot.getElementById('zenBtnClose');

    // Scroll progress
    backdrop.addEventListener('scroll', () => {
      const st = backdrop.scrollTop;
      const sh = backdrop.scrollHeight - backdrop.clientHeight;
      if (sh > 0) {
        const pct = Math.min(100, Math.round((st / sh) * 100));
        progressBar.style.width = `${pct}%`;
      }
    });

    btnTheme.addEventListener('click', () => {
      const themes = ['paper', 'dark', 'sepia', 'white'];
      const nextIdx = (themes.indexOf(currentTheme) + 1) % themes.length;
      currentTheme = themes[nextIdx];
      renderZenReader();
    });

    btnFont.addEventListener('click', () => {
      isSerif = !isSerif;
      renderZenReader();
    });

    btnSizeDec.addEventListener('click', () => {
      if (fontSizePx > 14) {
        fontSizePx -= 2;
        renderZenReader();
      }
    });

    btnSizeInc.addEventListener('click', () => {
      if (fontSizePx < 28) {
        fontSizePx += 2;
        renderZenReader();
      }
    });

    btnClose.addEventListener('click', closeZenReader);
  }

  function openZenReader() {
    renderZenReader();
    ensureZenHost();
    hostEl.style.display = 'block';
    isOpen = true;
    document.addEventListener('keydown', handleKeyDown);
  }

  function closeZenReader() {
    if (hostEl) hostEl.style.display = 'none';
    isOpen = false;
    document.removeEventListener('keydown', handleKeyDown);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape' && isOpen) {
      closeZenReader();
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'OMNI_OPEN_ZEN_READER') {
        if (isOpen) {
          closeZenReader();
        } else {
          openZenReader();
        }
        sendResponse({ ok: true });
      }
    });
  } catch (e) {}
})();
