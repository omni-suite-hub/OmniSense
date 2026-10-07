import { DEFAULT_LOCALE, FALLBACK_LOCALE, SUPPORTED_LOCALES } from './constants.js';

let currentDict = {};
let currentLocale = DEFAULT_LOCALE;
let loadedLocale = null;

export async function loadLocale(locale) {
  const target = SUPPORTED_LOCALES.includes(locale) ? locale : FALLBACK_LOCALE;
  try {
    const res = await fetch(chrome.runtime.getURL(`i18n/${target}.json`));
    if (!res.ok) throw new Error('locale fetch failed');
    currentDict = await res.json();
    currentLocale = target;
  } catch (e) {
    // fallback to empty; caller should handle missing keys
    currentDict = {};
    currentLocale = target;
  }
  loadedLocale = currentLocale;
}

/**
 * Load only if the dictionary is not already populated for this locale.
 * Non-UI contexts (the service worker) need translations too — for example the
 * localised context-menu titles and the one-off "page saved" notice — and doing
 * a fetch + JSON.parse on every call would be wasteful.
 */
export async function ensureLocaleLoaded(locale) {
  const target = SUPPORTED_LOCALES.includes(locale) ? locale : FALLBACK_LOCALE;
  if (loadedLocale === target && Object.keys(currentDict).length) return target;
  await loadLocale(target);
  return target;
}

export function getLocale() {
  return currentLocale;
}

export function setLocale(locale) {
  return loadLocale(locale);
}

export function t(key, args = {}) {
  const raw = currentDict[key];
  if (raw == null) return key;
  return String(raw).replace(/\{\{(\w+)\}\}/g, (_, name) => (args[name] != null ? args[name] : `{{${name}}}`));
}

// Apply data-i18n attributes to current document
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const args = {};
    for (const attr of el.getAttributeNames()) {
      if (attr.startsWith('data-i18n-')) {
        args[attr.slice('data-i18n-'.length)] = el.getAttribute(attr);
      }
    }
    const val = t(key, args);
    if (el.hasAttribute('data-i18n-attr')) {
      el.setAttribute(el.getAttribute('data-i18n-attr'), val);
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = val;
    } else {
      el.textContent = val;
    }
  });
}
