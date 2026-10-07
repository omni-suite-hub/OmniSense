/**
 * OmniSense Read-Along (Karaoke sync) Content Script — v3.5 Deluxe Precision Edition
 *
 * Highlights the sentence currently being read by SpeechSynthesis on the active page.
 * Uses a multi-tiered highlight system:
 * 1. Native CSS Custom Highlight API (zero DOM mutation)
 * 2. Floating absolute overlay boxes with breath glow animation
 * 3. Container level focus border without layout shifts
 * 4. Floating dynamic audio-wave equalizer pill indicator
 * 5. Sentence-level exact pixel scroll targeting (prevents off-screen scrolling)
 * 6. Sequential forward-tracking reader progress
 */
(() => {
  const STYLE_ID = 'omnisense-read-along-style';
  const OVERLAY_CONTAINER_ID = 'omnisense-tts-overlay-root';
  const PILL_ID = 'omnisense-read-along-pill';
  const CONTAINER_CLASS = 'omnisense-tts-container-highlight';
  const SUPPORTS_CUSTOM_HIGHLIGHT = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && !!CSS.highlights;

  let activeRange = null;
  let activeContainer = null;
  let isPaused = false;
  let lastMatchedBlock = null;
  let lastChunkIndex = -1;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      ::highlight(omnisense-tts) {
        background-color: rgba(16, 185, 129, 0.22) !important;
        color: inherit !important;
      }
      ::highlight(omnisense-tts-paused) {
        background-color: rgba(245, 158, 11, 0.22) !important;
        color: inherit !important;
      }
      #${OVERLAY_CONTAINER_ID} {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 2147483645;
        overflow: visible;
      }
      .omnisense-tts-overlay-box {
        position: absolute;
        background: linear-gradient(180deg, rgba(52, 211, 153, 0.12) 0%, rgba(16, 185, 129, 0.26) 100%) !important;
        border-bottom: 2.5px solid #10b981 !important;
        border-radius: 4px !important;
        box-shadow: 0 2px 10px rgba(16, 185, 129, 0.28), 0 0 0 1px rgba(16, 185, 129, 0.2) inset !important;
        pointer-events: none !important;
        transition: background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease, opacity 0.25s ease !important;
        animation: omniKaraokeBreath 2.2s ease-in-out infinite alternate !important;
      }
      @keyframes omniKaraokeBreath {
        0% {
          box-shadow: 0 2px 8px rgba(16, 185, 129, 0.20), 0 0 0 1px rgba(16, 185, 129, 0.18) inset;
          background: linear-gradient(180deg, rgba(52, 211, 153, 0.10) 0%, rgba(16, 185, 129, 0.22) 100%);
        }
        100% {
          box-shadow: 0 3px 16px rgba(16, 185, 129, 0.42), 0 0 0 1.5px rgba(52, 211, 153, 0.45) inset;
          background: linear-gradient(180deg, rgba(52, 211, 153, 0.16) 0%, rgba(16, 185, 129, 0.32) 100%);
        }
      }
      .omnisense-tts-overlay-box.omni-paused {
        animation: none !important;
        background: linear-gradient(180deg, rgba(251, 191, 36, 0.12) 0%, rgba(245, 158, 11, 0.25) 100%) !important;
        border-bottom-color: #f59e0b !important;
        box-shadow: 0 2px 8px rgba(245, 158, 11, 0.25), 0 0 0 1px rgba(245, 158, 11, 0.2) inset !important;
      }
      .${CONTAINER_CLASS} {
        box-shadow: -3.5px 0 0 0 #10b981 !important;
        transition: box-shadow 0.25s ease !important;
      }
      .${CONTAINER_CLASS}.omni-paused {
        box-shadow: -3.5px 0 0 0 #f59e0b !important;
      }
      #${PILL_ID} {
        position: absolute;
        z-index: 2147483646;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px 3px 8px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
        font-size: 11px;
        font-weight: 600;
        color: #ffffff;
        background: linear-gradient(135deg, rgba(16, 185, 129, 0.95) 0%, rgba(5, 150, 105, 0.98) 100%);
        backdrop-filter: blur(12px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.25);
        box-shadow: 0 6px 18px rgba(16, 185, 129, 0.38), 0 1px 3px rgba(0, 0, 0, 0.12);
        border-radius: 999px;
        pointer-events: none;
        transition: transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease, background 0.25s ease, box-shadow 0.25s ease;
        opacity: 0;
        transform: translateY(6px) scale(0.92);
        user-select: none;
      }
      #${PILL_ID}.show {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      #${PILL_ID}.omni-paused {
        background: linear-gradient(135deg, rgba(245, 158, 11, 0.95) 0%, rgba(217, 119, 6, 0.98) 100%);
        box-shadow: 0 6px 18px rgba(245, 158, 11, 0.38), 0 1px 3px rgba(0, 0, 0, 0.12);
      }
      .omni-wave-bars {
        display: inline-flex;
        align-items: flex-end;
        gap: 2px;
        height: 11px;
      }
      .omni-wave-bar {
        width: 2.2px;
        background: #ffffff;
        border-radius: 1px;
        animation: omniWave 0.8s ease-in-out infinite alternate;
      }
      .omni-wave-bar:nth-child(1) { height: 5px; animation-delay: 0s; }
      .omni-wave-bar:nth-child(2) { height: 11px; animation-delay: 0.22s; }
      .omni-wave-bar:nth-child(3) { height: 7px; animation-delay: 0.44s; }
      @keyframes omniWave {
        0% { transform: scaleY(0.4); opacity: 0.75; }
        100% { transform: scaleY(1.2); opacity: 1; }
      }
      #${PILL_ID}.omni-paused .omni-wave-bar {
        animation-play-state: paused;
        transform: scaleY(0.5);
        opacity: 0.6;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getOrCreateOverlayRoot() {
    let root = document.getElementById(OVERLAY_CONTAINER_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = OVERLAY_CONTAINER_ID;
      document.body.appendChild(root);
    }
    return root;
  }

  function renderOverlayRects(range, paused = false) {
    const root = getOrCreateOverlayRoot();
    root.innerHTML = '';
    if (!range) return;

    const pageX = window.scrollX || document.documentElement.scrollLeft;
    const pageY = window.scrollY || document.documentElement.scrollTop;
    const clientRects = Array.from(range.getClientRects());

    clientRects.forEach(cr => {
      if (cr.width < 1 || cr.height < 1) return;
      const box = document.createElement('div');
      box.className = 'omnisense-tts-overlay-box' + (paused ? ' omni-paused' : '');
      box.style.left = `${pageX + cr.left - 2}px`;
      box.style.top = `${pageY + cr.top - 1}px`;
      box.style.width = `${cr.width + 4}px`;
      box.style.height = `${cr.height + 2}px`;
      root.appendChild(box);
    });
  }

  function getOrCreatePill() {
    let pill = document.getElementById(PILL_ID);
    if (!pill) {
      pill = document.createElement('div');
      pill.id = PILL_ID;
      pill.innerHTML = '<span class="omni-wave-bars"><span class="omni-wave-bar"></span><span class="omni-wave-bar"></span><span class="omni-wave-bar"></span></span><span class="pill-text">正在朗读</span>'; // i18n-allow-cjk
      document.body.appendChild(pill);
    }
    return pill;
  }

  function updatePillPosition(rect, paused = false) {
    if (!rect) return;
    const pill = getOrCreatePill();
    pill.classList.toggle('omni-paused', paused);
    const textSpan = pill.querySelector('.pill-text');
    if (textSpan) textSpan.textContent = paused ? '已暂停' : '正在朗读'; // i18n-allow-cjk

    const pageX = window.scrollX || document.documentElement.scrollLeft;
    const pageY = window.scrollY || document.documentElement.scrollTop;

    const top = Math.max(8, pageY + rect.top - 26);
    const maxLeft = (window.innerWidth || document.documentElement.clientWidth || 800) - 120;
    const left = Math.max(8, Math.min(pageX + rect.left, pageX + maxLeft));

    pill.style.top = `${top}px`;
    pill.style.left = `${left}px`;
    pill.classList.add('show');
  }

  function hidePill() {
    const pill = document.getElementById(PILL_ID);
    if (pill) pill.classList.remove('show');
    const root = document.getElementById(OVERLAY_CONTAINER_ID);
    if (root) root.innerHTML = '';
  }

  function clearHighlight() {
    activeRange = null;
    if (SUPPORTS_CUSTOM_HIGHLIGHT) {
      try {
        CSS.highlights.delete('omnisense-tts');
        CSS.highlights.delete('omnisense-tts-paused');
      } catch (e) {}
    }

    if (activeContainer) {
      activeContainer.classList.remove(CONTAINER_CLASS, 'omni-paused');
      activeContainer = null;
    }

    const oldContainers = document.querySelectorAll(`.${CONTAINER_CLASS}`);
    oldContainers.forEach(el => el.classList.remove(CONTAINER_CLASS, 'omni-paused'));

    hidePill();
  }

  function cleanString(str) {
    return String(str || '')
      .replace(/[\r\n\t\f\v\u00a0\u2000-\u200b]+/g, ' ')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .trim();
  }

  /**
   * 1-to-1 character normalization for canonical search.
   * Crucially preserves string length so that character indices in canonical
   * strings map directly to character indices in the DOM mapping array.
   */
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

  /**
   * Walks through all visible text nodes in a block, collapsing redundant whitespace
   * while recording the exact { node, offset } in the DOM for EVERY single character.
   */
  function extractBlockTextAndMap(block) {
    const walker = document.createTreeWalker(
      block,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'textarea') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node = walker.nextNode();
    let text = '';
    const mapping = [];
    let lastWasSpace = false;

    while (node) {
      const val = node.nodeValue;
      if (val) {
        for (let i = 0; i < val.length; i++) {
          const ch = val[i];
          const isWs = /[\s\u00a0\u2000-\u200b]/.test(ch);
          if (isWs) {
            if (!lastWasSpace && text.length > 0) {
              text += ' ';
              mapping.push({ node, offset: i });
              lastWasSpace = true;
            }
          } else {
            text += ch;
            mapping.push({ node, offset: i });
            lastWasSpace = false;
          }
        }
      }
      node = walker.nextNode();
    }
    return { text, mapping };
  }

  /**
   * Constructs a DOM Range spanning from mapping[startIdx] to mapping[endIdx - 1].
   */
  function createRangeFromMapping(mapping, startIdx, endIdx) {
    if (!mapping || !mapping.length || startIdx < 0 || endIdx <= startIdx) return null;
    const safeStart = Math.max(0, Math.min(startIdx, mapping.length - 1));
    const safeEnd = Math.max(safeStart + 1, Math.min(endIdx, mapping.length));
    const startInfo = mapping[safeStart];
    const endInfo = mapping[safeEnd - 1];
    if (!startInfo || !endInfo || !startInfo.node || !endInfo.node) return null;

    try {
      const range = document.createRange();
      range.setStart(startInfo.node, startInfo.offset);
      range.setEnd(endInfo.node, endInfo.offset + 1);
      return range;
    } catch (e) {
      return null;
    }
  }

  /**
   * Expands an anchor match in blockText to cover the COMPLETE sentence,
   * avoiding truncated highlights (e.g. chopping off the trailing clause).
   */
  function expandToFullSentence(blockText, anchorStart, anchorEnd, targetLength, anchorOffsetInTarget = 0) {
    // 1. Trace back to beginning of sentence
    let sentStart = Math.max(0, anchorStart - anchorOffsetInTarget);
    while (sentStart < anchorStart && /[\s\u2022\-\*\d\.]/.test(blockText[sentStart])) {
      sentStart++;
    }

    // 2. Look forward from anchorEnd for sentence-ending punctuation
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

    // If no punctuation found or if punctuation belongs to another distant sentence:
    if (sentEnd === -1 || (targetLength > 0 && sentEnd - sentStart > targetLength + 25)) {
      if (targetLength > 0) {
        sentEnd = Math.min(blockText.length, sentStart + targetLength);
      } else {
        sentEnd = blockText.length;
      }
    }

    return { start: sentStart, end: sentEnd };
  }

  /**
   * Multi-pass precision matcher for a block element.
   * Matches full sentences or expands anchors to complete sentence boundaries.
   */
  function findBestRangeInBlock(block, cleanText) {
    const { text: blockText, mapping } = extractBlockTextAndMap(block);
    if (!blockText || !mapping.length) return null;

    const canonBlock = toCanonical(blockText);
    const canonTarget = toCanonical(cleanText);

    // Pass 1: Direct full sentence match
    const directIdx = canonBlock.indexOf(canonTarget);
    if (directIdx !== -1) {
      return createRangeFromMapping(mapping, directIdx, directIdx + canonTarget.length);
    }

    // Pass 2: Stripped full sentence match (removes leading bullet/number prefixes)
    const strippedTarget = cleanText.replace(/^[^\w\u4e00-\u9fa5]+/, '').trim();
    const canonStripped = toCanonical(strippedTarget);
    if (canonStripped.length >= 6) {
      const strippedIdx = canonBlock.indexOf(canonStripped);
      if (strippedIdx !== -1) {
        return createRangeFromMapping(mapping, strippedIdx, strippedIdx + canonStripped.length);
      }
    }

    // Pass 3: Long prefix anchor (first 26-36 chars) expanded to full sentence boundary
    if (canonStripped.length >= 14) {
      const prefixAnchor = canonStripped.slice(0, Math.min(28, canonStripped.length));
      const prefixIdx = canonBlock.indexOf(prefixAnchor);
      if (prefixIdx !== -1) {
        const { start, end } = expandToFullSentence(
          blockText,
          prefixIdx,
          prefixIdx + prefixAnchor.length,
          canonStripped.length,
          0
        );
        return createRangeFromMapping(mapping, start, end);
      }
    }

    // Pass 4: Middle core anchor (avoids leading headers / metadata)
    if (canonStripped.length >= 22) {
      const midAnchor = canonStripped.slice(8, Math.min(32, canonStripped.length));
      const midIdx = canonBlock.indexOf(midAnchor);
      if (midIdx !== -1) {
        const { start, end } = expandToFullSentence(
          blockText,
          midIdx,
          midIdx + midAnchor.length,
          canonStripped.length,
          8
        );
        return createRangeFromMapping(mapping, start, end);
      }
    }

    // Pass 5: Longest CJK sequence or keyword (>= 8 chars)
    const keywords = canonStripped.match(/[\u4e00-\u9fa5]{6,}|[a-z0-9_-]{8,}/g);
    if (keywords && keywords.length) {
      keywords.sort((a, b) => b.length - a.length);
      const kw = keywords[0];
      const kwIdx = canonBlock.indexOf(kw);
      if (kwIdx !== -1) {
        const kwOffset = canonStripped.indexOf(kw);
        const { start, end } = expandToFullSentence(
          blockText,
          kwIdx,
          kwIdx + kw.length,
          canonStripped.length,
          kwOffset >= 0 ? kwOffset : 0
        );
        return createRangeFromMapping(mapping, start, end);
      }
    }

    return null;
  }

  /**
   * Discovers scrollable ancestor containers (e.g. documentation sites or custom viewports).
   */
  function findScrollContainer(element) {
    let parent = element?.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const style = window.getComputedStyle(parent);
      const overflowY = style.overflowY;
      const isScrollable = (overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight + 10;
      if (isScrollable) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return window;
  }

  /**
   * Smart sentence-level scroll positioning.
   * Directly scrolls the active sentence itself into the golden reading eye-level (~32% from top).
   * Eliminates jitter and avoids off-screen scrolling caused by parent container centering.
   */
  function smartScrollIntoView(rect, element) {
    if (!rect) return;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    const top = rect.top;
    const bottom = rect.bottom;

    // Comfort zone: sentence is comfortably visible between 18% and 82% of viewport
    const isInComfortZone = top >= vh * 0.18 && bottom <= vh * 0.82;
    if (isInComfortZone) return;

    const scrollContainer = findScrollContainer(element);

    if (scrollContainer && scrollContainer !== window && scrollContainer !== document.body && scrollContainer !== document.documentElement) {
      // Inner scroll container: scroll by delta
      const ch = scrollContainer.clientHeight;
      const cRect = scrollContainer.getBoundingClientRect();
      const relTop = top - cRect.top;
      const targetRelTop = ch * 0.32;
      const deltaY = relTop - targetRelTop;
      scrollContainer.scrollBy({ top: deltaY, behavior: 'smooth' });

      // If container itself is partly offscreen in window, adjust window
      if (cRect.top < vh * 0.1 || cRect.bottom > vh * 0.9) {
        const winDelta = cRect.top - vh * 0.2;
        window.scrollBy({ top: winDelta, behavior: 'smooth' });
      }
    } else {
      // Main window scroll: directly scroll by delta to position sentence at ~32% from top
      const targetTop = vh * 0.32;
      const deltaY = top - targetTop;
      window.scrollBy({ top: deltaY, behavior: 'smooth' });
    }
  }

  function applyHighlight(block, range) {
    activeRange = range;
    activeContainer = block;
    block.classList.add(CONTAINER_CLASS);

    if (SUPPORTS_CUSTOM_HIGHLIGHT) {
      try {
        const hl = new Highlight(range);
        CSS.highlights.set('omnisense-tts', hl);
      } catch (e) {}
    }

    renderOverlayRects(range, false);
    let rect = range.getBoundingClientRect();
    if ((!rect || (rect.width === 0 && rect.height === 0)) && block) {
      rect = block.getBoundingClientRect();
    }
    updatePillPosition(rect, false);
    smartScrollIntoView(rect, block);
  }

  function highlightSentence(rawText, chunkIndex) {
    if (!rawText || typeof rawText !== 'string') return;
    const cleanText = cleanString(rawText);
    if (cleanText.length < 2) return;

    ensureStyles();
    clearHighlight();
    isPaused = false;

    // Reset progress tracking if starting a new reading session or jumping backward
    if (typeof chunkIndex === 'number') {
      if (chunkIndex === 0 || chunkIndex < lastChunkIndex) {
        lastMatchedBlock = null;
      }
      lastChunkIndex = chunkIndex;
    }

    const blockSelectors = 'article p, main p, .post-content p, .article-content p, .markdown-body p, .article-viewer p, p, li, blockquote, h1, h2, h3, h4, h5, h6, article div, .markdown-body div';
    const allBlocks = Array.from(document.querySelectorAll(blockSelectors));
    const blocks = allBlocks.filter(b => b.textContent && b.textContent.trim().length > 0);
    if (!blocks.length) return;

    // Prioritize search starting from current reading position downwards to prevent jumping backwards
    let orderedBlocks = blocks;
    if (lastMatchedBlock) {
      const idx = blocks.indexOf(lastMatchedBlock);
      if (idx !== -1) {
        orderedBlocks = [...blocks.slice(idx), ...blocks.slice(0, idx)];
      }
    }

    // Try finding the exact or expanded sentence range
    for (const block of orderedBlocks) {
      const range = findBestRangeInBlock(block, cleanText);
      if (range) {
        applyHighlight(block, range);
        lastMatchedBlock = block;
        return;
      }
    }

    // Fallback: Container-level highlight if exact range couldn't be extracted
    const stripped = cleanText.replace(/^[^\w\u4e00-\u9fa5]+/, '').trim();
    const shortAnchor = stripped.slice(0, Math.min(18, stripped.length));
    for (const block of orderedBlocks) {
      if (block.textContent && shortAnchor && block.textContent.includes(shortAnchor)) {
        activeContainer = block;
        block.classList.add(CONTAINER_CLASS);
        lastMatchedBlock = block;
        const rect = block.getBoundingClientRect();
        updatePillPosition(rect, false);
        smartScrollIntoView(rect, block);
        return;
      }
    }
  }

  function setPaused(paused) {
    isPaused = paused;
    if (SUPPORTS_CUSTOM_HIGHLIGHT && activeRange) {
      try {
        if (paused) {
          CSS.highlights.delete('omnisense-tts');
          CSS.highlights.set('omnisense-tts-paused', new Highlight(activeRange));
        } else {
          CSS.highlights.delete('omnisense-tts-paused');
          CSS.highlights.set('omnisense-tts', new Highlight(activeRange));
        }
      } catch (e) {}
    }

    if (activeContainer) {
      activeContainer.classList.toggle('omni-paused', paused);
    }

    if (activeRange) {
      renderOverlayRects(activeRange, paused);
      let rect = activeRange.getBoundingClientRect();
      if ((!rect || (rect.width === 0 && rect.height === 0)) && activeContainer) {
        rect = activeContainer.getBoundingClientRect();
      }
      updatePillPosition(rect, paused);
    } else if (activeContainer) {
      const rect = activeContainer.getBoundingClientRect();
      updatePillPosition(rect, paused);
    }
  }

  window.addEventListener('resize', () => {
    if (activeRange) {
      renderOverlayRects(activeRange, isPaused);
      updatePillPosition(activeRange.getBoundingClientRect(), isPaused);
    } else if (activeContainer) {
      updatePillPosition(activeContainer.getBoundingClientRect(), isPaused);
    }
  }, { passive: true });

  window.addEventListener('scroll', () => {
    if (activeRange) {
      renderOverlayRects(activeRange, isPaused);
      updatePillPosition(activeRange.getBoundingClientRect(), isPaused);
    } else if (activeContainer) {
      updatePillPosition(activeContainer.getBoundingClientRect(), isPaused);
    }
  }, { passive: true });

  // ---------------- Floating Ball & Content Tab Speech Player ----------------
  const FLOATING_BALL_HOST_ID = 'omnisense-floating-ball-host';
  let fbHostEl = null;
  let fbShadow = null;
  let fbBallEl = null;
  let fbMenuEl = null;
  let fbStatusEl = null;
  let fbSentenceEl = null;
  let fbBtnToggle = null;
  let fbBtnNext = null;
  let fbBtnStop = null;
  let fbBtnOpenPanel = null;
  let fbIsMenuOpen = false;

  let ttsQueue = [];
  let ttsCurrentIndex = 0;
  let ttsRate = 1;
  let ttsVoice = null;
  let ttsLang = 'zh-CN';
  let ttsScript = 'han';
  let ttsIsPlaying = false;
  let ttsIsPaused = false;
  let ttsSessionVersion = 0;

  function broadcastState(state, currentIdx = 0, total = 0, text = '') {
    try {
      chrome.runtime.sendMessage({
        type: 'OMNI_TTS_STATE_UPDATE',
        state,
        currentIdx,
        total,
        text
      }).catch(() => {});
    } catch {}
  }

  function ensureFloatingBall() {
    if (fbHostEl && document.getElementById(FLOATING_BALL_HOST_ID)) return;
    fbHostEl = document.createElement('div');
    fbHostEl.id = FLOATING_BALL_HOST_ID;
    fbHostEl.style.cssText = 'all: initial; position: fixed; right: 20px; top: 52%; transform: translateY(-50%); z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;';
    fbShadow = fbHostEl.attachShadow({ mode: 'open' });

    fbShadow.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .omni-fb-wrap {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: flex-end;
        }
        .omni-fb-ball {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: linear-gradient(135deg, rgba(17, 24, 39, 0.95) 0%, rgba(15, 23, 42, 0.98) 100%);
          border: 1.5px solid rgba(255, 255, 255, 0.2);
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 10px rgba(16, 185, 129, 0.2);
          backdrop-filter: blur(14px) saturate(180%);
          cursor: grab;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          user-select: none;
          transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.22s ease, border-color 0.22s ease, opacity 0.22s ease;
        }
        .omni-fb-ball:hover {
          transform: scale(1.08);
        }
        .omni-fb-ball:active {
          cursor: grabbing;
        }

        /* Pulse rings */
        .omni-fb-ring, .omni-fb-ring-outer {
          position: absolute;
          top: -6px; left: -6px; right: -6px; bottom: -6px;
          border-radius: 50%;
          border: 2px solid #10b981;
          pointer-events: none;
          opacity: 0;
        }
        .omni-fb-ring-outer {
          top: -12px; left: -12px; right: -12px; bottom: -12px;
          border: 1.5px solid rgba(52, 211, 153, 0.6);
        }

        /* Equalizer inside ball */
        .omni-fb-wave-box {
          display: flex;
          align-items: flex-end;
          gap: 3px;
          height: 20px;
          width: 18px;
        }
        .omni-fb-wave-bar {
          flex: 1;
          background: #9ca3af;
          border-radius: 2px;
          height: 5px;
          transition: background 0.25s ease, height 0.2s ease;
        }

        /* PLAYING ANIMATIONS */
        .omni-fb-ball.playing {
          border-color: #10b981;
          box-shadow: 0 0 24px rgba(16, 185, 129, 0.75), 0 6px 20px rgba(0, 0, 0, 0.45);
          animation: omniBallBreath 2.2s infinite alternate ease-in-out;
        }
        .omni-fb-ball.playing .omni-fb-ring {
          animation: omniPulseRing 2s cubic-bezier(0.2, 0.8, 0.4, 1) infinite;
        }
        .omni-fb-ball.playing .omni-fb-ring-outer {
          animation: omniPulseRing 2s 0.65s cubic-bezier(0.2, 0.8, 0.4, 1) infinite;
        }
        .omni-fb-ball.playing .omni-fb-wave-bar {
          background: #10b981;
        }
        .omni-fb-ball.playing .omni-fb-wave-bar:nth-child(1) {
          animation: omniWaveDance 0.85s infinite ease-in-out alternate;
          animation-delay: 0.1s;
        }
        .omni-fb-ball.playing .omni-fb-wave-bar:nth-child(2) {
          animation: omniWaveDance 0.85s infinite ease-in-out alternate;
          animation-delay: 0.4s;
        }
        .omni-fb-ball.playing .omni-fb-wave-bar:nth-child(3) {
          animation: omniWaveDance 0.85s infinite ease-in-out alternate;
          animation-delay: 0.22s;
        }

        /* PAUSED STATE */
        .omni-fb-ball.paused {
          border-color: #f59e0b;
          box-shadow: 0 0 18px rgba(245, 158, 11, 0.6), 0 4px 14px rgba(0, 0, 0, 0.4);
        }
        .omni-fb-ball.paused .omni-fb-wave-bar {
          background: #f59e0b;
          height: 8px;
          animation: none !important;
        }

        /* IDLE STATE */
        .omni-fb-ball.idle {
          opacity: 0.82;
          border-color: rgba(255, 255, 255, 0.25);
        }
        .omni-fb-ball.idle .omni-fb-wave-bar {
          background: #9ca3af;
          height: 4px;
          animation: none !important;
        }

        @keyframes omniPulseRing {
          0% { transform: scale(0.92); opacity: 0.9; }
          60% { opacity: 0.35; }
          100% { transform: scale(1.52); opacity: 0; }
        }
        @keyframes omniWaveDance {
          0% { height: 4px; }
          100% { height: 20px; }
        }
        @keyframes omniBallBreath {
          0% { transform: scale(1); }
          100% { transform: scale(1.07); }
        }

        /* Mini Menu */
        .omni-fb-menu {
          position: absolute;
          right: 60px;
          top: 50%;
          transform: translateY(-50%) scale(0.92);
          background: linear-gradient(135deg, rgba(17, 24, 39, 0.96) 0%, rgba(15, 23, 42, 0.98) 100%);
          border: 1px solid rgba(255, 255, 255, 0.18);
          backdrop-filter: blur(16px) saturate(180%);
          box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55), 0 0 20px rgba(16, 185, 129, 0.2);
          border-radius: 12px;
          padding: 10px 12px;
          width: 260px;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .omni-fb-menu.open {
          opacity: 1;
          pointer-events: auto;
          transform: translateY(-50%) scale(1);
        }
        .omni-fb-info {
          margin-bottom: 8px;
        }
        .omni-fb-status {
          font-size: 11px;
          font-weight: 700;
          color: #10b981;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .omni-fb-status.paused {
          color: #f59e0b;
        }
        .omni-fb-sentence {
          font-size: 11.5px;
          color: #f1f5f9;
          line-height: 1.45;
          margin-top: 4px;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .omni-fb-controls {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .omni-fb-btn {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.16);
          color: #ffffff;
          border-radius: 6px;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.18s ease, transform 0.18s ease;
        }
        .omni-fb-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: translateY(-1px);
        }
        .omni-fb-btn-primary {
          background: #10b981;
          border-color: #10b981;
        }
        .omni-fb-btn-primary:hover {
          background: #059669;
        }
        .omni-fb-btn-panel {
          margin-left: auto;
          background: rgba(16, 185, 129, 0.15);
          border-color: rgba(16, 185, 129, 0.4);
          color: #10b981;
        }
        .omni-fb-btn-panel:hover {
          background: rgba(16, 185, 129, 0.3);
        }
      </style>
      <div class="omni-fb-wrap">
        <div class="omni-fb-menu" id="omniMenu">
          <div class="omni-fb-info">
            <div class="omni-fb-status" id="omniStatus">OmniSense 听网页</div> <!-- i18n-allow-cjk -->
            <div class="omni-fb-sentence" id="omniSentence">—</div>
          </div>
          <div class="omni-fb-controls">
            <button class="omni-fb-btn omni-fb-btn-primary" id="omniBtnToggle" title="播放/暂停">⏸</button> <!-- i18n-allow-cjk -->
            <button class="omni-fb-btn" id="omniBtnNext" title="下一句">⏭</button> <!-- i18n-allow-cjk -->
            <button class="omni-fb-btn" id="omniBtnStop" title="停止">⏹</button> <!-- i18n-allow-cjk -->
            <button class="omni-fb-btn" id="omniBtnZen" title="极简沉浸禅阅读">📖 禅读</button> <!-- i18n-allow-cjk -->
            <button class="omni-fb-btn omni-fb-btn-panel" id="omniBtnOpenPanel" title="打开侧边栏">侧栏</button> <!-- i18n-allow-cjk -->
          </div>
        </div>
        <div class="omni-fb-ball idle" id="omniBall" title="OmniSense 朗读助手（点击控制）"> <!-- i18n-allow-cjk -->
          <div class="omni-fb-ring"></div>
          <div class="omni-fb-ring-outer"></div>
          <div class="omni-fb-wave-box">
            <span class="omni-fb-wave-bar"></span>
            <span class="omni-fb-wave-bar"></span>
            <span class="omni-fb-wave-bar"></span>
          </div>
        </div>
      </div>
    `;

    (document.body || document.documentElement).appendChild(fbHostEl);

    fbBallEl = fbShadow.getElementById('omniBall');
    fbMenuEl = fbShadow.getElementById('omniMenu');
    fbStatusEl = fbShadow.getElementById('omniStatus');
    fbSentenceEl = fbShadow.getElementById('omniSentence');
    fbBtnToggle = fbShadow.getElementById('omniBtnToggle');
    fbBtnNext = fbShadow.getElementById('omniBtnNext');
    fbBtnStop = fbShadow.getElementById('omniBtnStop');
    fbBtnOpenPanel = fbShadow.getElementById('omniBtnOpenPanel');

    // Dragging
    let isDragging = false;
    let startY = 0;
    let initialTop = 0;
    let hasMoved = false;

    fbBallEl.addEventListener('mousedown', (e) => {
      isDragging = true;
      hasMoved = false;
      startY = e.clientY;
      const rect = fbHostEl.getBoundingClientRect();
      initialTop = rect.top;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaY = e.clientY - startY;
      if (Math.abs(deltaY) > 4) {
        hasMoved = true;
        fbHostEl.style.transform = 'none';
        const newTop = Math.max(20, Math.min(window.innerHeight - 60, initialTop + deltaY));
        fbHostEl.style.top = `${newTop}px`;
      }
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    fbBallEl.addEventListener('click', () => {
      if (hasMoved) return;
      fbIsMenuOpen = !fbIsMenuOpen;
      fbMenuEl.classList.toggle('open', fbIsMenuOpen);
    });

    fbBtnToggle.addEventListener('click', () => {
      if (ttsIsPlaying && !ttsIsPaused) {
        pauseTabSpeech();
      } else if (ttsIsPaused) {
        resumeTabSpeech();
      }
    });

    fbBtnNext.addEventListener('click', () => {
      jumpTabSpeech(ttsCurrentIndex + 1);
    });

    fbBtnStop.addEventListener('click', () => {
      stopTabSpeech();
    });

    const fbBtnZen = fbShadow.getElementById('omniBtnZen');
    fbBtnZen?.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_ZEN_READER' });
      } catch {}
    });

    fbBtnOpenPanel.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
      } catch {}
    });
  }

  function updateFloatingBallState(state, currentIdx = 0, total = 0, text = '') {
    ensureFloatingBall();
    if (!fbBallEl) return;

    fbBallEl.classList.remove('playing', 'paused', 'idle');
    fbStatusEl.classList.remove('paused');

    if (state === 'playing') {
      fbBallEl.classList.add('playing');
      fbBtnToggle.textContent = '⏸';
      fbStatusEl.textContent = total > 0 ? `正在朗读 · ${currentIdx + 1}/${total} 句` : '正在朗读…'; // i18n-allow-cjk
      fbSentenceEl.textContent = text || '—';
    } else if (state === 'paused') {
      fbBallEl.classList.add('paused');
      fbBtnToggle.textContent = '▶';
      fbStatusEl.classList.add('paused');
      fbStatusEl.textContent = total > 0 ? `已暂停 · ${currentIdx + 1}/${total} 句` : '已暂停'; // i18n-allow-cjk
      fbSentenceEl.textContent = text || '—';
    } else {
      fbBallEl.classList.add('idle');
      fbBtnToggle.textContent = '▶';
      fbStatusEl.textContent = 'OmniSense 听网页'; // i18n-allow-cjk
      fbSentenceEl.textContent = '—';
      fbMenuEl.classList.remove('open');
      fbIsMenuOpen = false;
    }
  }

  function tabVoicesReady() {
    const synth = window.speechSynthesis;
    if (!synth) return Promise.resolve([]);
    const now = synth.getVoices() || [];
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        try { synth.removeEventListener('voiceschanged', done); } catch {}
        clearTimeout(timer);
        resolve(synth.getVoices() || []);
      };
      const timer = setTimeout(done, 1200);
      try { synth.addEventListener('voiceschanged', done); } catch {}
    });
  }

  function voiceBaseName(v) {
    return String((v && v.name) || '')
      .replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '')
      .trim();
  }

  function voiceTag(v) {
    return String((v && v.lang) || '').toLowerCase().replace(/_/g, '-');
  }

  function localeCounts(voices) {
    const counts = new Map();
    for (const v of voices || []) {
      const b = voiceBaseName(v);
      counts.set(b, (counts.get(b) || 0) + 1);
    }
    return counts;
  }

  const NOVELTY_VOICES = new Set([
    'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged',
    'fred', 'good news', 'hysterical', 'jester', 'junior', 'kathy', 'organ',
    'pipe organ', 'princess', 'ralph', 'superstar', 'trinoids', 'whisper',
    'wobble', 'zarvox'
  ]);

  function isNoveltyVoice(v) {
    return NOVELTY_VOICES.has(voiceBaseName(v).toLowerCase());
  }

  const TAB_VOICE_LANG_PREFIX = { han: 'zh', latin: 'en' };
  const TAB_VOICE_PREFERRED_TAGS = { han: ['zh-cn', 'zh-hans', 'zh'], latin: ['en-us', 'en-gb', 'en'] };
  const TAB_CJK_LANGS = new Set(['zh', 'ja', 'ko', 'yue', 'wuu', 'cmn']);

  function rankTabVoices(voices, script) {
    const want = TAB_VOICE_LANG_PREFIX[script] || 'zh';
    let eligible = (voices || []).filter(v => voiceTag(v).split('-')[0] === want);
    if (!eligible.length && script === 'latin') {
      eligible = (voices || []).filter(v => !TAB_CJK_LANGS.has(voiceTag(v).split('-')[0]));
    }
    if (!eligible.length) return [];

    const counts = localeCounts(voices);
    const prefs = TAB_VOICE_PREFERRED_TAGS[script] || [];
    return eligible.map(v => {
      const tag = voiceTag(v);
      const dedicated = (counts.get(voiceBaseName(v)) || 0) === 1;
      const novelty = isNoveltyVoice(v);
      const at = prefs.indexOf(tag);
      const score =
        (v.default ? 1 : 0) * 1e6 +
        (dedicated ? 1 : 0) * 1e5 +
        (novelty ? 0 : 1) * 1e4 +
        (at >= 0 ? (prefs.length - at) * 10 : 0) +
        (v.localService ? 2 : 0);
      return { voice: v, score };
    }).sort((a, b) => b.score - a.score);
  }

  function pickTabVoice(voices, script) {
    const ranked = rankTabVoices(voices, script);
    return ranked.length ? ranked[0].voice : null;
  }

  async function startTabSpeech(chunks, rate = 1, voiceName = null, lang = 'zh-CN', script = 'han', startIndex = 0) {
    if (!chunks || !chunks.length) return;
    ensureFloatingBall();
    window.speechSynthesis.cancel();
    ttsSessionVersion++;

    ttsQueue = chunks;
    ttsCurrentIndex = Math.max(0, Math.min(startIndex, chunks.length - 1));
    ttsRate = rate || 1;
    ttsIsPlaying = true;
    ttsIsPaused = false;
    ttsLang = lang || 'zh-CN';
    ttsScript = script || (lang && lang.startsWith('zh') ? 'han' : 'latin');

    const voices = await tabVoicesReady();

    // 1. Pick voice: match exact name or baseName (e.g. Tingting)
    ttsVoice = null;
    if (voiceName) {
      ttsVoice = voices.find(v => v.name === voiceName) ||
                 voices.find(v => voiceBaseName(v) === voiceBaseName({ name: voiceName }));
    }
    // 2. Dedicated voice algorithm (Tingting for Chinese, non-novelty for English)
    if (!ttsVoice) {
      ttsVoice = pickTabVoice(voices, ttsScript);
    }
    // 3. Fallback matching
    if (!ttsVoice && lang) {
      ttsVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(lang.toLowerCase())) ||
                 voices.find(v => v.lang && v.lang.toLowerCase().includes(lang.toLowerCase()));
    }

    queueTabUtterances(ttsCurrentIndex, ttsRate);
  }

  function queueTabUtterances(startIdx, rate) {
    if (!ttsIsPlaying) return;
    const version = ttsSessionVersion;
    const chunks = ttsQueue;
    if (!chunks || !chunks.length || startIdx >= chunks.length) {
      stopTabSpeech(true);
      return;
    }

    let endedCount = startIdx;

    // Immediately trigger highlight and floating ball for the starting sentence
    if (chunks[startIdx]) {
      highlightSentence(chunks[startIdx].text, startIdx);
      updateFloatingBallState('playing', startIdx, chunks.length, chunks[startIdx].text);
      broadcastState('playing', startIdx, chunks.length, chunks[startIdx].text);
    }

    // Queue every chunk in the SAME synchronous pass!
    // This allows Chrome's native audio engine to buffer all utterances back-to-back without JS scheduling pauses.
    for (let i = startIdx; i < chunks.length; i++) {
      const chunk = chunks[i];
      const u = new SpeechSynthesisUtterance(chunk.text);
      if (ttsVoice) {
        u.voice = ttsVoice;
      }
      u.lang = ttsVoice ? (ttsVoice.lang || ttsLang) : ttsLang;
      u.rate = rate;

      u.onstart = () => {
        if (version !== ttsSessionVersion || !ttsIsPlaying) return;
        ttsCurrentIndex = i;
        highlightSentence(chunk.text, i);
        updateFloatingBallState('playing', i, chunks.length, chunk.text);
        broadcastState('playing', i, chunks.length, chunk.text);
      };

      u.onend = () => {
        if (version !== ttsSessionVersion || !ttsIsPlaying) return;
        endedCount++;
        if (endedCount >= chunks.length) {
          stopTabSpeech(true);
        }
      };

      u.onerror = (e) => {
        if (version !== ttsSessionVersion || !ttsIsPlaying) return;
        const err = (e && e.error) || 'unknown';
        if (err === 'interrupted' || err === 'canceled') return;
        endedCount++;
        if (endedCount >= chunks.length) {
          stopTabSpeech(true);
        }
      };

      try {
        window.speechSynthesis.speak(u);
      } catch (err) {
        if (version !== ttsSessionVersion) return;
        endedCount++;
        if (endedCount >= chunks.length) {
          stopTabSpeech(true);
        }
      }
    }
  }

  function pauseTabSpeech() {
    if (!ttsIsPlaying) return;
    ttsIsPaused = true;
    window.speechSynthesis.pause();
    setPaused(true);
    const curText = ttsQueue[ttsCurrentIndex]?.text || '';
    updateFloatingBallState('paused', ttsCurrentIndex, ttsQueue.length, curText);
    broadcastState('paused', ttsCurrentIndex, ttsQueue.length, curText);
  }

  function resumeTabSpeech() {
    if (!ttsIsPlaying || !ttsIsPaused) return;
    ttsIsPaused = false;
    ttsSessionVersion++;
    window.speechSynthesis.cancel();
    setPaused(false);
    queueTabUtterances(ttsCurrentIndex, ttsRate);
  }

  function stopTabSpeech(isDone = false) {
    ttsIsPlaying = false;
    ttsIsPaused = false;
    ttsSessionVersion++;
    window.speechSynthesis.cancel();
    clearHighlight();
    updateFloatingBallState('stopped', 0, 0, '');
    broadcastState('stopped', 0, 0, '');
  }

  function jumpTabSpeech(idx) {
    if (!ttsQueue.length) return;
    const targetIdx = Math.max(0, Math.min(idx, ttsQueue.length - 1));
    ttsCurrentIndex = targetIdx;
    ttsSessionVersion++;
    window.speechSynthesis.cancel();
    ttsIsPlaying = true;
    ttsIsPaused = false;
    setPaused(false);
    queueTabUtterances(targetIdx, ttsRate);
  }

  function setTabRate(rate) {
    ttsRate = rate;
    if (ttsIsPlaying && !ttsIsPaused) {
      ttsSessionVersion++;
      window.speechSynthesis.cancel();
      queueTabUtterances(ttsCurrentIndex, ttsRate);
    }
  }

  // Always re-bind message listener (safely handles extension reloads)
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'OMNI_TTS_START_PLAYBACK') {
        startTabSpeech(msg.chunks, msg.rate, msg.voiceName, msg.lang, msg.script, msg.startIndex || 0)
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      } else if (msg.type === 'OMNI_TTS_PAUSE') {
        pauseTabSpeech();
        sendResponse({ ok: true });
      } else if (msg.type === 'OMNI_TTS_RESUME') {
        resumeTabSpeech();
        sendResponse({ ok: true });
      } else if (msg.type === 'OMNI_TTS_STOP') {
        stopTabSpeech();
        sendResponse({ ok: true });
      } else if (msg.type === 'OMNI_TTS_JUMP') {
        jumpTabSpeech(msg.index);
        sendResponse({ ok: true });
      } else if (msg.type === 'OMNI_TTS_SET_RATE') {
        setTabRate(msg.rate);
        sendResponse({ ok: true });
      } else if (msg.type === 'OMNI_TTS_GET_STATE') {
        sendResponse({
          isPlaying: ttsIsPlaying,
          isPaused: ttsIsPaused,
          currentIdx: ttsCurrentIndex,
          total: ttsQueue.length,
          currentText: ttsQueue[ttsCurrentIndex]?.text || '',
          rate: ttsRate
        });
      } else if (msg.type === 'OMNI_TTS_HIGHLIGHT') {
        highlightSentence(msg.text, msg.index);
        sendResponse({ ok: true });
      } else if (msg.type === 'OMNI_TTS_CLEAR_HIGHLIGHT') {
        clearHighlight();
        lastMatchedBlock = null;
        lastChunkIndex = -1;
        sendResponse({ ok: true });
      }
    });
  } catch (e) {}

  // Initialize floating ball ready on page load
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureFloatingBall);
    } else {
      ensureFloatingBall();
    }
  } catch {}
})();
