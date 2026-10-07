/**
 * Text preparation and voice selection for 听网页 (Web Speech API).
 *
 * Deliberately PURE: no DOM, no `speechSynthesis`, no i18n calls. That is what
 * lets the E2E harness `import` this exact file and exercise the same code the
 * panel runs, instead of reimplementing it next to the test. The project has
 * already been burned by a harness that re-guessed a unit the product owned
 * (TEST_REPORT.md §5.8 / T8) — the fix for that class of bug is this one.
 *
 * Two concerns live here because they are both "decide what to hand the engine":
 *
 *   1. `splitForSpeech` — one long utterance is not one smooth read-out. See the
 *      measurement notes below.
 *   2. `pickVoice` — which installed system voice may read this text at all.
 *
 * Note on CJK characters in this file: none. Sentence punctuation and script
 * boundaries are expressed as code points, because `e2e/check-i18n.cjs` rule 6
 * fails the build on hard-coded CJK in JS source.
 */

/**
 * Hard ceiling on a single utterance, in characters.
 *
 * Not an arbitrary number: Chrome's speech engine does not stream an arbitrarily
 * long utterance smoothly — it SEGMENTS it, and every segment boundary is a
 * silence. Measured reproducibly by `e2e/diag-voice-audio.cjs` (`say` +
 * `ffmpeg silencedetect`), one voice at a time, punctuation-free Chinese so that
 * every detected silence is the engine's own and not a comma:
 *
 *   voice       60 ch        120 ch      250 ch          500 ch          1000 ch
 *   Tingting    0 breaks     0 breaks    0 breaks        1 × 0.21 s      3 × 0.21 s (0.64 s)
 *   Eddy        1 × 0.50 s   0 breaks    1 × 0.57 s      3 × 0.51-0.57 s 5 × 0.51-0.57 s (2.62 s)
 *
 * Two conclusions follow, and both drive the value:
 *
 *  1. The break interval is a fixed AUDIO duration, not a character count:
 *     Tingting segments every ~56.5 s, Eddy every ~27.6 s. Over 1000 characters
 *     that is 0.64 s of dead air with the dedicated voice and 2.62 s with the
 *     persona — a 4× difference, which is the 「断断续续」 being removed.
 *  2. 120 characters is the largest value at which BOTH families rendered zero
 *     engine-inserted silences (Eddy: fine at 120, one break at 250). Staying
 *     under the engines' own interval means the engine never has to insert a
 *     break, and the only silences left are at sentence ends, where a pause is
 *     what the listener expects anyway.
 *
 * Bounded from below by seam cost: every `speak()` has a scheduling cost, so
 * chunks that are too short make the SEAMS the new choppiness. That cost could
 * not be measured here (no audio device in the harness — see the §3 note in
 * `e2e/diag-tts-smooth.cjs`) and is the one number that still needs a real
 * machine's ear.
 */
export const SPEECH_CHUNK_MAX_CHARS = 120;

/** Never cut sooner than this unless the text itself forces it. */
export const SPEECH_CHUNK_MIN_CHARS = 60;

/**
 * Code points that end a sentence. A chunk boundary here is inaudible.
 * 0x0a is a paragraph break, which the engine already renders as a pause.
 */
const STRONG_END = new Set([
  0x0a,                                             // newline
  0x21, 0x2e, 0x3b, 0x3f,                           // ! . ; ?
  0x2026, 0x3002, 0xff01, 0xff1b, 0xff1f            // … 。 ！ ； ？
]);

/**
 * Code points that end a clause or separate words: a worse place to break, but
 * infinitely better than cutting a word in half.
 */
const WEAK_END = new Set([
  0x09, 0x20,                                       // tab, space
  0x2c, 0x3a,                                       // , :
  0x3001, 0xff0c, 0xff0e, 0xff1a                    // 、 ， ． ：
]);

/**
 * Collapse the whitespace that a readability extraction leaves behind.
 *
 * The raw text is full of `\n\n  \n  \n` runs. They are harmless to `trim()`,
 * but they make every length-based decision (chunk sizes, progress, "is this
 * text the same as that text") depend on extraction artefacts rather than on
 * what is actually being read.
 */
