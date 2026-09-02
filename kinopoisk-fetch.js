(() => {
  'use strict';

  const originalFetch = window.fetch.bind(window);

  function isKinopoiskRequest(input) {
    try {
      const rawUrl = typeof input === 'string' || input instanceof URL
        ? input
        : input?.url;
      if (!rawUrl) return false;

      const url = new URL(rawUrl, window.location.href);
      return /^(?:www\.)?kinopoisk\.ru$/i.test(url.hostname);
    } catch {
      return false;
    }
  }

  window.fetch = (input, init = {}) => {
    if (!isKinopoiskRequest(input)) {
      return originalFetch(input, init);
    }

    return originalFetch(input, {
      ...init,
      credentials: 'include'
    });
  };
})();
