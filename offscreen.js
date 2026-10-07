import { MLCEngine } from './vendor/web-llm/web-llm.js';
import { MSG_TYPES, MODELS, DEFAULT_MODEL_KEY } from './shared/constants.js';
import { idbPut, idbGetAll, idbDeleteByIndex } from './shared/idb.js';
// Chunking rules for the capsule, kept in a pure module so the browserless unit
// selftest exercises the same code this host runs. See that file's header for the
// measured defect it exists to fix: a Chinese article used to be indexed as ONE
// truncated chunk, i.e. only its first quarter was ever searchable.
import { chunkForEmbedding, CAPSULE_MAX_CHUNKS } from './shared/capsule-chunk.js';
// Token budgeting lives in one shared module so the host, the service worker and
// the E2E harnesses all agree on what "fits". See the header of that file for the
// user-visible bug it was written to fix.
import {
  contextWindowFor, estimateTokens, tokensForMessages, truncateToTokens,
  truncateToTokensFromEnd, splitByTokens, isContextOverflowError,
  CHAT_TEMPLATE_MARGIN, MIN_COMPLETION_TOKENS
} from './shared/token-budget.js';
// NOTE: shared/settings.js is deliberately NOT imported here.
//
// An offscreen document cannot read chrome.storage: calling it throws
//   TypeError: Cannot read properties of undefined (reading 'local')
// That is not obvious from the API docs, and because the call sat inside the
// inference path it surfaced as
//   「出错了，请重试 / Cannot read properties of undefined (reading 'local')」
// in the result box — but ONLY when the model had not been pre-loaded, because
// a resident model short-circuits the settings read. That made tone/writing/
// summary look randomly broken. The service worker resolves every setting the
// host needs and attaches it to the message as `msg.settings`.

let engine = null;
// `loadedModelKey` is only set AFTER a load has been verified to have really
// happened. It is deliberately NOT set when a load merely *starts*: WebLLM's
// `reload()` begins with `unload()`, so a second load aborts the first one, and
// the aborted `reload()` swallows the AbortError and resolves normally. Trusting
// a pre-emptive flag therefore produced a "模型已就绪" badge with an empty
// pipeline behind it, which made every inference fail with ModelNotLoadedError.
let loadedModelKey = null;
// Single in-flight load. Concurrent callers join this promise instead of issuing
// a second `reload()` that would cancel the first.
let modelLoadPromise = null;
let pendingModelId = null;
let embedder = null;
let embedderPromise = null;
let embedderInitError = null;
const ports = new Set();

// Vendored, extension-local ONNX Runtime assets. transformers.js would otherwise
// point ORT at `https://cdn.jsdelivr.net/...`, which the MV3 extension CSP
// (`script-src 'self'`) blocks — that silently broke the whole embedding path.
const ORT_DIST = 'npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';

function broadcast(m) { ports.forEach(p => p.postMessage(m)); }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'omni-offscreen') return;
  ports.add(port);
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => ports.delete(port));
});

function handleMessage(msg, port) {
  switch (msg.type) {
    case MSG_TYPES.MODEL_LOAD:
      // ensureModel() broadcasts its own success/failure status.
      ensureModel(msg.modelKey, msg.modelId).catch(() => {});
      break;
    case MSG_TYPES.INFER_STREAM:
      runInference(msg, port).catch(e => {
        port.postMessage({ type: MSG_TYPES.INFER_ERROR, requestId: msg.requestId, error: e.message });
        port.postMessage({ type: MSG_TYPES.INFER_END, requestId: msg.requestId });
      });
      break;
    case MSG_TYPES.EMBEDDING:
      runEmbedding(msg, port).catch(e => port.postMessage({ type: MSG_TYPES.INFER_ERROR, requestId: msg.requestId, error: e.message }));
      break;
    case MSG_TYPES.CAPTURE_PAGE:
      // `requestId` is present only for the explicit user-initiated capture; the
      // passive content-script path omits it and stays fire-and-forget.
      capturePage(msg.data, port, msg.requestId);
      break;
    case MSG_TYPES.CAPSULE_QUERY:
      queryCapsule(msg.query, port, msg.requestId);
      break;
  }
}

// ---------------- WebLLM ----------------
async function getEngine() {
  if (engine) return engine;
  engine = new MLCEngine();
  engine.setInitProgressCallback((r) => {
    broadcast({ type: MSG_TYPES.MODEL_PROGRESS, status: 'downloading', progress: r.progress, text: r.text });
  });
  return engine;
}

/**
 * Confirm the engine really holds a usable pipeline.
 *
 * `getMessage()` routes through the engine's pipeline lookup, which throws
 * `ModelNotLoadedError` when the model map is empty — i.e. exactly the state a
 * silently-aborted `reload()` leaves behind.
 */