export function normalizeForSpeech(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0\u2000-\u200b]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Is there a sentence end at index `i`?
 *
 * ASCII '.' needs a guard: "127.0.0.1", "v1.2" and "e.g." all contain a full
 * stop that is not the end of anything. A '.' counts only when what follows (if
 * anything) does not continue the current word.
 */
function strongEndAt(s, i) {
  const c = s.charCodeAt(i);
  if (!STRONG_END.has(c)) return false;
  if (c !== 0x2e) return true;
  for (let j = i + 1; j < s.length; j++) {
    const n = s.charCodeAt(j);
    if (n === 0x20 || n === 0x09) continue;          // skip the space after '.'
    if ((n >= 0x30 && n <= 0x39) || (n >= 0x61 && n <= 0x7a)) return false;
    return true;
  }
  return true;                                       // end of text
}

/** Where to cut, searching backwards from `end`. */
function boundaryNear(s, start, end, maxChars) {
  // If maxChars <= SPEECH_CHUNK_MAX_CHARS (speech TTS mode), paragraph breaks (\n)
  // are the strongest natural boundary so distinct headings/items remain discrete utterances.
  if (maxChars <= SPEECH_CHUNK_MAX_CHARS) {
    const nl = s.indexOf('\n', start);
    if (nl !== -1 && nl < end) {
      let nextPos = nl + 1;
      while (nextPos < end && s.charCodeAt(nextPos) === 0x0a) nextPos++;
      return nextPos;
    }
  }

  // Prefer a real sentence end in the second half of the window, so chunks stay
  // reasonably long instead of collapsing to the first comma. The floor is
  // SPEECH_CHUNK_MIN_CHARS rather than a bare `maxChars / 2` so that the rule the
  // doc comment states is the rule the code runs — for the shipped 120-char window
  // the two happen to agree, which is exactly how a doc and its code drift apart.
  const floor = Math.min(start + Math.max(SPEECH_CHUNK_MIN_CHARS, Math.floor(maxChars / 2)), end - 1);
  for (let i = end - 1; i >= floor; i--) if (strongEndAt(s, i)) return i + 1;
  for (let i = end - 1; i >= floor; i--) if (WEAK_END.has(s.charCodeAt(i))) return i + 1;
  // Nothing nice in the second half. Widen to the whole window rather than
  // splitting a word: a shorter chunk costs a slightly longer pause, a split
  // word costs a mispronunciation.
  for (let i = end - 1; i > start; i--) if (WEAK_END.has(s.charCodeAt(i))) return i + 1;
  return end;
}

/**
 * Split text into utterances that can be queued back to back.
 *
 * Returns `{ normalized, chunks }` where every chunk carries `start`/`end`
 * offsets into `normalized`. The concatenation invariant
 * `chunks.map(c => c.text).join('') === normalized` always holds — the E2E
 * asserts exactly that, because it is what turns "it read something" into
 * "it read the whole thing, once".
 */
export function splitForSpeech(text, maxChars = SPEECH_CHUNK_MAX_CHARS) {
  const normalized = normalizeForSpeech(text);
  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    const cut = boundaryNear(normalized, start, end, maxChars);
    if (cut > start && cut < end) {
      end = cut;
    }
    // A whitespace-only slice would be an utterance that makes a silent pause and
    // reports no progress. Only reachable on pathological input (180+ spaces in a
    // row), but the fix is two lines and keeps the concatenation invariant.
    if (!normalized.slice(start, end).trim() && end < normalized.length) {
      let j = end;
      while (j < normalized.length && /\s/.test(normalized[j])) j++;
      end = Math.min(normalized.length, j + 1);
    }
    chunks.push({ text: normalized.slice(start, end), start, end });
    start = end;
  }
  return { normalized, chunks };
}

/**
 * Which writing system is this text actually in?
 *
 * Was measured, not assumed: this machine exposes 199 voices, 21 of them `zh`,
 * so the previous hard-coded `startsWith('zh')` lookup ALWAYS found one and
 * always attached a Chinese voice — to English text too. That is the
 * 「口齿还不清晰」 in the user's report.
 *
 * Codepoint scan rather than a CJK regex literal (see the file header).
 */
