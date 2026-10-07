// Classic (non-module) content script — self-contained, no imports.
// Hides cosmetic ad selectors and accumulates an element-hide count.
(async () => {
  try {
    const state = await chrome.storage.local.get(['omnisense.adblock.enabled', 'omnisense.adblock.allowlist']);
    const enabled = state['omnisense.adblock.enabled'] ?? true;
    if (!enabled) return;

    const allowlist = state['omnisense.adblock.allowlist'] || [];
    if (allowlist.some(d => location.hostname.includes(d))) return;

    let selectors = [];
    try {
      const url = chrome.runtime.getURL('rules/cosmetic-subset.json');
      const res = await fetch(url);
      selectors = await res.json();
    } catch (e) {
      return;
    }
    if (!Array.isArray(selectors) || !selectors.length) return;

    const style = document.createElement('style');
    style.id = 'omnisense-cosmetic-filter';
    style.textContent = `${selectors.join(', ')} { display: none !important; visibility: hidden !important; }`;
    (document.head || document.documentElement).appendChild(style);

    let count = 0;
    try {
      selectors.forEach(sel => { count += document.querySelectorAll(sel).length; });
      if (count > 0) {
        const key = 'omnisense.adblock.stats';
        const got = await chrome.storage.local.get(key);
        const stats = got[key] || { requests: 0, elements: 0 };
        stats.elements = (stats.elements || 0) + count;
        await chrome.storage.local.set({ [key]: stats });
      }
    } catch (e) {}
  } catch (e) {}
})();
