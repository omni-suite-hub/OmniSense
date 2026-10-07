// Shared lightweight, streaming-friendly, XSS-safe Markdown renderer for OmniSense

/**
 * Escape raw HTML entities to guarantee XSS safety before applying markdown rules.
 */
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

/**
 * Format inline markdown tokens (bold, italic, strike, links, inline code, tags).
 */
function formatInline(text) {
  let s = text;

  // Bold & Italic: ***text***
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong class="md-strong"><em class="md-em">$1</em></strong>');
  // Bold: **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong class="md-strong">$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong class="md-strong">$1</strong>');
  // Italic: *text* or _text_
  s = s.replace(/\*([^\s*][^*]*?)\*/g, '<em class="md-em">$1</em>');
  s = s.replace(/_([^\s_][^_]*?)_/g, '<em class="md-em">$1</em>');
  // Strikethrough: ~~text~~
  s = s.replace(/~~(.+?)~~/g, '<del class="md-del">$1</del>');

  // Key-value bracket tags, e.g. [60%], [轻度倾向], [客观中立], [严重失衡]
  s = s.replace(/\[(\d+%|轻度倾向|客观中立|情绪煽动|严重失衡|客观严谨|平衡中立|主观浓烈)\]/g, '<span class="md-tag">$1</span>'); // i18n-allow-cjk

  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  return s;
}

/**
 * Parse and render Markdown string to safe HTML.
 * Handles streaming gracefully (partial chunks will not crash).
 */
export function renderMarkdown(markdownText) {
  if (!markdownText || typeof markdownText !== 'string') return '';

  // 1. First escape all raw HTML to prevent injection
  const escaped = escapeHtml(markdownText.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));

  // 2. Extract and protect code blocks
  const codeBlocks = [];
  let text = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)(?:```|$)/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    const cleanLang = lang.trim() || 'text';
    codeBlocks.push(
      `<div class="md-code-wrap">` +
        `<div class="md-code-header"><span>${cleanLang}</span></div>` +
        `<pre><code class="language-${cleanLang}">${code.trimEnd()}</code></pre>` +
      `</div>`
    );
    return `\x00BLOCKTOKEN${idx}ENDTOKEN\x00`;
  });

  // 3. Extract and protect inline code
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="md-inline-code">${code}</code>`);
    return `\x00INLINETOKEN${idx}ENDTOKEN\x00`;
  });

  // 4. Split into lines and group into semantic blocks
  const lines = text.split('\n');
  const blocks = [];
  let currentList = null; // { type: 'ul' | 'ol', items: [] }
  let currentQuote = null; // string[]
  let currentPara = [];
  let currentTable = null; // string[]

  function flushList() {
    if (!currentList) return;
    const tag = currentList.type === 'ul' ? 'ul' : 'ol';
    const cls = currentList.type === 'ul' ? 'md-ul' : 'md-ol';
    const itemsHtml = currentList.items.map(it => `<li class="md-li">${formatInline(it)}</li>`).join('');
    blocks.push(`<${tag} class="${cls}">${itemsHtml}</${tag}>`);
    currentList = null;
  }

  function flushQuote() {
    if (!currentQuote) return;
    const content = currentQuote.map(l => formatInline(l)).join('<br>');
    blocks.push(`<blockquote class="md-quote">${content}</blockquote>`);
    currentQuote = null;
  }

  function flushPara() {
    if (!currentPara.length) return;
    const content = currentPara.map(l => formatInline(l)).join('<br>');
    blocks.push(`<p class="md-p">${content}</p>`);
    currentPara = [];
  }

  function flushTable() {
    if (!currentTable || currentTable.length < 2) {
      if (currentTable) {
        currentTable.forEach(row => currentPara.push(row));
        flushPara();
      }
      currentTable = null;
      return;
    }
    const headerRow = currentTable[0].split('|').map(c => c.trim()).filter((c, i, a) => !(i === 0 && !c) && !(i === a.length - 1 && !c));
    const dataRows = currentTable.slice(2).map(r =>
      r.split('|').map(c => c.trim()).filter((c, i, a) => !(i === 0 && !c) && !(i === a.length - 1 && !c))
    );

    const thead = `<tr>${headerRow.map(h => `<th>${formatInline(h)}</th>`).join('')}</tr>`;
    const tbody = dataRows.map(row => `<tr>${row.map(cell => `<td>${formatInline(cell)}</td>`).join('')}</tr>`).join('');
    blocks.push(`<div class="md-table-wrap"><table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`);
    currentTable = null;
  }

  function flushAll() {
    flushList();
    flushQuote();
    flushTable();
    flushPara();
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Check code block placeholder
    if (line.startsWith('\x00BLOCKTOKEN') && line.endsWith('ENDTOKEN\x00')) {
      flushAll();
      blocks.push(line);
      continue;
    }

    // Blank line
    if (!line) {
      flushAll();
      continue;
    }

    // Table rows (contains pipes)
    if (line.startsWith('|') && line.endsWith('|')) {
      flushList();
      flushQuote();
      flushPara();
      if (!currentTable) currentTable = [];
      currentTable.push(line);
      continue;
    } else if (currentTable) {
      flushTable();
    }

    // Horizontal Rule: --- or ***
    if (/^(?:---|\*\*\*|___)$/.test(line)) {
      flushAll();
      blocks.push('<hr class="md-hr">');
      continue;
    }

    // Bracket Section Headings like 【天平倾向指标】 or 【被回避的隐性成本与事实】
    const bracketMatch = line.match(/^(?:###\s*)?【(.+?)】$/);
    if (bracketMatch) {
      flushAll();
      blocks.push(`<div class="md-section-badge"><span class="md-badge-icon">📌</span> 【${bracketMatch[1]}】</div>`);
      continue;
    }

    // Headings #, ##, ###, ####
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushAll();
      const level = hMatch[1].length;
      blocks.push(`<h${level} class="md-h${level}">${formatInline(hMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote: > text
    if (line.startsWith('&gt; ') || line.startsWith('> ')) {
      flushList();
      flushPara();
      if (!currentQuote) currentQuote = [];
      const quoteText = line.replace(/^(?:&gt;|>)\s?/, '');
      currentQuote.push(quoteText);
      continue;
    } else if (currentQuote) {
      flushQuote();
    }

    // Unordered list: - item, * item, • item
    const ulMatch = line.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      flushQuote();
      flushPara();
      if (!currentList || currentList.type !== 'ul') {
        flushList();
        currentList = { type: 'ul', items: [] };
      }
      currentList.items.push(ulMatch[1]);
      continue;
    }

    // Ordered list: 1. item, 2. item
    const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      flushQuote();
      flushPara();
      if (!currentList || currentList.type !== 'ol') {
        flushList();
        currentList = { type: 'ol', items: [] };
      }
      currentList.items.push(olMatch[2]);
      continue;
    }

    // Regular paragraph line
    flushList();
    flushQuote();
    currentPara.push(rawLine);
  }

  flushAll();

  let resultHtml = blocks.join('');

  // 5. Restore code blocks & inline codes
  resultHtml = resultHtml.replace(/\x00BLOCKTOKEN(\d+)ENDTOKEN\x00/g, (m, idx) => codeBlocks[Number(idx)] || '');
  resultHtml = resultHtml.replace(/\x00INLINETOKEN(\d+)ENDTOKEN\x00/g, (m, idx) => inlineCodes[Number(idx)] || '');

  return resultHtml;
}