function assertModelLoaded(eng) {
  try {
    eng.getMessage();
  } catch (e) {
    throw new Error(`${(e && e.name) || 'Error'}: ${(e && e.message) || e}`);
  }
}

/**
 * WebLLM has no CPU fallback: without a real WebGPU adapter every model load
 * fails with an opaque stack trace. Probe for a usable adapter up front and
 * report a stable code the UI can turn into an explanation.
 */
async function hasWebGPU() {
  if (!navigator.gpu) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

/**
 * Load (or join an in-flight load of) the model.
 *
 * `modelId` wins over `modelKey` when present, which lets callers target a model
 * that is not in the shipped `MODELS` table (used by the E2E suite so it can run
 * against a small model instead of the 1.8 GB default).
 */
async function ensureModel(modelKey, modelId) {
  const cfg = MODELS[modelKey] || MODELS[DEFAULT_MODEL_KEY];
  const id = modelId || cfg.id;
  if (loadedModelKey === id && !modelLoadPromise) return;

  // Never *abort* an in-flight load: reload() starts with unload(), and the
  // aborted reload() resolves as if it had succeeded (see the note on
  // loadedModelKey). Join the running load instead, then load ours if it is a
  // different model.
  if (modelLoadPromise) {
    if (pendingModelId === id) return modelLoadPromise;
    return modelLoadPromise.catch(() => {}).then(() => ensureModel(modelKey, modelId));
  }

  pendingModelId = id;
  modelLoadPromise = (async () => {
    loadedModelKey = null;
    broadcast({ type: MSG_TYPES.MODEL_STATUS, status: 'downloading', progress: 0, text: `Loading ${id}` });
    try {
      if (!(await hasWebGPU())) throw new Error('NO_WEBGPU');
      const eng = await getEngine();
      await eng.reload(id);
      assertModelLoaded(eng);
      loadedModelKey = id;
      broadcast({ type: MSG_TYPES.MODEL_STATUS, status: 'ready', progress: 1, text: id });
    } catch (e) {
      loadedModelKey = null;
      broadcast({ type: MSG_TYPES.MODEL_STATUS, status: 'error', progress: 0, text: e.message });
      throw e;
    }
  })().finally(() => { modelLoadPromise = null; pendingModelId = null; });

  return modelLoadPromise;
}

/**
 * Settings carried by the incoming message (see the note on the imports).
 * Always read through this rather than from chrome.storage.
 */
function settingsFromMessage(msg) {
  return (msg && msg.settings) || {};
}

/**
 * Inference entry point: make sure a model is actually resident before asking
 * for a completion, then stream the chunks back on the requesting port.
 */
async function ensureReadyForInference(msg) {
  if (modelLoadPromise) return modelLoadPromise;   // a load is running — wait it out
  if (loadedModelKey) return;                      // already resident — nothing to do
  const preferred = settingsFromMessage(msg).modelKey || DEFAULT_MODEL_KEY;
  return ensureModel(preferred);
}

const SYSTEM_PROMPT =
  'You are a helpful local AI assistant running in the browser. Keep answers concise and honest.';

/**
 * Per-prompt generation budget, plus the payload field that can be arbitrarily
 * long and how to cope when it does not fit.
 *
 * `maxTokens` is a REQUEST, never a guarantee: `runChat` clamps it against the
 * loaded model's context window minus the prompt. The previous code hard-coded
 * 2048 for every prompt — including `roast`, which produces a single sentence —
 * and never subtracted it from the window at all.
 */
const PROMPT_SPEC = {
  tone:          { maxTokens: 1024, source: 'text',    longInput: 'head' },
  roast:         { maxTokens: 192,  source: 'text',    longInput: 'head' },
  writing_blank: { maxTokens: 1024, source: null,      longInput: 'head' },
  writing_ref:   { maxTokens: 1024, source: 'article', longInput: 'digest' },
  summary:       { maxTokens: 1024, source: 'article', longInput: 'merge' },
  podcast:       { maxTokens: 1024, source: 'article', longInput: 'concat' },
  ask:           { maxTokens: 1024, source: 'article', longInput: 'digest' },
  agreement:     { maxTokens: 1024, source: 'article', longInput: 'digest' },
  briefing:      { maxTokens: 1024, source: 'article', longInput: 'digest' },
  bias_advocate: { maxTokens: 1024, source: 'article', longInput: 'digest' },
  margin_notes:  { maxTokens: 768,  source: 'article', longInput: 'digest' },
  selection_act: { maxTokens: 512,  source: 'text',    longInput: 'head' }
};
const DEFAULT_SPEC = { maxTokens: 1024, source: null, longInput: 'head' };

/**
 * Output budget for one map-phase chunk. Short on purpose — a chunk call only
 * emits notes, and every token reserved here is a token the chunk cannot use.
 */
const CHUNK_MAX_TOKENS = 320;

/** Smallest chunk we will ever cut, so the splitter always makes progress. */
const MIN_CHUNK_SOURCE_TOKENS = 128;

/**
 * Hard ceiling on map-phase model calls for a single request.
 *
 * A 200 000-character article would otherwise fan out into ~50 sequential
 * generations — minutes of waiting with no way to interrupt. Beyond this the
 * tail is dropped and the user is told, which is bounded and honest. The
 * alternative (silently generating for ten minutes) is worse.
 */
const MAX_CHUNKS = 20;

/** Summary wording per level, replacing a level NAME with an actual instruction. */
const SUMMARY_CLAUSE = {
  detailed: '输出 5-8 条要点，每条 1-2 句，最后加一句以“一句话：”开头的总结',
  brief: '输出 3-5 条要点，每条一句，最后加一句以“一句话：”开头的总结',
  conclusion: '不要分点，只输出一段结论'
};

/**
 * Inference entry point.
 *
 * The chain is: make sure a model is resident → decide whether the prompt fits
 * the model's context window → either answer directly or take a long-input path.
 *
 * The previous version had no third step. It capped the article by CHARACTER
 * COUNT (`article.substring(0, 10000)`), which for Chinese is roughly a 1:1
 * token ratio and therefore ~10 000 tokens against a 4096-token window. WebLLM
 * rejected the request outright and the raw rejection —
 *   Prompt tokens exceed context window size: number of prompt tokens: 4338;
 *   context window size: 4096
 * — landed in the 文章总结 result box. The model, the reader and the messaging
 * were all fine; the prompt simply did not fit and nothing had ever checked.
 */
async function runInference(msg, port) {
  const { promptKey, payload, requestId } = msg;
  await ensureReadyForInference(msg);
  const eng = await getEngine();
  const ctx = contextWindowFor(loadedModelKey);
  port.postMessage({ type: MSG_TYPES.INFER_START, requestId });

  const spec = PROMPT_SPEC[promptKey] || DEFAULT_SPEC;
  const source = spec.source ? String((payload && payload[spec.source]) || '') : '';
  const singleShotBudget = sourceBudgetFor(promptKey, payload, spec, ctx);

  try {
    if (!spec.source || estimateTokens(source) <= singleShotBudget) {
      await runChat(eng, buildMessages(promptKey, payload), spec.maxTokens, ctx,
        { stream: true, port, requestId });
    } else {
      await runLongInput(eng, promptKey, payload, spec, source, singleShotBudget, ctx, port, requestId);
    }
  } catch (e) {
    // The caller (handleMessage) turns this into INFER_ERROR + INFER_END.
    throw e;
  }
  port.postMessage({ type: MSG_TYPES.INFER_END, requestId });
}

/**
 * How many tokens of the variable payload can ride along in ONE call, once the
 * completion we want, the system prompt, the instruction and the chat template
 * are paid for.
 *
 * `extra` lets a caller measure a variant of the prompt (e.g. the "these are the
 * notes" wording) instead of the plain one.
 */
function sourceBudgetFor(promptKey, payload, spec, ctx, extra) {
  const empty = { ...payload, ...extra, [spec.source || 'text']: '' };
  const fixed = tokensForMessages(buildMessages(promptKey, empty));
  // `fixed` already includes CHAT_TEMPLATE_MARGIN; do not subtract it twice.
  return Math.max(0, ctx - spec.maxTokens - fixed);
}

/** Which long-input strategy a prompt uses, accounting for per-call overrides. */
function strategyFor(promptKey, payload) {
  // Continuation is the one case where the END of the text is the relevant part:
  // the model needs to see where the draft stops, not how it started.
  if (promptKey === 'writing_ref' && payload && payload.continuation) return 'tail';
  const spec = PROMPT_SPEC[promptKey];
  return (spec && spec.longInput) || 'head';
}

/** Source budget for one map-phase chunk call. */
function chunkSourceBudget(kind, ctx) {
  const fixed = tokensForMessages(buildChunkMessages(kind, 1, 2, ''));
  return Math.max(MIN_CHUNK_SOURCE_TOKENS, ctx - CHUNK_MAX_TOKENS - fixed);
}

/**
 * Long-input paths, in increasing order of effort.
 *
 *   head   keep the beginning, drop the tail (tone, roast)
 *   tail   keep the end, drop the beginning (writing continuation)
 *   digest reduce to notes, then do the real task on the notes (writing_ref)
 *   merge  reduce to notes, then merge them into the answer (summary)
 *   concat rewrite each chunk and join them (podcast)
 *
 * Only `head`/`tail` lose information outright, and they say so through an
 * INFER_NOTICE. `digest`/`merge`/`concat` cover the whole input up to MAX_CHUNKS.
 */
async function runLongInput(eng, promptKey, payload, spec, source, singleShotBudget, ctx, port, requestId) {
  const strategy = strategyFor(promptKey, payload);

  if (strategy === 'head' || strategy === 'tail') {
    port.postMessage({
      type: MSG_TYPES.INFER_NOTICE, requestId,
      code: strategy === 'tail' ? 'truncated_tail' : 'truncated_head'
    });
    const body = strategy === 'tail'
      ? truncateToTokensFromEnd(source, singleShotBudget)
      : truncateToTokens(source, singleShotBudget);
    await runChat(eng, buildMessages(promptKey, { ...payload, [spec.source]: body }), spec.maxTokens, ctx,
      { stream: true, port, requestId });
    return;
  }

  const chunkKind = strategy === 'concat' ? 'podcast' : 'points';
  let parts = splitByTokens(source, chunkSourceBudget(chunkKind, ctx));
  let overCap = false;
  if (parts.length > MAX_CHUNKS) {
    parts = parts.slice(0, MAX_CHUNKS);
    overCap = true;
  }

  // Announce the strategy up front, and re-state it once the map phase is over:
  // the last per-chunk notice is a "3/3" progress counter, and leaving that on
  // screen after generation has moved on reads as "still working".
  const strategyCode = strategy === 'concat' ? 'podcast_chunked'
    : strategy === 'digest' ? 'writing_chunked' : 'summary_chunked';
  const announce = () => port.postMessage({
    type: MSG_TYPES.INFER_NOTICE, requestId, code: strategyCode
  });

  announce();

  if (strategy === 'concat') {
    // A script meant to be spoken has to run end to end, so rewrite fragment by
    // fragment and stream straight through. There is no merge step that could
    // improve it — and joining them preserves the article's own order.
    let first = true;
    for (let i = 0; i < parts.length; i++) {
      port.postMessage({ type: MSG_TYPES.INFER_NOTICE, requestId, code: 'chunk_progress', done: i + 1, total: parts.length });
      if (!first) port.postMessage({ type: MSG_TYPES.INFER_STREAM, requestId, text: '\n\n' });
      first = false;
      await runChat(eng, buildChunkMessages(chunkKind, i, parts.length, parts[i]), CHUNK_MAX_TOKENS, ctx,
        { stream: true, port, requestId });
    }
    announce();
    if (overCap) port.postMessage({ type: MSG_TYPES.INFER_NOTICE, requestId, code: 'truncated_head' });
    return;
  }

  // digest / merge: reduce the parts to notes first, then run the real prompt on
  // the notes instead of on the article.
  let digest = '';
  for (let i = 0; i < parts.length; i++) {
    port.postMessage({ type: MSG_TYPES.INFER_NOTICE, requestId, code: 'chunk_progress', done: i + 1, total: parts.length });
    const piece = await runChat(eng, buildChunkMessages(chunkKind, i, parts.length, parts[i]), CHUNK_MAX_TOKENS, ctx,
      { stream: false, temperature: 0.3 });
    if (piece.trim()) digest += (digest ? '\n\n' : '') + piece.trim();
  }
  // A small model can legitimately return nothing for a fragment. Falling back to
  // the raw text, cut to what the final prompt can hold, is strictly better than
  // refusing to answer — and it is precisely what the head-truncation path would
  // have produced anyway.
  if (!digest.trim()) {
    digest = truncateToTokens(source, sourceBudgetFor(promptKey, payload, spec, ctx, { digest: true }));
  }
  if (!digest.trim()) throw new Error('CONTEXT_EXCEEDED');

  // The notes can themselves be too long (many chunks → many notes), so reduce
  // again. Bounded to 3 rounds and it must actually get shorter, otherwise we
  // fall through to the final call, whose own budget logic still protects us.
  const digestBudget = sourceBudgetFor(promptKey, payload, spec, ctx, { digest: true });
  let guard = 0;
  while (estimateTokens(digest) > digestBudget && guard++ < 3) {
    const sub = splitByTokens(digest, chunkSourceBudget('points', ctx));
    let next = '';
    for (let i = 0; i < sub.length; i++) {
      const piece = sub[i];
      const r = await runChat(eng, buildChunkMessages('points', i, sub.length, piece), CHUNK_MAX_TOKENS, ctx,
        { stream: false, temperature: 0.3 });
      if (r.trim()) next += (next ? '\n\n' : '') + r.trim();
    }
    if (!next.trim() || estimateTokens(next) >= estimateTokens(digest)) break;
    digest = next;
  }

  await runChat(eng, buildMessages(promptKey, { ...payload, [spec.source]: digest, digest: true }), spec.maxTokens, ctx,
    { stream: true, port, requestId });
  announce();
  if (overCap) port.postMessage({ type: MSG_TYPES.INFER_NOTICE, requestId, code: 'truncated_head' });
}

/**
 * One completion, with a self-correcting token budget.
 *
 * Two independent safety nets, because our estimator is a heuristic and the
 * runtime's tokeniser is the authority:
 *
 *   1. Pre-emptive. If the messages do not fit, shrink the body (keeping the
 *      instruction, which is always at the head) and try again.
 *   2. Reactive. WebLLM's own count may disagree with ours. When it rejects the
 *      prompt it says so, and we halve the generation budget and retry rather
 *      than showing the user a stack trace.
 *
 * A retry never re-streams: if any text has already reached the UI the error is
 * propagated untouched, so the answer can never appear twice.
 */
async function runChat(eng, messages, wantMaxTokens, ctx, opts) {
  const { stream = false, port = null, requestId = null, temperature = 0.7 } = opts || {};
  let msgs = messages;
  let want = Math.max(MIN_COMPLETION_TOKENS, wantMaxTokens);
  let lastErr = null;
  let collected = '';

  for (let attempt = 0; attempt < 4; attempt++) {
    const fits = fitMessages(msgs, ctx, want);
    if (fits) {
      try {
        // ALWAYS request the streaming form, even for the map phase where the
        // text is discarded. It is the one code path this project has proven
        // works against the vendored WebLLM build, and the only cost of using it
        // for a non-streaming caller is that we assemble the answer ourselves.
        const res = await eng.chat.completions.create({
          messages: fits.messages, stream: true, temperature, max_tokens: fits.maxTokens
        });
        for await (const chunk of res) {
          const text = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
            chunk.choices[0].delta.content) || '';
          if (!text) continue;
          collected += text;
          if (stream && port) port.postMessage({ type: MSG_TYPES.INFER_STREAM, requestId, text });
        }
        return collected;
      } catch (e) {
        if (!isContextOverflowError(e)) throw e;
        if (collected) throw e;                    // never duplicate output
        lastErr = e;
      }
    }
    want = Math.max(MIN_COMPLETION_TOKENS, Math.floor(want / 2));
    msgs = shrinkMessages(msgs, ctx, want);
  }
  throw lastErr || new Error('CONTEXT_EXCEEDED');
}

