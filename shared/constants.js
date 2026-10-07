// Shared constants for OmniSense

export const APP_NAME = 'OmniSense';
export const DEFAULT_LOCALE = 'zh';
export const FALLBACK_LOCALE = 'en';
export const SUPPORTED_LOCALES = ['zh', 'en'];

export const STORES = {
  DB: 'omnisense',
  CAPSULE: 'capsule',
  SETTINGS: 'settings',
  GENERATIONS: 'generations'
};

export const MODELS = {
  'qwen3b': {
    id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    labelKey: 'settings.model.3b',
    sizeHint: '~1.8GB'
  },
  'qwen7b': {
    id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC',
    labelKey: 'settings.model.7b',
    sizeHint: '~4–5GB'
  }
};
export const DEFAULT_MODEL_KEY = 'qwen3b';

export const TABS = [
  'capsule', 'ask', 'tabgroup', 'summary', 'listen', 'writing', 'tone', 'roast', 'privacy', 'adblock'
];

export const MSG_TYPES = {
  // model / offscreen
  MODEL_LOAD: 'MODEL_LOAD',
  MODEL_STATUS: 'MODEL_STATUS',
  MODEL_PROGRESS: 'MODEL_PROGRESS',
  INFER_STREAM: 'INFER_STREAM',
  INFER_START: 'INFER_START',
  INFER_END: 'INFER_END',
  INFER_ERROR: 'INFER_ERROR',
  // Progress/notice line for a request that is still running (e.g. "the article
  // was long, so it is being summarised in chunks"). Kept separate from
  // INFER_STREAM so it never mixes generated text into what the user copies.
  INFER_NOTICE: 'INFER_NOTICE',
  EMBEDDING: 'EMBEDDING',
  // capture / history
  CAPTURE_PAGE: 'CAPTURE_PAGE',
  CAPTURE_TAB: 'CAPTURE_TAB',
  CAPTURE_RESULT: 'CAPTURE_RESULT',
  CAPSULE_SEARCH: 'CAPSULE_SEARCH',
  CAPSULE_QUERY: 'CAPSULE_QUERY',
  CAPSULE_CLEAR: 'CAPSULE_CLEAR',
  CAPSULE_STATS: 'CAPSULE_STATS',
  // "What is actually stored?" — the listing route. Separate from CAPSULE_QUERY
  // because it is a different operation with a different cost: listing reads
  // IndexedDB and nothing else, while a query needs the embedding model resident.
  CAPSULE_RECENT: 'CAPSULE_RECENT',
  // Remove one page (all of its chunks) by URL.
  CAPSULE_DELETE: 'CAPSULE_DELETE',
  CAPSULE_GRAPH: 'CAPSULE_GRAPH',
  RUN_SELECTION_ACTION: 'RUN_SELECTION_ACTION',
  CAPTURE_SELECTION: 'CAPTURE_SELECTION',
  OPEN_ZEN_READER: 'OPEN_ZEN_READER',
  // readability / page info
  GET_ARTICLE: 'GET_ARTICLE',
  GET_SELECTION: 'GET_SELECTION',
  SCAN_PRIVACY: 'SCAN_PRIVACY',
  INSERT_TEXT: 'INSERT_TEXT',
  // adblock / stats
  GET_ADBLOCK_STATS: 'GET_ADBLOCK_STATS',
  TOGGLE_ADBLOCK: 'TOGGLE_ADBLOCK',
  ALLOWLIST_PAGE: 'ALLOWLIST_PAGE',
  GET_RELATED_CAPSULES: 'GET_RELATED_CAPSULES',
  CLUSTER_TABS: 'CLUSTER_TABS',
  DEDUPE_TABS: 'DEDUPE_TABS',
  // radar & agreement
  SCAN_PATTERNS: 'SCAN_PATTERNS',
  CRUSH_OVERLAYS: 'CRUSH_OVERLAYS',
  TOGGLE_COUNTDOWN_BADGES: 'TOGGLE_COUNTDOWN_BADGES',
  SCAN_AGREEMENT: 'SCAN_AGREEMENT',
  // ui
  TOAST: 'TOAST',
  OPEN_SIDE_PANEL: 'OPEN_SIDE_PANEL',
  PING: 'PING'
};

export const RETENTION_OPTIONS = [
  { value: 30, labelKey: 'settings.retention.30' },
  { value: 90, labelKey: 'settings.retention.90' },
  { value: 180, labelKey: 'settings.retention.180' },
  { value: 0, labelKey: 'settings.retention.forever' }
];
export const DEFAULT_RETENTION_DAYS = 90;

// Recording what you read is opt-in: nothing is captured until the user turns the
// time capsule on (onboarding step 2 or the settings switch). The single explicit
// manual "收录本页" action always works, because that is user-initiated.
export const DEFAULT_AUTO_RECORD = false;
export const MIN_CAPTURE_CHARS = 80;

/**
 * How many stored PAGES the "view everything" listing returns.
 *
 * Pages, not chunks: rows in the capsule store are chunks, so a page with 20
 * chunks would otherwise fill the whole list on its own. Ordered newest first,
 * which is what someone asking "what have I got in here?" is actually asking.
 */
export const CAPSULE_RECENT_LIMIT = 100;

// Below this there is nothing worth summarising. The article reader can return a
// title with a couple of sentences on a login wall or a gallery page, and sending
// that to the model produces an apology that looks like a malfunction.
export const MIN_SUMMARY_CHARS = 120;

export const TONE_STYLES = [
  { key: 'luxun', labelKey: 'tone.style.luxun' },
  { key: 'worker', labelKey: 'tone.style.worker' },
  { key: 'xiaohongshu', labelKey: 'tone.style.xiaohongshu' },
  { key: 'yinyang', labelKey: 'tone.style.yinyang' },
  { key: 'formal', labelKey: 'tone.style.formal' },
  { key: 'plain', labelKey: 'tone.style.plain' }
];

export const WRITING_LENGTHS = [
  { key: 'short', labelKey: 'writing.length_short' },
  { key: 'medium', labelKey: 'writing.length_medium' },
  { key: 'long', labelKey: 'writing.length_long' }
];
export const WRITING_TONES = [
  { key: 'neutral', labelKey: 'writing.tone_neutral' },
  { key: 'light', labelKey: 'writing.tone_light' },
  { key: 'professional', labelKey: 'writing.tone_professional' }
];
export const WRITING_LANGS = [
  { key: 'zh', labelKey: 'writing.lang_zh' },
  { key: 'en', labelKey: 'writing.lang_en' }
];

export const SUMMARY_LEVELS = [
  { key: 'detailed', labelKey: 'summary.detailed' },
  { key: 'brief', labelKey: 'summary.brief' },
  { key: 'conclusion', labelKey: 'summary.conclusion' }
];

export const TTS_RATES = [0.75, 1, 1.25];

// Tracking / privacy scan known patterns (subset)
export const TRACKER_PATTERNS = [
  { name: 'Google Analytics', patterns: ['google-analytics.com', 'googletagmanager.com', 'gtag'] },
  { name: 'Facebook Pixel', patterns: ['facebook.com/tr', 'connect.facebook.net'] },
  { name: 'Twitter/X', patterns: ['twitter.com/i/ads', 'static.ads-twitter.com'] },
  { name: 'LinkedIn Insight', patterns: ['licdn.com', 'linkedin.com/tracking'] },
  { name: 'Baidu Tongji', patterns: ['hm.baidu.com', 'baidu.com/hm.js'] },
  { name: 'Hotjar', patterns: ['hotjar.com'] }
];
