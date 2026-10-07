// Cross-context settings backed by chrome.storage.local.

export async function getSetting(key, defaultValue = null) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? defaultValue;
}

export async function setSetting(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function removeSetting(key) {
  await chrome.storage.local.remove(key);
}

export const SettingKeys = {
  locale: 'omnisense.locale',
  defaultTab: 'omnisense.defaultTab',
  autoRecord: 'omnisense.autoRecord',
  retentionDays: 'omnisense.retentionDays',
  modelKey: 'omnisense.modelKey',
  adblockEnabled: 'omnisense.adblock.enabled',
  onboarded: 'omnisense.onboarded',
  // Set the first time an automatic capture is stored, so the one-off
  // discoverability notice is shown exactly once. It MUST exist as a constant:
  // background.js used to read `SettingKeys.captureNotified` before it was
  // defined, i.e. `undefined`, which made the "first capture" toast fire on
  // every single page and wrote a literal "undefined" key to storage.
  captureNotified: 'omnisense.captureNotified',
  stats: 'omnisense.adblock.stats'
};
