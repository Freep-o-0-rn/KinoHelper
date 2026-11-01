// KinoHelper v1.553 — film-independent, episode-scoped playback checkpoints.
// Only trusts the explicitly selected theatre.stravers.live season/episode controls.
// Does not change playback, navigate, or seek.
(() => {
  'use strict';
  if (globalThis.__kinoSeriesProgressV1) return;
  globalThis.__kinoSeriesProgressV1 = true;

  const SAVE_INTERVAL = 5000;
  const MAX_DURATION = 8 * 3600;
  const CHECK_INTERVAL = 2000;
  let selectionKey = '';
  let lastNonEmptySelection = '';
  let selectionSince = 0;
  let formerVideo = null;
  let formerSrc = '';
  let formerTime = 0;
  let awaitingMedia = false;
  let mediaChanged = false;
  let previousVideoTime = null;
  let activeVideo = null;
  let lastTime = null;
  let lastTick = 0;
  let movingSamples = 0;
  let watchedSeconds = 0;
  let pendingRanges = [];
  // crypto.randomUUID exists on HTTPS players; deterministic test realms may
  // not expose crypto, so provide a temporary fallback scoped to this script.
  const newStatsTrackingId = () => globalThis.crypto?.randomUUID?.() ||
    ('local-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2).padEnd(20,'0'));
  let statsTrackingId = newStatsTrackingId();
  let lastSent = 0;
  let lastKnownMediaSrc = '';
  let trackedMediaToken = 0;
  const videos = new Set();
  const known = new WeakSet();

  function selectedEpisode() {
    const selected = [...document.querySelectorAll('button.select__item')].slice(0, 12);
    const seasons = new Set();
    const episodes = new Set();
    for (const button of selected) {
      if (button.hidden || button.getAttribute?.('aria-hidden') === 'true') continue;
      const r = button.getBoundingClientRect?.();
      if (r && (r.width <= 0 || r.height <= 0)) continue;
      const label = String(button.textContent || '').replace(/\s+/g, ' ').trim();
      const s = label.match(/^(?:Сезон|Season)\s*№?\s*(\d{1,3})$/i);
      const e = label.match(/^(?:Серия|Episode)\s*№?\s*(\d{1,3})$/i);
      if (s) seasons.add(Number(s[1]));
      if (e) episodes.add(Number(e[1]));
    }
    if (seasons.size !== 1 || episodes.size !== 1) return null;
    const season = [...seasons][0], episode = [...episodes][0];
    if (season < 1 || season > 250 || episode < 1 || episode > 250) return null;
    // An open dropdown may temporarily disagree while an episode is switching.
    for (const option of [...document.querySelectorAll('button.select__drop-item.active')].slice(0, 20)) {
      const label = String(option.textContent || '').replace(/\s+/g, ' ').trim();
      const s = label.match(/^(?:Сезон|Season)\s*№?\s*(\d{1,3})$/i);
      const e = label.match(/^(?:Серия|Episode)\s*№?\s*(\d{1,3})$/i);
      if ((s && Number(s[1]) !== season) || (e && Number(e[1]) !== episode)) return null;
    }
    return { season, episode, key: season + ':' + episode };
  }

  function valid(video) {
    if (!video || video.readyState < 2 ||
        !Number.isFinite(video.currentTime) ||
        !Number.isFinite(video.duration) ||
        video.currentTime < 0 || video.duration < 60 ||
        video.duration > MAX_DURATION ||
        video.currentTime > video.duration + 2 ||
        video.videoWidth < 160 || video.videoHeight < 90) return false;
    const r = video.getBoundingClientRect?.();
    return !r || (r.width >= 80 && r.height >= 60);
  }

  function primary() {
    const items = [...videos].filter(valid);
    items.sort((a,b) => (Number(!b.paused) - Number(!a.paused)) ||
      b.videoWidth*b.videoHeight - a.videoWidth*a.videoHeight);
    return items[0] || null;
  }

  function resetMovement() {
    lastTime = null;
    lastTick = 0;
    movingSamples = 0;
    watchedSeconds = 0;
    pendingRanges = [];
    statsTrackingId = newStatsTrackingId();
    lastSent = 0;
  }

  function observeSelection(video) {
    const choice = selectedEpisode();
    const key = choice?.key || '';
    const now = Date.now();
    if (selectionKey !== key) {
      const previousWasKnown = Boolean(lastNonEmptySelection);
      const switchedEpisode = Boolean(previousWasKnown && key &&
        lastNonEmptySelection !== key);

      // Capture the former stream when the selection first disappears.
      // Do not overwrite it when the new episode selector later appears;
      // that was the reason 1.554 could remain stuck on the old episode.
      if (selectionKey || !previousWasKnown) {
        formerVideo = activeVideo || video;
        formerSrc = formerVideo?.currentSrc || '';
        formerTime = Number(formerVideo?.currentTime) || 0;
        previousVideoTime = formerTime;
        mediaChanged = false;
      }
      if (switchedEpisode) awaitingMedia = true;
      else if (key && (!previousWasKnown ||
          key === lastNonEmptySelection)) awaitingMedia = false;

      if (key) lastNonEmptySelection = key;
      selectionKey = key;
      selectionSince = now;
      activeVideo = video;
      resetMovement();
    }

    if (!choice) return null;
    if (video && activeVideo !== video) {
      if (awaitingMedia) mediaChanged = true;
      activeVideo = video;
      resetMovement();
    }

    if (awaitingMedia && video) {
      const source = video.currentSrc || '';
      const t = Number(video.currentTime);
      const resetToBeginning = Number.isFinite(t) &&
        Number.isFinite(previousVideoTime) &&
        previousVideoTime - t >= 1.0 && t <= 90;
      const sourceChanged = Boolean(formerSrc && source && formerSrc !== source);
      const oldVideoReplaced = mediaChanged && video.readyState >= 2;
      if (resetToBeginning || sourceChanged || oldVideoReplaced) {
        awaitingMedia = false;
        resetMovement();
      }
      previousVideoTime = t;
    }
    if (awaitingMedia || now - selectionSince < 1300) return null;
    return choice;
  }

  function send(video, eventType, choice) {
    if (!valid(video) || movingSamples < 2 || watchedSeconds < 2) return;
    const latest = selectedEpisode();
    if (!latest || latest.key !== choice.key) return;
    // No URLs, iframe tokens, or video sources are included in messages.
    lastSent = Date.now();
    pendingRanges = [];
    try {
      chrome.runtime.sendMessage({
        action: 'kinoSeriesEpisodeProgress',
        payload: {
          season: choice.season, episode: choice.episode,
          currentTime: Math.round(video.currentTime * 10)/10,
          duration: Math.round(video.duration * 10)/10,
          playedSeconds: Math.floor(watchedSeconds),
          // Intervals are bound to the verified season and episode selection.
          watchedRanges: pendingRanges.map(range => [...range]),
          statsTrackingId,
          event: eventType
        }
      }).catch(() => {});
    } catch { /* Tab may be closing. */ }
  }

  function consider(video, eventType) {
    const choice = observeSelection(video);
    if (!choice || !valid(video) || video !== primary()) return;
    const now = Date.now();
    const current = video.currentTime;
    const dt = lastTime === null ? 0 : current - lastTime;
    const elapsed = lastTick ? (now - lastTick)/1000 : 0;
    const rate = Math.max(0.25, Number(video.playbackRate) || 1);
    const moving = !video.paused && !video.seeking &&
      dt >= 0.05 && dt <= 5 &&
      dt <= Math.max(2, elapsed * rate * 2 + 1);
    if (moving) {
      movingSamples++;
      watchedSeconds += Math.min(dt/rate, 5);
      const start = Math.max(0, lastTime);
      const end = Math.min(video.duration, current);
      if (end > start) {
        const last = pendingRanges[pendingRanges.length - 1];
        if (last && start >= last[0] && start <= last[1] + 0.35) {
          last[1] = Math.max(last[1], end);
        } else if (pendingRanges.length < 64) {
          pendingRanges.push([start,end]);
        }
      }
    }
    lastTime = current;
    lastTick = now;

    if (eventType === 'seeked') {
      if (movingSamples >= 2 && watchedSeconds >= 2) send(video, 'seeked', choice);
      return;
    }
    if (movingSamples < 2 || watchedSeconds < 2) return;
    if (eventType === 'ended') {
      if (video.ended && current >= video.duration - 5 && watchedSeconds >= 30)
        send(video, 'ended', choice);
      return;
    }
    if (['pause','hidden','pagehide'].includes(eventType)) {
      send(video, eventType, choice);
    } else if (!video.paused && now - lastSent >= SAVE_INTERVAL) {
      send(video, 'playing', choice);
    }
  }

  function discover() {
    const roots = [document];
    for (let i=0; i<roots.length && i<20; i++) {
      const root = roots[i];
      for (const video of root.querySelectorAll('video')) {
        if (known.has(video)) continue;
        known.add(video);
        videos.add(video);
        for (const event of ['timeupdate','play','playing','pause','seeked','ended',
          'loadedmetadata','durationchange','loadstart','emptied']) {
          video.addEventListener(event, () => {
            if (event === 'loadstart' || event === 'emptied') {
              if (video === formerVideo && (awaitingMedia || !selectionKey))
                mediaChanged = true;
              if (video === activeVideo) resetMovement();
              return;
            }
            consider(video, event);
          }, { passive: true });
        }
      }
      let count = 0;
      for (const element of root.querySelectorAll('*')) {
        if (++count > 2000 || roots.length >= 20) break;
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    for (const video of videos) if (!video.isConnected) videos.delete(video);
  }

  const observer = new MutationObserver(() => {
    discover();
    // Observe the selector before the player swaps its video source.
    observeSelection(primary());
  });
  if (document.documentElement)
    observer.observe(document.documentElement, {subtree: true, childList: true});
  discover();
  const pulse = setInterval(() => {
    discover();
    consider(primary(), 'heartbeat');
  }, CHECK_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) consider(primary(), 'hidden');
  });
  window.addEventListener('pagehide', () => {
    consider(primary(), 'pagehide');
    clearInterval(pulse);
    observer.disconnect();
  }, {once:true});
})();
