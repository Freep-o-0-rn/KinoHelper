// Display saved playback progress in History and in a separate last-opened card.
// This module only reads progress; video seeking/restoration is a later stage.
(() => {
  'use strict';
  const PROGRESS_KEY = 'kinoPlaybackProgressV1';
  const HISTORY_KEY = 'kinopoiskHistory';
  const panel = document.getElementById('resumeLast');
  const lastTitle = document.getElementById('resumeLastTitle');
  const lastMeta = document.getElementById('resumeLastMeta');
  const lastProgress = document.getElementById('resumeLastProgress');
  const lastOpen = document.getElementById('resumeLastOpen');
  if (!panel || !lastTitle || !lastMeta || !lastProgress || !lastOpen) return;

  let progress = Object.create(null);
  let history = [];
  let currentKey = '';
  let selected = null;
  let storageReadSequence = 0;
  let tabReadSequence = 0;

  function mediaFromUrl(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      const match = url.pathname.match(/^\/(film|series)\/([1-9]\d{0,12})(?:\/|$)/);
      return match ? { type: match[1], id: match[2], key: match[1] + ':' + match[2] }
        : null;
    } catch {
      return null;
    }
  }

  function validEntry(item) {
    return Boolean(item && item.type === 'film' &&
      /^\d+$/.test(String(item.id || '')) &&
      Number.isFinite(item.position) && item.position >= 0 &&
      Number.isFinite(item.duration) && item.duration >= 60 &&
      item.duration <= 8 * 3600 &&
      item.position <= item.duration + 2 &&
      Number.isFinite(item.updatedAt) && item.updatedAt > 0);
  }

  function positionFor(key) {
    if (!/^film:\d+$/.test(key)) return null;
    const item = progress[key];
    return validEntry(item) && key === 'film:' + String(item.id) ? item : null;
  }

  function percentage(item) {
    // Без события завершения не показываем ложные 100% при округлении.
    return item.completed ? 100 :
      Math.max(0, Math.min(99, Math.round(item.position / item.duration * 100)));
  }

  function formatTime(value) {
    const time = Math.max(0, Math.floor(value));
    const h = Math.floor(time / 3600);
    const m = Math.floor(time % 3600 / 60);
    const s = time % 60;
    return h > 0 ? h + ':' + String(m).padStart(2, '0') +
      ':' + String(s).padStart(2, '0') :
      m + ':' + String(s).padStart(2, '0');
  }

  function makeTrack(item, className) {
    const track = document.createElement('div');
    track.className = className;
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', item.completed ?
      'Фильм просмотрен' : 'Прогресс фильма');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(percentage(item)));
    const fill = document.createElement('div');
    fill.className = 'resume-progress-fill';
    fill.style.width = percentage(item) + '%';
    track.appendChild(fill);
    if (item.completed) track.classList.add('complete');
    return track;
  }

  function updateTrack(track, item) {
    const percent = percentage(item);
    track.setAttribute('aria-valuenow', String(percent));
    track.setAttribute('aria-label', item.completed ?
      'Фильм просмотрен' : 'Прогресс фильма');
    track.className = track.className.replace(/\\scomplete\\b/g, '') +
      (item.completed ? ' complete' : '');
    const fill = track.querySelector('.resume-progress-fill');
    if (fill) fill.style.width = percent + '%';
  }

  function decorateHistory() {
    const rows = document.querySelectorAll('.history-item[data-kino-media-key]');
    for (const row of rows) {
      const key = row.dataset.kinoMediaKey;
      const item = positionFor(key);
      let block = row.querySelector('.history-item-progress');
      if (!item) {
        if (block) block.remove();
        continue;
      }

      const content = row.querySelector('.history-item-main');
      if (!content) continue;
      if (!block) {
        block = document.createElement('div');
        block.className = 'history-item-progress';
        const label = document.createElement('div');
        label.className = 'history-progress-label';
        block.append(makeTrack(item, 'history-progress-track'), label);
        content.appendChild(block);
      }
      const pct = percentage(item);
      const track = block.querySelector('.history-progress-track');
      if (track) updateTrack(track, item);
      const label = block.querySelector('.history-progress-label');
      if (label) label.textContent = item.completed
        ? '✓ Просмотрено · ' + formatTime(item.duration)
        : formatTime(item.position) + ' / ' + formatTime(item.duration) +
          ' · ' + pct + '%';
    }
  }

  function recentCandidates() {
    // Preserve the user's own history ordering and timestamp, even when the
    // entry was imported from an earlier extension version.
    const unique = new Map();
    for (const entry of history) {
      if (!entry || typeof entry.url !== 'string') continue;
      const media = mediaFromUrl(entry.url);
      if (!media || unique.has(media.key)) continue;
      const saved = positionFor(media.key);
      // Finished films are excluded from the last-view card. The historical
      // entry still displays its 100% progress bar.
      if (saved?.completed) continue;
      const activity = Math.max(
        Number.isFinite(entry.timestamp) ? entry.timestamp : 0,
        Number.isFinite(saved?.updatedAt) ? saved.updatedAt : 0
      );
      unique.set(media.key, {
        media, entry, saved,
        activity,
        hasPlayback: Boolean(saved && saved.position >= 2)
      });
    }
    return [...unique.values()].sort((a, b) =>
      b.activity - a.activity || Number(b.hasPlayback) - Number(a.hasPlayback));
  }

  function renderLast() {
    const latest = recentCandidates().find(item => item.media.key !== currentKey);
    selected = latest || null;
    panel.hidden = !selected;
    if (!selected) return;

    lastTitle.textContent = String(selected.entry.title || '').trim() ||
      (selected.media.type === 'series' ? 'Сериал №' : 'Фильм №') + selected.media.id;
    const saved = selected.saved;
    if (saved && saved.position >= 2) {
      const percent = percentage(saved);
      lastMeta.textContent = 'Сохранено ' + formatTime(saved.position) + ' / ' +
        formatTime(saved.duration) + ' · ' + percent + '%';
      lastProgress.hidden = false;
      let track = lastProgress.querySelector('.resume-last-track');
      if (!track) {
        track = makeTrack(saved, 'resume-last-track');
        lastProgress.replaceChildren(track);
      }
      updateTrack(track, saved);
    } else {
      lastMeta.textContent = selected.media.type === 'series'
        ? 'Сериал · таймкод серии пока недоступен'
        : 'Фильм · таймкод пока не сохранён';
      lastProgress.hidden = true;
    }
    const canResume = selected.media.type === 'film' &&
      Boolean(saved && !saved.completed && saved.position >= 10 &&
        saved.position <= saved.duration - 25);
    lastOpen.textContent = canResume ? '▶ Продолжить' : '▶ Открыть';
    lastOpen.title = canResume
      ? 'Открыть фильм и восстановить сохранённую позицию'
      : 'Открыть фильм или сериал';
  }

  function render() {
    decorateHistory();
    renderLast();
  }

  async function readStorage() {
    const sequence = ++storageReadSequence;
    try {
      const stored = (await chrome.storage.local.get(PROGRESS_KEY))[PROGRESS_KEY];
      if (sequence !== storageReadSequence) return;
      progress = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? stored : Object.create(null);
      render();
    } catch (error) {
      console.warn('[KinoHelper resume] Прогресс временно недоступен:', error);
      if (sequence !== storageReadSequence) return;
      progress = Object.create(null);
      render();
    }
  }

  async function updateActive() {
    const seq = ++tabReadSequence;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (seq !== tabReadSequence) return;
      const media = mediaFromUrl(tab?.url);
      // Only the watch tab is "currently watching". A Kinopoisk catalog
      // page should not suppress a genuine last-view entry.
      const isKinopoisk = /^https:\/\/www\.kinopoisk\.ru\//.test(tab?.url || '');
      const currentIsWatchPage = media && !isKinopoisk;
      let key = currentIsWatchPage ? media.key : '';
      // Some watch providers redirect to a non-canonical URL. Recover a
      // verified watch session only if its current URL still matches this tab.
      if (!key && !isKinopoisk && Number.isInteger(tab?.id) &&
          /^https:\/\//.test(tab?.url || '')) {
        try {
          const reply = await chrome.runtime.sendMessage({
            action: 'getWatchSession', tabId: tab.id
          });
          if (seq !== tabReadSequence) return;
          const session = reply?.ok ? reply.session : null;
          if (session?.currentUrl === tab.url &&
              ['film', 'series'].includes(session.type) &&
              /^[1-9]\d{0,12}$/.test(String(session.id))) {
            key = session.type + ':' + session.id;
          }
        } catch { /* No valid session: do not guess film identity. */ }
      }
      currentKey = key;
      renderLast();
    } catch {
      if (seq !== tabReadSequence) return;
      currentKey = '';
      renderLast();
    }
  }

  function updateHistory(items) {
    history = Array.isArray(items) ? items : [];
    render();
  }

  lastOpen.addEventListener('click', () => {
    const value = selected;
    if (!value) return;
    if (typeof window.openHistoryUrl === 'function') {
      const saved = value.saved;
      const resume = value.media.type === 'film' &&
        Boolean(saved && !saved.completed && saved.position >= 10 &&
          saved.position <= saved.duration - 25);
      void window.openHistoryUrl(value.entry.url, value.entry.title, { resume }).catch(error =>
        console.warn('[KinoHelper resume] Не удалось открыть фильм:', error));
    } else {
      void chrome.tabs.create({ url: value.entry.url });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[PROGRESS_KEY]) void readStorage();
  });

  chrome.tabs.onActivated.addListener(() => void updateActive());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (typeof info.url === 'string' || info.status === 'complete') void updateActive();
  });
  chrome.tabs.onRemoved.addListener(() => void updateActive());
  window.addEventListener('focus', () => {
    void updateActive();
    void readStorage();
  });

  window.KinoResumeUI = { updateHistory, readStorage, updateActive };
  void readStorage();
  void updateActive();
})();