export function dominantScript(text) {
  let han = 0, latin = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // CJK Unified Ideographs + Extension A, plus the CJK punctuation block.
    if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f)) han++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  if (han === 0) return 'latin';
  // A Han character carries a whole syllable/word; a Latin character does not.
  // Weighing 1 Han ≈ 5 Latin letters keeps "在 Chrome 里用 MV3" on the Han side.
  return han * 5 >= latin ? 'han' : 'latin';
}

export const VOICE_LANG_PREFIX = { han: 'zh', latin: 'en' };
export const VOICE_PREFERRED_TAGS = { han: ['zh-cn', 'zh-hans', 'zh'], latin: ['en-us', 'en-gb', 'en'] };
/** Language prefixes whose voices may never read non-CJK text, and vice versa. */
export const CJK_LANGS = new Set(['zh', 'ja', 'ko', 'yue', 'wuu', 'cmn']);

/**
 * Language names rendered inside `listen.no_voice`.
 *
 * Reached through a table carrying `labelKey`, not a ternary inline in `t()`,
 * because that is how `e2e/check-i18n.cjs` discovers indirectly-referenced keys.
 * Written inline they would be reported as unused and could be deleted as dead
 * weight while still being rendered.
 */
export const VOICE_LANG_LABEL = {
  han: { labelKey: 'listen.lang_zh' },
  latin: { labelKey: 'listen.lang_en' }
};

export function voiceTag(v) {
  return String((v && v.lang) || '').toLowerCase().replace(/_/g, '-');
}

/**
 * The voice's base name, with any trailing locale suffix removed.
 *
 * Chrome renders a macOS voice as `Eddy (Chinese (China mainland))` and the same
 * voice for another language as `Eddy (Chinese (Taiwan))` — the parenthetical is
 * a *translation* of the locale, so grouping by the bare name is what reveals
 * that one voice is mounted for many locales.
 */
export function voiceBaseName(v) {
  // The locale suffix can itself contain parentheses — Chrome renders the same
  // macOS voice as `Eddy (Chinese (China mainland))` — so a flat `\([^)]*\)$`
  // does not match it, every voice ends up looking single-locale, and the
  // "dedicated voice" tier silently stops discriminating. One level of nesting
  // is all Chrome produces.
  return String((v && v.name) || '')
    .replace(/\s*\((?:[^()]|\([^()]*\))*\)\s*$/, '')
    .trim();
}

/**
 * How many locales each voice name is mounted for.
 *
 * This is the piece of evidence that needs no hand-written list: a voice mounted
 * for exactly one locale is that locale's DEDICATED voice, while a voice mounted
 * for dozens is a cross-language persona. Measured on this machine with
 * `say -v '?'` (which lists each persona once per language):
 *
 *   Tingting / Meijia / Sinji  → mounted for zh only          → dedicated
 *   Eddy / Flo / Reed / Rocko /
 *   Sandy / Shelley / Grandma / Grandpa → mounted for 14 locales → persona
 *
 * The distinction is not cosmetic. Rendering the same 110-character text through
 * both families (`say` + `ffmpeg silencedetect`, the same voices Chrome uses):
 *
 *   dedicated (Tingting/Meijia/Sinji): 24.8–25.2 s, 0.19–0.20 s of trailing silence
 *   persona   (Eddy/Flo/Rocko/...):    21.0 s,       0.50 s of trailing silence
 *
 * The personas speak ~16% faster and hold half a second of dead air at the end of
 * every utterance. Every one of those lands as an audible hiccup once the text is
 * chunked, which is the "断断续续" being fixed here.
 */
export function localeCounts(voices) {
  const counts = new Map();
  for (const v of voices || []) {
    const b = voiceBaseName(v);
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  return counts;
}

/**
 * Apple's novelty voices.
 *
 * These are not speech: they render the text through a musical/noise synth, so
 * how long they take has nothing to do with how long the text is. Measured with
 * `say`, one identical 117-character English sentence (normal median 7.29 s):
 *
 *   Good News 22.05 s ×3.02 · Bells 19.99 ×2.74 · Jester 18.98 ×2.60
 *   Bad News 15.65 ×2.14 · Organ 13.98 ×1.92 · Cellos 12.56 ×1.72
 *   Albert 9.32 ×1.28 · Bahh 9.32 ×1.28      ← Albert is what the shipped ranking picked
 *
 * Eight of the names below were confirmed as duration outliers by that
 * measurement, and no voice outside this list was an outlier. The rest of the
 * list is Apple's documented novelty set, kept because a voice does not have to
 * be slow to be a joke — `Fred`, `Kathy`, `Ralph` and `Junior` pace like speech
 * and would win an otherwise-arbitrary tie.
 *
 * The ranking used to fall through to "first voice in the order the engine
 * returned", and on this machine the first `en-US` voice in that order is
 * `Albert` — so every English page was read by a novelty voice. That is the
 * 「口齿还不清晰」 half of the user's report, and the reason the list is here.
 *
 * A penalty rather than a hard filter: if a machine genuinely has nothing else,
 * a novelty voice still beats not reading at all.
 */
export const NOVELTY_VOICES = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged',
  'fred', 'good news', 'hysterical', 'jester', 'junior', 'kathy', 'organ',
  'pipe organ', 'princess', 'ralph', 'superstar', 'trinoids', 'whisper',
  'wobble', 'zarvox'
]);

