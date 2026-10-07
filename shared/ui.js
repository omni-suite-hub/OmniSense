import { t } from './i18n.js';
import { MSG_TYPES, MODELS, DEFAULT_MODEL_KEY } from './constants.js';
import { postToSW } from './messaging.js';
import { getSetting, SettingKeys } from './settings.js';

export function setupModelStatusBar(containerEl) {
  const el = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
  if (!el) return { update() {} };

  // The download banner interpolates the model size ("首次约 1.8GB，可后台进行").
  // It used to be called with an empty string, which rendered as "首次约 ，".
  let sizeHint = MODELS[DEFAULT_MODEL_KEY].sizeHint;
  getSetting(SettingKeys.modelKey, DEFAULT_MODEL_KEY)
    .then(k => { sizeHint = (MODELS[k] || MODELS[DEFAULT_MODEL_KEY]).sizeHint; })
    .catch(() => {});

  const update = (status, progress, text) => {
    el.className = 'model-status';
    if (status === 'ready') {
      el.classList.add('ready');
      el.textContent = t('global.download_done');
    } else if (status === 'downloading') {
      el.classList.add('downloading');
      const pct = progress != null ? `${Math.round(progress * 100)}%` : '';
      el.textContent = `${t('global.download_start', { size: sizeHint })} ${pct}`.trim();
    } else if (status === 'error') {
      el.classList.add('error');
      el.textContent = formatModelError(text);
    } else {
      el.classList.add('idle');
      el.textContent = text || t('global.local_only');
    }
  };

  // Listen to broadcast updates from background
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === MSG_TYPES.MODEL_STATUS || m.type === MSG_TYPES.MODEL_PROGRESS) {
      update(m.status, m.progress, m.text);
    }
  });

  // Reflect a sane idle label immediately (avoids showing the raw placeholder).
  update('idle');

  // Initial ask. Routed through postToSW so a cold-starting service worker never
  // produces an "Unchecked runtime.lastError" entry in chrome://extensions.
  postToSW({ type: MSG_TYPES.PING });

  return { update };
}

export function showToast(message, duration = 2000) {
  const existing = document.querySelector('.omni-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'omni-toast';
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

export function setThinking(buttonOrSelector, thinking = true) {
  const el = typeof buttonOrSelector === 'string'
    ? document.querySelector(buttonOrSelector)
    : buttonOrSelector;
  if (!el) return;
  if (thinking) {
    el.dataset.originalText = el.textContent;
    el.textContent = t('global.thinking');
    el.disabled = true;
    el.classList.add('thinking');
  } else {
    el.textContent = el.dataset.originalText || el.textContent;
    el.disabled = false;
    el.classList.remove('thinking');
  }
}

export function makeTabs(container, onSwitch) {
  const buttons = container.querySelectorAll('[data-tab]');
  // Panels live outside the tab bar (e.g. in #main), so search the whole document.
  const panels = document.querySelectorAll('[data-panel]');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      buttons.forEach(b => b.classList.toggle('active', b === btn));
      panels.forEach(p => {
        p.classList.toggle('active', p.dataset.panel === tab);
      });
      if (onSwitch) onSwitch(tab);
    });
  });
}

export function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return t('capsule.days_ago', { n: days });
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return t('capsule.hours_ago', { n: hours });
  return t('capsule.just_now');
}

/**
 * Turn a machine-readable model failure into something a user can act on.
 * The inference host cannot reach the i18n dictionary (it is not a UI context),
 * so it sends stable codes and the UI translates them here.
 */
export function formatModelError(text) {
  if (text === 'NO_WEBGPU') return t('global.nogpu');
  // Raised by the inference host when even the shrink-and-retry path could not
  // fit a prompt into the model's context window. It used to surface as the raw
  // string "Prompt tokens exceed context window size: number of prompt tokens:
  // 4338; context window size: 4096" inside the result box.
  if (text === 'CONTEXT_EXCEEDED') return t('global.context_exceeded');
  if (!text) return t('global.error_retry');
  return text;
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
