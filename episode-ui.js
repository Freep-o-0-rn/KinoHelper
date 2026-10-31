// Compact, read-only series episode line in the existing "Сейчас смотрите" card.
// No diagnostic panels; never show guessed season/episode numbers.
(() => {
  'use strict';
  const line = document.getElementById('currentEpisodeInfo');
  if (!line) return;
  let generation = 0;

  function candidateFromUrl(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' ||
          !['brogiro.cfd', 'www.kinokino.vip', 'flcksbr.top'].includes(url.hostname))
        return null;
      const match = url.pathname.match(/^\/series\/([1-9]\d{0,12})(?:\/|$)/);
      return match ? match[1] : null;
    } catch { return null; }
  }

  async function render() {
    const sequence = ++generation;
    line.hidden = true;
    line.textContent = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (sequence !== generation || !Number.isInteger(tab?.id)) return;
      let seriesId = candidateFromUrl(tab.url);
      if (!seriesId) {
        const response = await chrome.runtime.sendMessage({
          action: 'getWatchSession', tabId: tab.id
        });
        if (sequence !== generation) return;
        const session = response?.ok ? response.session : null;
        if (session?.type === 'series' && session.currentUrl === tab.url &&
            /^[1-9]\d{0,12}$/.test(String(session.id))) {
          seriesId = String(session.id);
        }
      }
      if (!seriesId) return;
      const response = await chrome.runtime.sendMessage({
        action: 'kinoGetEpisodeIdentity', tabId: tab.id
      });
      if (sequence !== generation) return;
      const item = response?.ok ? response.identity : null;
      if (!item || String(item.seriesId) !== seriesId ||
          !Number.isInteger(item.season) || !Number.isInteger(item.episode)) return;
      line.textContent = 'Сезон ' + item.season + ' · Серия ' + item.episode;
      line.hidden = false;
    } catch { /* Do not show stale or invented episode details. */ }
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === 'kinoEpisodeSelectionChanged') void render();
    if (message?.action === 'kinoWatchSessionChanged') void render();
  });
  chrome.tabs.onActivated.addListener(() => void render());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (typeof info.url === 'string' || info.status === 'complete') void render();
  });
  chrome.tabs.onRemoved.addListener(() => void render());
  window.addEventListener('focus', () => void render());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void render();
  });
  // On a long-lived side panel, refresh after the service worker's 20-second
  // evidence TTL. A stale series episode must disappear automatically.
  setInterval(() => {
    if (!document.hidden) void render();
  }, 12000);
  void render();
})();