/**
 * Can these messages be sent with `wantMaxTokens` of room left to generate?
 * Returns the clamped parameters, or null meaning "shrink and ask again".
 */
function fitMessages(messages, ctx, wantMaxTokens) {
  const overhead = tokensForMessages(messages.filter(m => m.role !== 'user'));
  const room = ctx - CHAT_TEMPLATE_MARGIN - wantMaxTokens - overhead;
  if (room < 1) return null;
  let userTokens = 0;
  for (const m of messages) if (m.role === 'user') userTokens += estimateTokens(m.content);
  if (userTokens > room) return null;
  return { messages, maxTokens: wantMaxTokens };
}

/** Cut the user body down to `room`, keeping the instruction at its head. */
function shrinkMessages(messages, ctx, wantMaxTokens) {
  const overhead = tokensForMessages(messages.filter(m => m.role !== 'user'));
  const room = Math.max(32, ctx - CHAT_TEMPLATE_MARGIN - wantMaxTokens - overhead);
  return messages.map(m => {
    if (m.role !== 'user') return m;
    if (estimateTokens(m.content) <= room) return m;
    return { ...m, content: truncateToTokens(m.content, room) };
  });
}

/** Map-phase prompts: turn one fragment into notes (or into spoken prose). */
function buildChunkMessages(kind, index, total, part) {
  const head = kind === 'podcast'
    ? `这是一篇文章的第 ${index + 1}/${total} 部分。请把它改写成口语化、适合朗读的播客稿，保留核心信息，用中文，只输出改写后的内容，不要解释：`
    : `这是一篇文章的第 ${index + 1}/${total} 部分。请提炼其中的关键信息，输出 2-4 条中文要点，只输出要点，不要解释：`;
  return [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: `${head}\n\n${part}` }];
}

