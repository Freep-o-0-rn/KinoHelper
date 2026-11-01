// Display saved playback progress in History and in a separate last-opened card.
// This module only reads progress; video seeking/restoration is a later stage.
(() => {
  'use strict';
  const PROGRESS_KEY = 'kinoPlaybackProgressV1';
  const SERIES_KEY = 'kinoSeriesEpisodeProgressV1';
  const COVERAGE_KEY = 'kinoPlaybackCoverageV1';
  const HISTORY_KEY = 'kinopoiskHistory';
  const DISMISS_KEY = 'kinoLastViewDismissedV1';
  const panel = document.getElementById('resumeLast');
  const lastTitle = document.getElementById('resumeLastTitle');
  const lastMeta = document.getElementById('resumeLastMeta');
  const lastProgress = document.getElementById('resumeLastProgress');
  const lastOpen = document.getElementById('resumeLastOpen');
  const closeLast = document.getElementById('resumeLastClose');
  if (!panel || !lastTitle || !lastMeta || !lastProgress || !lastOpen ||
      !closeLast) return;

  let progress = Object.create(null);
  let episodeProgress = Object.create(null);
  let coverage = Object.create(null);
  let history = [];
  let currentKey = '';
  let activeWatchPage = false;
  // Hide the card until the first active-tab check completes. A storage
  // response must not briefly reveal it while a player tab is loading.
  let checkingActiveTab = true;
  let selected = null;
  // Dismiss only the currently displayed title/episode, without deleting
  // history or checkpoints. Shared across popup and Side Panel for this
  // Chrome session, so re-renders cannot make it reappear.
  let dismissedIdentity = '';
  let dismissReadComplete = false;
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

  function isKnownWatchMediaPage(raw) {
    try {
      const url = new URL(raw);
      // These are watch providers, not Kinopoisk's catalog pages.
      return url.protocol === 'https:' &&
        ['brogiro.cfd', 'www.kinokino.vip', 'flcksbr.top']
          .includes(url.hostname.toLowerCase()) &&
        Boolean(mediaFromUrl(raw));
    } catch { return false; }
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

  function latestSeriesEpisode(seriesId, includeCompleted = true) {
    if (!/^[1-9]\d{0,12}$/.test(String(seriesId))) return null;
    const candidates = [];
    for (const [key, entry] of Object.entries(episodeProgress)) {
      if (!entry || entry.type !== 'series' || String(entry.id) !== String(seriesId) ||
          !Number.isInteger(entry.season) || !Number.isInteger(entry.episode) ||
          entry.season < 1 || entry.season > 250 ||
          entry.episode < 1 || entry.episode > 250 ||
          key !== 'series:' + seriesId + ':' + entry.season + ':' + entry.episode ||
          !Number.isFinite(entry.position) || entry.position < 0 ||
          !Number.isFinite(entry.duration) || entry.duration < 60 ||
          entry.duration > 8 * 3600 ||
          entry.position > entry.duration + 2 ||
          !Number.isFinite(entry.updatedAt) || entry.updatedAt <= 0 ||
          (!includeCompleted && entry.completed)) continue;
      candidates.push(entry);
    }
    return candidates.sort((a,b) => b.updatedAt - a.updatedAt)[0] || null;
  }

  function savedForMedia(media, includeCompleted = true) {
    return media?.type === 'series'
      ? latestSeriesEpisode(media.id, includeCompleted)
      : positionFor(media?.key);
  }

  function episodeLabel(item) {
    return 'Сезон ' + item.season + ' · Серия ' + item.episode;
  }

  function displayMediaForEntry(entry) {
    const media = mediaFromUrl(entry?.url);
    if (!media || media.type !== 'film') return media;
    // /film/<id> also hosts series on this provider. A verified episode
    // checkpoint takes precedence. The explicit "(сериал)" history suffix
    // is display-only; it must never authorize saving or restoring a video.
    const labeledSeries = /\(\s*(?:сериал|series)(?:\s+\d{4}(?:[-–—]\d{4})?)?\s*\)\s*$/i
      .test(String(entry?.title || ''));
    return latestSeriesEpisode(media.id) || labeledSeries
      ? { ...media, type: 'series', key: 'series:' + media.id }
      : media;
  }

  // Never seek by title alone. A resume target must have an actual
  // validated checkpoint (film or explicit season+episode).
  function resumeTargetFor(entry) {
    const media = displayMediaForEntry(entry);
    if (!media) return null;
    const saved = media.type === 'series'
      ? latestSeriesEpisode(media.id, true) : positionFor(media.key);
    if (!saved || saved.completed || saved.position < 10 ||
        saved.position > saved.duration - 25) return null;
    if (saved.type === 'series') {
      return {kind:'series', id:String(saved.id),
        season:saved.season, episode:saved.episode};
    }
    if (media.type === 'film') return {kind:'film',id:String(saved.id)};
    return null;
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
    track.className = track.className.includes('resume-last-track')
      ? 'resume-last-track' : 'history-progress-track';
    if (item.completed) track.className += ' complete';
    const fill = track.querySelector('.resume-progress-fill');
    if (fill) fill.style.width = percent + '%';
  }

  function coveredPercent(key,item) {
    const record=coverage[key];
    if(!record || !Number.isFinite(record.duration) ||
        Math.abs(record.duration-item.duration)>Math.max(10,item.duration*.015) ||
        !Array.isArray(record.ranges))return 0;
    const intervals=record.ranges.filter(v=>
      Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)&&
      v[0]>=0&&v[1]<=item.duration&&v[1]>v[0])
      .map(([a,b])=>[a,b]).sort((a,b)=>a[0]-b[0]);
    let seconds=0,lastEnd=0;
    for(const [start,end] of intervals){
      seconds+=Math.max(0,end-Math.max(lastEnd,start));
      lastEnd=Math.max(lastEnd,end);
    }
    return Math.min(100,seconds/item.duration*100);
  }

  function decorateHistory() {
    const rows = document.querySelectorAll('.history-item[data-kino-media-key]');
    for (const row of rows) {
      const originalKey = row.dataset.kinoMediaKey;
      const entry = history.find(value =>
        mediaFromUrl(value?.url)?.key === originalKey);
      const key = displayMediaForEntry(entry)?.key || originalKey;
      const media = /^series:([1-9]\d{0,12})$/.exec(key);
      const item = media ? latestSeriesEpisode(media[1]) : positionFor(key);
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
      if (label) {
        const prefix = item.type === 'series' ? episodeLabel(item) + ' · ' : '';
        label.textContent = prefix + (item.completed
          ? '✓ Просмотрено · ' + formatTime(item.duration)
          : formatTime(item.position) + ' / ' + formatTime(item.duration) +
            ' · ' + pct + '%');
      }
      const progressKey=item.type==='series'
        ? 'series:'+item.id+':'+item.season+':'+item.episode
        : 'film:'+item.id;
      const observed=coveredPercent(progressKey,item);
      let confirm=block.querySelector('.history-confirm-complete');
      if (!item.completed && observed>=85) {
        if (!confirm) {
          confirm=document.createElement('button');
          confirm.type='button';
          confirm.className='history-confirm-complete';
          confirm.addEventListener('click',async()=>{
            if(confirm.disabled)return;
            confirm.disabled=true;
            confirm.textContent='Проверяем…';
            try{
              const result=await chrome.runtime.sendMessage({
                action:'kinoConfirmCoveredPlayback',key:progressKey
              });
              if(!result?.ok)throw Error(result?.error||'Не удалось подтвердить');
              await readStorage();
            }catch(error){
              confirm.disabled=false;
              confirm.textContent='Не удалось: '+String(error.message||error);
            }
          });
          block.appendChild(confirm);
        }
        if(!confirm.disabled)confirm.textContent='✓ Досмотрел';
        confirm.title='Подтвердить окончание просмотра: просмотрено '+
          Math.floor(observed)+'% уникального материала';
      } else if(confirm)confirm.remove();
    }
  }

  function lastIdentity(candidate) {
    const media = candidate?.media;
    if (!media) return '';
    const saved = candidate.saved;
    return media.type === 'series' && saved?.type === 'series'
      ? 'series:' + media.id + ':' + saved.season + ':' + saved.episode
      : media.key;
  }

  async function readDismissal() {
    try {
      const record = await chrome.storage.session.get(DISMISS_KEY);
      dismissedIdentity = typeof record?.[DISMISS_KEY] === 'string'
        ? record[DISMISS_KEY] : '';
    } catch { /* Hiding still works locally when session storage is unavailable. */ }
    dismissReadComplete = true;
    renderLast();
  }

  function recentCandidates() {
    // Preserve the user's own history ordering and timestamp, even when the
    // entry was imported from an earlier extension version.
    const unique = new Map();
    for (const entry of history) {
      if (!entry || typeof entry.url !== 'string') continue;
      const media = displayMediaForEntry(entry);
      if (!media || unique.has(media.key)) continue;
      // Only the actual most recently watched episode represents a series.
      // Never fall back to an older unfinished episode after a newer one ends.
      const saved = savedForMedia(media, true);
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
    // "Сейчас смотрите" owns the player view. Never display a competing
    // "Последний просмотр" card there — including on /film/<id> URLs
    // whose iframe is actually a series. This guard also applies to
    // asynchronous storage updates every five seconds.
    if (checkingActiveTab || activeWatchPage || !dismissReadComplete) {
      selected = null;
      panel.hidden = true;
      return;
    }
    // Do not fall back to older media when the latest card is dismissed.
    const latest = recentCandidates().find(item => item.media.key !== currentKey);
    selected = latest && lastIdentity(latest) !== dismissedIdentity
      ? latest : null;
    panel.hidden = !selected;
    if (!selected) return;

    lastTitle.textContent = String(selected.entry.title || '').trim() ||
      (selected.media.type === 'series' ? 'Сериал №' : 'Фильм №') + selected.media.id;
    const saved = selected.saved;
    if (saved && saved.position >= 2) {
      const percent = percentage(saved);
      lastMeta.textContent = (saved.type === 'series'
        ? episodeLabel(saved) + ' · ' : '') +
        'Сохранено ' + formatTime(saved.position) + ' / ' +
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
        ? 'Сериал · таймкод серии пока не сохранён'
        : 'Фильм · таймкод пока не сохранён';
      lastProgress.hidden = true;
    }
    const canResume = Boolean(resumeTargetFor(selected.entry));
    lastOpen.textContent = canResume ? '▶ Продолжить' : '▶ Открыть';
    lastOpen.title = canResume
      ? 'Открыть сохранённый фильм или серию с нужного момента'
      : 'Открыть фильм или сериал';
  }

  function render() {
    decorateHistory();
    renderLast();
  }

  async function readStorage() {
    const sequence = ++storageReadSequence;
    try {
      const [filmData, seriesData, coverageData] = await Promise.all([
        chrome.storage.local.get(PROGRESS_KEY),
        chrome.storage.local.get(SERIES_KEY),
        chrome.storage.local.get(COVERAGE_KEY)
      ]);
      if (sequence !== storageReadSequence) return;
      const stored = filmData[PROGRESS_KEY];
      const episodes = seriesData[SERIES_KEY];
      const segments = coverageData[COVERAGE_KEY];
      coverage = segments&&typeof segments==='object'&&!Array.isArray(segments)
        ?segments:Object.create(null);
      progress = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? stored : Object.create(null);
      episodeProgress = episodes && typeof episodes === 'object' && !Array.isArray(episodes)
        ? episodes : Object.create(null);
      render();
    } catch (error) {
      console.warn('[KinoHelper resume] Прогресс временно недоступен:', error);
      if (sequence !== storageReadSequence) return;
      progress = Object.create(null);
      episodeProgress = Object.create(null);
      coverage = Object.create(null);
      render();
    }
  }

  async function updateActive() {
    const seq = ++tabReadSequence;
    checkingActiveTab = true;
    panel.hidden = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (seq !== tabReadSequence) return;

      // Detect the *page*, not the media type: the video provider also
      // serves series at /film/<id>. No iframe observation is required
      // just to hide "Последний просмотр".
      let watching = isKnownWatchMediaPage(tab?.url);
      let key = watching ? mediaFromUrl(tab.url).key : '';

      // For redirects to other domains, trust only a current watch session
      // verified by the background worker, never an arbitrary /film/ URL.
      const onKinopoisk = /^https:\/\/www\.kinopoisk\.ru\//.test(tab?.url || '');
      if (!watching && !onKinopoisk && Number.isInteger(tab?.id) &&
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
            watching = true;
            key = session.type + ':' + session.id;
          }
        } catch { /* No trusted watch session. */ }
      }

      if (seq !== tabReadSequence) return;
      activeWatchPage = watching;
      checkingActiveTab = false;
      currentKey = key;
      renderLast();
    } catch {
      if (seq !== tabReadSequence) return;
      activeWatchPage = false;
      checkingActiveTab = false;
      currentKey = '';
      renderLast();
    }
  }

  function updateHistory(items) {
    history = Array.isArray(items) ? items : [];
    render();
  }

  closeLast.addEventListener('click', () => {
    if (!selected) return;
    dismissedIdentity = lastIdentity(selected);
    selected = null;
    panel.hidden = true;
    // Session-scoped suppression, not permanent deletion of playback data.
    void chrome.storage.session.set({ [DISMISS_KEY]: dismissedIdentity })
      .catch(() => {});
  });

  lastOpen.addEventListener('click', () => {
    const value = selected;
    if (!value) return;
    if (typeof window.openHistoryUrl === 'function') {
      const target = resumeTargetFor(value.entry);
      void window.openHistoryUrl(value.entry.url, value.entry.title, {
        resume: Boolean(target), resumeTarget: target
      }).catch(error =>
        console.warn('[KinoHelper resume] Не удалось открыть просмотр:', error));
    } else {
      void chrome.tabs.create({ url: value.entry.url });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' &&
        (changes[PROGRESS_KEY]||changes[SERIES_KEY]||changes[COVERAGE_KEY]))
      void readStorage();
    if (area === 'session' && changes[DISMISS_KEY]) {
      dismissedIdentity = typeof changes[DISMISS_KEY].newValue === 'string'
        ? changes[DISMISS_KEY].newValue : '';
      dismissReadComplete = true;
      renderLast();
    }
  });

  chrome.tabs.onActivated.addListener(() => void updateActive());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (typeof info.url === 'string' || info.status === 'complete') void updateActive();
  });
  chrome.tabs.onRemoved.addListener(() => void updateActive());
  chrome.runtime?.onMessage?.addListener(message => {
    if (message?.action === 'kinoWatchSessionChanged' ||
        message?.action === 'kinoEpisodeSelectionChanged') {
      void updateActive();
    }
  });
  window.addEventListener('focus', () => {
    void updateActive();
    void readStorage();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void updateActive();
  });

  window.KinoResumeUI = { updateHistory, readStorage, updateActive,
    resumeTargetFor };
  void readDismissal();
  void readStorage();
  void updateActive();
})();
