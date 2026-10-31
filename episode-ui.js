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
      // Query the verified iframe selection first. On the provider a real
      // series may have a /film/<id> URL and a film-classified watch session.
      const response = await chrome.runtime.sendMessage({
        action: 'kinoGetEpisodeIdentity', tabId: tab.id
      });
      if (sequence !== generation) return;
      const item = response?.ok ? response.identity : null;
      if (!item || !Number.isInteger(item.season) ||
          !Number.isInteger(item.episode)) return;
      let seriesId = candidateFromUrl(tab.url);
      const route = new URL(tab.url).pathname.match(/^\/(?:film|series)\/([1-9]\d{0,12})(?:\/|$)/);
      if (route && route[1] !== String(item.seriesId)) return;
      if (!seriesId) seriesId = String(item.seriesId);
      if (String(item.seriesId) !== seriesId) return;
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