/**
 * The real prompts.
 *
 * Note there is no truncation here any more — by the time a body reaches this
 * function its size has already been decided against the model's window. The
 * old `article?.substring(0, 10000)` / `substring(0, 8000)` caps were the bug.
 *
 * `payload.digest` means `article` holds notes produced by the map phase rather
 * than the article itself, so the wording says so.
 */
function buildMessages(promptKey, payload) {
  const { text, styles, level, topic, length, tone, lang, instruction, article, digest } = payload || {};
  let user = '';

  switch (promptKey) {
    case 'tone': {
      const styleList = (styles || []).map(s => s.label || s).join('、');
      user = `请将以下文字改写为“${styleList}”风格，只输出改写后的文字，不解释：\n${text || ''}`;
      break;
    }
    case 'roast':
      user = `请对以下内容生成一句犀利、幽默、纯娱乐的吐槽，只输出一句，不要多解释：\n${text || ''}`;
      break;
    case 'writing_blank':
      user = `请用${lang === 'en' ? 'English' : '中文'}写一篇关于“${topic}”的文章。语气：${tone || 'neutral'}，长度：${length || 'medium'}。`;
      break;
    case 'writing_ref':
      user = `参考以下${digest ? '文章要点' : '文章内容'}：\n---\n${article || ''}\n---\n\n请根据指令完成写作：${instruction || '总结核心观点'}。用${lang === 'en' ? 'English' : '中文'}。`;
      break;
    case 'summary': {
      const clause = SUMMARY_CLAUSE[level] || SUMMARY_CLAUSE.detailed;
      user = `请对以下${digest ? '文章各部分的要点' : '文章'}进行总结。${clause}。\n\n${article || ''}`;
      break;
    }
    case 'podcast':
      user = `请将以下文章改写成更口语化的播客稿（适合朗读），保留核心信息，用中文：\n\n${article || ''}`;
      break;
    case 'ask':
      user = `参考以下文章内容：\n---\n${article || ''}\n---\n\n请针对用户的问题进行准确回答。忠于原文，逻辑清晰，不要编造未提及的事实。用${lang === 'en' ? 'English' : '中文'}回答。\n问题：${payload?.question || ''}`;
      break;
    case 'agreement':
      user = `你是一名专业的用户权益保护与法律条款审查助手。请仔细审查以下服务协议或隐私条款正文，重点排查 5 大维度：\n1. 自动续费与扣费陷阱\n2. 知识产权与版权让渡\n3. 个人隐私共享与商业化授权\n4. 单方免责霸王条款\n5. 争议解决与管辖限制\n\n请给出清晰的分析：\n- 综合风险评级与核心预警\n- 重点风险条款摘录与危害提示\n- 用户操作防范建议\n\n协议内容：\n${article || ''}`;
      break;
    case 'briefing':
      user = `你是一位亲切生动、声音富有磁性的早报电台主持人。现在是 OmniSense FM 98.5 早报时间。\n请根据以下用户近期收录的知识记忆，生成一篇通俗生动、适合听觉收听的口语化早报广播稿：\n1. 晨间开场问候；\n2. 将各篇文章的核心观点融会贯通、串联播报；\n3. 积极向上的启发性结语。\n适合连续朗读，请直接输出播报正文，不要使用 Markdown 特殊符号。\n\n近期知识要点：\n${article || ''}`;
      break;
    case 'bias_advocate':
      user = `你是一名严苛的批判性思维专家与“反方首席辩手”。请对以下文章展开深度立场审视与反方辩驳，输出结构化的对抗分析：\n\n【天平倾向指标】\n事实客观度：XX% | 情绪主观度：XX%\n立场倾向评级：[客观中立] 或 [轻度倾向] 或 [情绪煽动] 或 [严重失衡]（请选一项并用方括号标注）\n\n【被回避的隐性成本与事实】\n（列举 2-3 条作者刻意淡化或回避的关键前提、隐性成本、反例或风险，说明作者为什么不提）\n\n【反方最强反驳论据】\n（从利益对立面或严苛审视角度，列出 2-3 条最有力的反驳攻破点）\n\n【认知盲区与独立思考】\n（指出文章中的逻辑漏洞，如幸存者偏差、以偏概全或因果倒置，给读者 1-2 条建议）\n\n文章内容：\n${article || ''}`;
      break;
    case 'margin_notes':
      user = `请为以下文章提取核心章节的智能导读与段落智能边注。提炼 3-5 条重点段落边注（每条不超过25字）以及核心专业术语释义，格式清晰简练：\n\n文章内容：\n${article || ''}`;
      break;
    case 'selection_act': {
      const mode = payload?.mode || 'explain';
      const selected = text || payload?.text || '';
      if (mode === 'explain') {
        user = `请用清晰简练的中文解释以下选中文本中的核心概念或术语（不超过120字，直截了当解释，不要有多余寒暄）：\n\n"${selected}"`;
      } else if (mode === 'debate') {
        user = `请充当反方首席辩手，用严密犀利的逻辑，对以下观点提出最强有力的反驳或指出其潜在漏洞（不超过120字）：\n\n"${selected}"`;
      } else if (mode === 'rewrite') {
        user = `请将以下文本分别润色为【专业学术风】和【简明商务风】（保留原意，直接输出润色后的内容）：\n\n"${selected}"`;
      } else if (mode === 'roast') {
        user = `请用幽默、机智、毒舌但不失内涵的语气吐槽以下这句话（不超过80字）：\n\n"${selected}"`;
      } else {
        user = `请简要分析以下内容：\n\n"${selected}"`;
      }
      break;
    }
    default:
      user = text || '';
  }
  return [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }];
}

