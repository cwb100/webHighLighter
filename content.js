(function () {
  const TOOLBAR_ID = 'wh-toolbar-host';
  const ACTION_MENU_ID = 'wh-action-menu-host';
  const RAIL_ID = 'wh-rail-host';
  const RAIL_TOOLTIP_ID = 'wh-rail-tooltip-host';
  const HIGHLIGHT_ATTR = 'data-wh-id';
  const HIGHLIGHT_CLASS = 'wh-highlight';
  const STORE_REQUEST_EVENT = 'WH_STORE_REQUEST';
  const RESTORE_RETRY_LIMIT = 10;
  const RAIL_GROUP_GAP = 10;
  const RAIL_TOOLTIP_SINGLE_LIMIT = 80;
  const RAIL_TOOLTIP_GROUP_LIMIT = 50;
  const RAIL_TOOLTIP_GROUP_ITEMS = 4;
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
  let railHost = null;
  let railMarkersEl = null;
  let railTooltipEl = null;
  let pendingRange = null;
  let activeHighlightId = null;
  let selectionTimer = null;
  let restoreTimer = null;
  let railTimer = null;
  let railInteractionLock = false;
  let restoreRetryCount = 0;
  let restoreInFlight = false;
  let currentPageUrl = normalizeUrl(location.href);
  let domObserver = null;

  init();

  function init() {
    injectStyles();
    bindEvents();
    bindNavigationTracking();
    bindDomObserver();
    scheduleRestore(0, true);
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
    window.addEventListener('resize', scheduleRailRender, true);
    document.addEventListener('visibilitychange', handleVisibilityChange, true);
    window.addEventListener('pageshow', handlePageShow, true);
    window.addEventListener('popstate', handleLocationMaybeChanged, true);
    window.addEventListener('hashchange', handleLocationMaybeChanged, true);

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
        padding: 0;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
        cursor: pointer;
        line-height: inherit;
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
    if (!isWithinPage(range.commonAncestorContainer)) {
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
    const element = getClosestElement(node);
    return Boolean(element && element.closest && element.closest('#' + TOOLBAR_ID));
  }

  function isWithinActionMenu(node) {
    const element = getClosestElement(node);
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
    const element = getClosestElement(target);
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
    scheduleRailRender();
  }

  function bindNavigationTracking() {
    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');
  }

  function patchHistoryMethod(methodName) {
    const original = history[methodName];
    if (typeof original !== 'function' || original.__whPatched) {
      return;
    }

    const wrapped = function (...args) {
      const result = original.apply(this, args);
      handleLocationMaybeChanged();
      return result;
    };
    wrapped.__whPatched = true;
    history[methodName] = wrapped;
  }

  function bindDomObserver() {
    if (!(window.MutationObserver && document.documentElement)) {
      return;
    }

    domObserver = new MutationObserver((records) => {
      if (records.every(isExtensionMutation)) {
        return;
      }

      scheduleRestore(200, false);
      scheduleRailRender();
    });

    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function isExtensionMutation(record) {
    if (isExtensionNode(record.target)) {
      return true;
    }

    const changedNodes = [...record.addedNodes, ...record.removedNodes];
    return changedNodes.length > 0 && changedNodes.every(isExtensionNode);
  }

  function isExtensionNode(node) {
    if (!node) {
      return false;
    }

    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element && element.closest && element.closest(`#${TOOLBAR_ID}, #${ACTION_MENU_ID}, #${RAIL_ID}, #${RAIL_TOOLTIP_ID}`));
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      handleLocationMaybeChanged();
      scheduleRestore(100, false);
    }
  }

  function handlePageShow() {
    handleLocationMaybeChanged();
    scheduleRestore(100, false);
  }

  function handleLocationMaybeChanged() {
    const nextPageUrl = normalizeUrl(location.href);
    if (nextPageUrl === currentPageUrl) {
      return;
    }

    currentPageUrl = nextPageUrl;
    restoreRetryCount = 0;
    clearAllHighlightsFromDom();
    clearMarkerRail();
    hideActionMenu();
    hideToolbar();
    clearSelection();
    scheduleRestore(100, true);
  }

  function scheduleRestore(delay, resetRetries) {
    if (resetRetries) {
      restoreRetryCount = 0;
    }

    if (restoreTimer) {
      window.clearTimeout(restoreTimer);
    }

    restoreTimer = window.setTimeout(() => {
      restoreTimer = null;
      void restoreHighlights().catch((error) => {
        console.error('Failed to restore highlights:', error);
      });
    }, delay);
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
    return getAllTextNodes().filter((node) => {
      try {
        return range.intersectsNode(node);
      } catch (error) {
        return false;
      }
    });
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

    if (!textNode.nodeValue || textNode.nodeValue.trim().length === 0) {
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
    getHighlightElementsById(highlightId).forEach((element) => {
      unwrapElement(element);
    });
    if (activeHighlightId === highlightId) {
      hideActionMenu();
    }
    scheduleRailRender();
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

  function clearAllHighlightsFromDom() {
    getAllHighlightElements().forEach((element) => {
      unwrapElement(element);
    });
    clearMarkerRail();
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
      scheduleRailRender();
    }
  }

  function applyHighlightColorToDom(highlightId, color) {
    getHighlightElementsById(highlightId).forEach((element) => {
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
    if (restoreInFlight) {
      return;
    }

    restoreInFlight = true;
    const pageUrl = currentPageUrl;

    try {
      const highlights = await callStore('getHighlightsForPage', {
        pageUrl
      });
      if (!Array.isArray(highlights) || highlights.length === 0) {
        return;
      }

      let missingCount = 0;
      for (const record of highlights) {
        if (hasHighlightInDom(record.id)) {
          continue;
        }

        const range = findRangeForRecord(record);
        if (!range) {
          missingCount += 1;
          continue;
        }
        wrapRangeByTextNodes(range, record.id, record.color);
      }

      scheduleRailRender();

      if (pageUrl !== currentPageUrl) {
        return;
      }

      if (missingCount > 0 && restoreRetryCount < RESTORE_RETRY_LIMIT) {
        restoreRetryCount += 1;
        scheduleRestore(500, false);
        return;
      }

      restoreRetryCount = 0;
    } finally {
      restoreInFlight = false;
    }
  }

  function hasHighlightInDom(highlightId) {
    return getHighlightElementsById(highlightId).length > 0;
  }

  function scheduleRailRender() {
    if (railInteractionLock) {
      return;
    }

    if (railTimer) {
      window.clearTimeout(railTimer);
    }

    railTimer = window.setTimeout(() => {
      railTimer = null;
      renderMarkerRail();
    }, 80);
  }

  function ensureMarkerRail() {
    if (railHost) {
      return;
    }

    railHost = document.createElement('div');
    railHost.id = RAIL_ID;
    railHost.style.position = 'fixed';
    railHost.style.top = '24px';
    railHost.style.right = '24px';
    railHost.style.bottom = '24px';
    railHost.style.width = '22px';
    railHost.style.zIndex = '2147483646';
    railHost.style.pointerEvents = 'none';
    railHost.style.display = 'none';
    railHost.style.background = 'transparent';

    const track = document.createElement('div');
    track.style.position = 'absolute';
    track.style.top = '0';
    track.style.bottom = '0';
    track.style.left = '50%';
    track.style.width = '3px';
    track.style.transform = 'translateX(-50%)';
    track.style.borderRadius = '999px';
    track.style.background = 'rgba(17, 24, 39, 0.18)';
    track.style.pointerEvents = 'none';

    railMarkersEl = document.createElement('div');
    railMarkersEl.style.position = 'relative';
    railMarkersEl.style.height = '100%';
    railMarkersEl.style.width = '100%';
    railMarkersEl.style.pointerEvents = 'none';

    updateRailLayout();
    railHost.appendChild(track);
    railHost.appendChild(railMarkersEl);
    document.documentElement.appendChild(railHost);
  }

  function clearMarkerRail() {
    if (!railHost || !railMarkersEl) {
      return;
    }

    hideMarkerTooltip();
    railMarkersEl.innerHTML = '';
    railHost.style.display = 'none';
  }

  function renderMarkerRail() {
    hideMarkerTooltip();
    const entries = collectMarkerEntries();
    if (entries.length === 0) {
      clearMarkerRail();
      return;
    }

    ensureMarkerRail();
    updateRailLayout();
    if (!railMarkersEl) {
      return;
    }

    const railHeight = Math.max(120, railHost.clientHeight || window.innerHeight - 48);
    const groups = groupMarkerEntries(entries, railHeight);
    railMarkersEl.innerHTML = '';
    for (const group of groups) {
      railMarkersEl.appendChild(createMarkerGroupElement(group));
    }
    railHost.style.display = 'block';
  }

  function updateRailLayout() {
    if (!railHost) {
      return;
    }

    const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    railHost.style.right = `${scrollbarWidth + 8}px`;
  }

  function collectMarkerEntries() {
    const entries = [];
    const seen = new Set();

    for (const element of getAllHighlightElements()) {
      const highlightId = element.getAttribute(HIGHLIGHT_ATTR);
      if (!highlightId || seen.has(highlightId)) {
        continue;
      }

      const firstElement = getPrimaryHighlightElement(highlightId);
      if (!firstElement) {
        continue;
      }

      seen.add(highlightId);
      const color = normalizeColorValue(firstElement.getAttribute('data-wh-color') || firstElement.style.backgroundColor || COLORS[0].value);
      entries.push({
        highlightId,
        color,
        text: getHighlightText(highlightId),
        offset: getElementDocumentOffset(firstElement)
      });
    }

    entries.sort((left, right) => left.offset - right.offset);
    return entries;
  }

  function getPrimaryHighlightElement(highlightId) {
    const elements = getHighlightElementsById(highlightId);
    if (elements.length === 0) {
      return null;
    }

    return elements
      .slice()
      .sort((left, right) => getElementDocumentOffset(left) - getElementDocumentOffset(right))[0];
  }

  function getHighlightText(highlightId) {
    const text = getHighlightElementsById(highlightId)
      .slice()
      .sort((left, right) => getElementDocumentOffset(left) - getElementDocumentOffset(right))
      .map((element) => element.textContent || '')
      .join('');
    return normalizeTooltipText(text);
  }

  function groupMarkerEntries(entries, railHeight) {
    const scrollableHeight = Math.max(1, getScrollableHeight());
    const groups = [];

    for (const entry of entries) {
      const ratio = clamp(entry.offset / scrollableHeight, 0, 1);
      const topPx = Math.max(6, ratio * railHeight);
      const lastGroup = groups[groups.length - 1];

      if (lastGroup && Math.abs(lastGroup.topPx - topPx) < RAIL_GROUP_GAP) {
        lastGroup.entries.push(entry);
        lastGroup.topPx = (lastGroup.topPx * (lastGroup.entries.length - 1) + topPx) / lastGroup.entries.length;
        continue;
      }

      groups.push({
        topPx,
        entries: [entry]
      });
    }

    return groups;
  }

  function createMarkerGroupElement(group) {
    const first = group.entries[0];
    const uniqueColors = [...new Set(group.entries.map((entry) => entry.color))];
    const background = uniqueColors.length === 1
      ? uniqueColors[0]
      : `linear-gradient(180deg, ${uniqueColors.slice(0, 4).join(', ')})`;
    const isGrouped = group.entries.length > 1;

    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = isGrouped ? 'wh-rail-marker grouped' : 'wh-rail-marker';
    marker.setAttribute('data-highlight-id', first.highlightId);
    marker.setAttribute('aria-label', createMarkerAriaLabel(group.entries, isGrouped));
    marker.style.position = 'absolute';
    marker.style.left = '50%';
    marker.style.top = `${group.topPx}px`;
    marker.style.width = '22px';
    marker.style.height = '22px';
    marker.style.minHeight = '22px';
    marker.style.transform = 'translate(-50%, -50%)';
    marker.style.border = '1px solid rgba(17, 24, 39, 0.22)';
    marker.style.borderRadius = '999px';
    marker.style.boxShadow = '0 4px 12px rgba(17, 24, 39, 0.2)';
    marker.style.cursor = 'pointer';
    marker.style.pointerEvents = 'auto';
    marker.style.background = background;
    marker.style.padding = '0';
    marker.style.margin = '0';
    marker.style.display = 'block';
    marker.style.backgroundClip = 'padding-box';
    marker.style.overflow = 'visible';

    if (isGrouped) {
      marker.textContent = String(group.entries.length);
      marker.style.font = '700 9px/22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      marker.style.color = '#111827';
      marker.style.textAlign = 'center';
    }

    marker.addEventListener('mouseenter', () => {
      showMarkerTooltip(marker, group.entries, isGrouped);
    });
    marker.addEventListener('mouseleave', hideMarkerTooltip);
    marker.addEventListener('focus', () => {
      showMarkerTooltip(marker, group.entries, isGrouped);
    });
    marker.addEventListener('blur', hideMarkerTooltip);
    marker.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideMarkerTooltip();
      scrollToHighlight(first.highlightId);
    });

    return marker;
  }

  function showMarkerTooltip(marker, entries, isGrouped) {
    const tooltip = ensureMarkerTooltip();
    tooltip.innerHTML = '';
    tooltip.style.width = isGrouped ? '260px' : '220px';
    tooltip.style.maxWidth = 'min(260px, calc(100vw - 72px))';

    fillMarkerTooltip(tooltip, entries, isGrouped);
    tooltip.style.display = 'block';
    tooltip.style.visibility = 'hidden';
    tooltip.style.opacity = '0';

    const markerRect = marker.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const top = clamp(markerRect.top + markerRect.height / 2 - tooltipHeight / 2, 8, window.innerHeight - tooltipHeight - 8);
    const left = clamp(markerRect.left - tooltipWidth - 10, 8, window.innerWidth - tooltipWidth - 8);

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.visibility = 'visible';
    tooltip.style.opacity = '1';
  }

  function hideMarkerTooltip() {
    if (!railTooltipEl) {
      return;
    }

    railTooltipEl.style.opacity = '0';
    railTooltipEl.style.visibility = 'hidden';
    railTooltipEl.style.display = 'none';
  }

  function ensureMarkerTooltip() {
    if (railTooltipEl) {
      return railTooltipEl;
    }

    railTooltipEl = document.createElement('div');
    railTooltipEl.id = RAIL_TOOLTIP_ID;
    railTooltipEl.style.position = 'fixed';
    railTooltipEl.style.padding = '8px 10px';
    railTooltipEl.style.border = '1px solid rgba(17, 24, 39, 0.12)';
    railTooltipEl.style.borderRadius = '10px';
    railTooltipEl.style.background = 'rgba(17, 24, 39, 0.94)';
    railTooltipEl.style.boxShadow = '0 10px 28px rgba(17, 24, 39, 0.28)';
    railTooltipEl.style.color = '#ffffff';
    railTooltipEl.style.font = '500 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    railTooltipEl.style.textAlign = 'left';
    railTooltipEl.style.whiteSpace = 'normal';
    railTooltipEl.style.wordBreak = 'break-word';
    railTooltipEl.style.pointerEvents = 'none';
    railTooltipEl.style.opacity = '0';
    railTooltipEl.style.visibility = 'hidden';
    railTooltipEl.style.display = 'none';
    railTooltipEl.style.transition = 'opacity 90ms ease';
    railTooltipEl.style.zIndex = '2147483647';
    document.documentElement.appendChild(railTooltipEl);
    return railTooltipEl;
  }

  function fillMarkerTooltip(tooltip, entries, isGrouped) {
    if (!isGrouped) {
      tooltip.textContent = truncateTooltipText(entries[0] && entries[0].text, RAIL_TOOLTIP_SINGLE_LIMIT);
      return;
    }

    const title = document.createElement('span');
    title.textContent = `${entries.length} 条标记`;
    title.style.display = 'block';
    title.style.marginBottom = '5px';
    title.style.color = 'rgba(255, 255, 255, 0.72)';
    title.style.font = '700 11px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    tooltip.appendChild(title);

    entries.slice(0, RAIL_TOOLTIP_GROUP_ITEMS).forEach((entry, index) => {
      const item = document.createElement('span');
      item.textContent = `${index + 1}. ${truncateTooltipText(entry.text, RAIL_TOOLTIP_GROUP_LIMIT)}`;
      item.style.display = 'block';
      item.style.marginTop = index === 0 ? '0' : '3px';
      tooltip.appendChild(item);
    });

    if (entries.length > RAIL_TOOLTIP_GROUP_ITEMS) {
      const more = document.createElement('span');
      more.textContent = `... 还有 ${entries.length - RAIL_TOOLTIP_GROUP_ITEMS} 条`;
      more.style.display = 'block';
      more.style.marginTop = '4px';
      more.style.color = 'rgba(255, 255, 255, 0.72)';
      tooltip.appendChild(more);
    }
  }

  function createMarkerAriaLabel(entries, isGrouped) {
    const firstText = truncateTooltipText(entries[0] && entries[0].text, RAIL_TOOLTIP_GROUP_LIMIT);
    return isGrouped ? `${entries.length} 条标记：${firstText}` : `标记：${firstText}`;
  }

  function truncateTooltipText(text, limit) {
    const normalized = normalizeTooltipText(text);
    if (normalized.length <= limit) {
      return normalized;
    }
    return normalized.slice(0, Math.max(0, limit - 3)).trimEnd() + '...';
  }

  function normalizeTooltipText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    return normalized || '标记内容为空';
  }

  function scrollToHighlight(highlightId) {
    const target = getPrimaryHighlightElement(highlightId);
    if (!target) {
      return;
    }

    lockRailInteraction();
    const rect = target.getBoundingClientRect();
    const targetTop = rect.top + window.scrollY - (window.innerHeight / 2) + (rect.height / 2);
    window.scrollTo({
      top: Math.max(0, targetTop),
      behavior: 'smooth'
    });
    flashHighlight(target);
  }

  function flashHighlight(element) {
    const previousTransition = element.style.transition;
    const previousBoxShadow = element.style.boxShadow;
    element.style.transition = 'box-shadow 180ms ease';
    element.style.boxShadow = '0 0 0 3px rgba(37, 99, 235, 0.55)';
    window.setTimeout(() => {
      element.style.boxShadow = previousBoxShadow;
      element.style.transition = previousTransition;
    }, 900);
  }

  function getScrollableHeight() {
    const doc = document.documentElement;
    const body = document.body;
    const scrollHeight = Math.max(
      doc ? doc.scrollHeight : 0,
      body ? body.scrollHeight : 0
    );
    return Math.max(1, scrollHeight - window.innerHeight);
  }

  function getElementDocumentOffset(element) {
    const rect = element.getBoundingClientRect();
    return rect.top + window.scrollY;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lockRailInteraction() {
    railInteractionLock = true;
    window.setTimeout(() => {
      railInteractionLock = false;
      scheduleRailRender();
    }, 450);
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
    const segments = collectTextSegments(root).segments;
    for (const segment of segments) {
      if (targetOffset <= segment.end) {
        return {
          node: segment.node,
          offset: Math.max(0, targetOffset - segment.start)
        };
      }
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
    if (node && node.getRootNode && node.getRootNode() instanceof ShadowRoot) {
      return null;
    }

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
    const segments = collectTextSegments(root).segments;
    let offset = 0;

    for (const segment of segments) {
      if (segment.node === container) {
        return offset + Math.max(0, Math.min(boundaryOffset, segment.node.nodeValue.length));
      }
      offset = segment.end;
    }

    return offset;
  }

  function getDocumentText() {
    return collectTextSegments(document.body).text;
  }

  function collectTextSegments(root) {
    const segments = [];
    let text = '';
    for (const node of getAllTextNodes(root)) {
      const start = text.length;
      text += node.nodeValue;
      segments.push({ node, start, end: text.length });
    }
    return { segments, text };
  }

  function getAllTextNodes(root) {
    const nodes = [];
    walkTextNodes(root || document.body, nodes);
    return nodes;
  }

  function walkTextNodes(node, result) {
    if (!node) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      if (shouldIncludeTextNode(node)) {
        result.push(node);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }

    const childNodes = Array.from(node.childNodes || []);
    for (const child of childNodes) {
      walkTextNodes(child, result);
    }

    if (node instanceof Element && node.shadowRoot) {
      walkTextNodes(node.shadowRoot, result);
    }
  }

  function shouldIncludeTextNode(node) {
    if (!node || !node.nodeValue) {
      return false;
    }

    const element = getClosestElement(node);
    if (!element) {
      return false;
    }

    if (element.closest('#' + TOOLBAR_ID) || element.closest('#' + ACTION_MENU_ID)) {
      return false;
    }

    if (element.closest('.' + HIGHLIGHT_CLASS)) {
      return false;
    }

    return true;
  }

  function getAllHighlightElements() {
    const elements = [];
    walkHighlightElements(document.body, elements);
    return elements;
  }

  function walkHighlightElements(node, result) {
    if (!node) {
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }

    const childNodes = Array.from(node.childNodes || []);
    for (const child of childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.classList.contains(HIGHLIGHT_CLASS) && child.hasAttribute(HIGHLIGHT_ATTR)) {
          result.push(child);
        }
        walkHighlightElements(child, result);
      }
    }

    if (node instanceof Element && node.shadowRoot) {
      walkHighlightElements(node.shadowRoot, result);
    }
  }

  function getHighlightElementsById(highlightId) {
    return getAllHighlightElements().filter((element) => element.getAttribute(HIGHLIGHT_ATTR) === highlightId);
  }

  function getClosestElement(node) {
    if (!node) {
      return null;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      return node;
    }

    if (node.parentElement) {
      return node.parentElement;
    }

    const root = node.getRootNode && node.getRootNode();
    if (root instanceof ShadowRoot) {
      return root.host || null;
    }

    return null;
  }

  function isWithinPage(node) {
    if (!node) {
      return false;
    }

    if (document.body.contains(node)) {
      return true;
    }

    let current = node;
    while (current) {
      const root = current.getRootNode && current.getRootNode();
      if (!(root instanceof ShadowRoot) || !root.host) {
        break;
      }

      if (document.body.contains(root.host)) {
        return true;
      }

      current = root.host;
    }

    return false;
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
