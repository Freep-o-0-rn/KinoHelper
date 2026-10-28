// Переключатель Popup / Chrome Side Panel.
// Режим хранится отдельно от настроек тем и истории пользователя.
(() => {
  'use strict';

  const STORAGE_KEY = 'kinoHelperDisplayMode';
  const input = document.getElementById('displayModeToggle');
  const status = document.getElementById('displayModeStatus');
  if (!input || !status) return;

  function setStatus(value, error = false) {
    status.textContent = value;
    status.classList.toggle('error', error);
  }

  async function loadMode() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      input.checked = data[STORAGE_KEY] === 'sidepanel';
    } catch (error) {
      console.warn('[KinoHelper] Не удалось получить режим интерфейса:', error);
      setStatus('Не удалось прочитать настройку режима', true);
    }
  }

  input.addEventListener('change', async () => {
    const nextMode = input.checked ? 'sidepanel' : 'popup';
    input.disabled = true;
    setStatus('Применяем режим…');

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'setKinoHelperDisplayMode',
        mode: nextMode
      });
      if (!response?.ok) {
        throw new Error(response?.error || 'Не удалось переключить режим');
      }
      setStatus(nextMode === 'sidepanel'
        ? 'Готово. Нажмите значок расширения, чтобы открыть боковую панель.'
        : 'Готово. Нажмите значок расширения, чтобы открыть popup.');
    } catch (error) {
      input.checked = !input.checked;
      setStatus(error.message || 'Не удалось переключить режим', true);
      console.warn('[KinoHelper] Ошибка переключения режима:', error);
    } finally {
      input.disabled = false;
    }
  });

  // Актуализируем настройку, когда она меняется из другого окна расширения.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY] || input.disabled) return;
    input.checked = changes[STORAGE_KEY].newValue === 'sidepanel';
  });

  void loadMode();
})();
