// Classic (non-module) content script — self-contained, no imports.
// Extracts page text and asks the service worker to record it into the local
// "time capsule". The background re-checks the autoRecord setting (the
// chrome.permissions API is not available inside content scripts).
//
// The default here MUST mirror DEFAULT_AUTO_RECORD in shared/constants.js.
// Having `?? true` on one side and `false` on the other meant the behaviour
// depended on which side evaluated first, and a style of "opt-in" that silently
// behaved as opt-out.
(async () => {
  try {
    if (!location.protocol.startsWith('http')) return;

    const state = await chrome.storage.local.get('omnisense.autoRecord');
    const auto = state['omnisense.autoRecord'] ?? false;
    if (!auto) return;

    function extractText() {
      const clone = document.cloneNode(true);
      clone.querySelectorAll('script, style, nav, header, footer, aside, [role="banner"], [role="navigation"]')
        .forEach(el => el.remove());
      return (clone.body && clone.body.innerText) || (document.body && document.body.innerText) || '';
    }

    function send() {
      const text = extractText();
      if (text.length < 80) return;
      // Callback form + explicit lastError read. The promise form would leave an
      // "Unchecked runtime.lastError" entry in chrome://extensions whenever the
      // service worker is asleep or cold-starting, which looks like a bug to the
      // user. Retry once so a cold start doesn't silently drop the capture.
      const post = (retries) => {
        try {
          chrome.runtime.sendMessage({
            type: 'CAPTURE_PAGE',
            data: { url: location.href, title: document.title, text }
          }, () => {
            if (chrome.runtime.lastError && retries > 0) {
              setTimeout(() => post(retries - 1), 400);
            }
          });
        } catch (e) { /* extension context invalidated */ }
      };
      post(2);
    }

    if (document.readyState === 'complete') {
      setTimeout(send, 2000);
    } else {
      window.addEventListener('load', () => setTimeout(send, 2000), { once: true });
    }
  } catch (e) {}
})();
