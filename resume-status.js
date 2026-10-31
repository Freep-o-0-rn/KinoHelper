// Read-only view for saved playback progress. No network calls or seeking.
(() => {
  'use strict';
  const KEY = 'kinoPlaybackProgressV1';
  const area = document.getElementById('resumeSavedItems');
  const info = document.getElementById('resumeSavedStatus');
  const refresh = document.getElementById('resumeSavedRefresh');
  if (!area || !info || !refresh) return;

  function clock(value) {
    const total = Math.max(0, Math.floor(value));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? h + ':' + String(m).padStart(2, '0') +
      ':' + String(s).padStart(2, '0') :
      m + ':' + String(s).padStart(2, '0');
  }

  async function draw() {
    try {
      const data = (await chrome.storage.local.get(KEY))[KEY];
      const list = Object.entries(data && typeof data === 'object' ? data : {})
        .filter(([key, item]) => /^film:\d+$/.test(key) && item &&
          Number.isFinite(item.position) && Number.isFinite(item.duration) &&
          item.duration >= 60)
        .map(([, item]) => item)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      info.textContent = list.length
        ? 'Сохранено фильмов: ' + list.length +
          '. Отслеживание работает без открытой панели.'
        : 'Пока нет сохранённого прогресса. Запусти фильм на несколько секунд.';
      const nodes = list.slice(0, 5).map(item => {
        const row = document.createElement('div');
        row.className = 'resume-saved-item';
        const title = document.createElement('div');
        title.className = 'resume-saved-title';
        title.textContent = item.title || 'Фильм №' + item.id;
        const meta = document.createElement('div');
        meta.className = 'resume-saved-meta';
        meta.textContent = clock(item.position) + ' / ' + clock(item.duration) +
          (item.completed ? ' · просмотрено' : ' · не завершено');
        row.append(title, meta);
        return row;
      });
      area.replaceChildren(...nodes);
    } catch (error) {
      info.textContent = 'Не удалось прочитать прогресс: ' + error.message;
      area.replaceChildren();
    }
  }

  refresh.addEventListener('click', () => void draw());
  chrome.storage.onChanged.addListener((changes, location) => {
    if (location === 'local' && changes[KEY]) void draw();
  });
  window.addEventListener('focus', () => void draw());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void draw();
  });
  void draw();
})();
