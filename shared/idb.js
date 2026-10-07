import { STORES } from './constants.js';

/**
 * Schema version.
 *
 * v2 added a `url` index to `capsule`, because "one page" — not "one visit" — is
 * the unit the product deals in: re-capturing a page must replace it, deleting an
 * entry must remove all of it, and the count the user sees must be a count of
 * pages. Without an index every one of those operations is a full scan that
 * deserialises every stored 384-float embedding.
 */
const DB_VERSION = 2;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(STORES.DB, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      // Close this connection the moment another context asks for a newer
      // version. The service worker and the offscreen document each hold their
      // own connection to this database, and an upgrade cannot proceed while an
      // older one is open: without this the v1 → v2 upgrade sits in `blocked`
      // forever and EVERY capsule operation hangs with no error anywhere.
      db.onversionchange = () => {
        try { db.close(); } catch (e) { /* already closed */ }
        dbPromise = null;
      };
      resolve(db);
    };
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORES.CAPSULE)) {
        const store = db.createObjectStore(STORES.CAPSULE, { keyPath: 'id' });
        store.createIndex('visitTime', 'visitTime', { unique: false });
        store.createIndex('domain', 'domain', { unique: false });
        store.createIndex('url', 'url', { unique: false });
      } else if (event.oldVersion < 2) {
        // Upgrading an existing profile. Rows written by v1 keep their old ids and
        // are NOT migrated here: `groupByPage` already collapses them by url, the
        // count uses the new url index so it is truthful immediately, and the
        // superseded copies are deleted the first time the listing is opened or
        // the page is captured again (both already scan the store). Doing it inside
        // the version-change transaction would mean deserialising every embedding
        // mid-upgrade, where a failure is far more expensive than a stale row.
        const store = event.target.transaction.objectStore(STORES.CAPSULE);
        if (!store.indexNames.contains('url')) store.createIndex('url', 'url', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains(STORES.GENERATIONS)) {
        db.createObjectStore(STORES.GENERATIONS, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
  return dbPromise;
}

export async function idbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbClear(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete every row whose `indexName` equals `key`. Returns how many went.
 *
 * This is how "delete this page" and "replace this page" are implemented: the
 * capsule's rows are chunks, so removing one entry means removing all of its
 * chunks, and looking them up by primary key would need the caller to already
 * know every id.
 *
 * Resolves on TRANSACTION completion, not on the last cursor callback: the
 * individual `delete()` requests are fire-and-forget within the transaction, and
 * resolving early would report success before the data was actually gone.
 */
export async function idbDeleteByIndex(store, indexName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const idx = os.index(indexName);
    // `openKeyCursor` and not `openCursor`: the index is only used to find WHICH
    // records to drop, and the values here are a 384-float embedding per row. A
    // value cursor would deserialise every one of them just to discard it.
    const req = idx.openKeyCursor(IDBKeyRange.only(key));
    const keys = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        // NOT `cursor.delete()`. `IDBCursor.delete()` is only valid on the cursor
        // returned by `openCursor()`; on the key cursor that `openKeyCursor()`
        // yields it throws `InvalidStateError: The cursor is a key cursor`.
        //
        // That is what shipped first, and because both callers swallow failures it
        // turned "replace this page" and the delete button into silent no-ops: the
        // button reported success and removed nothing. Deleting BY PRIMARY KEY is
        // what a key cursor is for — `cursor.primaryKey` is the record's key even
        // when the cursor walks an index.
        keys.push(cursor.primaryKey);
        cursor.continue();
        return;
      }
      // Cursor exhausted. Still inside the same readwrite transaction, so issuing
      // the deletes now joins them to this transaction's atomicity — and resolving
      // on `oncomplete` (rather than here) is what makes the returned count true.
      for (const pk of keys) os.delete(pk);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(keys.length);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * How many rows, and how many DISTINCT values of `indexName`.
 *
 * The two numbers differ exactly when the same page has been stored more than
 * once, which is the difference between "8 段记忆" and "2 篇文章" — the gap that
 * made a user ask how to see what they had saved.
 *
 * Uses `openKeyCursor`, which yields the index key and the primary key but NOT
 * the stored value: counting pages must not deserialise every embedding in the
 * store. Index-key order puts equal keys next to each other, so distinct values
 * are counted by comparing each key with the previous one.
 */
export async function idbCountDistinct(store, indexName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const idx = tx.objectStore(store).index(indexName);
    const req = idx.openKeyCursor();
    let rows = 0, distinct = 0, last;
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve({ rows, distinct }); return; }
      rows++;
      if (rows === 1 || cursor.key !== last) { distinct++; last = cursor.key; }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Cheap "how much is in here" summary: total rows plus the newest visitTime.
 * Deliberately uses count() + a reverse cursor instead of getAll(), which would
 * materialise every stored embedding vector just to render one line of UI.
 */
export async function idbStats(store) {
  const db = await openDB();
  const count = await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
  let lastVisitTime = 0;
  try {
    lastVisitTime = await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const idx = tx.objectStore(store).index('visitTime');
      const req = idx.openCursor(null, 'prev');
      req.onsuccess = () => resolve(req.result ? (req.result.value.visitTime || 0) : 0);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    // Store without a visitTime index (settings / generations) — count is enough.
    lastVisitTime = 0;
  }
  return { count, lastVisitTime };
}

/**
 * Drop entries older than `days`. 0 (or negative) means "keep forever".
 *
 * Lives here rather than in the inference host because the retention setting is
 * read with chrome.storage, which is unavailable in an offscreen document —
 * which is why retention used to be a silent no-op.
 */
export async function idbPrune(store, days) {
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    let removed = 0;
    if (os.indexNames.contains('visitTime')) {
      const idx = os.index('visitTime');
      const req = idx.openKeyCursor(IDBKeyRange.upperBound(cutoff));
      const keys = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          keys.push(cursor.primaryKey);
          cursor.continue();
          return;
        }
        for (const pk of keys) os.delete(pk);
        removed = keys.length;
      };
      req.onerror = () => reject(req.error);
    } else {
      const req = os.openCursor();
      const keys = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          if ((cursor.value?.visitTime || 0) < cutoff) keys.push(cursor.primaryKey);
          cursor.continue();
          return;
        }
        for (const pk of keys) os.delete(pk);
        removed = keys.length;
      };
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbQueryByIndex(store, indexName, range) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const idx = tx.objectStore(store).index(indexName);
    const req = idx.openCursor(range);
    const out = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        out.push(cursor.value);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}
