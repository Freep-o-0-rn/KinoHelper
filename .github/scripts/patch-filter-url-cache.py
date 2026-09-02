from pathlib import Path

p = Path('filters.js')
s = p.read_text(encoding='utf-8')

old = """  const CACHE_KEY = 'kinopoiskDynamicFilterCacheV4';\n  const LEGACY_CACHE_KEYS = ['kinopoiskDynamicFilterCacheV3', 'kinopoiskDynamicFilterCacheV2'];\n  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;\n"""
new = """  const CACHE_KEY = 'kinopoiskDynamicFilterCacheV4';\n  const PAGE_CACHE_KEY = 'kinopoiskFilterUrlCacheV1';\n  const LEGACY_CACHE_KEYS = ['kinopoiskDynamicFilterCacheV3', 'kinopoiskDynamicFilterCacheV2'];\n  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;\n  const PAGE_CACHE_MAX_ENTRIES = 40;\n"""
if old not in s:
    raise SystemExit('constants block not found')
s = s.replace(old, new, 1)

old = """    let cacheMemory = null;\n\n    async function ensureCache() {\n"""
new = """    let cacheMemory = null;\n    let pageCacheMemory = null;\n\n    async function ensureCache() {\n"""
if old not in s:
    raise SystemExit('cache memory block not found')
s = s.replace(old, new, 1)

start = s.index("    async function saveCache(cache) {")
end = s.index("\n\n    function fresh(entry) {", start)
replacement = r'''    async function saveCache(cache) {
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

      // Первый запуск новой схемы: переносим текущие модели по типам в URL-кэш.
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
    }'''
s = s[:start] + replacement + s[end:]

start = s.index("    async function applyUrl(targetUrl, meta = {}) {")
end = s.index("\n\n    async function load({ force = false } = {}) {", start)
replacement = r'''    async function refreshCachedPage(type, sourceUrl) {
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
    }'''
s = s[:start] + replacement + s[end:]

start = s.index("    async function load({ force = false } = {}) {")
end = s.index("\n\n    async function changeType(type) {", start)
replacement = r'''    async function load({ force = false } = {}) {
      const type = state.contentType;
      const typeState = activeTypeState();
      const pageCacheEntry = await cachedPageModel(type, typeState.sourceUrl);
      const typeCacheEntry = await cachedModel(type);
      const cacheEntry = pageCacheEntry || (
        typeCacheEntry?.model && urlsEqual(typeCacheEntry.sourceUrl, typeState.sourceUrl)
          ? typeCacheEntry
          : null
      );
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
    }'''
s = s[:start] + replacement + s[end:]

start = s.index("    async function clear() {")
end = s.index("\n\n    async function initialize() {", start)
replacement = r'''    async function clear() {
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
    }'''
s = s[:start] + replacement + s[end:]

p.write_text(s, encoding='utf-8')
