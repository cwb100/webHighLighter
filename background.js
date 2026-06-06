importScripts('storage.js');

const DASHBOARD_URL = chrome.runtime.getURL('dashboard.html');
const STORE_UPDATED_EVENT = 'WH_STORE_UPDATED';
const STORE_REQUEST_EVENT = 'WH_STORE_REQUEST';

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setTitle({ title: 'Open highlighter console' });
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type !== STORE_REQUEST_EVENT) {
    return;
  }

  void handleStoreRequest(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error('Store request failed:', error);
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : 'Unknown store request failure'
      });
    });

  return true;
});

async function handleStoreRequest(message) {
  const { action, payload } = message;
  switch (action) {
    case 'getHighlightsForPage':
      return webHighlighterStore.getHighlightsForPage(payload.pageUrl);
    case 'saveHighlight': {
      await webHighlighterStore.saveHighlight(payload.page, payload.highlight);
      await broadcastStoreUpdated(payload.page.url, 'create');
      return true;
    }
    case 'deleteHighlight': {
      const removed = await webHighlighterStore.deleteHighlight(payload.pageUrl, payload.highlightId);
      if (removed) {
        await broadcastStoreUpdated(payload.pageUrl, 'delete');
      }
      return removed;
    }
    case 'updateHighlightColor': {
      const highlight = await webHighlighterStore.updateHighlightColor(
        payload.pageUrl,
        payload.highlightId,
        payload.color
      );
      if (highlight) {
        await broadcastStoreUpdated(payload.pageUrl, 'update-color');
      }
      return highlight;
    }
    case 'exportData':
      return webHighlighterStore.exportData();
    case 'importData': {
      const result = await webHighlighterStore.importData(payload.data);
      await broadcastStoreUpdated('', 'import');
      return result;
    }
    default:
      throw new Error(`Unsupported store action: ${action}`);
  }
}

async function broadcastStoreUpdated(pageUrl, change) {
  try {
    await chrome.runtime.sendMessage({
      type: STORE_UPDATED_EVENT,
      pageUrl,
      change
    });
  } catch (error) {
    console.debug('Failed to broadcast store update:', error);
  }
}
