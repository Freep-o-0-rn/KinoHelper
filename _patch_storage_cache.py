from pathlib import Path

p = Path('filters.js')
s = p.read_text(encoding='utf-8')

s = s.replace(
    "  const CACHE_KEY = 'kinopoiskDynamicFilterCacheV3';\n",
    "  const CACHE_KEY = 'kinopoiskDynamicFilterCacheV4';\n"
    "  const LEGACY_CACHE_KEYS = ['kinopoiskDynamicFilterCacheV3', 'kinopoiskDynamicFilterCacheV2'];\n"
)

start = s.index('    function loadCache() {')
end = s.index('    function fresh(entry) {', start)
cache_block = '''    let cacheMemory = null;\n\n    async function ensureCache() {\n      if (cacheMemory && typeof cacheMemory === 'object') return cacheMemory;\n\n      try {\n        const stored = await chrome.storage.local.get(CACHE_KEY);\n        const value = stored?.[CACHE_KEY];\n        if (value && typeof value === 'object') {\n          cacheMemory = value;\n          return cacheMemory;\n        }\n      } catch (error) {\n        debug('Не удалось прочитать chrome.storage.local:', error);\n      }\n\n      // Однократная миграция уже распарсенного кэша из localStorage.\n      for (const legacyKey of LEGACY_CACHE_KEYS) {\n        const legacy = safeParse(localStorage.getItem(legacyKey) || 'null', null);\n        if (!legacy || typeof legacy !== 'object' || !Object.keys(legacy).length) continue;\n\n        cacheMemory = legacy;\n        try {\n          await chrome.storage.local.set({ [CACHE_KEY]: cacheMemory });\n          LEGACY_CACHE_KEYS.forEach(key => localStorage.removeItem(key));\n        } catch (error) {\n          debug('Не удалось перенести кэш в chrome.storage.local:', error);\n        }\n        return cacheMemory;\n      }\n\n      cacheMemory = {};\n      return cacheMemory;\n    }\n\n    async function saveCache(cache) {\n      cacheMemory = cache && typeof cache === 'object' ? cache : {};\n      await chrome.storage.local.set({ [CACHE_KEY]: cacheMemory });\n    }\n\n    async function cacheModel(type, model) {\n      const cache = await ensureCache();\n      cache[type] = {\n        fetchedAt: Date.now(),\n        sourceUrl: model.sourceUrl,\n        model\n      };\n      await saveCache(cache);\n    }\n\n    async function cachedModel(type) {\n      const cache = await ensureCache();\n      const entry = cache[type];\n      return entry?.model && entry?.sourceUrl ? entry : null;\n    }\n\n'''
s = s[:start] + cache_block + s[end:]

# Persist successful models asynchronously.
s = s.replace('        cacheModel(type, model);', '        await cacheModel(type, model);')

# Replace load() so cached filters render immediately, then refresh only when stale/forced.
start = s.index('    async function load({ force = false } = {}) {')
end = s.index('\n\n    async function changeType(type)', start)
load_block = '''    async function load({ force = false } = {}) {\n      const type = state.contentType;\n      const typeState = activeTypeState();\n      const cacheEntry = await cachedModel(type);\n      const cacheMatchesState = Boolean(\n        cacheEntry?.model && urlsEqual(cacheEntry.sourceUrl, typeState.sourceUrl)\n      );\n      contentTypeElement.value = type;\n\n      // Показываем локальную копию сразу. Свежий кэш вообще не требует сети.\n      if (cacheMatchesState) {\n        render(cacheEntry.model);\n        retryElement.style.display = 'none';\n\n        if (!force && fresh(cacheEntry)) {\n          setStatus();\n          return;\n        }\n      }\n\n      setUpdating(\n        true,\n        cacheMatchesState ? 'Обновляем сохранённые фильтры...' : 'Загружаем фильтры...'\n      );\n\n      try {\n        const model = await fetchModel(typeState.sourceUrl, type);\n        typeState.sourceUrl = model.sourceUrl;\n        saveState();\n        await cacheModel(type, model);\n        render(model);\n        retryElement.style.display = 'none';\n        setStatus();\n      } catch (error) {\n        debug('Ошибка загрузки фильтров:', error);\n\n        if (cacheEntry?.model) {\n          // Даже просроченная копия лучше полного отказа: она остаётся рабочей,\n          // пока Кинопоиск снова не станет доступен для обновления.\n          typeState.sourceUrl = cacheEntry.sourceUrl;\n          saveState();\n          render(cacheEntry.model);\n          setStatus('Не удалось обновить фильтры. Используется сохранённый кэш', 'error');\n        } else {\n          currentModel = null;\n          dynamicElement.innerHTML = '<div class="kp-filter-empty">Не удалось загрузить фильтры Кинопоиска</div>';\n          setStatus('Не удалось загрузить фильтры Кинопоиска', 'error');\n        }\n\n        retryElement.style.display = 'inline-flex';\n      } finally {\n        filtersElement.classList.remove('is-updating');\n        updating = false;\n      }\n    }'''
s = s[:start] + load_block + s[end:]

# Ensure no synchronous cache calls remain.
assert 'const cacheEntry = cachedModel(type);' not in s
assert "kinopoiskDynamicFilterCacheV4" in s
assert 'chrome.storage.local.get(CACHE_KEY)' in s
assert 'chrome.storage.local.set({ [CACHE_KEY]: cacheMemory })' in s
assert s.count('await cacheModel(type, model);') >= 3

p.write_text(s, encoding='utf-8')
