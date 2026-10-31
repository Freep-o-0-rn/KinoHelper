// KinoHelper: one-shot restore of a verified saved film timecode.
// Runs only on the known player iframe. Never restores a series episode.
(() => {
  'use strict';
  if (globalThis.__kinoResumeSeekV1) return;
  globalThis.__kinoResumeSeekV1 = true;

  const POLL_MS = 500;
  const TIMEOUT_MS = 30000;
  const MIN_DURATION = 60;
  const MAX_DURATION = 8 * 3600;
  const started = Date.now();
  let pollTimer = null;
  let target = null;
  let seekAttempted = false;
  let seekAt = 0;
  let stopped = false;

  function stop() {
    stopped = true;
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  }

  function qualifies(video) {
    if (!video || video.readyState < 1 ||
        !Number.isFinite(video.duration) || video.duration < MIN_DURATION ||
        video.duration > MAX_DURATION ||
        video.videoWidth < 160 || video.videoHeight < 90) return false;
    const rect = video.getBoundingClientRect?.();
    return !rect || (rect.width >= 80 && rect.height >= 60);
  }

  function findPrimary() {
    if (!target) return null;
    const matches = [];
    const roots = [document];
    let visited = 0;
    for (let i = 0; i < roots.length && i < 20; i++) {
      const root = roots[i];
      for (const video of root.querySelectorAll('video')) {
        if (!qualifies(video)) continue;
        // Strong guard against jumping a different edition or a preroll ad.
        const tolerance = Math.max(15, target.duration * 0.015);
        if (Math.abs(video.duration - target.duration) > tolerance) continue;
        matches.push(video);
      }
      for (const node of root.querySelectorAll('*')) {
        if (++visited > 2000 || roots.length >= 20) break;
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    if (!matches.length) return null;
    matches.sort((a, b) => {
      const score = v => Number(!v.paused) * 100 +
        v.videoWidth * v.videoHeight / 10000;
      return score(b) - score(a);
    });
    return matches[0];
  }

  async function tick() {
    if (stopped) return;
    if (Date.now() - started > TIMEOUT_MS) {
      stop();
      return;
    }
    const video = findPrimary();
    if (!video || video.seeking) return;

    const delta = Math.abs(video.currentTime - target.position);
    if (delta <= 3 && seekAttempted) {
      // Only acknowledge restoration after verifying actual player position.
      stop();
      try {
        await chrome.runtime.sendMessage({
          action: 'kinoResumeAcknowledge', position: video.currentTime
        });
      } catch { /* The checkpoint remains available for another attempt. */ }
      return;
    }

    if (!seekAttempted || Date.now() - seekAt >= 4000) {
      // Seek only if there is a trusted pending resume command.
      // Allow retry if the player replaced the video element after loading.
      if (Number.isFinite(video.currentTime) &&
          (video.currentTime > target.position + 30)) {
        stop(); // Already far beyond saved position: don't rewind.
        return;
      }
      try {
        video.currentTime = target.position;
        seekAttempted = true;
        seekAt = Date.now();
      } catch {
        // Metadata may be ready before the player accepts seeking.
      }
    }
  }

  async function begin() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'kinoResumeGetPending' });
      if (!response?.ok || !response.pending) return;
      const pending = response.pending;
      if (!Number.isFinite(pending.position) || pending.position < 10 ||
          !Number.isFinite(pending.duration) || pending.duration < MIN_DURATION ||
          pending.duration > MAX_DURATION ||
          pending.position > pending.duration - 25) return;
      target = pending;
      pollTimer = setInterval(() => { void tick(); }, POLL_MS);
      void tick();
    } catch { /* No pending resume, so leave playback untouched. */ }
  }

  void begin();
  window.addEventListener('pagehide', stop, { once: true });
})();
