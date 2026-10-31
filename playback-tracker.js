// KinoHelper playback tracking v1: passive monitoring, no seeking or player control.
// Loaded only on confirmed player host after user-granted site access.
(() => {
  'use strict';
  if (globalThis.__kinoPlaybackTrackerV1) return;
  globalThis.__kinoPlaybackTrackerV1 = true;

  const SAVE_INTERVAL_MS = 10000;
  const MAX_DURATION = 8 * 60 * 60;
  const events = ['timeupdate', 'play', 'playing', 'pause', 'seeked', 'ended',
    'loadedmetadata', 'durationchange'];
  const known = new WeakSet();
  const watched = new Set();
  let current = null;
  let lastTime = null;
  let lastSampleAt = 0;
  let confirmedSamples = 0;
  let playedSeconds = 0;
  let lastSentAt = 0;
  let scanTimer = null;

  const now = () => Date.now();
  function viable(video) {
    if (!video || video.readyState < 2 ||
        !Number.isFinite(video.duration) || video.duration < 60 ||
        video.duration > MAX_DURATION ||
        !Number.isFinite(video.currentTime) || video.currentTime < 0 ||
        video.currentTime > video.duration + 5 ||
        video.videoWidth < 160 || video.videoHeight < 90) return false;
    const rect = typeof video.getBoundingClientRect === 'function'
      ? video.getBoundingClientRect() : null;
    return !rect || (rect.width >= 80 && rect.height >= 60);
  }

  function selectPrimary() {
    const candidates = [...watched].filter(viable);
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const rank = video => (video.paused ? 0 : 4) +
        Math.min(video.videoWidth * video.videoHeight / 1e6, 4) +
        Math.min(video.duration / 3600, 3);
      return rank(b) - rank(a);
    });
    return candidates[0];
  }

  function send(video, eventType) {
    if (!chrome.runtime?.id || !viable(video)) return;
    if (confirmedSamples < 2 || playedSeconds < 2) return;
    const time = video.currentTime;
    const duration = video.duration;
    // No progress on preroll/ad or videos we cannot associate with a film.
    const data = {
      action: 'kinoPlaybackProgress',
      payload: {
        currentTime: Math.round(time * 10) / 10,
        duration: Math.round(duration * 10) / 10,
        playedSeconds: Math.round(playedSeconds),
        event: eventType
      }
    };
    lastSentAt = now();
    try {
      chrome.runtime.sendMessage(data).catch(() => {});
    } catch { /* Service worker may stop during page close. */ }
  }

  function consider(video, eventType) {
    if (!viable(video)) return;
    const primary = selectPrimary();
    if (primary !== video) return;
    if (current !== video) {
      current = video;
      lastTime = null;
      confirmedSamples = 0;
      playedSeconds = 0;
      lastSampleAt = 0;
      lastSentAt = 0;
    }

    const timestamp = now();
    const time = video.currentTime;
    const dt = lastTime === null ? 0 : time - lastTime;
    const elapsed = lastSampleAt ? (timestamp - lastSampleAt) / 1000 : 0;
    const moving = !video.paused && !video.seeking &&
      dt >= 0.05 && dt <= 5 &&
      (elapsed === 0 || dt <= Math.max(2, elapsed * (video.playbackRate || 1) * 2 + 1));
    if (moving) {
      confirmedSamples += 1;
      playedSeconds += Math.min(dt / Math.max(0.25, video.playbackRate || 1), 5);
    }
    if (eventType === 'seeked') {
      lastTime = time;
      lastSampleAt = timestamp;
      // Do not treat a seek jump as real playback or as completion.
      if (confirmedSamples >= 2 && playedSeconds >= 2) send(video, 'seeked');
      return;
    }
    lastTime = time;
    lastSampleAt = timestamp;

    if (eventType === 'ended') {
      if (video.ended && time >= durationMinus(video.duration, 5) &&
          playedSeconds >= 30) send(video, 'ended');
      return;
    }

    if (confirmedSamples < 2 || playedSeconds < 2) return;
    if (eventType === 'pause' || eventType === 'pagehide') {
      send(video, eventType);
    } else if (!video.paused && timestamp - lastSentAt >= SAVE_INTERVAL_MS) {
      send(video, 'playing');
    }
  }

  function durationMinus(duration, seconds) {
    return Math.max(0, duration - seconds);
  }

  function discover() {
    const stack = [document];
    for (let i = 0; i < stack.length && i < 20; i++) {
      const root = stack[i];
      for (const video of root.querySelectorAll('video')) {
        if (known.has(video)) continue;
        known.add(video);
        watched.add(video);
        for (const event of events) {
          video.addEventListener(event, () => consider(video, event), { passive: true });
        }
      }
      let inspected = 0;
      for (const element of root.querySelectorAll('*')) {
        if (++inspected > 2000 || stack.length >= 20) break;
        if (element.shadowRoot) stack.push(element.shadowRoot);
      }
    }
    for (const video of watched) {
      if (!video.isConnected) watched.delete(video);
    }
  }

  const observer = new MutationObserver(() => discover());
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  discover();

  // A 2-second heartbeat covers players that suppress timeupdate events.
  scanTimer = setInterval(() => {
    discover();
    const primary = selectPrimary();
    if (primary) consider(primary, 'heartbeat');
  }, 2000);

  window.addEventListener('pagehide', () => {
    if (current) consider(current, 'pagehide');
    if (scanTimer !== null) clearInterval(scanTimer);
    observer.disconnect();
  });
})();
