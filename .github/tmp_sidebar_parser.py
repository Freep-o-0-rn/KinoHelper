from pathlib import Path

filters_path = Path('filters.js')
js = filters_path.read_text(encoding='utf-8')

# 1) URL normalization: accept real Kinopoisk list URLs and keep their real parameters.
start = js.index('  function isFilterPath(pathname) {')
end = js.index('\n\n  function urlsEqual', start)
js = js[:start] + r'''  function isFilterPath(pathname) {
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
  }''' + js[end:]

# 2) Compare both pathname filters and real query parameters.
start = js.index('  function pathFilterMap(url) {')
end = js.index('\n\n  function inferGroupHint', start)
js = js[:start] + r'''  function filterStateMap(rawUrl) {
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
  }''' + js[end:]

# 3) Extract only the Kinopoisk sidebar. JSON is used only to populate dropdown options.
start = js.index('  function extractCandidates(doc, sourceUrl) {')
end = js.index('\n\n  function humanizeKey', start)
js = js[:start] + r'''  function elementDepth(element) {
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
  }''' + js[end:]

# 4) Build the model only from sidebar actions/dropdowns.
start = js.index('  function buildModel(doc, sourceUrl, contentType) {')
end = js.index('\n\n  function delay(ms)', start)
js = js[:start] + r'''  function buildModel(doc, sourceUrl, contentType) {
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
  }''' + js[end:]

# 5) No new visible/background tabs. First use extension fetch with cookies;
#    if Kinopoisk redirects/CORS-blocks it, reuse an already-open Kinopoisk tab
#    as a same-origin fetch executor without navigating that tab.
start = js.index('  function delay(ms) {')
end = js.index('\n\n  function create(options)', start)
js = js[:start] + r'''  function isKinopoiskListsUrl(rawUrl) {
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

  async function fetchModel(sourceUrl, contentType) {
    const page = await readKinopoiskPage(sourceUrl);
    const doc = new DOMParser().parseFromString(page.html, 'text/html');

    if (!doc.querySelector('h1') && !doc.body?.textContent?.includes('Кинопоиск')) {
      throw new Error('Получена некорректная страница Кинопоиска');
    }

    return buildModel(doc, page.url || sourceUrl, contentType);
  }''' + js[end:]

# Export the new invisible loader for Random pages too.
js = js.replace('    readPage: readKinopoiskPageInTab', '    readPage: readKinopoiskPage')

filters_path.write_text(js, encoding='utf-8')

# Remove the global fetch monkey-patch; loading is explicit now.
popup_path = Path('popup.html')
html = popup_path.read_text(encoding='utf-8')
html = html.replace('  <script src="kinopoisk-fetch.js"></script>\n', '')
popup_path.write_text(html, encoding='utf-8')
