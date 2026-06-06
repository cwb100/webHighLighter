(function () {
  const STORE_KEY = 'webHighlighterStore';
  const TOOLBAR_ID = 'wh-toolbar-host';
  const HIGHLIGHT_ATTR = 'data-wh-id';
  const HIGHLIGHT_CLASS = 'wh-highlight';
  const COLORS = [
    { name: 'Yellow', value: '#fff59d' },
    { name: 'Green', value: '#c8e6c9' },
    { name: 'Blue', value: '#bbdefb' },
    { name: 'Pink', value: '#f8bbd0' },
    { name: 'Orange', value: '#ffe0b2' }
  ];

  let toolbarHost = null;
  let toolbarShadow = null;
  let pendingRange = null;
  let selectionTimer = null;

  init();

  function init() {
    injectStyles();
    restoreHighlights();
    bindEvents();
  }

  function bindEvents() {
    document.addEventListener('mouseup', scheduleToolbar, true);
    document.addEventListener('keyup', scheduleToolbar, true);
    document.addEventListener('selectionchange', scheduleToolbar, true);
    window.addEventListener('scroll', hideToolbar, true);
    window.addEventListener('resize', hideToolbar, true);

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.type === 'WH_REMOVE_HIGHLIGHT' && typeof message.highlightId === 'string') {
        removeHighlightFromDom(message.highlightId);
        sendResponse({ ok: true });
      }
    });
  }

  function injectStyles() {
    if (document.getElementById('wh-highlight-style')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'wh-highlight-style';
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        border-radius: 2px;
        padding: 0 2px;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }

      .${HIGHLIGHT_CLASS}:hover {
        outline: 1px solid rgba(0, 0, 0, 0.25);
      }
    `;
    document.documentElement.appendChild(style);
  }

  function scheduleToolbar() {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => {
      const range = getCurrentSelectionRange();
      if (!range) {
        hideToolbar();
        return;
      }
      pendingRange = range.cloneRange();
      showToolbar(range);
    }, 25);
  }

  function getCurrentSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!document.body.contains(range.commonAncestorContainer)) {
      return null;
    }

    if (range.toString().trim().length === 0) {
      return null;
    }

    if (isWithinToolbar(range.commonAncestorContainer)) {
      return null;
    }

    if (selectionIntersectsHighlight(range)) {
      return null;
    }

    return range;
  }

  function isWithinToolbar(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element && element.closest && element.closest('#' + TOOLBAR_ID));
  }

  function selectionIntersectsHighlight(range) {
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

    return Boolean(ancestor && ancestor.closest && ancestor.closest('.' + HIGHLIGHT_CLASS));
  }

  function showToolbar(range) {
    ensureToolbar();
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideToolbar();
      return;
    }

    const left = Math.max(12, Math.min(window.innerWidth - 280, rect.left));
    const top = Math.max(12, rect.bottom + 10);

    toolbarHost.style.left = `${left}px`;
    toolbarHost.style.top = `${top}px`;
    toolbarHost.style.display = 'block';
  }

  function ensureToolbar() {
    if (toolbarHost) {
      return;
    }

    toolbarHost = document.createElement('div');
    toolbarHost.id = TOOLBAR_ID;
    toolbarHost.style.position = 'fixed';
    toolbarHost.style.zIndex = '2147483647';
    toolbarHost.style.display = 'none';

    toolbarShadow = toolbarHost.attachShadow({ mode: 'open' });
    toolbarShadow.innerHTML = `
      <style>
        .panel {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px;
          border-radius: 12px;
          background: #111827;
          color: #fff;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
          font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .label {
          margin-right: 4px;
          opacity: 0.8;
        }
        button {
          width: 24px;
          height: 24px;
          border: 0;
          border-radius: 999px;
          cursor: pointer;
          padding: 0;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25);
        }
        button:hover {
          transform: scale(1.05);
        }
      </style>
      <div class="panel" part="panel">
        <span class="label">Highlight</span>
        ${COLORS.map((color) => `<button title="${color.name}" aria-label="${color.name}" data-color="${color.value}" style="background:${color.value}"></button>`).join('')}
      </div>
    `;

    toolbarShadow.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    toolbarShadow.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }

      const color = target.getAttribute('data-color');
      if (!color || !pendingRange) {
        return;
      }

      await createHighlightFromRange(pendingRange, color);
      clearSelection();
      hideToolbar();
    });

    document.documentElement.appendChild(toolbarHost);
  }

  function hideToolbar() {
    if (!toolbarHost) {
      return;
    }
    toolbarHost.style.display = 'none';
  }

  function clearSelection() {
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }
    pendingRange = null;
  }

  async function createHighlightFromRange(range, color) {
    const id = createId();
    const { start, end, text } = getRangeOffsets(range);
    const quote = text;
    const contextWindow = 32;
    const documentText = getDocumentText();
    const record = {
      id,
      color,
      quote,
      start,
      end,
      prefix: documentText.slice(Math.max(0, start - contextWindow), start),
      suffix: documentText.slice(end, end + contextWindow),
      createdAt: new Date().toISOString()
    };

    wrapRange(range, id, color);
    await saveHighlight(record);
  }

  function wrapRange(range, id, color) {
    const wrapper = document.createElement('span');
    wrapper.className = HIGHLIGHT_CLASS;
    wrapper.setAttribute(HIGHLIGHT_ATTR, id);
    wrapper.dataset.whColor = color;
    wrapper.style.backgroundColor = color;

    const fragment = range.extractContents();
    wrapper.appendChild(fragment);
    range.insertNode(wrapper);
  }

  function removeHighlightFromDom(highlightId) {
    const selector = `span[${HIGHLIGHT_ATTR}="${CSS.escape(highlightId)}"]`;
    document.querySelectorAll(selector).forEach((element) => {
      unwrapElement(element);
    });
  }

  function unwrapElement(element) {
    const parent = element.parentNode;
    if (!parent) {
      return;
    }

    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element);
    }
    parent.removeChild(element);
    if (parent.nodeType === Node.ELEMENT_NODE && typeof parent.normalize === 'function') {
      parent.normalize();
    }
  }

  async function restoreHighlights() {
    const store = await readStore();
    const page = store.pages && store.pages[normalizeUrl(location.href)];
    if (!page || !Array.isArray(page.highlights) || page.highlights.length === 0) {
      return;
    }

    const highlights = [...page.highlights].sort((left, right) => left.start - right.start);
    for (const record of highlights) {
      const range = findRangeForRecord(record);
      if (!range) {
        continue;
      }
      wrapRange(range, record.id, record.color);
    }
  }

  function findRangeForRecord(record) {
    const body = document.body;
    if (!body || !record.quote) {
      return null;
    }

    const exact = locateRangeByOffsets(record.start, record.end);
    if (exact && exact.toString() === record.quote) {
      return exact;
    }

    const text = getDocumentText();
    const candidates = findAllOccurrences(text, record.quote);
    if (candidates.length === 0) {
      return null;
    }

    const scored = candidates.map((index) => ({
      index,
      score: contextScore(text, index, record)
    }));
    scored.sort((left, right) => right.score - left.score);

    for (const candidate of scored) {
      const range = locateRangeByOffsets(candidate.index, candidate.index + record.quote.length);
      if (range) {
        return range;
      }
    }

    return null;
  }

  function contextScore(text, index, record) {
    const prefix = text.slice(Math.max(0, index - record.prefix.length), index);
    const suffix = text.slice(index + record.quote.length, index + record.quote.length + record.suffix.length);
    return commonSuffixLength(prefix, record.prefix) + commonPrefixLength(suffix, record.suffix);
  }

  function commonPrefixLength(left, right) {
    let count = 0;
    while (count < left.length && count < right.length && left[count] === right[count]) {
      count += 1;
    }
    return count;
  }

  function commonSuffixLength(left, right) {
    let count = 0;
    while (
      count < left.length &&
      count < right.length &&
      left[left.length - 1 - count] === right[right.length - 1 - count]
    ) {
      count += 1;
    }
    return count;
  }

  function locateRangeByOffsets(startOffset, endOffset) {
    const root = document.body;
    const start = locateDomPosition(root, startOffset);
    const end = locateDomPosition(root, endOffset);
    if (!start || !end) {
      return null;
    }

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function locateDomPosition(root, targetOffset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement && node.parentElement.closest('#' + TOOLBAR_ID)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let offset = 0;
    let node = walker.nextNode();
    while (node) {
      const nextOffset = offset + node.nodeValue.length;
      if (targetOffset <= nextOffset) {
        return { node, offset: Math.max(0, targetOffset - offset) };
      }
      offset = nextOffset;
      node = walker.nextNode();
    }

    return null;
  }

  function getRangeOffsets(range) {
    const root = document.body;
    const start = offsetFromBoundary(root, range.startContainer, range.startOffset);
    const end = offsetFromBoundary(root, range.endContainer, range.endOffset);
    return {
      start,
      end,
      text: range.toString()
    };
  }

  function offsetFromBoundary(root, container, boundaryOffset) {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(container, boundaryOffset);
    return range.toString().length;
  }

  function getDocumentText() {
    return collectTextSegments(document.body).text;
  }

  function collectTextSegments(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement && node.parentElement.closest('#' + TOOLBAR_ID)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const segments = [];
    let text = '';
    let node = walker.nextNode();
    while (node) {
      const start = text.length;
      text += node.nodeValue;
      segments.push({ node, start, end: text.length });
      node = walker.nextNode();
    }
    return { segments, text };
  }

  function findAllOccurrences(text, query) {
    const positions = [];
    let index = 0;
    while (index >= 0) {
      index = text.indexOf(query, index);
      if (index === -1) {
        break;
      }
      positions.push(index);
      index += Math.max(1, query.length);
    }
    return positions;
  }

  async function saveHighlight(record) {
    const store = await readStore();
    const pageKey = normalizeUrl(location.href);
    const page = store.pages[pageKey] || {
      url: pageKey,
      title: document.title,
      updatedAt: new Date().toISOString(),
      highlights: []
    };

    const existingIndex = page.highlights.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) {
      page.highlights[existingIndex] = record;
    } else {
      page.highlights.push(record);
    }

    page.title = document.title;
    page.updatedAt = new Date().toISOString();
    store.pages[pageKey] = page;
    await writeStore(store);
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

  function createId() {
    if (crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `wh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
})();
