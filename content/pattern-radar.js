/**
 * OmniSense Pattern & Trap Radar Content Script
 *
 * Scans active page for psychological marketing traps:
 * 1. Fake countdown timers (resetting on reload)
 * 2. Fullscreen intrusive modal overlays & cookie banners
 * 3. Auto-crushing blocking backdrops & unlocking scroll
 * 4. Pre-checked promotional / opt-in checkboxes
 */
(() => {
  const BADGE_CLASS = 'omni-pattern-radar-badge';
  const BADGE_CONTAINER_ID = 'omni-pattern-radar-badges-root';
  const STORAGE_KEY = '__omni_countdown_tracker__';

  function parseCountdownText(text) {
    if (!text || typeof text !== 'string') return null;
    const s = text.trim();
    const clockMatch = s.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
    if (clockMatch) {
      const hours = clockMatch[1] ? parseInt(clockMatch[1], 10) : 0;
      const minutes = parseInt(clockMatch[2], 10);
      const seconds = parseInt(clockMatch[3], 10);
      if (minutes < 60 && seconds < 60) {
        return {
          matched: clockMatch[0],
          totalSeconds: hours * 3600 + minutes * 60 + seconds
        };
      }
    }
    // Spoken / unit format e.g. "15分20秒" or "10 mins" or "限时 15 分钟" // i18n-allow-cjk
    const hourMatch = s.match(/(\d+)\s*(?:小时|hours?|hrs?)/i); // i18n-allow-cjk
    const minMatch = s.match(/(\d+)\s*(?:分|分钟|mins?|minutes?)/i); // i18n-allow-cjk
    const secMatch = s.match(/(\d+)\s*(?:秒|secs?|seconds?)/i); // i18n-allow-cjk

    if (hourMatch || minMatch || secMatch) {
      const h = hourMatch ? parseInt(hourMatch[1], 10) : 0;
      const m = minMatch ? parseInt(minMatch[1], 10) : 0;
      const sec = secMatch ? parseInt(secMatch[1], 10) : 0;
      const total = h * 3600 + m * 60 + sec;
      if (total > 0 && total <= 86400) {
        const matchedParts = [hourMatch?.[0], minMatch?.[0], secMatch?.[0]].filter(Boolean).join(' ');
        return { matched: matchedParts, totalSeconds: total };
      }
    }
    return null;
  }

  function isRejectCookieButton(text, extraAttrs = '') {
    const combined = `${text || ''} ${extraAttrs || ''}`.toLowerCase();
    if (/(accept\s*all|agree\s*to\s*all|allow\s*all|全部同意|接受全部|同意并继续)/i.test(combined)) { // i18n-allow-cjk
      return false;
    }
    const rejectRegex = /(reject\s*all|decline\s*all|refuse\s*all|essential\s*only|necessary\s*only|deny\s*all|仅必要|仅接受必要|不同意|拒绝全部|拒绝|仅必要cookie)/i; // i18n-allow-cjk
    return rejectRegex.test(combined);
  }

  function getTrackerRecord() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveTrackerRecord(record) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch {}
  }

  /**
   * Scans for countdown timer elements in the DOM.
   */
  function scanCountdowns() {
    const countdowns = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!node || node.nodeType !== 1) return NodeFilter.FILTER_REJECT;
        const tag = node.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'path' || tag === 'noscript') {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.classList?.contains(BADGE_CLASS)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let current;
    const candidates = [];
    while ((current = walker.nextNode())) {
      if (current.children.length > 5) continue;
      const text = (current.innerText || current.textContent || '').trim();
      if (!text || text.length > 80) continue;
      const parsed = parseCountdownText(text);
      if (parsed) {
        const style = window.getComputedStyle(current);
        if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0) {
          candidates.push({ el: current, parsed, text });
        }
      }
    }

    const prevRecord = getTrackerRecord();
    const now = Date.now();

    candidates.forEach(({ el, parsed, text }) => {
      let isFake = false;
      let reason = 'detected_timer';

      if (prevRecord && prevRecord.initialSeconds) {
        const elapsed = Math.max(0, Math.floor((now - prevRecord.firstSeen) / 1000));
        const expected = Math.max(0, prevRecord.initialSeconds - elapsed);
        if (elapsed >= 4 && parsed.totalSeconds > expected + 3) {
          isFake = true;
          reason = 'reset_on_reload';
        }
      }

      if (!isFake) {
        // Round numbers like 15:00 or 10:00 often used for urgency marketing
        if ([300, 600, 900, 1200, 1800].includes(parsed.totalSeconds)) {
          isFake = true;
          reason = 'round_interval_pattern';
        }
      }

      countdowns.push({
        text: parsed.matched,
        fullText: text.slice(0, 50),
        totalSeconds: parsed.totalSeconds,
        isFake,
        reason
      });

      // Record for cross-refresh comparison
      if (!prevRecord || !prevRecord.firstSeen) {
        saveTrackerRecord({
          firstSeen: now,
          initialSeconds: parsed.totalSeconds,
          lastSeen: now,
          observedCount: 1
        });
      } else {
        prevRecord.lastSeen = now;
        prevRecord.observedCount = (prevRecord.observedCount || 1) + 1;
        saveTrackerRecord(prevRecord);
      }
    });

    return countdowns;
  }

  /**
   * Scans for intrusive overlays, modals, and cookie banners.
   */
  function scanOverlays() {
    const overlays = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const allElements = Array.from(document.querySelectorAll('div, section, aside, dialog, .modal, .overlay, .popup, [role="dialog"], [role="alertdialog"]'));

    for (const el of allElements) {
      if (el.id === BADGE_CONTAINER_ID || el.classList?.contains(BADGE_CLASS)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) continue;

      const pos = style.position;
      if (pos !== 'fixed' && pos !== 'sticky' && pos !== 'absolute') continue;

      const zIndex = parseInt(style.zIndex, 10);
      const rect = el.getBoundingClientRect();

      const coversMuchOfScreen = rect.width >= vw * 0.65 && rect.height >= vh * 0.5;
      const isHighZ = !isNaN(zIndex) && zIndex >= 90;
      const classOrId = `${el.className || ''} ${el.id || ''}`.toLowerCase();
      const hasOverlayKeyword = /(cookie|consent|banner|modal|overlay|popup|dialog|gdpr|privacy-wall|login-gate)/i.test(classOrId); // i18n-allow-cjk

      if ((coversMuchOfScreen && isHighZ) || (hasOverlayKeyword && (coversMuchOfScreen || isHighZ))) {
        // Look for buttons inside
        const buttons = Array.from(el.querySelectorAll('button, a[role="button"], input[type="button"], [class*="btn"]'));
        const rejectBtn = buttons.find(b => isRejectCookieButton(b.innerText || b.textContent || '', `${b.className} ${b.id}`));

        overlays.push({
          id: el.id || '',
          className: String(el.className || '').slice(0, 40),
          coversMuchOfScreen,
          hasRejectBtn: !!rejectBtn,
          zIndex: isNaN(zIndex) ? 0 : zIndex
        });
      }
    }

    const bodyStyle = window.getComputedStyle(document.body);
    const htmlStyle = window.getComputedStyle(document.documentElement);
    const scrollLocked = bodyStyle.overflow === 'hidden' || htmlStyle.overflow === 'hidden' || bodyStyle.position === 'fixed';

    return { overlays, scrollLocked };
  }

  /**
   * Scans for pre-checked promotional / opt-in checkboxes.
   */
  function scanPreCheckedCheckboxes() {
    const checkboxes = [];
    const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]:checked'));

    inputs.forEach(input => {
      const parent = input.closest('label, div, p, li, form') || input.parentElement;
      const text = (parent?.innerText || parent?.textContent || '').trim().replace(/\s+/g, ' ');
      if (text) {
        const isPromo = /(续费|自动扣|订阅|推广|优惠|营销|商业|newsletter|promot|auto-renew|recurring|sponsor)/i.test(text); // i18n-allow-cjk
        checkboxes.push({
          name: input.name || input.id || 'checkbox',
          text: text.slice(0, 60),
          isPromo
        });
      }
    });

    return checkboxes;
  }

  /**
   * Crushes intrusive overlays, clicks reject buttons, and restores smooth scrolling.
   */
  function crushOverlays() {
    let clickedButtons = 0;
    let crushedCount = 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 1. First attempt: click reject/essential cookie buttons
    const allButtons = Array.from(document.querySelectorAll('button, a[role="button"], input[type="button"], [class*="btn"]'));
    for (const b of allButtons) {
      const text = b.innerText || b.textContent || '';
      const attrs = `${b.className || ''} ${b.id || ''} ${b.getAttribute('aria-label') || ''}`;
      if (isRejectCookieButton(text, attrs)) {
        try {
          b.click();
          clickedButtons++;
        } catch {}
      }
    }

    // 2. Second attempt: neutralise blocking fullscreen backdrops
    const potentialOverlays = Array.from(document.querySelectorAll('div, section, aside, dialog, .modal, .overlay, .popup, [role="dialog"]'));
    for (const el of potentialOverlays) {
      if (el.id === BADGE_CONTAINER_ID) continue;
      const style = window.getComputedStyle(el);
      const pos = style.position;
      if (pos !== 'fixed' && pos !== 'sticky' && pos !== 'absolute') continue;

      const zIndex = parseInt(style.zIndex, 10);
      const rect = el.getBoundingClientRect();
      const coversMuch = rect.width >= vw * 0.65 && rect.height >= vh * 0.5;
      const classOrId = `${el.className || ''} ${el.id || ''}`.toLowerCase();
      const isBanner = /(cookie|consent|banner|modal|overlay|popup|backdrop|dialog|gdpr|mask)/i.test(classOrId); // i18n-allow-cjk

      if ((coversMuch && zIndex >= 80) || (isBanner && coversMuch)) {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('opacity', '0', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
        crushedCount++;
      }
    }

    // 3. Unlock document scrolling
    let restoredScroll = false;
    const body = document.body;
    const docEl = document.documentElement;

    if (body) {
      body.style.setProperty('overflow', 'auto', 'important');
      body.style.setProperty('position', 'static', 'important');
      body.style.setProperty('height', 'auto', 'important');
      body.classList.remove('modal-open', 'no-scroll', 'overflow-hidden', 'noscroll');
      restoredScroll = true;
    }
    if (docEl) {
      docEl.style.setProperty('overflow', 'auto', 'important');
      docEl.style.setProperty('position', 'static', 'important');
      docEl.style.setProperty('height', 'auto', 'important');
      docEl.classList.remove('modal-open', 'no-scroll', 'overflow-hidden', 'noscroll');
    }

    return { crushedCount, clickedButtons, restoredScroll };
  }

  /**
   * Toggles in-page visual badges for countdown timers.
   */
  function toggleCountdownBadges(show) {
    let container = document.getElementById(BADGE_CONTAINER_ID);
    if (!show) {
      if (container) container.remove();
      return;
    }

    if (!container) {
      container = document.createElement('div');
      container.id = BADGE_CONTAINER_ID;
      document.body.appendChild(container);
    }
    container.innerHTML = '';

    const countdownElements = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let curr;
    while ((curr = walker.nextNode())) {
      if (curr.children.length > 5 || curr.id === BADGE_CONTAINER_ID) continue;
      const text = (curr.innerText || curr.textContent || '').trim();
      if (!text || text.length > 80) continue;
      if (parseCountdownText(text)) {
        const style = window.getComputedStyle(curr);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          countdownElements.push(curr);
        }
      }
    }

    countdownElements.forEach(el => {
      const rect = el.getBoundingClientRect();
      const badge = document.createElement('div');
      badge.className = BADGE_CLASS;
      badge.style.cssText = `
        position: absolute;
        top: ${rect.top + window.scrollY - 24}px;
        left: ${rect.left + window.scrollX}px;
        background: #ef4444;
        color: #ffffff;
        font-size: 11px;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(239, 68, 68, 0.4);
        z-index: 2147483646;
        pointer-events: none;
        white-space: nowrap;
      `;
      badge.textContent = '⚠️ 营销压力倒计时（心理促单）'; // i18n-allow-cjk
      container.appendChild(badge);
    });
  }

  // Register message listener
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'SCAN_PATTERNS') {
        const countdowns = scanCountdowns();
        const { overlays, scrollLocked } = scanOverlays();
        const checkboxes = scanPreCheckedCheckboxes();
        sendResponse({ countdowns, overlays, scrollLocked, checkboxes });
      } else if (msg.type === 'CRUSH_OVERLAYS') {
        const result = crushOverlays();
        sendResponse(result);
      } else if (msg.type === 'TOGGLE_COUNTDOWN_BADGES') {
        toggleCountdownBadges(!!msg.show);
        sendResponse({ ok: true });
      }
    });
  } catch {}
})();
