(function () {
  const TOOLBAR_ID = 'wh-toolbar-host';
  const ACTION_MENU_ID = 'wh-action-menu-host';
  const HIGHLIGHT_ATTR = 'data-wh-id';
  const HIGHLIGHT_CLASS = 'wh-highlight';
  const STORE_REQUEST_EVENT = 'WH_STORE_REQUEST';
  const COLORS = [
    { name: 'Yellow', value: '#fff59d' },
    { name: 'Green', value: '#c8e6c9' },
    { name: 'Blue', value: '#bbdefb' },
    { name: 'Pink', value: '#f8bbd0' },
    { name: 'Orange', value: '#ffe0b2' }
  ];

  let toolbarHost = null;
  let toolbarShadow = null;
  let actionMenuHost = null;
  let actionMenuShadow = null;
  let pendingRange = null;
  let activeHighlightId = null;
  let selectionTimer = null;

  init();

  function init() {
    injectStyles();
    void restoreHighlights().catch((error) => {
      console.error('Failed to restore highlights:', error);
    });
    bindEvents();
  }

  function bindEvents() {
    document.addEventListener('mouseup', scheduleToolbar, true);
    document.addEventListener('keyup', scheduleToolbar, true);
    document.addEventListener('selectionchange', scheduleToolbar, true);
    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('keydown', handleDocumentKeydown, true);
    window.addEventListener('scroll', hideToolbar, true);
    window.addEventListener('scroll', hideActionMenu, true);
    window.addEventListener('resize', hideToolbar, true);
    window.addEventListener('resize', hideActionMenu, true);

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
        cursor: pointer;
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

  function isWithinActionMenu(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element && element.closest && element.closest('#' + ACTION_MENU_ID));
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

  function handleDocumentClick(event) {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (isWithinActionMenu(target)) {
      return;
    }

    const highlightElement = getHighlightElementFromTarget(target);
    if (highlightElement) {
      event.preventDefault();
      event.stopPropagation();
      openActionMenu(highlightElement);
      hideToolbar();
      clearSelection();
      return;
    }

    hideActionMenu();
  }

  function handleDocumentKeydown(event) {
    if (event.key === 'Escape') {
      hideActionMenu();
      hideToolbar();
      clearSelection();
    }
  }

  function getHighlightElementFromTarget(target) {
    const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    if (!element || !element.closest) {
      return null;
    }

    return element.closest(`.${HIGHLIGHT_CLASS}`);
  }

  function openActionMenu(highlightElement) {
    const highlightId = highlightElement.getAttribute(HIGHLIGHT_ATTR);
    if (!highlightId) {
      return;
    }

    activeHighlightId = highlightId;
    ensureActionMenu();
    renderActionMenu(highlightElement);
    positionActionMenu(highlightElement);
    actionMenuHost.style.display = 'block';
  }

  function ensureActionMenu() {
    if (actionMenuHost) {
      return;
    }

    actionMenuHost = document.createElement('div');
    actionMenuHost.id = ACTION_MENU_ID;
    actionMenuHost.style.position = 'fixed';
    actionMenuHost.style.zIndex = '2147483647';
    actionMenuHost.style.display = 'none';

    actionMenuShadow = actionMenuHost.attachShadow({ mode: 'open' });
    actionMenuShadow.innerHTML = `
      <style>
        .panel {
          min-width: 280px;
          max-width: 320px;
          padding: 12px;
          border-radius: 14px;
          background: #111827;
          color: #fff;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
          font: 12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 10px;
        }
        .title {
          font-size: 13px;
          font-weight: 600;
        }
        .delete-btn {
          border: 0;
          border-radius: 10px;
          padding: 8px 12px;
          background: #ef4444;
          color: #fff;
          cursor: pointer;
        }
        .section {
          margin-top: 10px;
        }
        .section-label {
          display: block;
          margin-bottom: 8px;
          opacity: 0.8;
        }
        .preset-colors {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 8px;
        }
        .color-btn {
          width: 100%;
          height: 28px;
          border: 0;
          border-radius: 999px;
          cursor: pointer;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25);
        }
        .custom-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-top: 10px;
        }
        .custom-row input[type="color"] {
          width: 42px;
          height: 32px;
          padding: 0;
          border: 0;
          background: transparent;
          cursor: pointer;
        }
        .hint {
          opacity: 0.7;
        }
      </style>
      <div class="panel" part="panel">
        <div class="row">
          <div class="title">已高亮文本操作</div>
          <button type="button" class="delete-btn" data-action="delete">删除</button>
        </div>
        <div class="section">
          <span class="section-label">调整颜色</span>
          <div class="preset-colors">
            ${COLORS.map((color) => `<button type="button" class="color-btn" title="${color.name}" aria-label="${color.name}" data-color="${color.value}" style="background:${color.value}"></button>`).join('')}
          </div>
          <div class="custom-row">
            <input type="color" data-action="custom-color" value="#fff59d" />
            <span class="hint">自定义颜色</span>
          </div>
        </div>
      </div>
    `;

    actionMenuShadow.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    actionMenuShadow.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const action = target.getAttribute('data-action');
      const color = target.getAttribute('data-color');

      if (action === 'delete') {
        await deleteHighlightById(activeHighlightId);
        return;
      }

      if (color) {
        await updateHighlightColor(activeHighlightId, color);
        return;
      }
    });

    actionMenuShadow.addEventListener('change', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) {
        return;
      }

      if (target.getAttribute('data-action') === 'custom-color') {
        await updateHighlightColor(activeHighlightId, target.value);
      }
    });

    document.documentElement.appendChild(actionMenuHost);
  }

  function renderActionMenu(highlightElement) {
    const currentColor = normalizeColorValue(highlightElement.getAttribute('data-wh-color') || highlightElement.style.backgroundColor || COLORS[0].value);
    const colorInput = actionMenuShadow.querySelector('input[type="color"]');
    if (colorInput instanceof HTMLInputElement && isHexColor(currentColor)) {
      colorInput.value = currentColor;
    }
  }

  function positionActionMenu(highlightElement) {
    const rect = highlightElement.getBoundingClientRect();
    const width = 320;
    const height = 220;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
    const preferredTop = rect.bottom + 10;
    const top = preferredTop + height > window.innerHeight ? Math.max(12, rect.top - height - 10) : preferredTop;

    actionMenuHost.style.left = `${left}px`;
    actionMenuHost.style.top = `${top}px`;
  }

  function hideActionMenu() {
    if (!actionMenuHost) {
      return;
    }

    actionMenuHost.style.display = 'none';
    activeHighlightId = null;
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
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      startPath: getNodePath(range.startContainer),
      endPath: getNodePath(range.endContainer),
      prefix: documentText.slice(Math.max(0, start - contextWindow), start),
      suffix: documentText.slice(end, end + contextWindow),
      createdAt: new Date().toISOString()
    };

    wrapRangeByTextNodes(range, id, color);
    const page = {
      url: normalizeUrl(location.href),
      title: document.title
    };
    await saveHighlight(page, record);
  }

  function wrapRangeByTextNodes(range, id, color) {
    const textNodes = getTextNodesInRange(range);
    for (let index = textNodes.length - 1; index >= 0; index -= 1) {
      const node = textNodes[index];
      const offsets = getTextNodeSelectionOffsets(range, node);
      wrapTextSlice(node, offsets.startOffset, offsets.endOffset, id, color);
    }
  }

  function getTextNodesInRange(range) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) {
          return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (parent && (parent.closest('#' + TOOLBAR_ID) || parent.closest('#' + ACTION_MENU_ID))) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent && parent.closest('.' + HIGHLIGHT_CLASS)) {
          return NodeFilter.FILTER_REJECT;
        }

        try {
          return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        } catch (error) {
          return NodeFilter.FILTER_REJECT;
        }
      }
    });

    const nodes = [];
    let current = walker.nextNode();
    while (current) {
      nodes.push(current);
      current = walker.nextNode();
    }
    return nodes;
  }

  function getTextNodeSelectionOffsets(range, node) {
    const startOffset = range.startContainer === node ? range.startOffset : 0;
    const endOffset = range.endContainer === node ? range.endOffset : node.nodeValue.length;
    return {
      startOffset,
      endOffset
    };
  }

  function wrapTextSlice(node, startOffset, endOffset, id, color) {
    if (!node || !node.nodeValue || startOffset >= endOffset) {
      return null;
    }

    if (endOffset < node.nodeValue.length) {
      node.splitText(endOffset);
    }

    let selectedNode = node;
    if (startOffset > 0) {
      selectedNode = node.splitText(startOffset);
    }

    return wrapTextNode(selectedNode, id, color);
  }

  function wrapTextNode(textNode, id, color) {
    const parent = textNode.parentNode;
    if (!parent) {
      return null;
    }

    const wrapper = document.createElement('span');
    wrapper.className = HIGHLIGHT_CLASS;
    wrapper.setAttribute(HIGHLIGHT_ATTR, id);
    wrapper.dataset.whColor = color;
    wrapper.style.backgroundColor = color;

    parent.insertBefore(wrapper, textNode);
    wrapper.appendChild(textNode);
    return wrapper;
  }

  function removeHighlightFromDom(highlightId) {
    const selector = `span[${HIGHLIGHT_ATTR}="${CSS.escape(highlightId)}"]`;
    document.querySelectorAll(selector).forEach((element) => {
      unwrapElement(element);
    });
    if (activeHighlightId === highlightId) {
      hideActionMenu();
    }
  }

  async function deleteHighlightById(highlightId) {
    if (!highlightId) {
      return;
    }

    const pageKey = normalizeUrl(location.href);
    const removed = await callStore('deleteHighlight', {
      pageUrl: pageKey,
      highlightId
    });
    if (removed) {
      removeHighlightFromDom(highlightId);
      hideActionMenu();
    }
  }

  async function updateHighlightColor(highlightId, color) {
    if (!highlightId || !color) {
      return;
    }

    const pageKey = normalizeUrl(location.href);
    const highlight = await callStore('updateHighlightColor', {
      pageUrl: pageKey,
      highlightId,
      color
    });
    if (highlight) {
      applyHighlightColorToDom(highlightId, color);
      hideActionMenu();
    }
  }

  function applyHighlightColorToDom(highlightId, color) {
    const selector = `span[${HIGHLIGHT_ATTR}="${CSS.escape(highlightId)}"]`;
    document.querySelectorAll(selector).forEach((element) => {
      element.dataset.whColor = color;
      element.style.backgroundColor = color;
    });
  }

  function normalizeColorValue(color) {
    if (!color) {
      return COLORS[0].value;
    }

    if (color.startsWith('rgb')) {
      return rgbToHex(color);
    }

    return color;
  }

  function isHexColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(value);
  }

  function rgbToHex(color) {
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) {
      return COLORS[0].value;
    }

    const toHex = (value) => Number(value).toString(16).padStart(2, '0');
    return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
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
    const highlights = await callStore('getHighlightsForPage', {
      pageUrl: normalizeUrl(location.href)
    });
    if (!Array.isArray(highlights) || highlights.length === 0) {
      return;
    }

    for (const record of highlights) {
      const range = findRangeForRecord(record);
      if (!range) {
        continue;
      }
      wrapRangeByTextNodes(range, record.id, record.color);
    }
  }

  function findRangeForRecord(record) {
    const body = document.body;
    if (!body || !record.quote) {
      return null;
    }

    const storedRange = locateRangeByStoredPaths(record);
    if (storedRange && storedRange.toString() === record.quote) {
      return storedRange;
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

  function locateRangeByStoredPaths(record) {
    if (!Array.isArray(record.startPath) || !Array.isArray(record.endPath)) {
      return null;
    }

    const startNode = resolveNodePath(record.startPath);
    const endNode = resolveNodePath(record.endPath);
    if (!startNode || !endNode) {
      return null;
    }

    const startOffset = clampBoundaryOffset(startNode, record.startOffset);
    const endOffset = clampBoundaryOffset(endNode, record.endOffset);
    if (startOffset == null || endOffset == null) {
      return null;
    }

    try {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    } catch (error) {
      return null;
    }
  }

  function resolveNodePath(path) {
    let current = document.body;
    for (const index of path) {
      if (!current || !current.childNodes || index < 0 || index >= current.childNodes.length) {
        return null;
      }
      current = current.childNodes[index];
    }
    return current;
  }

  function clampBoundaryOffset(node, offset) {
    if (typeof offset !== 'number') {
      return null;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return Math.max(0, Math.min(offset, node.nodeValue.length));
    }

    return Math.max(0, Math.min(offset, node.childNodes.length));
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

  function getNodePath(node) {
    const path = [];
    let current = node;

    while (current && current !== document.body) {
      const parent = current.parentNode;
      if (!parent) {
        return null;
      }

      const index = Array.prototype.indexOf.call(parent.childNodes, current);
      if (index < 0) {
        return null;
      }

      path.unshift(index);
      current = parent;
    }

    return path;
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

  async function saveHighlight(page, record) {
    await callStore('saveHighlight', {
      page,
      highlight: record
    });
  }

  function callStore(action, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: STORE_REQUEST_EVENT,
          action,
          payload
        },
        (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }

          if (!response || response.ok !== true) {
            reject(new Error(response && response.error ? response.error : 'Store request failed'));
            return;
          }

          resolve(response.result);
        }
      );
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

  function createId() {
    if (crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `wh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})();
