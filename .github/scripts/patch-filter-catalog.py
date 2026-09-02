from pathlib import Path

p = Path('filters.js')
s = p.read_text(encoding='utf-8')

s = s.replace(
"  const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV1';\n",
"  const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV1';\n  const FILTER_CATALOG_KEY = 'kinopoiskFilterCatalogV1';\n"
)

marker = "  function isKinopoiskListsUrl(rawUrl) {\n"
if marker not in s:
    raise SystemExit('isKinopoiskListsUrl marker not found')

insert = r'''  function pathSegmentForKey(rawUrl, key) {
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

  async function extractFilterCatalogFromOpenTab() {
    const tabs = await chrome.tabs.query({
      url: ['https://www.kinopoisk.ru/*', 'https://kinopoisk.ru/*']
    });

    const candidates = tabs
      .filter(tab => Number.isInteger(tab.id) && !tab.discarded && /\/lists\/movies\//.test(tab.url || ''))
      .sort((a, b) => Number(a.active) - Number(b.active));

    let lastError = null;

    for (const tab of candidates) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
            const targets = [
              { key: 'country', title: 'Страны', resetLabel: 'Все страны' },
              { key: 'genre', title: 'Жанры', resetLabel: 'Все жанры' },
              { key: 'year', title: 'Годы', resetLabel: 'Все годы' }
            ];

            const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
            const exact = text => [...document.querySelectorAll('div, span, button, label, p')]
              .filter(node => clean(node.textContent) === text)
              .sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)
              .pop() || null;

            const clickableFor = target => {
              const reset = exact(target.resetLabel);
              if (reset) {
                return reset.closest('button, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]') || reset.parentElement;
              }

              const heading = exact(target.title);
              let root = heading?.parentElement || null;
              for (let depth = 0; root && depth < 5; depth += 1, root = root.parentElement) {
                const nodes = [...root.querySelectorAll('button, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]')];
                const candidate = nodes.find(node => {
                  const text = clean(node.textContent);
                  return text && text !== target.title && text.length < 60;
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

            const groups = {};

            for (const target of targets) {
              const trigger = clickableFor(target);
              if (!trigger) continue;

              try {
                trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                await delay(90);

                const options = new Map();
                document.querySelectorAll('a[href]').forEach(anchor => {
                  const label = clean(anchor.textContent || anchor.getAttribute('aria-label'));
                  if (!label || label.length > 70) return;

                  let url;
                  try {
                    url = new URL(anchor.getAttribute('href'), location.href);
                  } catch {
                    return;
                  }

                  if (!/^(?:www\.)?kinopoisk\.ru$/i.test(url.hostname)) return;
                  if (!url.pathname.startsWith('/lists/movies/')) return;

                  const segment = url.pathname
                    .slice('/lists/movies/'.length)
                    .split('/')
                    .filter(Boolean)
                    .find(part => part.startsWith(`${target.key}--`));
                  if (!segment) return;

                  options.set(label, { label, url: url.href });
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
                await delay(25);
              }
            }

            return { groups };
          }
        });

        const catalog = results?.[0]?.result;
        if (catalog?.groups && Object.keys(catalog.groups).length) {
          return {
            fetchedAt: Date.now(),
            groups: catalog.groups
          };
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      candidates.length
        ? `Не удалось прочитать раскрывающиеся фильтры: ${lastError?.message || 'варианты не найдены'}`
        : 'Нет открытой страницы списков Кинопоиска для чтения dropdown'
    );
  }

  async function getFilterCatalog() {
    const stored = await readStoredFilterCatalog();
    if (filterCatalogFresh(stored)) return stored;

    try {
      const freshCatalog = await extractFilterCatalogFromOpenTab();
      await saveFilterCatalog(freshCatalog);
      return freshCatalog;
    } catch {
      return stored;
    }
  }

'''
s = s.replace(marker, insert + marker)

old = """    return buildModel(doc, normalizeStateUrl(sourceUrl, contentType), contentType);\n"""
new = """    const model = buildModel(doc, normalizeStateUrl(sourceUrl, contentType), contentType);\n    const catalog = await getFilterCatalog();\n    return enrichModelWithCatalog(model, catalog);\n"""
if old not in s:
    raise SystemExit('fetchModel return marker not found')
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
