/*
 * Token budgeting for the local models.
 *
 * Why this file exists
 * --------------------
 * The previous prompt builder capped long inputs by CHARACTER COUNT
 * (`article.substring(0, 10000)`), which is not a token budget and does not even
 * correlate with one across scripts. Roughly 10 000 Chinese characters is on the
 * order of 10 000 tokens; the shipped Qwen2.5-3B MLC build declares a 4096-token
 * context window, so the request was rejected before a single token was
 * generated:
 *
 *   Prompt tokens exceed context window size:
 *     number of prompt tokens: 4338; context window size: 4096
 *
 * The user saw that raw string in the 文章总结 result box. Nothing was wrong
 * with the model, the article reader or the message plumbing — the prompt simply
 * did not fit, and nothing anywhere in the chain had ever asked whether it would.
 *
 * Everything here is deliberately dependency-free and pure so the service
 * worker, the offscreen host and the E2E harnesses can all share one definition
 * of "does this fit".
 */

/**
 * Context windows of the prebuilt MLC weight sets we ship or test against.
 *
 * These are NOT the model families' theoretical maxima (Qwen2.5-3B supports 32k
 * in principle). A WebLLM prebuilt config pins `context_window_size` explicitly,
 * and that pinned value is what the runtime enforces. The 4096 below is measured,
 * not assumed — it is the number quoted back in the overflow error above.
 *
 * If you add a model, put its real pinned window here. Getting it wrong is not
 * fatal (see `runChat`'s reactive shrink), but the pre-emptive budget will be
 * wrong in one direction or the other.
 */
export const MODEL_CONTEXT_WINDOWS = {
  'Qwen2.5-3B-Instruct-q4f16_1-MLC': 4096,
  'Qwen2.5-7B-Instruct-q4f16_1-MLC': 4096,
  'SmolLM2-360M-Instruct-q4f16_1-MLC': 2048
};

/** Used when the loaded model is not in the table. The smallest shipped window. */
export const DEFAULT_CONTEXT_WINDOW = 4096;

/**
 * Headroom for the chat template's own tokens.
 *
 * WebLLM renders `<|im_start|>role\n … <|im_end|>\n` around every message and
 * appends the assistant priming. Those tokens count against the window but are
 * invisible to us. 64 is comfortably above what any of the shipped templates
 * costs for a two-message conversation.
 */
export const CHAT_TEMPLATE_MARGIN = 64;

/**
 * Never ask for less than this much output.
 *
 * Below roughly this size the model tends to emit a truncated fragment, which is
 * a worse user experience than a slightly over-long prompt.
 */
export const MIN_COMPLETION_TOKENS = 128;

/**
 * Token cost of one ASCII byte and one non-ASCII character.
 *
 * The estimates are deliberately CONSERVATIVE (they over-count), because
 * over-counting costs a little extra chunking while under-counting reproduces
 * the exact bug this file was written to fix.
 *
 *   ASCII  BPE merges whole English words; ~4 chars/token in practice, we charge
 *          3 to leave room for punctuation, code and URLs, which tokenise worse.
 *   CJK    Chinese/Japanese/Korean characters tokenise at roughly 0.6–1.1 tokens
 *          each depending on how common the word is. We charge a flat 1.0.
 *
 * These are heuristics, not a tokenizer. `isContextOverflowError` plus the
 * shrink-and-retry loop in the inference host exist precisely so that being
 * wrong here is a performance question, never a correctness one.
 */
export const ASCII_TOKENS_PER_CHAR = 1 / 3;
export const WIDE_TOKENS_PER_CHAR = 1;

/** The context window for a loaded model id, with a safe fallback. */
export function contextWindowFor(modelId) {
  return MODEL_CONTEXT_WINDOWS[modelId] || DEFAULT_CONTEXT_WINDOW;
}