export function isNoveltyVoice(v) {
  return NOVELTY_VOICES.has(voiceBaseName(v).toLowerCase());
}

/**
 * Rank the eligible voices, best first, with the reason attached.
 *
 * Exported because the ranking has to be AUDITABLE: `e2e/diag-tts-smooth.cjs`
 * prints the winner and the margin of the runner-up, so a future change that
 * silently starts preferring a novelty voice shows up as a diff in that output
 * rather than only as a bad-sounding read-out.
 *
 * Tiers, highest first — each one is a fact the panel can read off the voice
 * list, not a guess:
 *
 *   1. `default`      the voice the system/user actually configured. This is the
 *                     only signal that reliably lands on a proper voice, and it
 *                     respects an explicit user choice even when that choice is
 *                     unusual, so nothing outranks it.
 *   2. dedicated      mounted for a single locale (`localeCounts`), i.e. the
 *                     locale's own voice rather than a cross-language persona.
 *                     This is what rescues Chinese, where no voice is `default`.
 *   3. not novelty    — see NOVELTY_VOICES.
 *   4. preferred tag  `en-US` over an unlisted `en-NZ`, etc.
 *   5. localService   a network-only voice goes silent with the connection.
 */
export function rankVoices(voices, script) {
  const want = VOICE_LANG_PREFIX[script];
  let eligible = (voices || []).filter(v => voiceTag(v).split('-')[0] === want);
  if (!eligible.length && script === 'latin') {
    eligible = (voices || []).filter(v => !CJK_LANGS.has(voiceTag(v).split('-')[0]));
  }
  if (!eligible.length) return [];

  const counts = localeCounts(voices);
  const prefs = VOICE_PREFERRED_TAGS[script];
  return eligible.map(v => {
    const tag = voiceTag(v);
    const dedicated = (counts.get(voiceBaseName(v)) || 0) === 1;
    const novelty = isNoveltyVoice(v);
    const at = prefs.indexOf(tag);
    const score =
      (v.default ? 1 : 0) * 1e6 +
      (dedicated ? 1 : 0) * 1e5 +
      (novelty ? 0 : 1) * 1e4 +
      (at >= 0 ? (prefs.length - at) * 10 : 0) +
      (v.localService ? 2 : 0);
    const why = [
      v.default ? 'default' : '',
      dedicated ? 'dedicated' : 'persona',
      novelty ? 'NOVELTY' : '',
      at >= 0 ? `tag:${tag}` : tag,
      v.localService ? 'local' : 'NETWORK'
    ].filter(Boolean).join(' ');
    return { voice: v, score, why };
  }).sort((a, b) => b.score - a.score);
}

/**
 * A voice that really speaks the text's language — or nothing at all.
 *
 * Returning `null` is deliberate: reading Chinese with an English voice, or the
 * reverse, is worse than not reading it. The caller turns `null` into an explicit
 * "no such voice is installed" message instead of falling back to a wrong-language
 * voice.
 *
 * The one concession is *within* a writing system: English text may fall back to
 * any non-CJK voice, because a French page read by an English voice is
 * mispronounced but still intelligible, and refusing outright would strand anyone
 * whose system ships no `en` voice. Crossing writing systems — which is what the
 * reported defect was — is never allowed.
 */
export function pickVoice(voices, script) {
  const ranked = rankVoices(voices, script);
  return ranked.length ? ranked[0].voice : null;
}
