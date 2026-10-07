/**
 * OmniSense Selection Magic Pill (智能划词魔法气泡)
 *
 * Lightweight, glassmorphic floating pill appearing on user text selection.
 * Offers instant Explain, Debate/Advocate, Rewrite, Roast, and Capsule Save.
 */
(() => {
  const HOST_ID = 'omnisense-selection-pill-host';
  let hostEl = null;
  let shadowRoot = null;
  let currentSelectionText = '';
  let currentPopoverEl = null;

  function ensureHost() {
    if (hostEl && document.getElementById(HOST_ID)) return;
    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; z-index: 2147483645; pointer-events: none;';
    shadowRoot = hostEl.attachShadow({ mode: 'open' });
    (document.body || document.documentElement).appendChild(hostEl);
  }

  function hidePill() {
    if (!shadowRoot) return;
    const pill = shadowRoot.getElementById('omniMagicPill');
    if (pill) pill.style.display = 'none';
    const popover = shadowRoot.getElementById('omniMagicPopover');
    if (popover) popover.style.display = 'none';
  }

  function renderPill(x, y, selText) {
    ensureHost();
    currentSelectionText = selText;

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
        .omni-pill-container {
          position: fixed;
          top: ${y}px;
          left: ${x}px;
          transform: translate(-50%, -100%);
          pointer-events: auto;
          display: flex;
          flex-direction: column;
          align-items: center;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
          z-index: 2147483645;
          animation: omniPillFadeIn 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes omniPillFadeIn {
          from { opacity: 0; transform: translate(-50%, -85%) scale(0.94); }
          to { opacity: 1; transform: translate(-50%, -100%) scale(1); }
        }
        .omni-pill {
          background: rgba(15, 23, 42, 0.88);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.15);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32), 0 2px 8px rgba(16, 185, 129, 0.2);
          border-radius: 24px;
          padding: 4px 6px;
          display: flex;
          align-items: center;
          gap: 2px;
        }
        .omni-pill-btn {
          background: transparent;
          border: none;
          color: #e2e8f0;
          font-size: 11.5px;
          font-weight: 500;
          padding: 4px 8px;
          border-radius: 16px;
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease, transform 0.12s ease;
          display: flex;
          align-items: center;
          gap: 4px;
          white-space: nowrap;
        }
        .omni-pill-btn:hover {
          background: rgba(255, 255, 255, 0.14);
          color: #ffffff;
          transform: translateY(-1px);
        }
        .omni-pill-btn-save {
          color: #34d399;
        }
        .omni-pill-btn-save:hover {
          background: rgba(16, 185, 129, 0.2);
          color: #6ee7b7;
        }
        .omni-popover {
          margin-top: 8px;
          width: 320px;
          max-width: 90vw;
          background: rgba(15, 23, 42, 0.95);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 12px;
          box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45);
          padding: 12px 14px;
          display: none;
          flex-direction: column;
          gap: 8px;
          color: #f1f5f9;
        }
        .omni-popover-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 11px;
          font-weight: 600;
          color: #10b981;
          text-transform: uppercase;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          padding-bottom: 6px;
        }
        .omni-popover-body {
          font-size: 12.5px;
          line-height: 1.6;
          max-height: 220px;
          overflow-y: auto;
          color: #e2e8f0;
          word-break: break-word;
        }
        .omni-popover-body p {
          margin: 0 0 6px;
        }
        .omni-popover-body p:last-child {
          margin-bottom: 0;
        }
        .omni-popover-body strong {
          color: #ffffff;
          font-weight: 700;
        }
        .omni-popover-body em {
          color: #cbd5e1;
          font-style: italic;
        }
        .omni-popover-body ul, .omni-popover-body ol {
          margin: 4px 0 6px 16px;
          padding: 0;
        }
        .omni-popover-body li {
          margin-bottom: 3px;
        }
        .omni-popover-body code {
          background: rgba(255, 255, 255, 0.1);
          padding: 1px 4px;
          border-radius: 3px;
          font-family: monospace;
          font-size: 11.5px;
          color: #38bdf8;
        }
        .omni-popover-body pre {
          background: #0d1117;
          padding: 6px 8px;
          border-radius: 6px;
          overflow-x: auto;
          margin: 4px 0;
        }
        .omni-popover-body .md-section-badge {
          display: inline-block;
          font-size: 11px;
          font-weight: 700;
          color: #10b981;
          background: rgba(16, 185, 129, 0.12);
          border: 1px solid rgba(16, 185, 129, 0.28);
          border-radius: 4px;
          padding: 1px 5px;
          margin: 4px 0 2px 0;
        }
        .omni-popover-body .md-tag {
          font-size: 10.5px;
          color: #38bdf8;
          background: rgba(56, 189, 248, 0.12);
          border-radius: 4px;
          padding: 1px 4px;
        }
        .omni-popover-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 6px;
          padding-top: 6px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        .omni-mini-btn {
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.15);
          color: #ffffff;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          cursor: pointer;
        }
        .omni-mini-btn:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        .omni-spinner {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid rgba(255, 255, 255, 0.2);
          border-top-color: #10b981;
          border-radius: 50%;
          animation: omniSpin 0.7s linear infinite;
        }
        @keyframes omniSpin {
          to { transform: rotate(360deg); }
        }
      </style>

      <div class="omni-pill-container" id="omniMagicPill">
        <div class="omni-pill">
          <button class="omni-pill-btn" data-mode="explain">🔍 释义</button> <!-- i18n-allow-cjk -->
          <button class="omni-pill-btn" data-mode="debate">⚖️ 反驳</button> <!-- i18n-allow-cjk -->
          <button class="omni-pill-btn" data-mode="rewrite">✍️ 润色</button> <!-- i18n-allow-cjk -->
          <button class="omni-pill-btn" data-mode="roast">😈 吐槽</button> <!-- i18n-allow-cjk -->
          <button class="omni-pill-btn omni-pill-btn-save" id="omniBtnSaveCapsule">📥 存胶囊</button> <!-- i18n-allow-cjk -->
        </div>

        <div class="omni-popover" id="omniMagicPopover">
          <div class="omni-popover-header">
            <span id="omniPopoverTitle">AI 分析</span> <!-- i18n-allow-cjk -->
            <button class="omni-mini-btn" id="omniPopoverClose">✕</button>
          </div>
          <div class="omni-popover-body" id="omniPopoverBody">
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="omni-spinner"></span>
              <span>思考中…</span> <!-- i18n-allow-cjk -->
            </div>
          </div>
          <div class="omni-popover-actions">
            <button class="omni-mini-btn" id="omniBtnCopyResult">复制</button> <!-- i18n-allow-cjk -->
          </div>
        </div>
      </div>
    `;

    const popover = shadowRoot.getElementById('omniMagicPopover');
    const popoverTitle = shadowRoot.getElementById('omniPopoverTitle');
    const popoverBody = shadowRoot.getElementById('omniPopoverBody');
    const popoverClose = shadowRoot.getElementById('omniPopoverClose');
    const btnCopyResult = shadowRoot.getElementById('omniBtnCopyResult');
    const btnSaveCapsule = shadowRoot.getElementById('omniBtnSaveCapsule');

    let currentRawResult = '';

    function formatPillMarkdown(raw) {
      if (!raw) return '';
      let text = String(raw)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Code blocks ```
      text = text.replace(/```([\s\S]*?)```/g, (m, code) => `<pre><code>${code.trim()}</code></pre>`);
      // Section badges 【...】
      text = text.replace(/【(.*?)】/g, '<div class="md-section-badge">【$1】</div>');
      // Inline code `...`
      text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      // Bold **...**
      text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      // Italic *...*
      text = text.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
      // Tags [xx%]
      text = text.replace(/\[(\d+%)\]/g, '<span class="md-tag">[$1]</span>');

      // Lines & lists
      const lines = text.split('\n');
      const out = [];
      let inList = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^[*-]\s+(.+)$/.test(trimmed)) {
          if (!inList) {
            out.push('<ul>');
            inList = true;
          }
          out.push(`<li>${trimmed.replace(/^[*-]\s+/, '')}</li>`);
        } else {
          if (inList) {
            out.push('</ul>');
            inList = false;
          }
          if (trimmed) {
            out.push(`<p>${trimmed}</p>`);
          }
        }
      }
      if (inList) out.push('</ul>');
      return out.join('');
    }

    popoverClose.addEventListener('click', () => {
      popover.style.display = 'none';
    });

    btnCopyResult.addEventListener('click', () => {
      const text = currentRawResult || popoverBody.innerText || '';
      navigator.clipboard.writeText(text);
      btnCopyResult.textContent = '已复制'; // i18n-allow-cjk
      setTimeout(() => { btnCopyResult.textContent = '复制'; }, 1500); // i18n-allow-cjk
    });

    btnSaveCapsule.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({
          type: 'CAPTURE_SELECTION',
          text: currentSelectionText,
          url: window.location.href,
          title: document.title
        }, (resp) => {
          void chrome.runtime.lastError;
          btnSaveCapsule.textContent = '✔ 已存入'; // i18n-allow-cjk
          setTimeout(() => { hidePill(); }, 1200);
        });
      } catch (err) {
        hidePill();
      }
    });

    shadowRoot.querySelectorAll('.omni-pill-btn[data-mode]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = btn.dataset.mode;
        const labels = {
          explain: '🔍 智能释义', // i18n-allow-cjk
          debate: '⚖️ 观点反驳', // i18n-allow-cjk
          rewrite: '✍️ 润色重写', // i18n-allow-cjk
          roast: '😈 毒舌吐槽' // i18n-allow-cjk
        };
        popoverTitle.textContent = labels[mode] || 'AI 分析'; // i18n-allow-cjk
        currentRawResult = '';
        popoverBody.innerHTML = `
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="omni-spinner"></span>
            <span>思考中…</span> <!-- i18n-allow-cjk -->
          </div>
        `;
        popover.style.display = 'flex';

        try {
          chrome.runtime.sendMessage({
            type: 'RUN_SELECTION_ACTION',
            mode,
            text: currentSelectionText
          }, (resp) => {
            const err = chrome.runtime.lastError;
            if (err) {
              popoverBody.textContent = '通信出错，请重试'; // i18n-allow-cjk
              return;
            }
            if (resp && resp.ok && resp.text) {
              currentRawResult = resp.text;
              popoverBody.innerHTML = formatPillMarkdown(resp.text);
            } else {
              currentRawResult = '';
              popoverBody.textContent = resp?.error || '生成失败，请重试'; // i18n-allow-cjk
            }
          });
        } catch (err) {
          popoverBody.textContent = '通信出错，请重试'; // i18n-allow-cjk
        }
      });
    });
  }

  // Handle text selection
  window.addEventListener('mouseup', (e) => {
    // If click was inside our shadow DOM, don't recompute
    if (hostEl && e.composedPath().includes(hostEl)) return;

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';

      if (text.length >= 2 && text.length <= 800) {
        try {
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const x = Math.max(160, Math.min(window.innerWidth - 160, rect.left + rect.width / 2));
            const y = Math.max(50, rect.top - 8);
            renderPill(x, y, text);
            return;
          }
        } catch (err) {}
      }

      hidePill();
    }, 20);
  });

  window.addEventListener('mousedown', (e) => {
    if (hostEl && e.composedPath().includes(hostEl)) return;
    hidePill();
  });
})();
