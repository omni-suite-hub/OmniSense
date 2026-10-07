/**
 * How one captured page becomes rows in the `capsule` store, and how those rows
 * are folded back into pages for display.
 *
 * Deliberately PURE: no DOM, no `chrome.*`, no i18n. That is what lets
 * `e2e/selftest-capsule.cjs` import this exact file and exercise the rules the
 * inference host actually runs, on a machine with no browser and no model. The
 * same reasoning as shared/speech.js, and for the same reason: the previous
 * round's product bug was caught by a browserless unit test and NOT by an E2E
 * suite that was fully green (TEST_REPORT.md §5.8 / T8).
 *
 * ---------------------------------------------------------------------------
 * The defect this module was written to fix, measured before it was written.
 *
 * `capturePage` split the article with `text.split(/\s+/)` and grouped the result
 * into blocks of 128 "words". For Latin text that is fine. For Chinese it is
 * catastrophic, because Chinese does not put spaces between words: the only `\s`
 * in a Chinese article are its paragraph breaks, so `words` ends up holding one
 * entry per PARAGRAPH and the whole article lands in a single chunk.
 *
 *   Chinese article, 2059 characters, 30 paragraphs
 *     → 30 "words" → 1 chunk of 2030 characters
 *   English article, 3979 characters, 30 paragraphs
 *     → 720 words  → 6 chunks of ~700 characters
 *
 * The embedder is all-MiniLM-L6-v2, whose window is 512 tokens — for Chinese
 * roughly 512 characters. So that single chunk was TRUNCATED: only the first
 * ~25 % of every Chinese article was ever embedded, the other ~75 % was not in
 * the index at all, and nothing in the UI could reveal it. The chunk count still
 * looked plausible ("4 段记忆") and the stored snippet was, by construction,
 * `chunk.slice(0, 240)` — i.e. always the article's opening lines, which is
 * exactly what a user sees when they search for something the article said later
 * on and get 「找不到相关内容」 back.
 *
 * ---------------------------------------------------------------------------
 * The rule, therefore, is a character budget for CJK and a word budget for Latin.
 *
 * The splitter is `splitForSpeech` from shared/speech.js rather than a second
 * implementation. Both problems are "cut text at a boundary the consumer respects
 * without exceeding a budget", and a copy here would drift from the original the
 * first time either budget moved — which is the class of bug TEST_REPORT.md §5.8
 * records. The budget is passed in explicitly, so moving the TTS window later
 * cannot silently move this one.
 *
 * Note on CJK in this file: none. `e2e/check-i18n.cjs` rule 6 fails the build on
 * hard-coded CJK outside the i18n mechanism; comments are exempt, code is not.
 */
import { splitForSpeech, dominantScript } from './speech.js';

/**
 * Character ceiling for one chunk of CJK text.
 *
 * Bounded above by the embedder: the window is 512 tokens and a Han character is
 * about one token, so 400 leaves a margin for the two special tokens and for the
 * occasional multi-character token. Bounded below by usefulness — a chunk is the
 * unit of retrieval, so very small chunks lose the context that makes a match
 * meaningful. `splitForSpeech` will not cut before `max(60, 400/2) = 200`
 * characters unless the text itself forces it, so real chunks land in 200–400.
 */
export const EMBED_MAX_CHARS_CJK = 400;

/** How many whitespace-separated words go into one chunk of non-CJK text. */
export const EMBED_WORDS_PER_CHUNK = 128;

/**
 * Character ceiling for one chunk of non-CJK text.
 *
 * The word budget above already produces ~700 characters for ordinary prose
 * (~175 tokens), but a "word" is not bounded: a pasted base64 blob, a very long
 * URL, or a run of text with no spaces at all arrives as one enormous token. A
 * word-count budget says nothing about those, so anything that comes out longer
 * than this is re-split by the character rule instead.
 */
export const EMBED_MAX_CHARS_LATIN = 1600;

/**
 * How many chunks of a single page are embedded.
 *
 * A cap rather than "all of it", because every chunk costs one embedder call at
 * capture time and one cosine comparison per query afterwards. 20 chunks is
 * 20 × 128 words ≈ 2560 words ≈ a long magazine feature; beyond that the marginal
 * chunk adds storage and query cost without making the page easier to find.
 */
export const CAPSULE_MAX_CHUNKS = 20;

/**
 * Cut `text` into pieces that each fit inside the embedder's window.
 *
 * Returns an array of strings; the concatenation covers the whole input (the
 * whitespace normalisation inside `splitForSpeech` may collapse runs of blank
 * lines, which changes no meaning and is asserted in the unit selftest).
 */
