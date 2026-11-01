// Local-only backup and merge for KinoHelper. No network, accounts or cached pages.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  const FORMAT = 'KinoHelperDataBackup';
  const VERSION = 1;
  const MAX_FILE_BYTES = 32 * 1024 * 1024;
  const LOCAL_KEYS = [
    'kinopoiskHistory', 'kinoHelperSettings', 'kinopoiskFilters',
    'kinopoiskDynamicFilterStateV2', 'historyCollapsed', 'darkTheme',
    'kinoHelperWatchlistV1', 'kinoHelperWatchlistCollapsed'
  ];
  const STORAGE_KEYS = [
    'kinoHelperDisplayMode', 'kinoPlaybackProgressV1',
    'kinoSeriesEpisodeProgressV1', 'kinoStatsLibraryV1',
    'kinoStatsWatchTimeV1', 'kinoStatsGenresV1', 'kinoStatsRatingsV1',
    'kinoStatsProfileId', 'kinoStatsProfileImportV1', 'kinoStatsWatchedV1',
    'kinoWatchlistProfilesV1'
  ];
  const OBJECT_KEYS = new Set(STORAGE_KEYS.filter(key =>
    key !== 'kinoHelperDisplayMode' && key !== 'kinoStatsProfileId'));
  const PROFILE = /^(?:[1-9]\d{0,12}|__local__)$/;
  const FILM = /^(?:film|series):[1-9]\d{0,12}$/;
  const EPISODE = /^series:[1-9]\d{0,12}:\d{1,3}:\d{1,3}$/;

  const object = value => value !== null &&
    typeof value === 'object' && !Array.isArray(value);
  const timestamp = value => Number.isFinite(Number(value)) &&
    Number(value) > 0 ? Number(value) : 0;
  const parse = (raw, fallback) => {
    try { return JSON.parse(raw); } catch { return fallback; }
  };
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  function mergeHistory(existing, imported) {
    const items = new Map();
    for (const row of [...(Array.isArray(existing) ? existing : []),
      ...(Array.isArray(imported) ? imported : [])]) {
      if (!object(row) || typeof row.url !== 'string' ||
          !/^https?:\/\//i.test(row.url) || row.url.length > 2048) continue;
      const old = items.get(row.url);
      if (!old || timestamp(row.timestamp) > timestamp(old.timestamp)) {
        items.set(row.url, row);
      }
    }
    return [...items.values()].sort((a, b) =>
      timestamp(b.timestamp) - timestamp(a.timestamp));
  }

  function mergeWatchlist(existing, imported) {
    const items = new Map();
    for (const row of [...(Array.isArray(existing) ? existing : []),
      ...(Array.isArray(imported) ? imported : [])]) {
      if (!object(row) || !['film', 'series'].includes(row.type) ||
          !/^[1-9]\d{0,12}$/.test(String(row.id))) continue;
      const key = row.type + ':' + row.id;
      const old = items.get(key);
      if (!old || timestamp(row.addedAt) > timestamp(old.addedAt)) {
        items.set(key, row);
      }
    }
    return [...items.values()]
      .sort((a, b) => timestamp(b.addedAt) - timestamp(a.addedAt))
      .slice(0, 1000);
  }

  function mergeMap(existing, imported, validator, resolve) {
    const result = Object.create(null);
    for (const [key, value] of Object.entries(object(existing) ? existing : {})) {
      if (validator(key, value)) result[key] = value;
    }
    for (const [key, value] of Object.entries(object(imported) ? imported : {})) {
      if (!validator(key, value)) continue;
      if (!has(result, key)) result[key] = value;
      else result[key] = resolve(result[key], value);
    }
    return result;
  }

  function newest(a, b) {
    return timestamp(b?.updatedAt) > timestamp(a?.updatedAt) ? b : a;
  }

  function mergeRatings(existing, imported) {
    return mergeMap(existing, imported, key => PROFILE.test(key),
      (a, b) => mergeMap(a, b,
        (key, value) => FILM.test(key) && object(value) &&
          Number.isInteger(value.rating) &&
          value.rating >= 1 && value.rating <= 10,
        newest));
  }

  function mergeWatched(existing, imported) {
    return mergeMap(existing, imported, key => PROFILE.test(key),
      (a,b) => mergeMap(a,b,
        (key,entry) => FILM.test(key) && object(entry) &&
          entry.watched === true,
        newest));
  }

  function mergeProfileImports(existing, imported) {
    return mergeMap(existing, imported, key => PROFILE.test(key),
      (a, b) => {
        const latest = newest(a, b);
        const pages = [...new Set([
          ...(Array.isArray(a?.visitedPages) ? a.visitedPages : []),
          ...(Array.isArray(b?.visitedPages) ? b.visitedPages : [])
        ])].filter(n => Number.isInteger(n) && n > 0 && n <= 20000)
          .sort((x, y) => x - y);
        return {
          ...latest,
          visitedPages: pages,
          pages: pages.length,
          votes: Math.max(Number(a?.votes) || 0, Number(b?.votes) || 0),
          nextPage: Math.max(Number(a?.nextPage) || 1, Number(b?.nextPage) || 1),
          lastPage: Math.max(Number(a?.lastPage) || 0, Number(b?.lastPage) || 0) || null
        };
      });
  }

  function mergeStorageValue(key, existing, imported) {
    if (key === 'kinoStatsRatingsV1') return mergeRatings(existing, imported);
    if (key === 'kinoStatsWatchedV1') return mergeWatched(existing, imported);
    if (key === 'kinoWatchlistProfilesV1') {
      return mergeMap(existing, imported,
        id => /^[1-9]\d{0,12}$/.test(id),
        (a,b)=>mergeMap(a,b,
          (id,item)=>/^(?:film|series):[1-9]\d{0,12}$/.test(id) &&
            object(item),newest));
    }
    if (key === 'kinoStatsProfileImportV1') {
      return mergeProfileImports(existing, imported);
    }
    if (!OBJECT_KEYS.has(key) || !object(existing) || !object(imported)) {
      return imported;
    }
    const validator = key === 'kinoSeriesEpisodeProgressV1' ||
      key === 'kinoStatsLibraryV1'
      ? (id, entry) => (FILM.test(id) || EPISODE.test(id)) && object(entry)
      : (id, entry) => FILM.test(id) && object(entry);
    return mergeMap(existing, imported, validator, (a, b) => {
      if (key === 'kinoStatsLibraryV1') {
        return { ...newest(a, b), completed: Boolean(a.completed || b.completed) };
      }
      if (key === 'kinoStatsWatchTimeV1') {
        // Overlapping backups must not double-count the same watch sessions.
        return { ...newest(a, b),
          seconds: Math.max(Number(a.seconds) || 0, Number(b.seconds) || 0) };
      }
      return newest(a, b);
    });
  }

  function validateBackup(backup) {
    if (!object(backup) || backup.format !== FORMAT ||
        backup.formatVersion !== VERSION ||
        !object(backup.local) || !object(backup.storage)) {
      throw Error('Неподдерживаемый файл резервной копии');
    }
    for (const key of LOCAL_KEYS) {
      if (!has(backup.local, key)) continue;
      const raw = backup.local[key];
      if (typeof raw !== 'string') throw Error('Повреждены данные: ' + key);
      if (['kinopoiskHistory', 'kinoHelperWatchlistV1'].includes(key) &&
          !Array.isArray(parse(raw, null))) {
        throw Error('Повреждён список: ' + key);
      }
      if (['kinoHelperSettings', 'kinopoiskFilters',
        'kinopoiskDynamicFilterStateV2'].includes(key) &&
          !object(parse(raw, null))) {
        throw Error('Повреждены настройки: ' + key);
      }
    }
    for (const key of STORAGE_KEYS) {
      if (!has(backup.storage, key)) continue;
      if (OBJECT_KEYS.has(key) && !object(backup.storage[key])) {
        throw Error('Повреждены данные статистики: ' + key);
      }
      if (key === 'kinoStatsProfileId' &&
          typeof backup.storage[key] !== 'string') {
        throw Error('Повреждён идентификатор профиля');
      }
      if (key === 'kinoHelperDisplayMode' &&
          typeof backup.storage[key] !== 'string') {
        throw Error('Повреждён режим отображения');
      }
    }
    return backup;
  }

  function combineData(current, incoming) {
    const next = { local: { ...current.local }, storage: { ...current.storage } };
    for (const key of LOCAL_KEYS) {
      if (!has(incoming.local, key)) continue;
      if (key === 'kinopoiskHistory') {
        next.local[key] = JSON.stringify(mergeHistory(
          parse(next.local[key], []), parse(incoming.local[key], [])));
      } else if (key === 'kinoHelperWatchlistV1') {
        next.local[key] = JSON.stringify(mergeWatchlist(
          parse(next.local[key], []), parse(incoming.local[key], [])));
      } else if (key === 'kinoHelperSettings') {
        next.local[key] = JSON.stringify({
          ...(object(parse(next.local[key], null)) ? parse(next.local[key], {}) : {}),
          ...parse(incoming.local[key], {})
        });
      } else {
        next.local[key] = incoming.local[key];
      }
    }
    for (const key of STORAGE_KEYS) {
      if (!has(incoming.storage, key)) continue;
      next.storage[key] = has(current.storage, key)
        ? mergeStorageValue(key, current.storage[key], incoming.storage[key])
        : incoming.storage[key];
    }

    // Never silently truncate imported history on the next UI launch.
    if (has(next.local, 'kinopoiskHistory')) {
      const history = parse(next.local.kinopoiskHistory, []);
      const settings = parse(next.local.kinoHelperSettings, {});
      if (object(settings) && settings.historyRulesActivated !== false) {
        const max = settings.historyMaxItems;
        const age = settings.historyMaxAgeDays;
        const overCount = max !== null && Number.isFinite(Number(max)) &&
          Number(max) > 0 && history.length > Number(max);
        const overAge = age !== null && Number.isFinite(Number(age)) &&
          Number(age) > 0 && history.some(item =>
            timestamp(item.timestamp) &&
            timestamp(item.timestamp) < Date.now() - Number(age) * 86400000);
        if (overCount || overAge) {
          next.local.kinoHelperSettings = JSON.stringify({
            ...settings,
            historyMaxItems: overCount ? null : max,
            historyMaxAgeDays: overAge ? null : age
          });
        }
      }
    }
    return next;
  }

  async function snapshot(root) {
    const local = {};
    for (const key of LOCAL_KEYS) {
      const value = root.localStorage.getItem(key);
      if (value !== null) local[key] = value;
    }
    return { local, storage: await root.chrome.storage.local.get(STORAGE_KEYS) };
  }

  async function exportData(root) {
    const saved = await snapshot(root);
    const backup = {
      format: FORMAT,
      formatVersion: VERSION,
      extensionVersion: root.chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      ...saved
    };
    const bytes = JSON.stringify(backup, null, 2);
    const blob = new Blob([bytes], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = root.document.createElement('a');
    anchor.href = url;
    anchor.download = 'KinoHelper-Backup-' +
      new Date().toISOString().slice(0, 10) + '.json';
    root.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function importData(root, backup) {
    validateBackup(backup);
    const before = await snapshot(root);
    const after = combineData(before, backup);
    const changes = {};
    for (const key of STORAGE_KEYS) {
      if (has(after.storage, key) && JSON.stringify(after.storage[key]) !==
          JSON.stringify(before.storage[key])) changes[key] = after.storage[key];
    }
    let wroteStorage = false;
    try {
      if (Object.keys(changes).length) {
        await root.chrome.storage.local.set(changes);
        wroteStorage = true;
      }
      for (const key of LOCAL_KEYS) {
        if (has(after.local, key) && after.local[key] !== before.local[key]) {
          root.localStorage.setItem(key, after.local[key]);
        }
      }
    } catch (error) {
      // Restore this tab's previous values if a quota or storage write fails.
      for (const key of LOCAL_KEYS) {
        try {
          if (has(before.local, key)) root.localStorage.setItem(key, before.local[key]);
          else root.localStorage.removeItem(key);
        } catch {}
      }
      if (wroteStorage) {
        const prior = {};
        const added = [];
        for (const key of Object.keys(changes)) {
          if (has(before.storage, key)) prior[key] = before.storage[key];
          else added.push(key);
        }
        try {
          if (added.length) await root.chrome.storage.local.remove(added);
          if (Object.keys(prior).length) await root.chrome.storage.local.set(prior);
        } catch {
          throw Error('Ошибка импорта; не все изменения удалось отменить. Сохраните резервную копию.');
        }
      }
      throw error;
    }
  }

  function install(root) {
    const doc = root.document;
    const setup = () => {
      const exportButton = doc.getElementById('backupExport');
      const importButton = doc.getElementById('backupImport');
      const picker = doc.getElementById('backupFile');
      const status = doc.getElementById('backupStatus');
      if (!exportButton || !importButton || !picker || !status) return;
      let busy = false;
      const message = (value, error = false) => {
        status.textContent = value;
        status.classList.toggle('error', error);
      };
      const run = async callback => {
        if (busy) return;
        busy = true;
        exportButton.disabled = importButton.disabled = true;
        try { await callback(); } catch (error) {
          message(error?.message || 'Не удалось обработать данные', true);
        } finally {
          busy = false;
          exportButton.disabled = importButton.disabled = false;
        }
      };
      exportButton.addEventListener('click', () => run(async () => {
        await exportData(root);
        message('Резервная копия сохранена.');
      }));
      importButton.addEventListener('click', () => {
        if (busy) return;
        picker.value = '';
        picker.click();
      });
      picker.addEventListener('change', () => {
        const file = picker.files?.[0];
        if (!file) return;
        void run(async () => {
          if (file.size > MAX_FILE_BYTES) {
            throw Error('Файл слишком большой (максимум 32 МБ)');
          }
          const backup = JSON.parse(await file.text());
          await importData(root, backup);
          root.sessionStorage.setItem('kinoBackupSuccess', '1');
          root.location.reload();
        });
      });
      if (root.sessionStorage.getItem('kinoBackupSuccess') === '1') {
        root.sessionStorage.removeItem('kinoBackupSuccess');
        doc.getElementById('settingsButton')?.click();
        message('Импорт завершён. Данные объединены.');
      }
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', setup);
    else setup();
  }

  return { mergeHistory, mergeWatchlist, mergeStorageValue,
    mergeRatings, validateBackup, combineData, importData, install };
});
