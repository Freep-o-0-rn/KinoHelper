// KinoHelper 1.550 — passive season/episode identification.
// No video controls, no stream URLs, no storage of watched series progress.
// Reports only an unambiguous (season, episode) pair.
(() => {
  'use strict';
  if (globalThis.__kinoEpisodeDetectorV1) return;
  globalThis.__kinoEpisodeDetectorV1 = true;

  const VALID_MAX = 250;
  const REPORT_EVERY_MS = 12000;
  let lastCandidate = '';
  let confirmedAt = 0;
  let reported = '';
  let reportedAt = 0;
  let scheduled = null;

  function number(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    if (!/^\d{1,3}$/.test(text)) return null;
    const n = Number(text);
    return n >= 1 && n <= VALID_MAX ? n : null;
  }

  function pair(season, episode) {
    season = number(season);
    episode = number(episode);
    return season !== null && episode !== null ? { season, episode } : null;
  }

  function parsePhrase(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    if (!text) return null;
    let match = text.match(/(?:^|[^\d])s(?:eason)?[\s._-]*(\d{1,3})[\s._-]*e(?:pisode)?[\s._-]*(\d{1,3})(?!\d)/i);
    if (match) return pair(match[1], match[2]);
    match = text.match(/(?:^|[^\d])(\d{1,3})\s*[xх×]\s*(\d{1,3})(?!\d)/i);
    if (match) return pair(match[1], match[2]);
    match = text.match(/(?:сезон|season)\s*№?\s*(\d{1,3})\s*(?:[,;:·./-]|\s)*\s*(?:серия|серии|series|episode|ep)\s*№?\s*(\d{1,3})(?!\d)/i);
    if (match) return pair(match[1], match[2]);
    match = text.match(/(\d{1,3})\s*(?:-?й|-?ый|-?ой)?\s*(?:сезон|season)\s*(?:[,;:·./-]|\s)*\s*(\d{1,3})\s*(?:-?я|-?ая)?\s*(?:серия|episode)(?!\w)/i);
    return match ? pair(match[1], match[2]) : null;
  }

  function fromUrl() {
    try {
      const url = new URL(location.href);
      if (url.protocol !== 'https:') return null;
      // Read only explicitly named season AND episode keys. Do not send URL.
      for (const [s, e] of [
        ['season', 'episode'], ['seasonNumber', 'episodeNumber'],
        ['season_id', 'episode_id']
      ]) {
        const a = url.searchParams.get(s);
        const b = url.searchParams.get(e);
        if (a !== null && b !== null) return pair(a, b);
      }
      const match = url.pathname.match(/\/season\/(\d{1,3})\/episode\/(\d{1,3})(?:\/|$)/i);
      return match ? pair(match[1], match[2]) : null;
    } catch {
      return null;
    }
  }

  function visible(element) {
    if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
    const rect = element.getBoundingClientRect?.();
    return !rect || (rect.width > 0 && rect.height > 0);
  }

  // Confirmed from real theatre.stravers.live player (KinoHelper 1.551 report):
  //   button.select__item  "Сезон 1" at top left
  //   button.select__item  "Серия 1" then "Серия 2" after switching
  //   button.select__drop-item.active is the selected dropdown option.
  // Do NOT inspect div.active.textContent: it contains the whole episode list.
  function fromPlayerSelector() {
    const buttons = [...document.querySelectorAll('button.select__item')]
      .slice(0, 20).filter(visible);
    if (!buttons.length) return { present: false };

    const seasons = new Set();
    const episodes = new Set();
    for (const button of buttons) {
      const label = String(button.textContent || '').replace(/\s+/g, ' ').trim();
      const season = label.match(/^(?:Сезон|Season)\s*№?\s*(\d{1,3})$/i);
      const episode = label.match(/^(?:Серия|Episode)\s*№?\s*(\d{1,3})$/i);
      if (season) seasons.add(number(season[1]));
      if (episode) episodes.add(number(episode[1]));
    }
    if (seasons.size !== 1 || episodes.size !== 1 ||
        seasons.has(null) || episodes.has(null)) {
      return { present: true, selection: null };
    }
    const selected = pair([...seasons][0], [...episodes][0]);
    if (!selected) return { present: true, selection: null };

    // Cross-check the expanded menu, if present. The menu may disappear
    // immediately after selecting a new episode; then the closed button is
    // sufficient evidence. Never treat every dropdown option as selected.
    const activeOptions = [...document.querySelectorAll('button.select__drop-item.active')]
      .slice(0, 20).filter(visible);
    for (const option of activeOptions) {
      const label = String(option.textContent || '').replace(/\s+/g, ' ').trim();
      const season = label.match(/^(?:Сезон|Season)\s*№?\s*(\d{1,3})$/i);
      const episode = label.match(/^(?:Серия|Episode)\s*№?\s*(\d{1,3})$/i);
      if ((season && number(season[1]) !== selected.season) ||
          (episode && number(episode[1]) !== selected.episode)) {
        return { present: true, selection: null };
      }
    }
    return { present: true, selection: selected };
  }

  function selectedPair() {
    const controls = [...document.querySelectorAll(
      '[aria-selected="true"],[aria-current="true"],[aria-current="step"],' +
      '[data-selected="true"],.active,.selected,.current'
    )].slice(0, 220).filter(visible);
    const candidates = [];
    const seasons = new Set();
    const episodes = new Set();
    for (const element of controls) {
      const attrs = ['aria-label', 'title', 'data-label', 'data-title'];
      const strings = attrs.map(name => element.getAttribute?.(name)).filter(Boolean);
      if (typeof element.textContent === 'string' && element.textContent.length <= 160) {
        strings.push(element.textContent);
      }
      const dataSeason = element.getAttribute?.('data-season');
      const dataEpisode = element.getAttribute?.('data-episode');
      const explicit = pair(dataSeason, dataEpisode);
      if (explicit) candidates.push(explicit);
      for (const str of strings) {
        const found = parsePhrase(str);
        if (found) candidates.push(found);
        const season = str.match(/^(?:сезон|season)\s*№?\s*(\d{1,3})$/i);
        const episode = str.match(/^(?:серия|episode)\s*№?\s*(\d{1,3})$/i);
        if (season) seasons.add(number(season[1]));
        if (episode) episodes.add(number(episode[1]));
      }
    }
    if (seasons.size === 1 && episodes.size === 1) {
      candidates.push(pair([...seasons][0], [...episodes][0]));
    }
    const unique = new Map(candidates.filter(Boolean).map(c => [
      c.season + ':' + c.episode, c
    ]));
    return unique.size === 1 ? [...unique.values()][0] :
      unique.size > 1 ? { conflict: true } : null;
  }

  function detect() {
    const byUrl = fromUrl();
    const explicit = fromPlayerSelector();
    // If the known series selector is present, never fall back to guessing
    // from generic ".active" containers. Incomplete/contradictory = unknown.
    const byControls = explicit.present ? explicit.selection : selectedPair();
    if (explicit.present && !byControls) return null;
    if (byControls?.conflict) return null;
    if (byUrl && byControls &&
        (byUrl.season !== byControls.season || byUrl.episode !== byControls.episode)) {
      return null;
    }
    return byUrl || byControls;
  }

  function sample() {
    const value = detect();
    const id = value ? value.season + ':' + value.episode : '';
    const currentTime = Date.now();
    if (id !== lastCandidate) {
      lastCandidate = id;
      confirmedAt = currentTime;
      return;
    }
    if (currentTime - confirmedAt < 1200) return;
    if (id === reported && (id === '' || currentTime - reportedAt < REPORT_EVERY_MS)) return;
    // When an episode becomes ambiguous, clear the previous observation.
    // Never keep a stale selected episode merely because no new one matched.
    reported = id;
    reportedAt = currentTime;
    try {
      chrome.runtime.sendMessage({
        action: 'kinoSeriesEpisodeObserved',
        payload: value
          ? { season: value.season, episode: value.episode }
          : { clear: true }
      }).catch(() => {});
    } catch { /* Browser may be unloading the frame. */ }
  }

  function schedule() {
    if (scheduled !== null) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      sample();
    }, 350);
  }

  const observer = new MutationObserver(schedule);
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      subtree: true, childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-selected', 'aria-current',
        'data-selected', 'data-season', 'data-episode']
    });
  }
  sample();
  const interval = setInterval(sample, 2500);
  window.addEventListener('pagehide', () => {
    observer.disconnect();
    clearInterval(interval);
    if (scheduled !== null) clearTimeout(scheduled);
  }, { once: true });
})();
