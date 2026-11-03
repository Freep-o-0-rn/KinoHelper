// KinoHelper 1.555: one-shot restore the saved season, episode and time.
// Activated ONLY by an explicit "Continue" click in the extension.
// No source URLs stored, no auto-play, and no seeking until selectors match.
(() => {
  'use strict';
  if (globalThis.__kinoSeriesResumeV1) return;
  globalThis.__kinoSeriesResumeV1 = true;

  const TICK = 450;
  const TIMEOUT = 60000;
  const started = Date.now();
  let target = null;
  let timer = null;
  let stopped = false;
  let lastOpenAt = 0;
  let lastChosenAt = 0;
  let selectorsMatchedAt = 0;
  let attemptedSeekAt = 0;
  let seekMade = false;
  let confirmedAt = 0;
  let lastAckAt = 0;

  const norm = text => String(text || '').replace(/\s+/g, ' ').trim();
  const selected = kind => {
    const re = kind === 'season'
      ? /^(?:Сезон|Season)\s*№?\s*(\d{1,3})$/i
      : /^(?:Серия|Episode)\s*№?\s*(\d{1,3})$/i;
    const matches = [...document.querySelectorAll('button.select__item')]
      .filter(button => re.test(norm(button.textContent)));
    return matches.length === 1 ? matches[0] : null;
  };
  const value = (button, kind) => {
    if (!button) return null;
    const re = kind === 'season'
      ? /^(?:Сезон|Season)\s*№?\s*(\d{1,3})$/i
      : /^(?:Серия|Episode)\s*№?\s*(\d{1,3})$/i;
    const match = norm(button.textContent).match(re);
    return match ? Number(match[1]) : null;
  };
  function matchingOption(kind, number) {
    const re = kind === 'season'
      ? /^(?:Сезон|Season)\s*№?\s*(\d{1,3})$/i
      : /^(?:Серия|Episode)\s*№?\s*(\d{1,3})$/i;
    const options = [...document.querySelectorAll('button.select__drop-item')]
      .filter(node => {
        const match = norm(node.textContent).match(re);
        if (!match || Number(match[1]) !== number || node.hidden ||
            node.getAttribute?.('aria-hidden') === 'true') return false;
        const rect = node.getBoundingClientRect?.();
        return !rect || (rect.width > 0 && rect.height > 0);
      });
    // Never guess among ambiguous dropdowns.
    return options.length === 1 ? options[0] : null;
  }

  function pick(kind, number, now) {
    const control = selected(kind);
    if (!control) return false;
    if (value(control, kind) === number) return true;
    const option = matchingOption(kind, number);
    if (option && now - lastChosenAt > 1100) {
      option.click();
      lastChosenAt = now;
      selectorsMatchedAt = 0;
      return false;
    }
    if (now - lastOpenAt > 2200 && now - lastChosenAt > 1100) {
      control.click();
      lastOpenAt = now;
    }
    return false;
  }

  function videos() {
    const roots = [document];
    const found = [];
    let visited = 0;
    for (let i = 0; i < roots.length && i < 15; i++) {
      const root = roots[i];
      for (const video of root.querySelectorAll('video')) {
        if (!video || video.readyState < 2 ||
            !Number.isFinite(video.duration) || video.duration < 60 ||
            !Number.isFinite(video.currentTime) ||
            video.videoWidth < 160 || video.videoHeight < 90) continue;
        const r = video.getBoundingClientRect?.();
        if (r && (r.width < 80 || r.height < 60)) continue;
        const tolerance = Math.max(15, target.duration * 0.015);
        if (Math.abs(video.duration - target.duration) <= tolerance)
          found.push(video);
      }
      for (const el of root.querySelectorAll('*')) {
        if (++visited >= 1400 || roots.length >= 15) break;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    found.sort((a, b) => Number(!b.paused) - Number(!a.paused) ||
      b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    return found[0] || null;
  }

  function stop() {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  async function tick() {
    if (stopped || !target) return;
    const now = Date.now();
    if (now - started > TIMEOUT) { stop(); return; }

    const season = selected('season');
    const episode = selected('episode');
    if (!season || !episode) { selectorsMatchedAt = 0; return; }
    if (value(season, 'season') !== target.season) {
      selectorsMatchedAt = 0;
      pick('season', target.season, now);
      return;
    }
    if (value(episode, 'episode') !== target.episode) {
      selectorsMatchedAt = 0;
      pick('episode', target.episode, now);
      return;
    }
    if (!selectorsMatchedAt) selectorsMatchedAt = now;
    // Let the provider finish changing the stream after its controls update.
    if (now - selectorsMatchedAt < 1400 || now - lastChosenAt < 1400) return;
    const video = videos();
    if (!video || video.seeking) return;
    const delta = Math.abs(video.currentTime - target.position);
    if (!seekMade && video.currentTime > target.position + 30) {
      stop();  // Don't unexpectedly rewind a manually advanced episode.
      return;
    }
    if (!seekMade || (delta > 3 && now - attemptedSeekAt > 4000)) {
      try {
        video.currentTime = target.position;
        attemptedSeekAt = now;
        seekMade = true;
        confirmedAt = 0;
      } catch { /* Video may still be loading. */ }
      return;
    }
    if (seekMade && delta <= 3) {
      if (!confirmedAt) { confirmedAt = now; return; }
      if (now - confirmedAt < 600 || now - lastAckAt < 2000) return;
      lastAckAt = now;
      try {
        const reply = await chrome.runtime.sendMessage({
          action: 'kinoSeriesResumeAcknowledge',
          payload: {
            season: target.season, episode: target.episode,
            position: video.currentTime, duration: video.duration
          }
        });
        if (reply?.ok) stop();
      } catch { /* Keep checkpoint protected until acknowledgement. */ }
    } else confirmedAt = 0;
  }

  async function start() {
    try {
      const reply = await chrome.runtime.sendMessage({
        action: 'kinoSeriesResumeGetPending'
      });
      const p = reply?.ok ? reply.pending : null;
      if (!p || !Number.isInteger(p.season) || !Number.isInteger(p.episode) ||
          !Number.isFinite(p.duration) || p.duration < 60 ||
          !Number.isFinite(p.position) || p.position < 10 ||
          p.position > p.duration - 25) return;
      target = p;
      timer = setInterval(() => { void tick(); }, TICK);
      void tick();
    } catch { /* No pending continue action => never touch player. */ }
  }

  void start();
  window.addEventListener('pagehide', stop, { once: true });
})();
