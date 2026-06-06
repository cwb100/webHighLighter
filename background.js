const DASHBOARD_URL = chrome.runtime.getURL('dashboard.html');

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setTitle({ title: 'Open highlighter console' });
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});
