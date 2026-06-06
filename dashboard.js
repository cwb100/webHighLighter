(function () {
  const pagesEl = document.getElementById('pages');
  const pageCountEl = document.getElementById('page-count');
  const highlightCountEl = document.getElementById('highlight-count');
  const refreshBtn = document.getElementById('refresh-btn');
  const exportDataBtn = document.getElementById('export-data-btn');
  const importDataBtn = document.getElementById('import-data-btn');
  const importFileInput = document.getElementById('import-file-input');
  const clearSearchBtn = document.getElementById('clear-search-btn');
  const dashboardStatus = document.getElementById('dashboard-status');
  const filterTitleInput = document.getElementById('filter-title');
  const filterUrlInput = document.getElementById('filter-url');
  const filterTextInput = document.getElementById('filter-text');
  const filterColorInput = document.getElementById('filter-color');
  const filterDateInput = document.getElementById('filter-date');
  const STORE_UPDATED_EVENT = 'WH_STORE_UPDATED';

  const EMPTY_HTML = '<div class="empty">还没有任何网页被划线。</div>';
  const NO_MATCH_HTML = '<div class="empty">没有匹配的标记。</div>';
  const LOAD_ERROR_HTML = '<div class="empty">加载划线数据失败。</div>';
  const EMPTY_PAGE_HIGHLIGHTS_HTML = '<div class="empty">这一页还没有具体标记。</div>';

  const filters = {
    title: '',
    url: '',
    text: '',
    color: '',
    date: ''
  };

  let renderTimer = null;

  refreshBtn.addEventListener('click', render);
  exportDataBtn.addEventListener('click', handleExportData);
  importDataBtn.addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', handleImportFile);
  clearSearchBtn.addEventListener('click', handleClearFilters);
  filterTitleInput.addEventListener('input', handleFilterInput);
  filterUrlInput.addEventListener('input', handleFilterInput);
  filterTextInput.addEventListener('input', handleFilterInput);
  filterColorInput.addEventListener('input', handleFilterInput);
  filterDateInput.addEventListener('input', handleFilterInput);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  render();

  async function render() {
    try {
      const pages = await webHighlighterStore.getPagesWithHighlights();
      const filteredPages = filterPages(pages, filters);

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

  function handleFilterInput() {
    filters.title = normalizeSearchValue(filterTitleInput.value);
    filters.url = normalizeSearchValue(filterUrlInput.value);
    filters.text = normalizeSearchValue(filterTextInput.value);
    filters.color = normalizeSearchValue(filterColorInput.value);
    filters.date = normalizeDateValue(filterDateInput.value);
    scheduleRender();
  }

  function handleClearFilters() {
    filters.title = '';
    filters.url = '';
    filters.text = '';
    filters.color = '';
    filters.date = '';

    filterTitleInput.value = '';
    filterUrlInput.value = '';
    filterTextInput.value = '';
    filterColorInput.value = '';
    filterDateInput.value = '';

    scheduleRender();
  }

  function handleRuntimeMessage(message) {
    if (!message || message.type !== STORE_UPDATED_EVENT) {
      return;
    }

    scheduleRender();
  }

  async function handleExportData() {
    try {
      const data = await webHighlighterStore.exportData();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `web-highlighter-backup-${formatToday()}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus('数据已导出为 JSON 备份文件。');
    } catch (error) {
      console.error('Failed to export data:', error);
      setStatus('导出失败，请稍后重试。');
    }
  }

  async function handleImportFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const summary = webHighlighterStore.getBackupSummary(data);
      const confirmed = window.confirm(
        `确认导入这个备份文件吗？\n\n页面：${summary.pageCount}\n标记：${summary.highlightCount}\n\n导入会与现有数据合并，不会清空当前数据。`
      );
      if (!confirmed) {
        return;
      }

      const result = await webHighlighterStore.importData(data);
      await render();
      setStatus(`导入完成：新增 ${result.importedHighlights} 条标记，跳过 ${result.skippedHighlights} 条重复标记。`);
    } catch (error) {
      console.error('Failed to import data:', error);
      setStatus('导入失败，请确认选择的是 Web Highlighter JSON 备份文件。');
    }
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
      <div class="highlight-item" data-open-page="${escapeHtml(pageKey)}" data-highlight-id="${escapeHtml(highlight.id)}" data-page-key="${escapeHtml(pageKey)}">
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
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
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

    document.querySelectorAll('[data-open-page]').forEach((item) => {
      item.addEventListener('click', async (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest('[data-delete-highlight]')) {
          return;
        }

        const url = item.getAttribute('data-open-page');
        if (!url) {
          return;
        }

        await openPage(url);
      });
    });
  }

  async function openPage(url) {
    return new Promise((resolve) => {
      chrome.tabs.create({ url }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.error('Failed to open page from dashboard:', error);
        }
        resolve();
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

  function filterPages(pages, activeFilters) {
    if (!hasActiveFilters(activeFilters)) {
      return pages;
    }

    const results = [];
    for (const page of pages) {
      const highlights = filterHighlightsForPage(page, activeFilters);
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

  function hasActiveFilters(activeFilters) {
    return Object.values(activeFilters).some(Boolean);
  }

  function filterHighlightsForPage(page, activeFilters) {
    const highlights = Array.isArray(page.highlights) ? page.highlights : [];
    return highlights.filter((highlight) => matchesFilters(page, highlight, activeFilters));
  }

  function matchesFilters(page, highlight, activeFilters) {
    if (activeFilters.title && !normalizeSearchValue(page.title).includes(activeFilters.title)) {
      return false;
    }

    if (activeFilters.url && !normalizeSearchValue(page.url).includes(activeFilters.url)) {
      return false;
    }

    if (activeFilters.text && !normalizeSearchValue(highlight.quote).includes(activeFilters.text)) {
      return false;
    }

    if (activeFilters.color && !normalizeSearchValue(highlight.color).includes(activeFilters.color)) {
      return false;
    }

    if (activeFilters.date && formatHighlightDate(highlight.createdAt) !== activeFilters.date) {
      return false;
    }

    return true;
  }

  function formatHighlightDate(value) {
    if (typeof value !== 'string' || value.length < 10) {
      return '';
    }
    return value.slice(0, 10);
  }

  function normalizeDateValue(value) {
    return String(value || '').trim();
  }

  function normalizeSearchValue(value) {
    return String(value || '').trim().toLowerCase();
  }

  function formatToday() {
    return new Date().toISOString().slice(0, 10);
  }

  function setStatus(message) {
    dashboardStatus.textContent = message;
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