// ---------------- Embedding / Capsule ----------------
// `navigator.gpu` existing does NOT mean a usable adapter exists (headless
// Chrome, VMs, blocklisted drivers all expose the API but hand back no adapter).
// Probe for a real adapter, and always keep wasm as the guaranteed fallback.
async function resolveDeviceChain() {
  const chain = [];
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) chain.push('webgpu');
    } catch { /* fall through to wasm */ }
  }
  chain.push('wasm');
  return chain;
}

async function getEmbedder() {
  if (embedder) return embedder;
  // Surface the real failure instead of returning null and letting callers
  // throw a meaningless "extr is not a function".
  if (embedderInitError) throw embedderInitError;
  // De-duplicate concurrent callers (a capture and a query can overlap while the
  // model is still loading) so we never build two pipelines at once.
  if (embedderPromise) return embedderPromise;
  embedderPromise = initEmbedder()
    .then(e => { embedder = e; return e; })
    .catch(e => { embedderInitError = e; throw e; })
    .finally(() => { embedderPromise = null; });
  return embedderPromise;
}

async function initEmbedder() {
  try {
    const { pipeline, env } = await import('./vendor/transformers/transformers.js');

    env.allowRemoteModels = true;   // weights come from HF (cached in browser Cache API)
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // Force every ORT asset to the vendored local copy BEFORE the pipeline is
    // built, so transformers.js never overwrites wasmPaths with a CDN URL.
    const dist = chrome.runtime.getURL(ORT_DIST);
    env.backends.onnx.wasm.wasmPaths = {
      mjs: dist + 'ort-wasm-simd-threaded.asyncify.mjs',
      wasm: dist + 'ort-wasm-simd-threaded.asyncify.wasm'
    };
    // Offscreen documents are not crossOriginIsolated, so threaded wasm can't
    // work; pin to a single thread and avoid spawning ORT proxy workers.
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;

    const devices = await resolveDeviceChain();
    let lastErr = null;
    for (const device of devices) {
      try {
        return await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
          device,
          dtype: 'fp32'
        });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('No usable embedding backend');
  } catch (e) {
    // getEmbedder() records this as embedderInitError and rethrows.
    throw e;
  }
}

