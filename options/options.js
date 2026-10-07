import { loadLocale, t, applyI18n } from '../shared/i18n.js';
import {
  MSG_TYPES, SUPPORTED_LOCALES, TABS, RETENTION_OPTIONS, MODELS, DEFAULT_MODEL_KEY,
  DEFAULT_RETENTION_DAYS, DEFAULT_AUTO_RECORD
} from '../shared/constants.js';
import { showToast } from '../shared/ui.js';
import { sendToSW, postToSW } from '../shared/messaging.js';
import { getSetting, setSetting, SettingKeys } from '../shared/settings.js';

async function init() {
  const savedLang = await getSetting(SettingKeys.locale, 'zh');
  await loadLocale(savedLang);
  applyI18n();

  // Language
  const langSel = document.getElementById('optLang');
  SUPPORTED_LOCALES.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l; opt.textContent = t(`settings.general.lang_${l}`);
    langSel.appendChild(opt);
  });
  langSel.value = savedLang;
  langSel.addEventListener('change', async () => {
    await setSetting(SettingKeys.locale, langSel.value);
    await loadLocale(langSel.value);
    applyI18n();
    showToast(t('global.save'));
  });

  // Default tab
  const tabSel = document.getElementById('optDefaultTab');
  TABS.forEach(tab => {
    const opt = document.createElement('option');
    opt.value = tab; opt.textContent = t(`${tab}.title`);
    tabSel.appendChild(opt);
  });
  tabSel.value = await getSetting(SettingKeys.defaultTab, 'capsule');
  tabSel.addEventListener('change', () => setSetting(SettingKeys.defaultTab, tabSel.value));

  // Capsule auto record
  const autoBox = document.getElementById('optAutoRecord');
  // Must match DEFAULT_AUTO_RECORD in shared/constants.js — the checkbox was
  // hard-coded to true here while the constant says false, so the panel showed
  // "on" for a user whose actual capture path was off.
  autoBox.checked = await getSetting(SettingKeys.autoRecord, DEFAULT_AUTO_RECORD);
  autoBox.addEventListener('change', () => {
    setSetting(SettingKeys.autoRecord, autoBox.checked);
  });

  // Retention
  const retSel = document.getElementById('optRetention');
  RETENTION_OPTIONS.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.value; opt.textContent = t(r.labelKey);
    retSel.appendChild(opt);
  });
  retSel.value = String(await getSetting(SettingKeys.retentionDays, DEFAULT_RETENTION_DAYS));
  retSel.addEventListener('change', () => setSetting(SettingKeys.retentionDays, Number(retSel.value)));

  document.getElementById('optClearCapsule').addEventListener('click', async () => {
    if (!confirm(t('settings.capsule.confirm'))) return;
    try {
      await sendToSW({ type: MSG_TYPES.CAPSULE_CLEAR });
      showToast(t('settings.capsule.cleared'));
    } catch (e) {
      showToast(t('global.error_retry'));
    }
  });

  // Model
  const modelSel = document.getElementById('optModelGrade');
  Object.keys(MODELS).forEach(k => {
    const opt = document.createElement('option');
    opt.value = k; opt.textContent = t(MODELS[k].labelKey);
    modelSel.appendChild(opt);
  });
  modelSel.value = await getSetting(SettingKeys.modelKey, DEFAULT_MODEL_KEY);
  modelSel.addEventListener('change', () => setSetting(SettingKeys.modelKey, modelSel.value));

  document.getElementById('optDownloadModel').addEventListener('click', () => {
    postToSW({ type: MSG_TYPES.MODEL_LOAD, modelKey: modelSel.value });
    showToast(t('global.download_start', { size: MODELS[modelSel.value].sizeHint }));
  });
  document.getElementById('optRemoveModel').addEventListener('click', () => {
    caches.keys().then(keys => keys.forEach(k => { if (k.includes('webllm') || k.includes('transformers')) caches.delete(k); }));
    showToast(t('settings.model.removed'));
  });

  // Adblock
  const adBox = document.getElementById('optAdblock');
  adBox.checked = await getSetting(SettingKeys.adblockEnabled, true);
  adBox.addEventListener('change', () => {
    setSetting(SettingKeys.adblockEnabled, adBox.checked);
    postToSW({ type: MSG_TYPES.TOGGLE_ADBLOCK, enabled: adBox.checked });
  });

  document.getElementById('optUpdateRules').addEventListener('click', () => {
    // Was a hard-coded Chinese string, which leaked into the English locale.
    showToast(t('settings.adblock.rules_note'));
  });

  // Model status broadcast
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === MSG_TYPES.MODEL_STATUS || m.type === MSG_TYPES.MODEL_PROGRESS) {
      const statusEl = document.getElementById('optModelStatus');
      if (m.status === 'ready') statusEl.textContent = t('settings.model.status', { status: t('settings.model.status_ready') });
      else if (m.status === 'downloading') statusEl.textContent = t('settings.model.status', { status: `${Math.round(m.progress * 100)}%` });
      else statusEl.textContent = t('settings.model.status', { status: t('settings.model.status_missing') });
    }
  });

  postToSW({ type: MSG_TYPES.PING });
}

init().catch(() => {});