/**
 * Approximate the token count of a string.
 *
 * Single pass, arithmetic only — it is called on every keystroke-sized input and
 * on multi-hundred-kilobyte articles, so it must stay cheap.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : String(text);
  let ascii = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 128) ascii++;
  }
  const wide = s.length - ascii;
  return Math.ceil(ascii * ASCII_TOKENS_PER_CHAR + wide * WIDE_TOKENS_PER_CHAR);
}

/** Prompt cost of a message array, including roles and template overhead. */
export function tokensForMessages(messages) {
  let n = CHAT_TEMPLATE_MARGIN;
  for (const m of messages || []) n += estimateTokens(m && m.content) + 4;
  return n;
}

/**
 * The longest prefix of `text` that fits in `budgetTokens`.
 *
 * Cuts from the END, which matters: every caller puts its instruction first and
 * the unbounded body last, so the instruction always survives.
 */
export function truncateToTokens(text, budgetTokens) {
  if (!text) return '';
  const s = typeof text === 'string' ? text : String(text);
  if (budgetTokens <= 0) return '';
  let used = 0;
  for (let i = 0; i < s.length; i++) {
    used += s.charCodeAt(i) < 128 ? ASCII_TOKENS_PER_CHAR : WIDE_TOKENS_PER_CHAR;
    if (used > budgetTokens) return s.slice(0, i);
  }
  return s;
}

/**
 * The longest SUFFIX of `text` that fits in `budgetTokens`.
 *
 * Needed by the writing continuation: "继续写下去" has to see the most recent
 * text, so keeping the head — which is what `truncateToTokens` does — would hand
 * the model the opening of the draft instead of where the pen currently is.
 */
export function truncateToTokensFromEnd(text, budgetTokens) {
  if (!text) return '';
  const s = typeof text === 'string' ? text : String(text);
  if (budgetTokens <= 0) return '';
  let used = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    used += s.charCodeAt(i) < 128 ? ASCII_TOKENS_PER_CHAR : WIDE_TOKENS_PER_CHAR;
    if (used > budgetTokens) return s.slice(i + 1);
  }
  return s;
}

/**
 * Split `text` into pieces that each fit in `budgetTokens`.
 *
 * Paragraph boundaries are preferred so a chunk does not end mid-sentence, which
 * both reads better in the intermediate summary and produces a cleaner result
 * from the model. A single paragraph larger than the budget is hard-split by
 * character.
 */
export function splitByTokens(text, budgetTokens) {
  if (!text) return [];
  const s = typeof text === 'string' ? text : String(text);
  if (estimateTokens(s) <= budgetTokens) return [s];

  const parts = [];
  let buf = '';
  const flush = () => { if (buf.trim()) parts.push(buf.trim()); buf = ''; };

  for (const para of s.split(/\n{2,}/)) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (estimateTokens(candidate) <= budgetTokens) { buf = candidate; continue; }
    flush();
    if (estimateTokens(para) <= budgetTokens) { buf = para; continue; }
    // One paragraph bigger than the whole budget: walk it in character steps.
    // The `piece.length === 0` guard is what stops a pathological budget from
    // looping forever or silently dropping text.
    let i = 0;
    while (i < para.length) {
      const piece = truncateToTokens(para.slice(i), budgetTokens);
      if (!piece) { parts.push(para[i]); i += 1; continue; }
      parts.push(piece);
      i += piece.length;
    }
  }
  flush();
  return parts;
}

/**
 * Recognise the runtime's "this prompt does not fit" rejection.
 *
 * Matched loosely on purpose: WebLLM's wording has changed between versions
 * ("Prompt tokens exceed context window size", "context window size", "exceeds
 * the context length"). The cost of a false positive is one wasted retry with a
 * smaller body; the cost of a false negative is the bug this file fixes.
 */
export function isContextOverflowError(err) {
  const msg = String((err && err.message) || err || '');
  return /context window|context length|exceed[^\n]*\bcontext\b|too many tokens|maximum context/i.test(msg);
}

/**
 * Pull the runtime's own prompt-token count out of an overflow message.
 * Returns 0 when it is not quoted, so callers can fall back to halving.
 */
export function reportedPromptTokens(err) {
  const msg = String((err && err.message) || err || '');
  const m = msg.match(/(?:prompt tokens|input tokens|number of tokens)\s*[:=]?\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}
