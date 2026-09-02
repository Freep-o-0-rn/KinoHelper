from pathlib import Path

p = Path('filters.js')
s = p.read_text(encoding='utf-8')

s = s.replace("const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV1';", "const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV2';")

old_fetch = '''  async function fetchModel(sourceUrl, contentType) {
    const page = await readKinopoiskPage(sourceUrl);
    const doc = new DOMParser().parseFromString(page.html, 'text/html');

    if (!doc.querySelector('h1') && !doc.body?.textContent?.includes('Кинопоиск')) {
      throw new Error('Получена некорректная страница Кинопоиска');
    }

    const model = buildModel(doc, normalizeStateUrl(sourceUrl, contentType), contentType);
    const catalog = await getFilterCatalog();
    return enrichModelWithCatalog(model, catalog);
  }
'''

new_fetch = '''  async function readRenderedPageFromTab(tabId) {
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
'''

if old_fetch not in s:
    raise SystemExit('fetchModel block not found')
s = s.replace(old_fetch, new_fetch)

old_page_cache = '''      // Первый запуск новой схемы: переносим текущие модели по типам в URL-кэш.
      pageCacheMemory = {};
      const typeCache = await ensureCache();
      Object.entries(typeCache).forEach(([type, entry]) => {
        if (!TYPES[type] || !entry?.model || !entry?.sourceUrl) return;
        pageCacheMemory[pageCacheId(type, entry.sourceUrl)] = entry;
      });

      if (Object.keys(pageCacheMemory).length) {
        try {
          await chrome.storage.local.set({ [PAGE_CACHE_KEY]: pageCacheMemory });
        } catch (error) {
          debug('Не удалось сохранить перенесённые локальные копии:', error);
        }
      }

      return pageCacheMemory;
'''
new_page_cache = '''      // V2 stores only complete per-URL models captured from the real rendered
      // Kinopoisk sidebar. Old partial models are intentionally not migrated.
      pageCacheMemory = {};
      return pageCacheMemory;
'''
if old_page_cache not in s:
    raise SystemExit('ensurePageCache migration block not found')
s = s.replace(old_page_cache, new_page_cache)

old_load = '''      const pageCacheEntry = await cachedPageModel(type, typeState.sourceUrl);
      const typeCacheEntry = await cachedModel(type);
      const cacheEntry = pageCacheEntry || (
        typeCacheEntry?.model && urlsEqual(typeCacheEntry.sourceUrl, typeState.sourceUrl)
          ? typeCacheEntry
          : null
      );
'''
new_load = '''      const cacheEntry = await cachedPageModel(type, typeState.sourceUrl);
'''
if old_load not in s:
    raise SystemExit('load cache block not found')
s = s.replace(old_load, new_load)

p.write_text(s, encoding='utf-8')
