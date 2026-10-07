import { MSG_TYPES } from './constants.js';

/**
 * "Receiving end does not exist" / "Could not establish connection" both mean the
 * message was never DELIVERED — the service worker was asleep or still
 * cold-starting. Retrying those is safe because nothing ran.
 *
 * "The message port closed before a response was received" is deliberately NOT in
 * this list: it means the message WAS delivered and the receiver simply did not
 * answer in time, so retrying could execute a non-idempotent action twice.
 */
const NOT_DELIVERED = /Receiving end does not exist|Could not establish connection/i;

/**
 * Send a message to the extension (service worker / other contexts).
 *
 * IMPORTANT: this deliberately uses the *callback* form rather than the promise
 * form. Chrome records every failed `sendMessage` as
 * "Unchecked runtime.lastError: Could not establish connection. Receiving end
 * does not exist." in chrome://extensions unless `runtime.lastError` is read.
 * That failure is routine — the service worker is asleep or still cold-starting
 * when a panel loads — and it shows up as a user-visible *extension error*.
 * Reading `lastError` inside the callback marks it as checked, so nothing is
 * logged, and we still get a proper promise to await.
 *
 * The one automatic retry exists because "the worker was asleep" used to surface
 * to the user as "I clicked the button and absolutely nothing happened": every
 * feature handler awaits one of these calls, and a rejection just aborts the
 * handler silently.
 */
export function sendToSW(msg, retries = 1) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          const err = chrome.runtime.lastError;
          if (!err) { resolve(response); return; }
          if (left > 0 && NOT_DELIVERED.test(err.message)) {
            setTimeout(() => attempt(left - 1), 200);
            return;
          }
          reject(new Error(err.message));
        });
      } catch (e) {
        // Extension context invalidated (e.g. reloaded mid-flight).
        reject(e);
      }
    };
    attempt(retries);
  });
}

/**
 * Fire-and-forget send that can never leave an unchecked `runtime.lastError`
 * behind, and that rides out service-worker cold starts with one retry.
 */
export function postToSW(msg, retries = 1) {
  return sendToSW(msg, 0).catch(() => {
    if (retries > 0) {
      setTimeout(() => { postToSW(msg, retries - 1); }, 250);
    }
  });
}

export function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

export function postToTab(tabId, msg, retries = 1) {
  return sendToTab(tabId, msg).catch(() => {
    if (retries > 0) {
      setTimeout(() => { postToTab(tabId, msg, retries - 1); }, 250);
    }
  });
}

/**
 * Broadcast a payload to every other open extension context from the service
 * worker. Same lastError discipline as above.
 */
export function broadcastFromSW(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
  } catch (e) { /* no receiving context, or SW shutting down */ }
}

// Open a streaming port to the offscreen inference host via the service worker.
export function connectInference(onChunk, onStatus, onError, onDone, onNotice) {
  const port = chrome.runtime.connect({ name: 'omni-offscreen' });
  port.onMessage.addListener((m) => {
    switch (m.type) {
      case MSG_TYPES.INFER_STREAM:
        if (onChunk) onChunk(m.text);
        break;
      case MSG_TYPES.INFER_NOTICE:
        if (onNotice) onNotice(m);
        break;
      case MSG_TYPES.MODEL_STATUS:
      case MSG_TYPES.MODEL_PROGRESS:
        if (onStatus) onStatus(m);
        break;
      case MSG_TYPES.INFER_ERROR:
        if (onError) onError(m.error);
        break;
      case MSG_TYPES.INFER_END:
        if (onDone) onDone();
        break;
    }
  });
  return {
    send: (payload) => port.postMessage(payload),
    close: () => port.disconnect()
  };
}

// Helpers for common actions
export function getArticle(tabId) {
  return sendToSW({ type: MSG_TYPES.GET_ARTICLE, tabId });
}

export function getSelection(tabId) {
  return sendToSW({ type: MSG_TYPES.GET_SELECTION, tabId });
}

export function scanPrivacy(tabId) {
  return sendToSW({ type: MSG_TYPES.SCAN_PRIVACY, tabId });
}

export function searchCapsule(query) {
  return sendToSW({ type: MSG_TYPES.CAPSULE_QUERY, query });
}

export function inferStream(promptKey, payload, handlers) {
  const conn = connectInference(handlers.onChunk, handlers.onStatus, handlers.onError, handlers.onDone);
  conn.send({ type: MSG_TYPES.INFER_STREAM, promptKey, payload });
  return conn;
}
