import { loadLocale, t, applyI18n } from '../shared/i18n.js';
import { MSG_TYPES, MODELS, DEFAULT_MODEL_KEY } from '../shared/constants.js';
import { getSetting, setSetting, SettingKeys } from '../shared/settings.js';
import { postToSW } from '../shared/messaging.js';

let step = 0;

async function init() {
  const savedLang = await getSetting(SettingKeys.locale, 'zh');
  await loadLocale(savedLang);
  applyI18n();
  renderStep();
}

function renderStep() {
  const title = document.getElementById('obTitle');
  const desc = document.getElementById('obDesc');
  const actions = document.getElementById('obActions');
  document.querySelectorAll('#progress span').forEach((s, i) => s.classList.toggle('active', i <= step));
  actions.innerHTML = '';

  if (step === 0) {
    title.textContent = t('onboard.welcome_title');
    desc.textContent = t('onboard.welcome_desc');
    addBtn(t('global.confirm'), true, () => { step++; renderStep(); });
  } else if (step === 1) {
    title.textContent = t('onboard.capsule_title');
    desc.textContent = t('onboard.capsule_desc');
    addBtn(t('onboard.capsule_enable'), true, async () => {
      // Deliberately no permission request: OmniSense never calls
      // chrome.history. Asking for it here (without a user gesture Chrome
      // recognises) was always denied, and because the capture path used to
      // gate on it, the whole capsule stayed silently empty forever. The only
      // switch that matters is this setting.
      await setSetting(SettingKeys.autoRecord, true);
      step++; renderStep();
    });
    addBtn(t('onboard.capsule_later'), false, () => { step++; renderStep(); });
  } else if (step === 2) {
    title.textContent = t('onboard.model_title');
    desc.textContent = t('onboard.model_desc', { size: MODELS[DEFAULT_MODEL_KEY].sizeHint });
    addBtn(t('onboard.model_download'), true, () => {
      postToSW({ type: MSG_TYPES.MODEL_LOAD, modelKey: DEFAULT_MODEL_KEY });
      step++; renderStep();
    });
    addBtn(t('onboard.model_later'), false, () => { step++; renderStep(); });
  } else {
    title.textContent = t('onboard.done_title');
    desc.textContent = t('onboard.done_desc');
    setSetting(SettingKeys.onboarded, true);
    addBtn(t('global.close'), true, () => window.close());
  }
}

function addBtn(label, primary, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  if (primary) btn.className = 'primary';
  btn.addEventListener('click', onClick);
  document.getElementById('obActions').appendChild(btn);
}

init().catch(() => {});
