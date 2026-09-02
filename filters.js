(() => {
  'use strict';

  const KINOPOISK_BASE = 'https://www.kinopoisk.ru';
  const STATE_KEY = 'kinopoiskDynamicFilterStateV2';
  const CACHE_KEY = 'kinopoiskDynamicFilterCacheV4';
  const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV2';
  const FILTER_CATALOG_KEY = 'kinopoiskFilterCatalogV2';
  const LEGACY_CACHE_KEYS = ['kinopoiskDynamicFilterCacheV3', 'kinopoiskDynamicFilterCacheV2'];
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const PAGE_CACHE_MAX_ENTRIES = 40;

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
    return String(pathname || '').startsWith('/lists/movies/');
  }

  function stripNonFilterParams(url) {
    url.searchParams.delete('page');
    url.searchParams.delete('ysclid');

    [...url.searchParams.keys()].forEach(key => {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    });

    return url;
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
      return stripNonFilterParams(url).href;
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

      url.protocol = 'https:';
      url.hostname = 'www.kinopoisk.ru';
      url.hash = '';
      return stripNonFilterParams(url).href;
    } catch {
      return null;
    }
  }

  function comparableUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.hash = '';
    url.searchParams.delete('page');
    url.searchParams.delete('ysclid');

    const entries = [...url.searchParams.entries()]
      .filter(([key]) => !/^utm_/i.test(key))
      .sort(([keyA, valueA], [keyB, valueB]) =>
        keyA.localeCompare(keyB) || valueA.localeCompare(valueB)
      );

    url.search = '';
    entries.forEach(([key, value]) => url.searchParams.append(key, value));
    return url.href;
  }

  function urlsEqual(left, right) {
    try {
      return comparableUrl(left) === comparableUrl(right);
    } catch {
      return left === right;
    }
  }

  function queryValues(rawUrl, key) {
    try {
      return new URL(rawUrl).searchParams.getAll(key).slice().sort();
    } catch {
      return [];
    }
  }

  function multisetContains(container, subset) {
    const remaining = [...container];
    for (const value of subset) {
      const index = remaining.indexOf(value);
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return true;
  }

  // Kinopoisk's active quick-filter chip normally links to the URL that
  // DISABLES that filter. Therefore an active chip has fewer b= values in its
  // target than in the current source URL.
  function isActiveQueryToggle(sourceUrl, targetUrl, key) {
    const sourceValues = queryValues(sourceUrl, key);
    const targetValues = queryValues(targetUrl, key);
    return sourceValues.length > targetValues.length &&
      multisetContains(sourceValues, targetValues);
  }

  function filterStateMap(rawUrl) {
    const result = new Map();

    try {
      const url = new URL(rawUrl);
      const tail = url.pathname.slice('/lists/movies/'.length);

      tail.split('/').filter(Boolean).forEach((segment, index) => {
        const separator = segment.indexOf('--');
        const key = separator > 0
          ? `path:${segment.slice(0, separator)}`
          : `path:${index}`;
        result.set(key, segment);
      });

      const queryKeys = new Set([...url.searchParams.keys()]);
      queryKeys.forEach(key => {
        if (key === 'page' || key === 'ysclid' || /^utm_/i.test(key)) return;
        const values = url.searchParams.getAll(key).slice().sort();
        result.set(`query:${key}`, JSON.stringify(values));
      });
    } catch {
      // Ignore malformed URL.
    }

    return result;
  }

  function changedFilterKeys(sourceUrl, targetUrl) {
    const source = filterStateMap(sourceUrl);
    const target = filterStateMap(targetUrl);
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

  function elementDepth(element) {
    let depth = 0;
    let current = element;
    while (current?.parentElement) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function findExactTextElement(doc, text) {
    let best = null;
    let bestDepth = -1;

    doc.querySelectorAll('div, span, button, label, p, h2, h3, h4').forEach(element => {
      if (cleanLabel(element.textContent) !== text) return;
      const depth = elementDepth(element);
      if (depth > bestDepth) {
        best = element;
        bestDepth = depth;
      }
    });

    return best;
  }

  function commonAncestor(elements) {
    if (!elements.length) return null;
    let current = elements[0];

    while (current && !elements.every(element => current.contains(element))) {
      current = current.parentElement;
    }

    return current;
  }

  function findSidebarRoot(doc) {
    const anchors = ['Страны', 'Жанры', 'Годы']
      .map(text => findExactTextElement(doc, text))
      .filter(Boolean);

    if (anchors.length < 2) {
      const fallback = ['Все страны', 'Все жанры', 'Все годы']
        .map(text => findExactTextElement(doc, text))
        .filter(Boolean);
      anchors.push(...fallback);
    }

    if (anchors.length < 2) return null;

    let root = commonAncestor(anchors);
    if (!root) return null;

    // Ascend enough to include the quick-filter buttons above the dropdowns,
    // but stop before the main movie list enters the container.
    while (root.parentElement && root.parentElement !== doc.body) {
      const parent = root.parentElement;
      const movieLinks = parent.querySelectorAll('a[href^="/film/"], a[href^="/series/"]').length;
      if (movieLinks > 2 || parent.querySelector('h1')) break;
      root = parent;
    }

    return root;
  }

  function extractCandidates(doc, sourceUrl) {
    const sidebarRoot = findSidebarRoot(doc);
    if (!sidebarRoot) {
      throw new Error('Не удалось найти боковые фильтры Кинопоиска');
    }

    const sidebarCandidates = [];
    const jsonCandidates = [];
    const seen = new Set();

    const add = (bucket, rawUrl, rawLabel, selected = false, order = 0, groupHint = '', scope = 'sidebar') => {
      const label = cleanLabel(rawLabel);
      const url = normalizeCandidateUrl(rawUrl, sourceUrl);
      if (!url || ignoreCandidate(label, url)) return;

      const key = `${scope}\n${label}\n${url}`;
      if (seen.has(key)) return;
      seen.add(key);

      bucket.push({
        label,
        url,
        selected: Boolean(selected),
        order,
        groupHint: cleanLabel(groupHint),
        scope
      });
    };

    let order = 0;
    sidebarRoot.querySelectorAll('a[href], [data-href], [data-url]').forEach(element => {
      const rawUrl = element.getAttribute('href') ||
        element.getAttribute('data-href') ||
        element.getAttribute('data-url');

      const label = cleanLabel(
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.textContent
      );

      add(
        sidebarCandidates,
        rawUrl,
        label,
        isSelectedElement(element),
        order++,
        inferGroupHint(element, label),
        'sidebar'
      );
    });

    // Native selects are uncommon on Kinopoisk, but support them generically.
    sidebarRoot.querySelectorAll('select').forEach(select => {
      const groupHint = cleanLabel(
        select.getAttribute('aria-label') ||
        select.closest('label')?.querySelector('span')?.textContent ||
        ''
      );

      [...select.options].forEach(option => {
        add(
          sidebarCandidates,
          option.value,
          option.textContent,
          option.selected,
          order++,
          groupHint,
          'sidebar'
        );
      });
    });

    // Closed Kinopoisk dropdowns are often serialized in page JSON. We inspect
    // URL+label pairs generically, but later keep only groups whose reset label
    // is actually visible in the sidebar (for example "Все страны").
    const jsonScripts = doc.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__');
    let jsonOrder = 100000;
    let visited = 0;

    const walk = (node, depth = 0) => {
      if (visited > 100000 || depth > 20 || node == null) return;
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
          jsonCandidates,
          rawUrl,
          rawLabel,
          Boolean(node.selected || node.active || node.isSelected),
          jsonOrder++,
          '',
          'json'
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
        // DOM sidebar candidates remain available.
      }
    });

    return {
      sidebarCandidates: sidebarCandidates.sort((a, b) => a.order - b.order),
      jsonCandidates: jsonCandidates.sort((a, b) => a.order - b.order),
      sidebarText: cleanLabel(sidebarRoot.textContent)
    };
  }

  function humanizeKey(key) {
    const text = String(key || 'Фильтр').replace(/[_-]+/g, ' ').trim();
    if (!text) return 'Фильтр';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function buildModel(doc, sourceUrl, contentType) {
    const normalizedSourceUrl = normalizeStateUrl(sourceUrl, contentType);
    const { sidebarCandidates, jsonCandidates, sidebarText } = extractCandidates(doc, normalizedSourceUrl);
    const groupMap = new Map();
    const actions = [];

    const addGroupOption = (groupKey, candidate) => {
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
    };

    sidebarCandidates.forEach(candidate => {
      const changes = changedFilterKeys(normalizedSourceUrl, candidate.url);

      // Quick filters on Kinopoisk are represented by repeated ?b= values.
      // Keep them as buttons exactly as they appear in the sidebar.
      if (changes.length === 1 && changes[0] === 'query:b') {
        candidate.selected = Boolean(
          candidate.selected ||
          isActiveQueryToggle(normalizedSourceUrl, candidate.url, 'b')
        );
        actions.push(candidate);
        return;
      }

      if (changes.length === 1) {
        addGroupOption(changes[0], candidate);
        return;
      }

      // A sidebar link that changes several parameters is still a valid
      // quick action. Main-content links are not in sidebarCandidates at all.
      if (changes.length > 0) actions.push(candidate);
    });

    // JSON may contain the options of closed dropdowns. Never create quick
    // actions from JSON because that is what previously pulled in central-page
    // modes, counters and unrelated links.
    jsonCandidates.forEach(candidate => {
      const changes = changedFilterKeys(normalizedSourceUrl, candidate.url);
      if (changes.length !== 1 || changes[0] === 'query:b') return;
      addGroupOption(changes[0], candidate);
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
        const hasSidebarOption = options.some(option => option.scope === 'sidebar');

        // Closed-dropdown data is trusted only if its reset value is visibly
        // present in the actual Kinopoisk sidebar. This removes unrelated
        // "Все мультфильмы" / support / central-list data.
        const resetVisible = Boolean(resetOption && sidebarText.includes(resetOption.label));
        if (!hasSidebarOption && !resetVisible) return null;

        let title = group.title;
        if (resetOption) title = resetOption.label.replace(/^Все\s+/i, '');
        if (!title) title = humanizeKey(group.key.replace(/^query:|^path:/, ''));
        title = title.charAt(0).toUpperCase() + title.slice(1);

        return { ...group, title, options };
      })
      .filter(Boolean)
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
      .slice(0, 20);

    if (!pathGroups.length && !uniqueActions.length) {
      throw new Error('Не удалось распознать боковые фильтры Кинопоиска');
    }

    return {
      sourceUrl: normalizedSourceUrl,
      contentType,
      fetchedAt: Date.now(),
      pathGroups,
      actions: uniqueActions
    };
  }

  function pathSegmentForKey(rawUrl, key) {
    try {
      const url = new URL(rawUrl);
      return url.pathname
        .slice('/lists/movies/'.length)
        .split('/')
        .filter(Boolean)
        .find(segment => segment.startsWith(`${key}--`)) || null;
    } catch {
      return null;
    }
  }

  function applyCatalogOption(sourceUrl, templateUrl, groupKey) {
    try {
      const key = String(groupKey || '').replace(/^path:/, '');
      if (!key) return sourceUrl;

      const source = new URL(sourceUrl);
      const template = new URL(templateUrl);
      const templateSegment = pathSegmentForKey(template.href, key);
      let segments = source.pathname
        .slice('/lists/movies/'.length)
        .split('/')
        .filter(Boolean)
        .filter(segment => !segment.startsWith(`${key}--`));

      if (templateSegment) {
        segments.push(templateSegment);
      }

      const rank = segment => {
        if (segment.startsWith('genre--')) return 10;
        if (segment.startsWith('country--')) return 20;
        if (segment.startsWith('year--')) return 30;
        return 100;
      };
      segments.sort((a, b) => rank(a) - rank(b));

      source.pathname = `/lists/movies/${segments.length ? `${segments.join('/')}/` : ''}`;
      source.hash = '';
      source.searchParams.delete('page');
      return stripNonFilterParams(source).href;
    } catch {
      return sourceUrl;
    }
  }

  function enrichModelWithCatalog(model, catalog) {
    if (!catalog?.groups || typeof catalog.groups !== 'object') return model;

    const groups = [...model.pathGroups];
    const order = ['country', 'genre', 'year'];

    order.forEach((key, index) => {
      const catalogGroup = catalog.groups[key];
      if (!catalogGroup?.options?.length) return;

      const groupKey = `path:${key}`;
      let group = groups.find(item => item.key === groupKey);
      if (!group) {
        group = {
          key: groupKey,
          title: catalogGroup.title,
          order: 50000 + index,
          options: []
        };
        groups.push(group);
      }

      const optionMap = new Map();
      group.options.forEach(option => optionMap.set(option.label, option));

      const resetUrl = applyCatalogOption(model.sourceUrl, catalogGroup.resetUrl, groupKey);
      optionMap.set(catalogGroup.resetLabel, {
        label: catalogGroup.resetLabel,
        url: resetUrl,
        selected: !pathSegmentForKey(model.sourceUrl, key),
        order: -1,
        groupHint: catalogGroup.title,
        scope: 'catalog'
      });

      catalogGroup.options.forEach((option, optionIndex) => {
        const url = applyCatalogOption(model.sourceUrl, option.url, groupKey);
        const selectedSegment = pathSegmentForKey(model.sourceUrl, key);
        const optionSegment = pathSegmentForKey(url, key);
        optionMap.set(option.label, {
          label: option.label,
          url,
          selected: Boolean(selectedSegment && optionSegment === selectedSegment),
          order: optionIndex,
          groupHint: catalogGroup.title,
          scope: 'catalog'
        });
      });

      group.title = catalogGroup.title;
      group.options = [...optionMap.values()];
    });

    model.pathGroups = groups.sort((a, b) => a.order - b.order);
    return model;
  }

  let filterCatalogMemory = null;

  async function readStoredFilterCatalog() {
    if (filterCatalogMemory) return filterCatalogMemory;
    try {
      const stored = await chrome.storage.local.get(FILTER_CATALOG_KEY);
      filterCatalogMemory = stored?.[FILTER_CATALOG_KEY] || null;
    } catch {
      filterCatalogMemory = null;
    }
    return filterCatalogMemory;
  }

  async function saveFilterCatalog(catalog) {
    filterCatalogMemory = catalog;
    await chrome.storage.local.set({ [FILTER_CATALOG_KEY]: catalog });
  }

  function filterCatalogFresh(catalog) {
    return Boolean(catalog && Date.now() - Number(catalog.fetchedAt || 0) < CACHE_TTL_MS);
  }

  async function extractFilterCatalogFromTab(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
        const targets = [
          { key: 'country', title: 'Страны', resetLabel: 'Все страны' },
          { key: 'genre', title: 'Жанры', resetLabel: 'Все жанры' },
          { key: 'year', title: 'Годы', resetLabel: 'Все годы' }
        ];

        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        const visible = element => {
          if (!(element instanceof Element)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
        };

        const exact = text => [...document.querySelectorAll('div, span, button, label, p')]
          .filter(node => clean(node.textContent) === text)
          .sort((a, b) => {
            const av = visible(a) ? 1 : 0;
            const bv = visible(b) ? 1 : 0;
            if (av !== bv) return bv - av;
            return a.querySelectorAll('*').length - b.querySelectorAll('*').length;
          })[0] || null;

        const clickableFor = target => {
          const reset = exact(target.resetLabel);
          if (reset) {
            const clickable = reset.closest(
              'button, a, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]'
            );
            if (clickable) return clickable;

            let current = reset.parentElement;
            for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
              if (visible(current) && current.getBoundingClientRect().width > 100) return current;
            }
          }

          const heading = exact(target.title);
          let root = heading?.parentElement || null;
          for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
            const nodes = [...root.querySelectorAll(
              'button, a, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]'
            )].filter(visible);
            const candidate = nodes.find(node => {
              const value = clean(node.textContent);
              return value && value !== target.title && value.length < 80;
            });
            if (candidate) return candidate;
          }
          return null;
        };

        const resetUrlFor = key => {
          const url = new URL(location.href);
          const parts = url.pathname
            .slice('/lists/movies/'.length)
            .split('/')
            .filter(Boolean)
            .filter(segment => !segment.startsWith(`${key}--`));
          url.pathname = `/lists/movies/${parts.length ? `${parts.join('/')}/` : ''}`;
          url.searchParams.delete('page');
          url.hash = '';
          return url.href;
        };

        const optionUrlFromNode = (node, target) => {
          const attrs = [
            node.getAttribute?.('href'),
            node.getAttribute?.('data-href'),
            node.getAttribute?.('data-url'),
            node.getAttribute?.('data-link')
          ].filter(Boolean);

          for (const raw of attrs) {
            try {
              const url = new URL(raw, location.href);
              if (url.pathname.startsWith('/lists/movies/') &&
                  url.pathname.includes(`${target.key}--`)) {
                return url.href;
              }
            } catch {}
          }

          const html = node.outerHTML || '';
          const escaped = html.replace(/&amp;/g, '&').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
          const pathMatch = escaped.match(new RegExp(
            `(?:https?:\\/\\/(?:www\\.)?kinopoisk\\.ru)?(\\/lists\\/movies\\/[^\"'<>\\s]*${target.key}--[^\"'<>\\s]*)`,
            'i'
          ));
          if (pathMatch) {
            try { return new URL(pathMatch[1], location.href).href; } catch {}
          }

          // Some Kinopoisk dropdown options expose only their actual value in
          // DOM data attributes. The value itself still comes from Kinopoisk;
          // we only place it into the filter path format used by this page.
          const rawValue = node.getAttribute?.('data-value') ||
            node.getAttribute?.('data-id') ||
            node.getAttribute?.('value');
          if (rawValue && /^[\w-]+$/u.test(rawValue)) {
            const url = new URL(resetUrlFor(target.key));
            const segments = url.pathname
              .slice('/lists/movies/'.length)
              .split('/')
              .filter(Boolean)
              .filter(segment => !segment.startsWith(`${target.key}--`));
            segments.push(`${target.key}--${rawValue}`);
            url.pathname = `/lists/movies/${segments.join('/')}/`;
            return url.href;
          }

          return null;
        };

        const waitForOptions = async target => {
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const nodes = [...document.querySelectorAll(
              'a[href], [data-href], [data-url], [data-link], [data-value], [data-id], [role="option"], [role="menuitem"], li, button'
            )].filter(visible);
            const found = nodes.filter(node => optionUrlFromNode(node, target));
            if (found.length > 1) return found;
            await delay(100);
          }
          return [];
        };

        const groups = {};

        for (const target of targets) {
          const trigger = clickableFor(target);
          if (!trigger) continue;

          try {
            trigger.click();
            await delay(180);
            const nodes = await waitForOptions(target);
            const options = new Map();

            nodes.forEach(node => {
              const label = clean(
                node.getAttribute?.('aria-label') ||
                node.getAttribute?.('title') ||
                node.textContent
              );
              if (!label || label.length > 70 || label === target.resetLabel) return;

              const url = optionUrlFromNode(node, target);
              if (!url) return;
              options.set(label, { label, url });
            });

            if (options.size) {
              groups[target.key] = {
                key: `path:${target.key}`,
                title: target.title,
                resetLabel: target.resetLabel,
                resetUrl: resetUrlFor(target.key),
                options: [...options.values()]
              };
            }
          } finally {
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape',
              code: 'Escape',
              keyCode: 27,
              which: 27,
              bubbles: true
            }));
            await delay(80);
          }
        }

        return { groups };
      }
    });

    const catalog = results?.[0]?.result;
    if (!catalog?.groups || !Object.keys(catalog.groups).length) {
      throw new Error('Кинопоиск не отдал варианты выпадающих фильтров');
    }

    return {
      fetchedAt: Date.now(),
      groups: catalog.groups
    };
  }

  async function waitForTabComplete(tabId, timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete' && /\/lists\/movies\//.test(tab.url || '')) {
        await new Promise(resolve => setTimeout(resolve, 700));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Служебная страница Кинопоиска не успела загрузиться');
  }

  async function extractFilterCatalogFromExistingTab() {
    const tabs = await chrome.tabs.query({
      url: ['https://www.kinopoisk.ru/lists/movies/*', 'https://kinopoisk.ru/lists/movies/*']
    });

    const candidates = tabs.filter(tab => Number.isInteger(tab.id) && !tab.discarded);
    let lastError = null;

    for (const tab of candidates) {
      try {
        return await extractFilterCatalogFromTab(tab.id);
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      candidates.length
        ? `Открытая страница Кинопоиска не подошла: ${lastError?.message || 'ошибка'}`
        : 'Открытой страницы списков Кинопоиска нет'
    );
  }

  async function extractFilterCatalogAutomatically() {
    // If the user already has a suitable Kinopoisk list open, reuse it without
    // changing that tab. Otherwise create a separate minimized, unfocused
    // service window and remove it immediately after the catalog is captured.
    try {
      return await extractFilterCatalogFromExistingTab();
    } catch {
      // Continue with the isolated service window.
    }

    let serviceWindowId = null;
    try {
      const serviceWindow = await chrome.windows.create({
        url: TYPES.all.baseUrl,
        type: 'popup',
        focused: false,
        state: 'minimized',
        width: 520,
        height: 720
      });

      serviceWindowId = serviceWindow.id;
      const serviceTab = serviceWindow.tabs?.[0];
      if (!serviceTab?.id) {
        throw new Error('Не удалось создать служебную вкладку Кинопоиска');
      }

      await waitForTabComplete(serviceTab.id);
      return await extractFilterCatalogFromTab(serviceTab.id);
    } finally {
      if (Number.isInteger(serviceWindowId)) {
        try {
          await chrome.windows.remove(serviceWindowId);
        } catch {}
      }
    }
  }

  async function getFilterCatalog() {
    const stored = await readStoredFilterCatalog();
    if (filterCatalogFresh(stored)) return stored;

    try {
      const freshCatalog = await extractFilterCatalogAutomatically();
      await saveFilterCatalog(freshCatalog);
      return freshCatalog;
    } catch (error) {
      console.warn('[KinoHelper filters] Не удалось обновить каталог dropdown:', error);
      return stored;
    }
  }

  function isKinopoiskListsUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return /^(?:www\.)?kinopoisk\.ru$/i.test(url.hostname) &&
        url.pathname.startsWith('/lists/movies/');
    } catch {
      return false;
    }
  }

  async function fetchKinopoiskDirect(sourceUrl) {
    const response = await fetch(sourceUrl, {
      cache: 'no-store',
      credentials: 'include',
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`Кинопоиск вернул HTTP ${response.status}`);
    }

    const finalUrl = response.url || sourceUrl;
    if (!isKinopoiskListsUrl(finalUrl)) {
      throw new Error('Кинопоиск перенаправил запрос на другую страницу');
    }

    return {
      html: await response.text(),
      url: finalUrl
    };
  }

  async function fetchKinopoiskThroughOpenTab(sourceUrl) {
    const tabs = await chrome.tabs.query({
      url: ['https://www.kinopoisk.ru/*', 'https://kinopoisk.ru/*']
    });

    const candidates = tabs.filter(tab => Number.isInteger(tab.id) && !tab.discarded);
    let lastError = null;

    for (const tab of candidates) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async targetUrl => {
            const response = await fetch(targetUrl, {
              cache: 'no-store',
              credentials: 'include',
              redirect: 'follow'
            });

            return {
              ok: response.ok,
              status: response.status,
              url: response.url,
              html: await response.text()
            };
          },
          args: [sourceUrl]
        });

        const page = results?.[0]?.result;
        if (!page?.ok) {
          throw new Error(`HTTP ${page?.status || 'unknown'}`);
        }
        if (!page.html || !isKinopoiskListsUrl(page.url)) {
          throw new Error('Кинопоиск вернул неожиданную страницу');
        }

        return { html: page.html, url: page.url };
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      candidates.length
        ? `Не удалось использовать открытую вкладку Кинопоиска: ${lastError?.message || 'ошибка'}`
        : 'Нет открытой вкладки Кинопоиска для резервной загрузки'
    );
  }

  async function readKinopoiskPage(sourceUrl) {
    let directError = null;

    try {
      return await fetchKinopoiskDirect(sourceUrl);
    } catch (error) {
      directError = error;
    }

    try {
      return await fetchKinopoiskThroughOpenTab(sourceUrl);
    } catch (tabError) {
      throw new Error(
        `Не удалось загрузить Кинопоиск без открытия новой вкладки. ` +
        `Прямой запрос: ${directError?.message || 'ошибка'}. ` +
        `Резервный запрос: ${tabError.message}`
      );
    }
  }

  async function readRenderedPageFromTab(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ html: document.documentElement.outerHTML, url: location.href })
    });

    const page = results?.[0]?.result;
    if (!page?.html || !isKinopoiskListsUrl(page.url)) {
      throw new Error('Не удалось прочитать отрисованную страницу Кинопоиска');
    }
    return page;
  }

  async function buildCompleteModelFromTab(tabId, sourceUrl, contentType) {
    const requestedUrl = normalizeStateUrl(sourceUrl, contentType);
    const page = await readRenderedPageFromTab(tabId);
    const doc = new DOMParser().parseFromString(page.html, 'text/html');

    if (!doc.querySelector('h1') && !doc.body?.textContent?.includes('Кинопоиск')) {
      throw new Error('Получена некорректная страница Кинопоиска');
    }

    const model = buildModel(doc, requestedUrl, contentType);
    const catalog = await extractFilterCatalogFromTab(tabId);
    model.sourceUrl = requestedUrl;
    model.fetchedAt = Date.now();
    return enrichModelWithCatalog(model, catalog);
  }

  async function findMatchingListTab(sourceUrl) {
    const tabs = await chrome.tabs.query({
      url: ['https://www.kinopoisk.ru/lists/movies/*', 'https://kinopoisk.ru/lists/movies/*']
    });

    return tabs.find(tab => {
      if (!Number.isInteger(tab.id) || tab.discarded || !tab.url) return false;
      try { return comparableUrl(tab.url) === comparableUrl(sourceUrl); }
      catch { return false; }
    }) || null;
  }

  async function fetchCompleteModelViaServiceWindow(sourceUrl, contentType) {
    const requestedUrl = normalizeStateUrl(sourceUrl, contentType);
    let serviceWindowId = null;

    try {
      const serviceWindow = await chrome.windows.create({
        url: requestedUrl,
        type: 'popup',
        focused: false,
        width: 520,
        height: 720
      });

      serviceWindowId = serviceWindow.id;
      const serviceTab = serviceWindow.tabs?.[0];
      if (!serviceTab?.id) throw new Error('Не удалось создать служебную вкладку Кинопоиска');

      if (Number.isInteger(serviceWindowId)) {
        try { await chrome.windows.update(serviceWindowId, { state: 'minimized' }); }
        catch {}
      }

      await waitForTabComplete(serviceTab.id);
      return await buildCompleteModelFromTab(serviceTab.id, requestedUrl, contentType);
    } finally {
      if (Number.isInteger(serviceWindowId)) {
        try { await chrome.windows.remove(serviceWindowId); }
        catch {}
      }
    }
  }

  async function fetchModel(sourceUrl, contentType) {
    const requestedUrl = normalizeStateUrl(sourceUrl, contentType);
    const matchingTab = await findMatchingListTab(requestedUrl);

    if (matchingTab?.id) {
      try { return await buildCompleteModelFromTab(matchingTab.id, requestedUrl, contentType); }
      catch (error) { console.warn('[KinoHelper filters] Не удалось прочитать открытую страницу:', error); }
    }

    return await fetchCompleteModelViaServiceWindow(requestedUrl, contentType);
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

    let cacheMemory = null;
    let pageCacheMemory = null;

    async function ensureCache() {
      if (cacheMemory && typeof cacheMemory === 'object') return cacheMemory;

      try {
        const stored = await chrome.storage.local.get(CACHE_KEY);
        const value = stored?.[CACHE_KEY];
        if (value && typeof value === 'object') {
          cacheMemory = value;
          return cacheMemory;
        }
      } catch (error) {
        debug('Не удалось прочитать chrome.storage.local:', error);
      }

      // Однократная миграция уже распарсенного кэша из localStorage.
      for (const legacyKey of LEGACY_CACHE_KEYS) {
        const legacy = safeParse(localStorage.getItem(legacyKey) || 'null', null);
        if (!legacy || typeof legacy !== 'object' || !Object.keys(legacy).length) continue;

        cacheMemory = legacy;
        try {
          await chrome.storage.local.set({ [CACHE_KEY]: cacheMemory });
          LEGACY_CACHE_KEYS.forEach(key => localStorage.removeItem(key));
        } catch (error) {
          debug('Не удалось перенести кэш в chrome.storage.local:', error);
        }
        return cacheMemory;
      }

      cacheMemory = {};
      return cacheMemory;
    }

    async function saveCache(cache) {
      cacheMemory = cache && typeof cache === 'object' ? cache : {};
      await chrome.storage.local.set({ [CACHE_KEY]: cacheMemory });
    }

    function pageCacheId(type, rawUrl) {
      const normalized = normalizeStateUrl(rawUrl, type);
      try {
        return `${type}\n${comparableUrl(normalized)}`;
      } catch {
        return `${type}\n${normalized}`;
      }
    }

    async function ensurePageCache() {
      if (pageCacheMemory && typeof pageCacheMemory === 'object') return pageCacheMemory;

      try {
        const stored = await chrome.storage.local.get(PAGE_CACHE_KEY);
        const value = stored?.[PAGE_CACHE_KEY];
        if (value && typeof value === 'object') {
          pageCacheMemory = value;
          return pageCacheMemory;
        }
      } catch (error) {
        debug('Не удалось прочитать локальные копии фильтров:', error);
      }

      // V2 stores only complete per-URL models captured from the real rendered
      // Kinopoisk sidebar. Old partial models are intentionally not migrated.
      pageCacheMemory = {};
      return pageCacheMemory;
    }

    async function savePageCache(cache) {
      const entries = Object.entries(cache && typeof cache === 'object' ? cache : {})
        .sort(([, left], [, right]) => Number(right?.fetchedAt || 0) - Number(left?.fetchedAt || 0))
        .slice(0, PAGE_CACHE_MAX_ENTRIES);

      pageCacheMemory = Object.fromEntries(entries);
      await chrome.storage.local.set({ [PAGE_CACHE_KEY]: pageCacheMemory });
    }

    async function cachePageModel(type, model, rawUrl = model?.sourceUrl) {
      if (!model || !rawUrl) return;

      const sourceUrl = normalizeStateUrl(rawUrl, type);
      const cache = await ensurePageCache();
      cache[pageCacheId(type, sourceUrl)] = {
        fetchedAt: Date.now(),
        sourceUrl,
        model: { ...model, sourceUrl }
      };
      await savePageCache(cache);
    }

    async function cachedPageModel(type, rawUrl) {
      const cache = await ensurePageCache();
      const entry = cache[pageCacheId(type, rawUrl)];
      return entry?.model && entry?.sourceUrl ? entry : null;
    }

    async function cacheModel(type, model) {
      const sourceUrl = normalizeStateUrl(model.sourceUrl, type);
      const normalizedModel = { ...model, sourceUrl };
      const cache = await ensureCache();
      cache[type] = {
        fetchedAt: Date.now(),
        sourceUrl,
        model: normalizedModel
      };
      await saveCache(cache);
      await cachePageModel(type, normalizedModel, sourceUrl);
    }

    async function cachedModel(type) {
      const cache = await ensureCache();
      const entry = cache[type];
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

    async function refreshCachedPage(type, sourceUrl) {
      try {
        const requestedUrl = normalizeStateUrl(sourceUrl, type);
        const model = await fetchModel(requestedUrl, type);
        model.sourceUrl = requestedUrl;

        const stillActive = state.contentType === type &&
          urlsEqual(activeTypeState().sourceUrl, requestedUrl);

        if (stillActive) {
          await cacheModel(type, model);
          render(model);
          retryElement.style.display = 'none';
          setStatus();
        } else {
          await cachePageModel(type, model, requestedUrl);
        }
      } catch (error) {
        debug('Не удалось обновить локальную копию фильтров:', error);
      }
    }

    async function applyUrl(targetUrl, meta = {}) {
      if (updating) return;

      const type = state.contentType;
      const previousState = JSON.parse(JSON.stringify(activeTypeState()));
      const previousModel = currentModel;
      const requestedUrl = normalizeStateUrl(targetUrl, type);
      const pageCacheEntry = await cachedPageModel(type, requestedUrl);

      // Состояние выбранных фильтров фиксируем сразу, до сетевого запроса.
      activeTypeState().sourceUrl = requestedUrl;
      if (meta.groupKey && meta.label) {
        activeTypeState().selectedLabels[meta.groupKey] = meta.label;
      }
      saveState();

      // Уже посещённая комбинация открывается мгновенно из локальной копии.
      if (pageCacheEntry?.model) {
        render({ ...pageCacheEntry.model, sourceUrl: requestedUrl });
        retryElement.style.display = 'none';
        setStatus();

        // Устаревшую копию обновляем в фоне, не блокируя интерфейс.
        if (!fresh(pageCacheEntry)) {
          void refreshCachedPage(type, requestedUrl);
        }
        return;
      }

      setUpdating(true);

      try {
        const model = await fetchModel(requestedUrl, type);
        model.sourceUrl = requestedUrl;
        activeTypeState().sourceUrl = requestedUrl;
        saveState();
        await cacheModel(type, model);
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
      const cacheEntry = await cachedPageModel(type, typeState.sourceUrl);
      contentTypeElement.value = type;

      // Любая уже сохранённая комбинация показывается сразу.
      if (cacheEntry?.model) {
        render({ ...cacheEntry.model, sourceUrl: typeState.sourceUrl });
        retryElement.style.display = 'none';
        setStatus();

        if (!force) {
          if (!fresh(cacheEntry)) {
            void refreshCachedPage(type, typeState.sourceUrl);
          }
          return;
        }
      }

      setUpdating(
        true,
        cacheEntry?.model ? 'Обновляем локальную копию...' : 'Загружаем фильтры...'
      );

      try {
        const requestedUrl = normalizeStateUrl(typeState.sourceUrl, type);
        const model = await fetchModel(requestedUrl, type);
        model.sourceUrl = requestedUrl;
        typeState.sourceUrl = requestedUrl;
        saveState();
        await cacheModel(type, model);
        render(model);
        retryElement.style.display = 'none';
        setStatus();
      } catch (error) {
        debug('Ошибка загрузки фильтров:', error);

        if (cacheEntry?.model) {
          typeState.sourceUrl = cacheEntry.sourceUrl;
          saveState();
          render(cacheEntry.model);
          setStatus('Не удалось обновить фильтры. Используется локальная копия', 'error');
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
      const baseUrl = normalizeStateUrl(TYPES[type].baseUrl, type);
      const pageCacheEntry = await cachedPageModel(type, baseUrl);

      state.byType[type] = {
        sourceUrl: baseUrl,
        selectedLabels: {}
      };
      saveState();

      if (pageCacheEntry?.model) {
        render({ ...pageCacheEntry.model, sourceUrl: baseUrl });
        retryElement.style.display = 'none';
        setStatus();
        if (!fresh(pageCacheEntry)) void refreshCachedPage(type, baseUrl);
        return;
      }

      setUpdating(true, 'Сбрасываем фильтры...');

      try {
        const model = await fetchModel(baseUrl, type);
        model.sourceUrl = baseUrl;
        await cacheModel(type, model);
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
      const url = normalizeStateUrl(active.sourceUrl, state.contentType);
      return {
        url,
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
    cleanLabel,
    readPage: readKinopoiskPage
  };
})();
