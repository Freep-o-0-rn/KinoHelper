(() => {
  'use strict';

  const KINOPOISK_BASE = 'https://www.kinopoisk.ru';
  const WATCH_BASE = 'https://www.kinokino.vip';
  const LEGACY_FILTERS_KEY = 'kinopoiskFilters';
  const SETTINGS_KEY = 'kinoHelperSettings';

  let engine = null;
  let initialized = false;

  function debug(...args) {
    console.log('[KinoHelper filters]', ...args);
  }

  function showMessage(text, type = 'info') {
    if (typeof window.showMessage === 'function') {
      window.showMessage(text, type);
      return;
    }

    const message = document.getElementById('message');
    if (!message) return;
    message.textContent = text;
    message.className = type;
  }

  function getSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        excludeHistoryFromRandom: saved.excludeHistoryFromRandom !== false
      };
    } catch {
      return { excludeHistoryFromRandom: true };
    }
  }

  function resetLegacyControls() {
    const genre = document.getElementById('genreFilter');
    const type = document.getElementById('typeFilter');
    const year = document.getElementById('yearFilter');
    const highRated = document.getElementById('highRatedCheckbox');
    const released = document.getElementById('releasedCheckbox');
    const popular = document.getElementById('popularCheckbox');

    if (genre) genre.value = '';
    if (type) type.value = '';
    if (year) year.value = '';
    if (highRated) highRated.checked = false;
    if (released) released.checked = false;
    if (popular) popular.checked = false;

    // The new engine migrates the old content type once, then owns filter state.
    localStorage.removeItem(LEGACY_FILTERS_KEY);
  }

  function createUi(filtersElement) {
    const old = filtersElement.querySelector('.kp-dynamic-root');
    if (old) old.remove();

    const root = document.createElement('div');
    root.className = 'kp-dynamic-root';
    root.style.display = 'contents';

    const typeLabel = document.createElement('label');
    typeLabel.className = 'kp-filter-type';
    typeLabel.htmlFor = 'contentTypeFilter';

    const typeCaption = document.createElement('span');
    typeCaption.className = 'kp-filter-caption';
    typeCaption.textContent = 'Тип';

    const typeSelect = document.createElement('select');
    typeSelect.id = 'contentTypeFilter';
    typeSelect.setAttribute('aria-label', 'Тип случайного выбора');
    [
      ['all', 'Все'],
      ['films', 'Фильмы'],
      ['series', 'Сериалы']
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      typeSelect.appendChild(option);
    });

    typeLabel.append(typeCaption, typeSelect);

    const status = document.createElement('div');
    status.id = 'filterStatus';
    status.className = 'filter-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const dynamic = document.createElement('div');
    dynamic.id = 'dynamicFilters';
    dynamic.className = 'dynamic-filters';

    root.append(typeLabel, status, dynamic);
    filtersElement.insertBefore(root, filtersElement.firstChild);

    const buttons = filtersElement.querySelector('.filter-buttons');
    const clearButton = document.getElementById('clearFiltersBtn');
    const retry = document.createElement('button');
    retry.id = 'retryFiltersBtn';
    retry.className = 'btn-retry';
    retry.type = 'button';
    retry.textContent = '↻ Повторить';
    retry.style.display = 'none';

    if (buttons) buttons.insertBefore(retry, clearButton || null);

    return { typeSelect, status, dynamic, retry };
  }

  function usableFilterModel(dynamicElement) {
    return Boolean(
      dynamicElement &&
      dynamicElement.children.length > 0 &&
      !dynamicElement.querySelector('.kp-filter-empty')
    );
  }

  async function pickRandomMovie(contentType, page, filterUrl) {
    const pageUrl = new URL(filterUrl);
    if (page > 1) pageUrl.searchParams.set('page', String(page));
    else pageUrl.searchParams.delete('page');

    const response = await fetch(pageUrl.href);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const scope = doc.querySelector('main') || doc;
    const selector = contentType === 'series'
      ? 'a[href^="/series/"]'
      : contentType === 'film'
        ? 'a[href^="/film/"]'
        : 'a[href^="/film/"], a[href^="/series/"]';

    const candidates = new Map();

    scope.querySelectorAll(selector).forEach(anchor => {
      const href = anchor.getAttribute('href');
      if (!href) return;

      let parsed;
      try {
        parsed = new URL(href, KINOPOISK_BASE);
      } catch {
        return;
      }

      const match = parsed.pathname.match(/^\/(film|series)\/(\d+)(?:\/|$)/);
      if (!match) return;
      if (contentType === 'film' && match[1] !== 'film') return;
      if (contentType === 'series' && match[1] !== 'series') return;

      const key = `${match[1]}:${match[2]}`;
      if (candidates.has(key)) return;

      const card = anchor.closest('[class*="styles_root"], article, li, [data-test-id*="item"]');
      const rawTitle = anchor.querySelector('img')?.alt ||
        card?.querySelector('h3, h2, [class*="name"], [class*="title"]')?.textContent ||
        anchor.textContent ||
        'Неизвестно';

      const title = String(rawTitle)
        .replace(/\s+/g, ' ')
        .replace(/^Смотреть\s+/i, '')
        .trim();

      candidates.set(key, {
        vipUrl: `${WATCH_BASE}${parsed.pathname}`,
        title: title || 'Неизвестно'
      });
    });

    const list = [...candidates.values()];
    if (!list.length) throw new Error('Фильмы/сериалы не найдены на странице');

    return list[Math.floor(Math.random() * list.length)];
  }

  async function runRandom(button, dynamicElement) {
    if (!engine || !initialized) {
      showMessage('Фильтры Кинопоиска ещё загружаются', 'error');
      return;
    }

    if (engine.isUpdating()) {
      showMessage('Подождите обновления фильтров', 'info');
      return;
    }

    if (!usableFilterModel(dynamicElement)) {
      showMessage('Не удалось загрузить фильтры Кинопоиска', 'error');
      return;
    }

    const originalHtml = button.innerHTML;

    try {
      button.innerHTML = '<span class="icon">⏳</span> Поиск...';
      button.classList.add('loading');

      const { url: filterUrl, contentType } = engine.buildUrl();
      const settings = getSettings();
      const attempts = settings.excludeHistoryFromRandom ? 10 : 1;

      showMessage('Ищем с текущими фильтрами...', 'info');

      if (typeof window.getMaxPage !== 'function') {
        throw new Error('Не удалось определить количество страниц');
      }

      const maxPage = await window.getMaxPage(contentType, filterUrl);
      if (!maxPage) throw new Error('Ничего не найдено с такими фильтрами');

      let lastError = null;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const randomPage = Math.floor(Math.random() * maxPage) + 1;
        showMessage(
          settings.excludeHistoryFromRandom
            ? `Ищем новый вариант: ${attempt}/10...`
            : `Ищем на странице ${randomPage}/${maxPage}...`,
          'info'
        );

        try {
          const movie = await pickRandomMovie(contentType, randomPage, filterUrl);

          if (
            settings.excludeHistoryFromRandom &&
            typeof window.historyContains === 'function' &&
            window.historyContains(movie.vipUrl)
          ) {
            debug('Пропускаем просмотренный:', movie.title, movie.vipUrl);
            continue;
          }

          if (typeof window.addToHistory === 'function') {
            window.addToHistory(movie.title, movie.vipUrl);
          }

          showMessage(`Найден: "${movie.title}"`, 'success');

          if (typeof window.openTrackedWatchTab === 'function') {
            const returnUrl = typeof window.buildKinopoiskUrl === 'function'
              ? window.buildKinopoiskUrl(movie.vipUrl)
              : null;
            await window.openTrackedWatchTab(movie.vipUrl, returnUrl);
          } else {
            await chrome.tabs.create({ url: movie.vipUrl });
          }

          return;
        } catch (error) {
          lastError = error;
          debug(`Ошибка случайного выбора, попытка ${attempt}:`, error);
        }
      }

      if (settings.excludeHistoryFromRandom) {
        throw new Error('Не удалось найти непросмотренный фильм за 10 попыток');
      }

      throw lastError || new Error('Не удалось выбрать фильм');
    } catch (error) {
      showMessage(`Ошибка поиска: ${error.message}`, 'error');
    } finally {
      button.innerHTML = originalHtml;
      button.classList.remove('loading');
    }
  }

  async function initialize() {
    const filtersElement = document.getElementById('filters');
    const toggle = document.getElementById('filtersToggle');
    const randomButton = document.getElementById('randomFilm');
    const clearButton = document.getElementById('clearFiltersBtn');

    if (!filtersElement || !toggle || !randomButton || !clearButton) {
      throw new Error('Не найдены элементы интерфейса фильтров');
    }

    const title = toggle.querySelector('span');
    if (title) title.textContent = 'Фильтры случайного выбора';

    const { typeSelect, status, dynamic, retry } = createUi(filtersElement);

    if (!window.KinoFilterEngine?.create) {
      throw new Error('Модуль фильтров не загружен');
    }

    engine = window.KinoFilterEngine.create({
      filtersElement,
      contentTypeElement: typeSelect,
      dynamicElement: dynamic,
      statusElement: status,
      retryElement: retry,
      legacyStorageKey: LEGACY_FILTERS_KEY,
      debug
    });

    // Capture phase makes only Random/Clear use the new engine. The existing
    // watch button and its service-worker flow are not intercepted or changed.
    randomButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void runRandom(randomButton, dynamic);
    }, true);

    clearButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!engine || engine.isUpdating()) return;
      void engine.clear();
    }, true);

    retry.addEventListener('click', () => {
      if (!engine || engine.isUpdating()) return;
      void engine.retry();
    });

    typeSelect.addEventListener('change', () => {
      if (!engine || engine.isUpdating()) return;
      void engine.changeType(typeSelect.value);
    });

    await engine.initialize();
    resetLegacyControls();
    initialized = true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    void initialize().catch(error => {
      debug('Ошибка инициализации:', error);
      showMessage('Не удалось загрузить фильтры Кинопоиска', 'error');
    });
  });
})();