async function runEmbedding(msg, port) {
  const extr = await getEmbedder();
  if (Array.isArray(msg.texts)) {
    const vectors = [];
    for (const t of msg.texts) {
      const out = await extr(t, { pooling: 'mean', normalize: true });
      vectors.push(Array.from(out.data));
    }
    port.postMessage({ type: MSG_TYPES.EMBEDDING, requestId: msg.requestId, vectors });
    return;
  }
  const out = await extr(msg.text, { pooling: 'mean', normalize: true });
  const vector = Array.from(out.data);
  port.postMessage({ type: MSG_TYPES.EMBEDDING, requestId: msg.requestId, vector });
}

/**
 * Embed one page into the local capsule.
 *
 * Shared by two callers:
 *  - the passive content-script capture (no `requestId`) — fire and forget;
 *  - the explicit "收录本页" action (`requestId` present) — replies with
 *    `CAPTURE_RESULT` so the UI can state the real outcome rather than leaving
 *    the user staring at an unchanged empty panel.
 *
 * The previous version returned early whenever the embedding pipeline was not
 * resident, which is exactly the state of a fresh profile: the very first
 * capture therefore never stored anything and never said so.
 */
async function capturePage(data, port, requestId) {
  const reply = (payload) => {
    if (requestId && port) port.postMessage({ type: MSG_TYPES.CAPTURE_RESULT, requestId, ...payload });
  };
  const { url, title, text } = data || {};
  if (!text || text.length < 50) return reply({ ok: false, chunks: 0, reason: 'too_short' });

  let extr;
  try {
    // Loads the ~25 MB MiniLM embedder on first use (cached afterwards), so the
    // first capture legitimately takes a while. getEmbedder() de-duplicates
    // concurrent callers, so an overlapping search cannot build a second one.
    extr = await getEmbedder();
  } catch (e) {
    broadcast({ type: MSG_TYPES.MODEL_STATUS, status: 'error', text: `Embedding unavailable: ${e.message}` });
    return reply({ ok: false, chunks: 0, reason: 'no_embedder' });
  }

  let domain = '';
  try { domain = new URL(url).hostname; } catch (e) { /* about:, data:, blob: */ }

  // Language-aware chunking — see shared/capsule-chunk.js for the measurement.
  // The old rule here was `text.split(/\s+/)` grouped into 128-word blocks, which
  // for Chinese (no spaces between words) produced a single 2000-character chunk
  // that the 512-token embedder then truncated.
  const chunks = chunkForEmbedding(text, CAPSULE_MAX_CHUNKS);
  if (!chunks.length) return reply({ ok: false, chunks: 0, reason: 'too_short' });

  // Embed EVERYTHING first, and only touch the store once that has worked.
  //
  // The obvious implementation — delete the page's old rows, then embed and write
  // the new ones — silently loses the user's saved copy whenever embedding fails
  // (a profile where the 25MB embedder cannot load, a tab closed mid-capture, an
  // out-of-memory). "I re-saved the page and now it's gone" is a much worse failure
  // than "the old copy is still there". So the old rows are deleted strictly after
  // at least one new vector exists, and never before.
  const embedded = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const out = await extr(chunks[i], { pooling: 'mean', normalize: true });
      embedded.push({ index: i, snippet: chunks[i].slice(0, 240), vector: Array.from(out.data) });
    } catch (e) {
      // Keep going — a partially embedded page is still searchable.
    }
  }
  if (!embedded.length) {
    reply({ ok: false, chunks: 0, reason: 'embed_failed' });
    return;
  }

  // Dedupe by URL: re-capturing a page REPLACES it. Without this the same article
  // captured twice sat in the list as two identical rows (same title, same domain,
  // same snippet, "5 小时前" and "刚刚"), which is the reported 「收录的时候，去重吧」.
  // Removing the old rows here also cleans up profiles written by schema v1, which
  // had no url index and therefore could not do this at all.
  await idbDeleteByIndex('capsule', 'url', url).catch(() => 0);

  // One shared timestamp for the whole page so all of its chunks collapse into a
  // single entry in the UI. Folding those chunks back into one row is done by
  // `groupByPage` in the service worker — this comment used to claim that "search
  // results can be de-duplicated by url" as if it already happened, and nothing
  // anywhere did it, so a long article returned six identical rows.
  const stamp = Date.now();
  let stored = 0;
  for (const item of embedded) {
    try {
      await idbPut('capsule', {
        // The url is in the id as well as in the index so that two captures
        // starting in the same millisecond cannot collide on the primary key.
        id: `${url}_${stamp}_${item.index}`,
        url, title, domain, chunkIndex: item.index, chunkTotal: embedded.length,
        snippet: item.snippet, visitTime: stamp, vector: item.vector
      });
      stored++;
    } catch (e) {
      // Keep going — a partially stored page is still searchable.
    }
  }

  if (stored) {
    // Reply BEFORE any housekeeping. Retention used to run first, and because it
    // read chrome.storage (unavailable here) it threw — so the reply was never
    // sent and the side panel waited until the message port timed out with
    // "The message port closed before a response was received", i.e. the
    // 「收录本页」button reported a failure even though the page HAD been stored.
    reply({ ok: true, chunks: stored, reason: null });
    return;
  }
  reply({ ok: false, chunks: 0, reason: 'embed_failed' });
}

