import { loadLocale, t, applyI18n } from '../shared/i18n.js';
import { MSG_TYPES } from '../shared/constants.js';
import { setupModelStatusBar, showToast } from '../shared/ui.js';
import { sendToSW, postToSW } from '../shared/messaging.js';
import { getSetting, SettingKeys } from '../shared/settings.js';

async function init() {
  const savedLang = await getSetting(SettingKeys.locale, 'zh');
  await loadLocale(savedLang);
  applyI18n();

  setupModelStatusBar('modelStatus');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;

  document.getElementById('btnOpenPanel').addEventListener('click', () => {
    if (tabId) {
      if (chrome.sidePanel?.open) chrome.sidePanel.open({ tabId }).catch(() => {});
      else if (chrome.sidebarAction?.open) chrome.sidebarAction.open().catch(() => {});
    }
    window.close();
  });

  document.getElementById('btnSummary').addEventListener('click', () => openFeature('summary'));
  document.getElementById('btnListen').addEventListener('click', () => openFeature('listen'));
  document.getElementById('btnPrivacy').addEventListener('click', () => openFeature('privacy'));
  document.getElementById('btnAdblock').addEventListener('click', () => openFeature('adblock'));
  document.getElementById('btnGroupTabs')?.addEventListener('click', async () => {
    try {
      showToast(t('global.thinking'));
      const res = await sendToSW({ type: MSG_TYPES.CLUSTER_TABS, windowId: tab?.windowId });
      if (res?.ok) {
        showToast(t('toast.tab_grouped', { count: res.count, groups: res.groups }));
        setTimeout(() => window.close(), 1200);
      } else if (res?.reason === 'too_few') {
        showToast(t('toast.tab_too_few'));
      } else if (res?.reason === 'no_clusters') {
        showToast(t('toast.tab_no_clusters'));
      } else {
        showToast(t('global.error_retry'));
      }
    } catch (e) {
      showToast(t('global.error_retry'));
    }
  });

  document.getElementById('capsuleSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (!q) return;
      openFeature('capsule', { query: q });
    }
  });

  refreshAdblockStats();

  async function openFeature(view, extra = {}) {
    if (!tabId) return;
    try {
      await chrome.storage.session.set({
        'omnisense.pendingView': { view, tabId, ...extra, ts: Date.now() }
      });
    } catch (e) {}
    postToSW({ type: 'OPEN_VIEW', view, tabId, ...extra });
    if (chrome.sidePanel?.open) chrome.sidePanel.open({ tabId }).catch(() => {});
    else if (chrome.sidebarAction?.open) chrome.sidebarAction.open().catch(() => {});
    window.close();
  }
}

async function refreshAdblockStats() {
  try {
    const stats = await sendToSW({ type: MSG_TYPES.GET_ADBLOCK_STATS });
    const el = document.getElementById('adblockStats');
    el.textContent = `${stats?.requests || 0} · ${stats?.elements || 0}`;
  } catch (e) {}
}

init().catch(() => {});
