(function () {
  const pagesEl = document.getElementById('pages');
  const pageCountEl = document.getElementById('page-count');
  const highlightCountEl = document.getElementById('highlight-count');
  const refreshBtn = document.getElementById('refresh-btn');
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search-btn');
  const STORE_UPDATED_EVENT = 'WH_STORE_UPDATED';

  const SEARCHABLE_TAGS = new Set(['title', 'url', 'text', 'color', 'date']);
  const DEFAULT_SEARCH_FIELDS = ['title', 'url', 'text'];
  const EMPTY_HTML = '<div class="empty">还没有任何网页被划线。</div>';
  const NO_MATCH_HTML = '<div class="empty">没有匹配的标记。</div>';
  const LOAD_ERROR_HTML = '<div class="empty">加载划线数据失败。</div>';
  const EMPTY_PAGE_HIGHLIGHTS_HTML = '<div class="empty">这一页还没有具体标记。</div>';

  let queryText = '';
  let renderTimer = null;

  refreshBtn.addEventListener('click', render);
  searchInput.addEventListener('input', handleSearchInput);
  clearSearchBtn.addEventListener('click', handleClearSearch);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  render();

  async function render() {
    try {
      const pages = await webHighlighterStore.getPagesWithHighlights();
      const filteredPages = filterPages(pages, parseQuery(queryText));

      pageCountEl.textContent = String(filteredPages.length);
      highlightCountEl.textContent = String(
        filteredPages.reduce((sum, page) => sum + (Array.isArray(page.highlights) ? page.highlights.length : 0), 0)
      );

      if (pages.length === 0) {
        pagesEl.innerHTML = EMPTY_HTML;
        return;
      }

      if (filteredPages.length === 0) {
        pagesEl.innerHTML = NO_MATCH_HTML;
        return;
      }

      pagesEl.innerHTML = filteredPages.map(renderPageCard).join('');
      bindActions();
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
      pagesEl.innerHTML = LOAD_ERROR_HTML;
    }
  }

  function handleSearchInput(event) {
    queryText = event.target.value || '';
    scheduleRender();
  }

  function handleClearSearch() {
    queryText = '';
    searchInput.value = '';
    scheduleRender();
  }

  function handleRuntimeMessage(message) {
    if (!message || message.type !== STORE_UPDATED_EVENT) {
      return;
    }

    scheduleRender();
  }

  function scheduleRender() {
    if (renderTimer) {
      window.clearTimeout(renderTimer);
    }

    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      render();
    }, 60);
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
          ${highlights.length > 0 ? highlights.map((highlight) => renderHighlightItem(page.url, highlight)).join('') : EMPTY_PAGE_HIGHLIGHTS_HTML}
        </div>

        <div class="page-actions">
          <button type="button" data-clear-page="${escapeHtml(page.url)}">清空本页</button>
        </div>
      </article>
    `;
  }

  function renderHighlightItem(pageKey, highlight) {
    const createdDate = formatHighlightDate(highlight.createdAt);
    return `
      <div class="highlight-item" data-highlight-id="${escapeHtml(highlight.id)}" data-page-key="${escapeHtml(pageKey)}">
        <div class="highlight-main">
          <p class="highlight-quote">${escapeHtml(highlight.quote || '')}</p>
          <div class="highlight-sub">
            <span class="swatch" style="background:${escapeHtml(highlight.color || '#fff59d')}"></span>
            <span>${escapeHtml(highlight.color || '')}</span>
            ${createdDate ? `<span>${escapeHtml(createdDate)}</span>` : ''}
          </div>
        </div>
        <div class="item-actions">
          <button type="button" data-delete-highlight="${escapeHtml(highlight.id)}" data-page-key="${escapeHtml(pageKey)}">删除</button>
        </div>
      </div>
    `;
  }

  function bindActions() {
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
    const removed = await webHighlighterStore.deleteHighlight(pageKey, highlightId);
    if (removed) {
      await notifyOpenTabs(pageKey, highlightId);
      render();
    }
  }

  async function clearPage(pageKey) {
    const removedIds = await webHighlighterStore.clearPage(pageKey);
    if (Array.isArray(removedIds)) {
      await notifyOpenTabs(pageKey, null, removedIds);
      render();
    }
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

  function parseQuery(query) {
    const terms = String(query || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(parseTerm)
      .filter((term) => term && term.value);

    return { terms };
  }

  function parseTerm(token) {
    const separatorIndex = token.indexOf(':');
    if (separatorIndex <= 0) {
      return createDefaultTerm(token);
    }

    const field = token.slice(0, separatorIndex).toLowerCase();
    const rawValue = token.slice(separatorIndex + 1);

    if (!SEARCHABLE_TAGS.has(field) || !rawValue.trim()) {
      return createDefaultTerm(token);
    }

    return {
      type: 'field',
      field,
      value: normalizeSearchValue(rawValue)
    };
  }

  function createDefaultTerm(value) {
    return {
      type: 'default',
      fields: DEFAULT_SEARCH_FIELDS,
      value: normalizeSearchValue(value)
    };
  }

  function filterPages(pages, query) {
    if (!query.terms.length) {
      return pages;
    }

    const results = [];
    for (const page of pages) {
      const highlights = filterHighlightsForPage(page, query.terms);
      if (highlights.length === 0) {
        continue;
      }

      results.push({
        ...page,
        highlights
      });
    }
    return results;
  }

  function filterHighlightsForPage(page, terms) {
    const highlights = Array.isArray(page.highlights) ? page.highlights : [];
    return highlights.filter((highlight) => terms.every((term) => matchesTerm(page, highlight, term)));
  }

  function matchesTerm(page, highlight, term) {
    if (term.type === 'default') {
      return term.fields.some((field) => matchFieldValue(page, highlight, field, term.value));
    }

    return matchFieldValue(page, highlight, term.field, term.value);
  }

  function matchFieldValue(page, highlight, field, value) {
    switch (field) {
      case 'title':
        return normalizeSearchValue(page.title).includes(value);
      case 'url':
        return normalizeSearchValue(page.url).includes(value);
      case 'text':
        return normalizeSearchValue(highlight.quote).includes(value);
      case 'color':
        return normalizeSearchValue(highlight.color).includes(value);
      case 'date':
        return formatHighlightDate(highlight.createdAt) === value;
      default:
        return false;
    }
  }

  function formatHighlightDate(value) {
    if (typeof value !== 'string' || value.length < 10) {
      return '';
    }
    return value.slice(0, 10);
  }

  function normalizeSearchValue(value) {
    return String(value || '').trim().toLowerCase();
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
