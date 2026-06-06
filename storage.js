(function () {
  const DB_NAME = 'webHighlighterDB';
  const DB_VERSION = 1;
  const META_MIGRATION_KEY = 'legacy-migration-complete';
  const LEGACY_STORE_KEY = 'webHighlighterStore';

  let dbPromise = null;
  let migrationPromise = null;

  const api = {
    normalizePageUrl,
    getPagesWithHighlights,
    getHighlightsForPage,
    saveHighlight,
    updateHighlightColor,
    deleteHighlight,
    clearPage,
    getPage
  };

  globalThis.webHighlighterStore = api;

  function normalizePageUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch (error) {
      return String(url).split('#')[0];
    }
  }

  async function getPagesWithHighlights() {
    const db = await openDatabase();
    const pages = await readAll(db, 'pages');
    const highlights = await readAll(db, 'highlights');
    const highlightMap = groupHighlightsByPage(highlights);

    return pages
      .map((page) => ({
        ...page,
        highlights: (highlightMap.get(page.url) || []).sort(byStart)
      }))
      .filter((page) => page.highlights.length > 0)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  async function getHighlightsForPage(pageUrl) {
    const db = await openDatabase();
    const highlights = await readAllByIndex(db, 'highlights', 'pageUrl', normalizePageUrl(pageUrl));
    return highlights.sort(byStart);
  }

  async function getPage(pageUrl) {
    const db = await openDatabase();
    return readOne(db, 'pages', normalizePageUrl(pageUrl));
  }

  async function saveHighlight(page, highlight) {
    const pageUrl = normalizePageUrl(page.url);
    const db = await openDatabase();
    const now = new Date().toISOString();
    const tx = db.transaction(['pages', 'highlights'], 'readwrite');
    const pageStore = tx.objectStore('pages');
    const highlightStore = tx.objectStore('highlights');

    const existingPage = await requestToPromise(pageStore.get(pageUrl));
    const existingHighlight = await requestToPromise(highlightStore.get(highlight.id));

    const nextPage = {
      url: pageUrl,
      title: page.title || pageUrl,
      updatedAt: now,
      highlightCount: existingPage && typeof existingPage.highlightCount === 'number'
        ? existingPage.highlightCount + (existingHighlight ? 0 : 1)
        : (existingHighlight ? 1 : 1)
    };

    await requestToPromise(pageStore.put(nextPage));
    await requestToPromise(highlightStore.put({
      ...highlight,
      pageUrl,
      pageTitle: page.title || pageUrl
    }));
    await txComplete(tx);
  }

  async function updateHighlightColor(pageUrl, highlightId, color) {
    const db = await openDatabase();
    const normalizedPageUrl = normalizePageUrl(pageUrl);
    const now = new Date().toISOString();
    const tx = db.transaction(['pages', 'highlights'], 'readwrite');
    const pageStore = tx.objectStore('pages');
    const highlightStore = tx.objectStore('highlights');

    const highlight = await requestToPromise(highlightStore.get(highlightId));
    if (!highlight || highlight.pageUrl !== normalizedPageUrl) {
      await txComplete(tx);
      return null;
    }

    highlight.color = color;
    highlight.updatedAt = now;
    await requestToPromise(highlightStore.put(highlight));

    const page = await requestToPromise(pageStore.get(normalizedPageUrl));
    if (page) {
      page.updatedAt = now;
      await requestToPromise(pageStore.put(page));
    }

    await txComplete(tx);
    return highlight;
  }

  async function deleteHighlight(pageUrl, highlightId) {
    const db = await openDatabase();
    const normalizedPageUrl = normalizePageUrl(pageUrl);
    const now = new Date().toISOString();
    const tx = db.transaction(['pages', 'highlights'], 'readwrite');
    const pageStore = tx.objectStore('pages');
    const highlightStore = tx.objectStore('highlights');

    const highlight = await requestToPromise(highlightStore.get(highlightId));
    if (!highlight || highlight.pageUrl !== normalizedPageUrl) {
      await txComplete(tx);
      return null;
    }

    await requestToPromise(highlightStore.delete(highlightId));

    const page = await requestToPromise(pageStore.get(normalizedPageUrl));
    if (page) {
      const nextCount = Math.max(0, (page.highlightCount || 0) - 1);
      if (nextCount === 0) {
        await requestToPromise(pageStore.delete(normalizedPageUrl));
      } else {
        page.highlightCount = nextCount;
        page.updatedAt = now;
        await requestToPromise(pageStore.put(page));
      }
    }

    await txComplete(tx);
    return highlight;
  }

  async function clearPage(pageUrl) {
    const normalizedPageUrl = normalizePageUrl(pageUrl);
    const db = await openDatabase();
    const highlights = await getHighlightsForPage(normalizedPageUrl);
    const tx = db.transaction(['pages', 'highlights'], 'readwrite');
    const pageStore = tx.objectStore('pages');
    const highlightStore = tx.objectStore('highlights');

    for (const highlight of highlights) {
      await requestToPromise(highlightStore.delete(highlight.id));
    }

    await requestToPromise(pageStore.delete(normalizedPageUrl));
    await txComplete(tx);

    return highlights.map((item) => item.id);
  }

  async function openDatabase() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;

          if (!db.objectStoreNames.contains('meta')) {
            db.createObjectStore('meta', { keyPath: 'key' });
          }

          if (!db.objectStoreNames.contains('pages')) {
            db.createObjectStore('pages', { keyPath: 'url' });
          }

          if (!db.objectStoreNames.contains('highlights')) {
            const highlightStore = db.createObjectStore('highlights', { keyPath: 'id' });
            highlightStore.createIndex('pageUrl', 'pageUrl', { unique: false });
          } else {
            const highlightStore = request.transaction.objectStore('highlights');
            if (!highlightStore.indexNames.contains('pageUrl')) {
              highlightStore.createIndex('pageUrl', 'pageUrl', { unique: false });
            }
          }
        };

        request.onsuccess = async () => {
          const db = request.result;
          db.onversionchange = () => db.close();

          try {
            await migrateLegacyStore(db);
            resolve(db);
          } catch (error) {
            db.close();
            reject(error);
          }
        };

        request.onerror = () => {
          reject(request.error || new Error('Failed to open IndexedDB'));
        };
      });
    }

    return dbPromise;
  }

  async function migrateLegacyStore(db) {
    if (!migrationPromise) {
      migrationPromise = (async () => {
        const migrated = await readMeta(db, META_MIGRATION_KEY);
        if (migrated && migrated.value === true) {
          return;
        }

        const legacyStore = await readLegacyStore();
        const pages = legacyStore && legacyStore.pages ? Object.values(legacyStore.pages) : [];
        if (pages.length > 0) {
          const tx = db.transaction(['meta', 'pages', 'highlights'], 'readwrite');
          const metaStore = tx.objectStore('meta');
          const pageStore = tx.objectStore('pages');
          const highlightStore = tx.objectStore('highlights');
          const now = new Date().toISOString();

          for (const page of pages) {
            const pageUrl = normalizePageUrl(page.url);
            const highlights = Array.isArray(page.highlights) ? page.highlights : [];
            await requestToPromise(pageStore.put({
              url: pageUrl,
              title: page.title || pageUrl,
              updatedAt: page.updatedAt || now,
              highlightCount: highlights.length
            }));

            for (const highlight of highlights) {
              await requestToPromise(highlightStore.put({
                ...highlight,
                pageUrl,
                pageTitle: page.title || pageUrl
              }));
            }
          }

          await requestToPromise(metaStore.put({
            key: META_MIGRATION_KEY,
            value: true,
            updatedAt: now
          }));
          await txComplete(tx);
        } else {
          const tx = db.transaction('meta', 'readwrite');
          const metaStore = tx.objectStore('meta');
          await requestToPromise(metaStore.put({
            key: META_MIGRATION_KEY,
            value: true,
            updatedAt: new Date().toISOString()
          }));
          await txComplete(tx);
        }

        await removeLegacyStore();
      })();
    }

    return migrationPromise;
  }

  async function readLegacyStore() {
    return new Promise((resolve) => {
      chrome.storage.local.get(LEGACY_STORE_KEY, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.error('Failed to read legacy highlight store:', error);
        }
        resolve(result[LEGACY_STORE_KEY] || null);
      });
    });
  }

  async function removeLegacyStore() {
    return new Promise((resolve) => {
      chrome.storage.local.remove(LEGACY_STORE_KEY, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.error('Failed to remove legacy highlight store:', error);
        }
        resolve();
      });
    });
  }

  function readAll(db, storeName) {
    return requestToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
  }

  function readOne(db, storeName, key) {
    return requestToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
  }

  function readAllByIndex(db, storeName, indexName, key) {
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    const index = store.index(indexName);
    return requestToPromise(index.getAll(key));
  }

  async function readMeta(db, key) {
    if (!db.objectStoreNames.contains('meta')) {
      return null;
    }
    return readOne(db, 'meta', key);
  }

  function groupHighlightsByPage(highlights) {
    const map = new Map();
    for (const highlight of highlights) {
      const pageUrl = highlight.pageUrl || '';
      if (!map.has(pageUrl)) {
        map.set(pageUrl, []);
      }
      map.get(pageUrl).push(highlight);
    }
    return map;
  }

  function byStart(left, right) {
    return (left.start || 0) - (right.start || 0);
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function txComplete(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }
})();
