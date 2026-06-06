(function () {
  const STORE_KEY = 'webHighlighterStore';

  const pagesEl = document.getElementById('pages');
  const pageCountEl = document.getElementById('page-count');
  const highlightCountEl = document.getElementById('highlight-count');
  const refreshBtn = document.getElementById('refresh-btn');

  refreshBtn.addEventListener('click', render);
  render();

  function render() {
    readStore().then((store) => {
      const pages = Object.values(store.pages || {}).sort((left, right) => {
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      });

      pageCountEl.textContent = String(pages.length);
      highlightCountEl.textContent = String(pages.reduce((sum, page) => sum + (Array.isArray(page.highlights) ? page.highlights.length : 0), 0));

      if (pages.length === 0) {
        pagesEl.innerHTML = '<div class="empty">还没有任何网页被划线。</div>';
        return;
      }

      pagesEl.innerHTML = pages.map(renderPageCard).join('');
      bindActions(store);
    });
  }

  function renderPageCard(page) {
    const highlights = [...(page.highlights || [])].sort((left, right) => left.start - right.start);
    return `
      <article class="page-card" data-page-key="${escapeHtml(page.url)}">
        <div class="page-head">
          <div>
            <h2 class="page-title">${escapeHtml(page.title || page.url)}</h2>
            <div class="page-url">${escapeHtml(page.url)}</div>
          </div>
          <div class="page-meta">${highlights.length} 条标记</div>
        </div>

        <div class="highlight-list">
          ${highlights.length > 0 ? highlights.map((highlight) => renderHighlightItem(page.url, highlight)).join('') : '<div class="empty">这一页还没有具体标记。</div>'}
        </div>

        <div class="page-actions">
          <button type="button" data-clear-page="${escapeHtml(page.url)}">清空本页</button>
        </div>
      </article>
    `;
  }

  function renderHighlightItem(pageKey, highlight) {
    return `
      <div class="highlight-item" data-highlight-id="${escapeHtml(highlight.id)}" data-page-key="${escapeHtml(pageKey)}">
        <div class="highlight-main">
          <p class="highlight-quote">${escapeHtml(highlight.quote || '')}</p>
          <div class="highlight-sub">
            <span class="swatch" style="background:${escapeHtml(highlight.color || '#fff59d')}"></span>
            <span>${escapeHtml(highlight.color || '')}</span>
          </div>
        </div>
        <div class="item-actions">
          <button type="button" data-delete-highlight="${escapeHtml(highlight.id)}" data-page-key="${escapeHtml(pageKey)}">删除</button>
        </div>
      </div>
    `;
  }

  function bindActions(currentStore) {
    document.querySelectorAll('[data-delete-highlight]').forEach((button) => {
      button.addEventListener('click', async () => {
        const pageKey = button.getAttribute('data-page-key');
        const highlightId = button.getAttribute('data-delete-highlight');
        if (!pageKey || !highlightId) {
          return;
        }
        await removeHighlight(pageKey, highlightId);
      });
    });

    document.querySelectorAll('[data-clear-page]').forEach((button) => {
      button.addEventListener('click', async () => {
        const pageKey = button.getAttribute('data-clear-page');
        if (!pageKey) {
          return;
        }
        await clearPage(pageKey);
      });
    });
  }

  async function removeHighlight(pageKey, highlightId) {
    const store = await readStore();
    const page = store.pages[pageKey];
    if (!page) {
      return;
    }

    page.highlights = page.highlights.filter((item) => item.id !== highlightId);
    if (page.highlights.length === 0) {
      delete store.pages[pageKey];
    } else {
      page.updatedAt = new Date().toISOString();
      store.pages[pageKey] = page;
    }

    await writeStore(store);
    await notifyOpenTabs(pageKey, highlightId);
    render();
  }

  async function clearPage(pageKey) {
    const store = await readStore();
    if (!store.pages[pageKey]) {
      return;
    }

    const removedIds = store.pages[pageKey].highlights.map((item) => item.id);
    delete store.pages[pageKey];
    await writeStore(store);
    await notifyOpenTabs(pageKey, null, removedIds);
    render();
  }

  async function notifyOpenTabs(pageKey, highlightId, removedIds) {
    const tabs = await queryTabs();
    const matches = tabs.filter((tab) => normalizeUrl(tab.url || '') === pageKey);
    for (const tab of matches) {
      if (highlightId) {
        sendMessage(tab.id, { type: 'WH_REMOVE_HIGHLIGHT', highlightId });
      } else if (Array.isArray(removedIds)) {
        for (const id of removedIds) {
          sendMessage(tab.id, { type: 'WH_REMOVE_HIGHLIGHT', highlightId: id });
        }
      }
    }
  }

  function queryTabs() {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.error('Failed to query tabs:', error);
        }
        resolve(tabs || []);
      });
    });
  }

  function sendMessage(tabId, message) {
    chrome.tabs.sendMessage(tabId, message, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.debug('Highlight page is not active in tab', tabId, error.message);
      }
    });
  }

  function readStore() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORE_KEY, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.error('Failed to read highlight store:', error);
        }
        resolve(result[STORE_KEY] || { pages: {} });
      });
    });
  }

  function writeStore(store) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORE_KEY]: store }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.error('Failed to write highlight store:', error);
        }
        resolve();
      });
    });
  }

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch (error) {
      return url.split('#')[0];
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