/**
 * Minimum cosine similarity for a chunk to count as a hit.
 *
 * Chosen from measurement, not taste — `e2e/diag-capsule-search.cjs` prints the
 * full score distribution including a noise floor from deliberately unrelated
 * queries. Measured with all-MiniLM-L6-v2 on this index:
 *
 *   irrelevant controls  "chocolate cake recipe with butter"      top 0.087
 *                        "how to repair a bicycle gear shifter"  top 0.077
 *   relevant, vague      "local inference privacy"                top 0.314
 *                        "a long form article about local inference" top 0.262
 *   relevant, specific   "webgpu accelerator weights …"           top 0.559
 *
 * The previous value of 0.35 sat ABOVE genuinely relevant short queries, so a
 * user who had saved a page and then searched for it with a normal 3–4 word
 * phrase got an empty list — the memory was there and the wiring was fine, the
 * results were just being discarded. 0.2 keeps a ~2.3x margin over the measured
 * noise floor while no longer hiding real matches.
 *
 * If you are tempted to raise this, run the diagnostic first: the separation
 * between "irrelevant" and "relevant but vague" is much larger than it looks.
 */
const CAPSULE_MIN_SCORE = 0.2;

async function queryCapsule(query, port, requestId) {
  let extr;
  try {
    extr = await getEmbedder();
  } catch (e) {
    broadcast({ type: MSG_TYPES.MODEL_STATUS, status: 'error', text: `Embedding unavailable: ${e.message}` });
    port.postMessage({ type: MSG_TYPES.CAPSULE_QUERY, requestId, results: [] });
    return;
  }
  const q = await extr(query, { pooling: 'mean', normalize: true });
  const qVec = Array.from(q.data);
  const all = await idbGetAll('capsule');
  const scored = all.map(item => ({
    ...item,
    score: Array.isArray(item.vector) && item.vector.length ? cosineSimilarity(qVec, item.vector) : -1
  }))
    .filter(i => i.score > CAPSULE_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
  port.postMessage({ type: MSG_TYPES.CAPSULE_QUERY, requestId, results: scored });
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Announce readiness. Callback form + lastError read: the service worker may not
// be listening yet, and the promise form would log that as an unchecked error.
try {
  chrome.runtime.sendMessage({ type: MSG_TYPES.PING }, () => { void chrome.runtime.lastError; });
} catch (e) { /* SW unavailable */ }