export function chunkForEmbedding(text, limit = CAPSULE_MAX_CHUNKS) {
  const s = String(text || '');
  if (!s.trim()) return [];

  let parts;
  if (dominantScript(s) === 'han') {
    parts = splitForSpeech(s, EMBED_MAX_CHARS_CJK).chunks.map(c => c.text);
  } else {
    const words = s.split(/\s+/).filter(Boolean);
    parts = [];
    for (let i = 0; i < words.length; i += EMBED_WORDS_PER_CHUNK) {
      parts.push(words.slice(i, i + EMBED_WORDS_PER_CHUNK).join(' '));
    }
    // See EMBED_MAX_CHARS_LATIN: a word-count budget does not bound the length.
    const bounded = [];
    for (const p of parts) {
      if (p.length <= EMBED_MAX_CHARS_LATIN) bounded.push(p);
      else bounded.push(...splitForSpeech(p, EMBED_MAX_CHARS_LATIN).chunks.map(c => c.text));
    }
    parts = bounded;
  }

  return parts.filter(p => p.trim()).slice(0, Math.max(1, limit));
}

/**
 * The identity of a captured PAGE.
 *
 * The URL, and nothing else.
 *
 * This used to be `url + visitTime`, on the reasoning that re-saving a page should
 * show up as a second, newer entry rather than silently overwriting the older
 * text. That reasoning was wrong in practice: capturing the same article twice
 * (which is what a user does when they are not sure the first one worked) put two
 * identical rows in the list — same title, same domain, same snippet, one
 * "5 小时前" and one "刚刚" — and the reported reaction was "收录的时候，去重吧".
 *
 * A page is one thing. Re-capturing replaces it; the newest text wins. Anything
 * derived from `visitTime` (ordering, "最近收录", retention) still uses the
 * timestamp of that one surviving capture.
 */
export function pageKey(row) {
  return String((row && row.url) || '');
}

/**
 * Fold chunk rows back into one entry per page.
 *
 * Two callers need this and both need it for the same reason: rows in `capsule`
 * are chunks, so an article embedded as six chunks would otherwise be shown as six
 * nearly-identical results. `offscreen.js` claimed in a comment that "search
 * results can be de-duplicated by url" — nothing anywhere did it.
 *
 * A page can still legitimately have several rows from different captures (a
 * profile upgraded from the schema that allowed it, or a passive capture racing a
 * manual one). Only the NEWEST capture's rows are reported: its chunk count, its
 * `visitTime`, and its snippet. Older copies are not merged into the result
 * because `supersededRowIds` is about to have them deleted anyway, and reporting a
 * chunk count that no surviving row accounts for would be worse than understating
 * it.
 *
 * It also strips the 384-float `vector` off every row. That matters: these objects
 * are returned across the extension message port, and shipping every embedding in
 * the store to the side panel to render one line of text per page is both slow and
 * pointless.
 */
export function groupByPage(rows) {
  const byUrl = new Map();
  for (const r of rows || []) {
    const key = pageKey(r);
    let page = byUrl.get(key);
    if (!page) {
      page = {
        key,
        url: (r && r.url) || '',
        title: (r && r.title) || '',
        domain: (r && r.domain) || '',
        visitTime: 0,
        chunks: 0,
        snippet: '',
        score: -1
      };
      byUrl.set(key, page);
    }
    const stamp = (r && r.visitTime) || 0;
    if (stamp > page.visitTime) {
      // A newer capture of the same page: it replaces everything reported so far.
      page.visitTime = stamp;
      page.chunks = 0;
      page.snippet = '';
      page.score = -1;
      page.title = (r && r.title) || page.title;
    }
    if (stamp !== page.visitTime) continue;
    page.chunks++;
    if (!page.title && r.title) page.title = r.title;
    if (!page.domain && r.domain) page.domain = r.domain;
    const score = typeof r.score === 'number' ? r.score : -1;
    if (score > page.score) {
      page.score = score;
      page.snippet = r.snippet || page.snippet;
    } else if (!page.snippet) {
      page.snippet = r.snippet || '';
    }
  }
  return [...byUrl.values()].sort((a, b) => (b.score - a.score) || (b.visitTime - a.visitTime));
}

/**
 * Ids of rows that a newer capture of the same page has replaced.
 *
 * The counterpart of `pageKey`: since a page is identified by its URL, any row of
 * that URL which is not part of the newest capture is stale. Two callers use this
 * to physically clean up rather than carrying the old copies forever — the
 * listing (which already reads every row, so the decision is free) and capture
 * itself.
 *
 * Kept separate from `groupByPage` so each stays a single-purpose function the
 * unit selftest can pin down on its own.
 */
export function supersededRowIds(rows) {
  const newest = new Map();
  for (const r of rows || []) {
    const key = pageKey(r);
    const stamp = (r && r.visitTime) || 0;
    if (!newest.has(key) || stamp > newest.get(key)) newest.set(key, stamp);
  }
  const doomed = [];
  for (const r of rows || []) {
    if (!r || !r.id) continue;
    if (((r && r.visitTime) || 0) !== newest.get(pageKey(r))) doomed.push(r.id);
  }
  return doomed;
}
