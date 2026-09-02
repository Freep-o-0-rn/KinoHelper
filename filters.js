(() => {
  'use strict';

  const KINOPOISK_BASE = 'https://www.kinopoisk.ru';
  const STATE_KEY = 'kinopoiskDynamicFilterStateV2';
  const CACHE_KEY = 'kinopoiskDynamicFilterCacheV2';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  const TYPES = {
    all: {
      label: 'Все',
      baseUrl: `${KINOPOISK_BASE}/lists/movies/`,
      randomType: 'all'
    },
    films: {
      label: 'Фильмы',
      baseUrl: `${KINOPOISK_BASE}/lists/movies/?b=films`,
      randomType: 'film'
    },
    series: {
      label: 'Сериалы',
      baseUrl: `${KINOPOISK_BASE}/lists/movies/?b=series`,
      randomType: 'series'
    }
  };

  const EXCLUDED_LABELS = new Set([
    'Фильмы',
    'Сериалы',
    'Скрыть просмотренные',
    'Загрузить на смартфоне'
  ]);

  function safeParse(value, fallback) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function cleanLabel(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isFilterPath(pathname) {
    if (!pathname.startsWith('/lists/movies/')) return false;

    const tail = pathname.slice('/lists/movies/'.length);
    const segments = tail.split('/').filter(Boolean);
    if (!segments.length) return true;

    return segments.every(segment => {
      const separator = segment.indexOf('--');
      return separator > 0 && separator < segment.length - 2;
    });
  }

  function normalizeStateUrl(rawUrl, type) {
    const fallback = TYPES[type]?.baseUrl || TYPES.all.baseUrl;

    try {
      const url = new URL(rawUrl || fallback, fallback);
      if (!/^(?:www\.)?kinopoisk\.ru$/i.test(url.hostname)) return fallback;
      if (!isFilterPath(url.pathname)) return fallback;

      url.protocol = 'https:';
      url.hostname = 'www.kinopoisk.ru';
      url.hash = '';
      url.searchParams.delete('page');
      return url.href;
    } catch {
      return fallback;
    }
  }

  function normalizeCandidateUrl(rawUrl, sourceUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

    const cleaned = rawUrl
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .trim();

    try {
      const url = new URL(cleaned, sourceUrl);
      if (!/^(?:www\.)?kinopoisk\.ru$/i.test(url.hostname)) return null;
      if (!isFilterPath(url.pathname)) return null;
      if (url.searchParams.has('page')) return null;

      url.protocol = 'https:';
      url.hostname = 'www.kinopoisk.ru';
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  function urlsEqual(left, right) {
    try {
      const a = new URL(left);
      const b = new URL(right);
      a.hash = '';
      b.hash = '';
      a.searchParams.delete('page');
      b.searchParams.delete('page');
      return a.href === b.href;
    } catch {
      return left === right;
    }
  }

  function pathFilterMap(url) {
    const result = new Map();

    try {
      const parsed = new URL(url);
      const tail = parsed.pathname.slice('/lists/movies/'.length);

      tail.split('/').filter(Boolean).forEach(segment => {
        const separator = segment.indexOf('--');
        if (separator <= 0) return;
        result.set(segment.slice(0, separator), segment.slice(separator + 2));
      });
    } catch {
      // Ignore malformed URL.
    }

    return result;
  }

  function changedPathKeys(sourceUrl, targetUrl) {
    const source = pathFilterMap(sourceUrl);
    const target = pathFilterMap(targetUrl);
    const keys = new Set([...source.keys(), ...target.keys()]);
    return [...keys].filter(key => source.get(key) !== target.get(key));
  }

  function inferGroupHint(element, ownLabel) {
    let current = element;

    for (let depth = 0; depth < 5 && current?.parentElement; depth += 1) {
      const parent = current.parentElement;
      const hints = parent.querySelectorAll('label, legend, h2, h3, h4, [role="heading"], button');

      for (const hint of hints) {
        if (hint === element || hint.contains(element)) continue;

        const text = cleanLabel(
          hint.getAttribute('aria-label') ||
          hint.getAttribute('title') ||
          hint.textContent
        );

        if (!text || text === ownLabel || text.length > 36) continue;
        return text.replace(/^Все\s+/i, '');
      }

      current = parent;
    }

    return '';
  }

  function isSelectedElement(element) {
    const ariaCurrent = element.getAttribute('aria-current');
    const ariaSelected = element.getAttribute('aria-selected');
    const pressed = element.getAttribute('aria-pressed');
    const className = String(element.className || '');

    return ariaCurrent === 'page' ||
      ariaCurrent === 'true' ||
      ariaSelected === 'true' ||
      pressed === 'true' ||
      /(?:^|\s)(?:active|selected|current)(?:\s|$)/i.test(className);
  }

  function ignoreCandidate(label, url) {
    if (!label || label.length > 70) return true;
    if (EXCLUDED_LABELS.has(label)) return true;
    if (/^\d+$/.test(label)) return true;
    if (/^(?:назад|впер[её]д|следующая|предыдущая)$/i.test(label)) return true;

    try {
      const parsed = new URL(url);
      const bValues = parsed.searchParams.getAll('b');

      if ((label === 'Фильмы' && bValues.includes('films')) ||
          (label === 'Сериалы' && bValues.includes('series'))) {
        return true;
      }
    } catch {
      return true;
    }

    return false;
  }

  function extractCandidates(doc, sourceUrl) {
    const candidates = [];
    const seen = new Set();

    const add = (rawUrl, rawLabel, selected = false, order = 0, groupHint = '') => {
      const label = cleanLabel(rawLabel);
      const url = normalizeCandidateUrl(rawUrl, sourceUrl);
      if (!url || ignoreCandidate(label, url)) return;

      const key = `${label}\n${url}`;
      if (seen.has(key)) return;
      seen.add(key);

      candidates.push({
        label,
        url,
        selected: Boolean(selected),
        order,
        groupHint: cleanLabel(groupHint)
      });
    };

    let order = 0;
    doc.querySelectorAll('a[href], [data-href], [data-url]').forEach(element => {
      const rawUrl = element.getAttribute('href') ||
        element.getAttribute('data-href') ||
        element.getAttribute('data-url');

      const label = cleanLabel(
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.textContent
      );

      add(rawUrl, label, isSelectedElement(element), order++, inferGroupHint(element, label));
    });

    // Closed dropdowns can be serialized into page JSON. Walk the JSON tree
    // and discover generic URL+label pairs without knowing filter names.
    const jsonScripts = doc.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__');
    let jsonOrder = 100000;
    let visited = 0;

    const walk = (node, depth = 0) => {
      if (visited > 80000 || depth > 18 || node == null) return;
      visited += 1;

      if (Array.isArray(node)) {
        node.forEach(item => walk(item, depth + 1));
        return;
      }

      if (typeof node !== 'object') return;

      const rawUrl = node.href || node.url || node.link || node.targetUrl || node.target;
      const rawLabel = node.label || node.title || node.name || node.text || node.caption;

      if (typeof rawUrl === 'string' && typeof rawLabel === 'string') {
        add(
          rawUrl,
          rawLabel,
          Boolean(node.selected || node.active || node.isSelected),
          jsonOrder++
        );
      }

      Object.values(node).forEach(value => walk(value, depth + 1));
    };

    jsonScripts.forEach(script => {
      const text = script.textContent?.trim();
      if (!text || (!text.startsWith('{') && !text.startsWith('['))) return;

      try {
        walk(JSON.parse(text));
      } catch {
        // DOM candidates remain available.
      }
    });

    return candidates.sort((a, b) => a.order - b.order);
  }

  function humanizeKey(key) {
    const text = String(key || 'Фильтр').replace(/[_-]+/g, ' ').trim();
    if (!text) return 'Фильтр';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function buildModel(doc, sourceUrl, contentType) {
    const normalizedSourceUrl = normalizeStateUrl(sourceUrl, contentType);
    const candidates = extractCandidates(doc, normalizedSourceUrl);
    const groupMap = new Map();
    const actions = [];

    candidates.forEach(candidate => {
      const pathChanges = changedPathKeys(normalizedSourceUrl, candidate.url);

      if (pathChanges.length === 1) {
        const groupKey = pathChanges[0];

        if (!groupMap.has(groupKey)) {
          groupMap.set(groupKey, {
            key: groupKey,
            title: candidate.groupHint || '',
            order: candidate.order,
            options: []
          });
        }

        const group = groupMap.get(groupKey);
        if (!group.title && candidate.groupHint) group.title = candidate.groupHint;
        group.order = Math.min(group.order, candidate.order);
        group.options.push(candidate);
        return;
      }

      actions.push(candidate);
    });

    const pathGroups = [...groupMap.values()]
      .map(group => {
        const optionMap = new Map();
        group.options.forEach(option => {
          const optionKey = `${option.label}\n${option.url}`;
          if (!optionMap.has(optionKey)) optionMap.set(optionKey, option);
        });

        const options = [...optionMap.values()];
        const resetOption = options.find(option => /^Все\s+/i.test(option.label));
        let title = group.title;

        if (!title && resetOption) title = resetOption.label.replace(/^Все\s+/i, '');
        if (!title) title = humanizeKey(group.key);

        return { ...group, title, options };
      })
      .filter(group => group.options.length)
      .sort((a, b) => a.order - b.order);

    const actionMap = new Map();
    actions.forEach(action => {
      const key = `${action.label}\n${action.url}`;
      if (!actionMap.has(key)) actionMap.set(key, action);
    });

    const uniqueActions = [...actionMap.values()]
      .filter(action => !pathGroups.some(group =>
        group.options.some(option => option.label === action.label && option.url === action.url)
      ))
      .slice(0, 40);

    if (!pathGroups.length && !uniqueActions.length) {
      throw new Error('Не удалось распознать фильтры Кинопоиска');
    }

    return {
      sourceUrl: normalizedSourceUrl,
      contentType,
      fetchedAt: Date.now(),
      pathGroups,
      actions: uniqueActions
    };
  }

  async function fetchModel(sourceUrl, contentType) {
    const response = await fetch(sourceUrl, {
      cache: 'no-store',
      credentials: 'omit'
    });

    if (!response.ok) throw new Error(`Кинопоиск вернул HTTP ${response.status}`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    if (!doc.querySelector('h1') && !doc.body?.textContent?.includes('Кинопоиск')) {
      throw new Error('Получена некорректная страница Кинопоиска');
    }

    return buildModel(doc, sourceUrl, contentType);
  }

  function create(options) {
    const {
      filtersElement,
      contentTypeElement,
      dynamicElement,
      statusElement,
      retryElement,
      legacyStorageKey = 'kinopoiskFilters',
      debug = () => {}
    } = options;

    let state = null;
    let currentModel = null;
    let updating = false;

    function createTypeState(type) {
      return {
        sourceUrl: TYPES[type].baseUrl,
        selectedLabels: {}
      };
    }

    function createDefaultState() {
      const legacy = safeParse(localStorage.getItem(legacyStorageKey) || 'null', null);
      let contentType = 'all';

      if (legacy?.type === 'films') contentType = 'films';
      if (legacy?.type === 'series') contentType = 'series';

      return {
        contentType,
        byType: {
          all: createTypeState('all'),
          films: createTypeState('films'),
          series: createTypeState('series')
        }
      };
    }

    function loadState() {
      const saved = safeParse(localStorage.getItem(STATE_KEY) || 'null', null);
      const result = saved && typeof saved === 'object' ? saved : createDefaultState();

      if (!TYPES[result.contentType]) result.contentType = 'all';
      if (!result.byType || typeof result.byType !== 'object') result.byType = {};

      Object.keys(TYPES).forEach(type => {
        const existing = result.byType[type];

        if (!existing || typeof existing !== 'object') {
          result.byType[type] = createTypeState(type);
          return;
        }

        result.byType[type] = {
          sourceUrl: normalizeStateUrl(existing.sourceUrl, type),
          selectedLabels: existing.selectedLabels && typeof existing.selectedLabels === 'object'
            ? existing.selectedLabels
            : {}
        };
      });

      return result;
    }

    function saveState() {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    }

    function activeTypeState() {
      return state.byType[state.contentType];
    }

    function loadCache() {
      const cache = safeParse(localStorage.getItem(CACHE_KEY) || '{}', {});
      return cache && typeof cache === 'object' ? cache : {};
    }

    function saveCache(cache) {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    }

    function cacheModel(type, model) {
      const cache = loadCache();
      cache[type] = {
        fetchedAt: Date.now(),
        sourceUrl: model.sourceUrl,
        model
      };
      saveCache(cache);
    }

    function cachedModel(type) {
      const entry = loadCache()[type];
      return entry?.model && entry?.sourceUrl ? entry : null;
    }

    function fresh(entry) {
      return Boolean(entry && Date.now() - Number(entry.fetchedAt || 0) < CACHE_TTL_MS);
    }

    function setStatus(text = '', type = '') {
      statusElement.textContent = text;
      statusElement.className = 'filter-status';
      if (!text) return;
      statusElement.classList.add('visible');
      if (type) statusElement.classList.add(type);
    }

    function setUpdating(value, text = 'Обновляем фильтры...') {
      updating = value;
      filtersElement.classList.toggle('is-updating', value);
      if (value) setStatus(`⏳ ${text}`, 'loading');
    }

    function selectedLabel(group) {
      const remembered = activeTypeState().selectedLabels?.[group.key];
      if (remembered) return remembered;

      const selected = group.options.find(option =>
        option.selected || urlsEqual(option.url, activeTypeState().sourceUrl)
      );
      if (selected) return selected.label;

      const reset = group.options.find(option => /^Все\s+/i.test(option.label));
      return reset?.label || group.title;
    }

    function render(model) {
      currentModel = model;
      contentTypeElement.value = state.contentType;
      dynamicElement.innerHTML = '';

      model.pathGroups.forEach(group => {
        const wrapper = document.createElement('label');
        wrapper.className = 'kp-filter-group';

        const caption = document.createElement('span');
        caption.className = 'kp-filter-caption';
        caption.textContent = group.title;

        const select = document.createElement('select');
        select.className = 'kp-filter-select';
        select.setAttribute('aria-label', group.title);

        const currentOption = group.options.find(option =>
          option.selected || urlsEqual(option.url, activeTypeState().sourceUrl)
        );

        if (!currentOption) {
          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = selectedLabel(group);
          placeholder.selected = true;
          placeholder.disabled = true;
          select.appendChild(placeholder);
        }

        group.options.forEach(option => {
          const node = document.createElement('option');
          node.value = option.url;
          node.textContent = option.label;
          node.selected = Boolean(
            currentOption &&
            option.label === currentOption.label &&
            option.url === currentOption.url
          );
          select.appendChild(node);
        });

        select.addEventListener('change', () => {
          const node = select.options[select.selectedIndex];
          if (!node?.value) return;
          void applyUrl(node.value, { groupKey: group.key, label: node.textContent });
        });

        wrapper.append(caption, select);
        dynamicElement.appendChild(wrapper);
      });

      if (model.actions.length) {
        const block = document.createElement('div');
        block.className = 'kp-filter-actions';

        model.actions.forEach(action => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'kp-filter-chip';
          button.textContent = action.label;

          if (action.selected || urlsEqual(action.url, activeTypeState().sourceUrl)) {
            button.classList.add('active');
          }

          button.addEventListener('click', () => void applyUrl(action.url));
          block.appendChild(button);
        });

        dynamicElement.appendChild(block);
      }
    }

    async function applyUrl(targetUrl, meta = {}) {
      if (updating) return;

      const type = state.contentType;
      const previousState = JSON.parse(JSON.stringify(activeTypeState()));
      const previousModel = currentModel;
      setUpdating(true);

      try {
        const model = await fetchModel(targetUrl, type);
        activeTypeState().sourceUrl = model.sourceUrl;

        if (meta.groupKey && meta.label) {
          activeTypeState().selectedLabels[meta.groupKey] = meta.label;
        }

        saveState();
        cacheModel(type, model);
        render(model);
        retryElement.style.display = 'none';
        setStatus();
      } catch (error) {
        state.byType[type] = previousState;
        saveState();
        if (previousModel) render(previousModel);
        debug('Не удалось обновить фильтры:', error);
        setStatus('Не удалось обновить фильтры Кинопоиска', 'error');
        retryElement.style.display = 'inline-flex';
      } finally {
        filtersElement.classList.remove('is-updating');
        updating = false;
      }
    }

    async function load({ force = false } = {}) {
      const type = state.contentType;
      const typeState = activeTypeState();
      const cacheEntry = cachedModel(type);
      contentTypeElement.value = type;

      if (!force && fresh(cacheEntry) && urlsEqual(cacheEntry.sourceUrl, typeState.sourceUrl)) {
        render(cacheEntry.model);
        retryElement.style.display = 'none';
        setStatus();
        return;
      }

      setUpdating(true, 'Загружаем фильтры...');

      try {
        const model = await fetchModel(typeState.sourceUrl, type);
        typeState.sourceUrl = model.sourceUrl;
        saveState();
        cacheModel(type, model);
        render(model);
        retryElement.style.display = 'none';
        setStatus();
      } catch (error) {
        debug('Ошибка загрузки фильтров:', error);

        if (cacheEntry?.model) {
          typeState.sourceUrl = cacheEntry.sourceUrl;
          saveState();
          render(cacheEntry.model);
          setStatus('Не удалось обновить фильтры. Используется последний кэш', 'error');
        } else {
          currentModel = null;
          dynamicElement.innerHTML = '<div class="kp-filter-empty">Не удалось загрузить фильтры Кинопоиска</div>';
          setStatus('Не удалось загрузить фильтры Кинопоиска', 'error');
        }

        retryElement.style.display = 'inline-flex';
      } finally {
        filtersElement.classList.remove('is-updating');
        updating = false;
      }
    }

    async function changeType(type) {
      if (!TYPES[type] || updating) return;
      state.contentType = type;
      saveState();
      await load();
    }

    async function clear() {
      if (updating) return;

      const type = state.contentType;
      const previousState = JSON.parse(JSON.stringify(activeTypeState()));
      const previousModel = currentModel;
      setUpdating(true, 'Сбрасываем фильтры...');

      try {
        const model = await fetchModel(TYPES[type].baseUrl, type);
        state.byType[type] = {
          sourceUrl: model.sourceUrl,
          selectedLabels: {}
        };
        saveState();
        cacheModel(type, model);
        render(model);
        retryElement.style.display = 'none';
        setStatus();
      } catch (error) {
        state.byType[type] = previousState;
        saveState();
        if (previousModel) render(previousModel);
        debug('Не удалось сбросить фильтры:', error);
        setStatus('Не удалось обновить фильтры Кинопоиска', 'error');
        retryElement.style.display = 'inline-flex';
      } finally {
        filtersElement.classList.remove('is-updating');
        updating = false;
      }
    }

    async function initialize() {
      state = loadState();
      contentTypeElement.value = state.contentType;
      await load();
    }

    function showState() {
      const active = activeTypeState();
      const result = { type: state.contentType, url: active.sourceUrl };
      debug('Текущие фильтры Кинопоиска:', result);
      return result;
    }

    function buildUrl() {
      const active = activeTypeState();
      return {
        url: active.sourceUrl,
        contentType: TYPES[state.contentType].randomType
      };
    }

    return {
      initialize,
      changeType,
      clear,
      retry: () => load({ force: true }),
      showState,
      buildUrl,
      getBaseUrl: type => TYPES[type]?.baseUrl || TYPES.all.baseUrl,
      isUpdating: () => updating
    };
  }

  window.KinoFilterEngine = {
    create,
    cleanLabel
  };
})();
