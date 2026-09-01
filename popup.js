// Домены сервисов
const KINOPOISK_BASE = "https://www.kinopoisk.ru";
const WATCH_BASE = "https://www.kinokino.vip";
const FALLBACK_WATCH_BASE = "https://flcksbr.top";

// Элементы DOM
const messageBox = document.getElementById("message");
const genreFilter = document.getElementById("genreFilter");
const typeFilter = document.getElementById("typeFilter");
const yearFilter = document.getElementById("yearFilter");
const highRatedCheckbox = document.getElementById("highRatedCheckbox");
const releasedCheckbox = document.getElementById("releasedCheckbox");
const popularCheckbox = document.getElementById("popularCheckbox");
const filtersToggle = document.getElementById("filtersToggle");
const filters = document.getElementById("filters");
const themeToggle = document.getElementById("themeToggle");
const historySection = document.getElementById("history");
const historyItems = document.getElementById("historyItems");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

// Принудительное открытие консоли для отладки
setTimeout(() => {
  console.log("=== Kinopoisk Extension Debug ===");
  console.log("Для просмотра логов откройте консоль разработчика");
  console.log("Нажмите F12 или Ctrl+Shift+I");
}, 1000);

// Сохранение фильтров в localStorage
function saveFiltersToStorage() {
    try {
        const filters = {
            genre: genreFilter.value,
            type: typeFilter.value,
            year: yearFilter.value,
            highRated: highRatedCheckbox.checked,
            released: releasedCheckbox.checked,
			popular: popularCheckbox.checked,
            savedAt: new Date().toLocaleString()
        };
        
        localStorage.setItem('kinopoiskFilters', JSON.stringify(filters));
        debugLog('Фильтры сохранены:', filters);
        
    } catch (error) {
        debugLog('Ошибка сохранения фильтров:', error);
        showMessage("Ошибка сохранения фильтров", "error");
    }
}

// Загрузка фильтров из localStorage
function loadFiltersFromStorage() {
    try {
        const savedFilters = localStorage.getItem('kinopoiskFilters');
        if (savedFilters) {
            const filters = JSON.parse(savedFilters);
            debugLog('Фильтры загружены:', filters);
            return filters;
        }
    } catch (error) {
        debugLog('Ошибка загрузки фильтров:', error);
    }
    return null;
}

// Применение сохраненных фильтров к UI
function applySavedFilters(filters) {
    debugLog("Применяем сохраненные фильтры:", filters);
    
    if (filters.genre) genreFilter.value = filters.genre;
    if (filters.type) typeFilter.value = filters.type;
    if (filters.year) yearFilter.value = filters.year;
    highRatedCheckbox.checked = filters.highRated || false;
    releasedCheckbox.checked = filters.released || false;
	popularCheckbox.checked = filters.popular || false;
    
    showFilterState();
}

// Очистка фильтров
function clearFilters() {
    genreFilter.value = '';
    typeFilter.value = '';
    yearFilter.value = '';
    highRatedCheckbox.checked = false;
    releasedCheckbox.checked = false;
	popularCheckbox.checked = false;
    
    localStorage.removeItem('kinopoiskFilters');
    debugLog("Все фильтры очищены");
    showMessage("Фильтры очищены", "info");
}

// Функция для отображения текущего состояния фильтров
function showFilterState() {
  const state = {
    genre: genreFilter.value || 'Все жанры',
    type: typeFilter.value || 'Все типы',
    year: yearFilter.value || 'Любой год',
    highRated: highRatedCheckbox.checked ? 'Да' : 'Нет',
    released: releasedCheckbox.checked ? 'Да' : 'Нет'
  };
  
  debugLog("=== ТЕКУЩИЕ ФИЛЬТРЫ ===");
  debugLog("Жанр:", state.genre);
  debugLog("Тип:", state.type);
  debugLog("Год:", state.year);
  debugLog("Высокий рейтинг:", state.highRated);
  debugLog("Уже вышедшие:", state.released);
  
  return state;
}

// Настройка слушателей изменений фильтров
function setupFilterListeners() {
    const filterElements = [genreFilter, typeFilter, yearFilter, highRatedCheckbox, releasedCheckbox, popularCheckbox];
    
    filterElements.forEach(element => {
        if (element.tagName === 'SELECT' || element.tagName === 'INPUT') {
            element.addEventListener('change', () => {
                debugLog("Изменен фильтр, автосохранение:", element.id);
                saveFiltersToStorage(); // ← Автоматическое сохранение при изменении
            });
        }
    });
    
    // Для текстового поля года - сохранение с задержкой
    yearFilter.addEventListener('input', debounce(() => {
        saveFiltersToStorage(); // ← Автосохранение с debounce
    }, 1000));
}

// Добавлена функция debounce для оптимизации
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Переключатель фильтров
filtersToggle.addEventListener('click', () => {
    filters.classList.toggle('active');
    filtersToggle.classList.toggle('active');
});

// Переключение темы
themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-theme');
    const isDark = document.body.classList.contains('dark-theme');
    themeToggle.textContent = isDark ? '☀️' : '🌙';
    localStorage.setItem('darkTheme', isDark);
});

// Обработчики кнопок фильтров
clearFiltersBtn.addEventListener('click', clearFilters);

// Загрузка сохраненной темы и фильтров
document.addEventListener('DOMContentLoaded', () => {
    const isDark = localStorage.getItem('darkTheme') === 'true';
    if (isDark) {
        document.body.classList.add('dark-theme');
        themeToggle.textContent = '☀️';
    }
    
    // Загрузка и применение фильтров
    const savedFilters = loadFiltersFromStorage();
    if (savedFilters) {
        applySavedFilters(savedFilters);
        showMessage("Фильтры восстановлены", "success");
    } else {
        showMessage("Выберите фильтры и нажмите 'Случайный'", "info");
    }
    
    // Настройка слушателей
    setupFilterListeners();
    
    // Загрузка истории
    updateHistoryView();
    
    // Показать текущий фильм
    showCurrentMovie();
});

// Включить логирование
const DEBUG = true;
function debugLog(...args) {
    if (DEBUG) {
        console.log('[Kinopoisk Extension]', ...args);
    }
}

// Вывод сообщений
function showMessage(text, type = "info") {
    messageBox.textContent = text;
    messageBox.className = type;
}


// Функция для построения URL с фильтрами
function buildFilterUrl(baseType = '') {
    let url = `${KINOPOISK_BASE}/lists/movies/`;
    const params = [];

    // БАЗОВЫЙ URL ДЛЯ ПОПУЛЯРНЫХ
    if (popularCheckbox.checked) {
        if (baseType === 'series' || typeFilter.value === 'series') {
            url = `${KINOPOISK_BASE}/lists/movies/popular-series/`;
        } else {
            url = `${KINOPOISK_BASE}/lists/movies/popular-films/`;
        }
    }

    const genre = genreFilter.value;
    if (genre) {
        url += `genre--${genre}/`;
    }

    const year = yearFilter.value.trim();
    if (year) {
        url += `year--${year}/`;
    }

    // ДЛЯ ПОПУЛЯРНЫХ НЕ ДОБАВЛЯЕМ ПАРАМЕТРЫ ТИПА (b=films/series)
    if (!popularCheckbox.checked) {
        if (baseType === 'series') {
            params.push('type=series');
            params.push('b=series');
        } else if (baseType === 'film') {
            params.push('b=films');
        }

        const type = typeFilter.value;
        if (type && !baseType) {
            params.push(`b=${type}`);
        }
    }

    // ЭТИ ПАРАМЕТРЫ РАБОТАЮТ ДЛЯ ВСЕХ
    if (highRatedCheckbox.checked) {
        params.push('b=high_rated');
    }

    if (releasedCheckbox.checked) {
        params.push('b=released');
    }

    let contentType = baseType;
    if (!contentType) {
        contentType = typeFilter.value === 'series' ? 'series' : 'film';
    }

    if (params.length > 0) {
        const separator = url.includes('?') ? '&' : '?';
        url += separator + params.join('&');
    }

    return { url, contentType };
}
/**
 * Универсальная функция: пытается определить максимальный номер страницы
 * 1) через "last" ссылку (если есть)
 * 2) через числа в пагинации (теги <a>, <button>, <span>, <li>)
 * 3) через параметры href (?page= или /page/...)
 * 4) как fallback — по общей фразе "Все 960 948 фильмов" и itemsPerPage
 *
 * Внимание: если сайт рендерит пагинацию динамически на клиенте (JS),
 * лучше выполнять parseMaxPageFromDoc прямо в контексте страницы (см. пример ниже).
 */
async function getMaxPage(contentType, filterUrl, itemsPerPage = 50) {
  try {
    debugLog("Загружаем страницу для определения количества страниц:", filterUrl);
    const res = await fetch(filterUrl);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    const max = parseMaxPageFromDoc(doc, itemsPerPage, contentType);
    debugLog("Определённое максимальное число страниц:", max);
    return max;
  } catch (error) {
    debugLog("Ошибка при получении количества страниц:", error);
    // В зависимости от логики приложения — можно возвращать 1 вместо броска
    throw new Error(`Ошибка при определении количества страниц: ${error.message}`);
  }
}

/** Парсер, который можно запускать и в content script (тогда doc = document). */
function parseMaxPageFromDoc(doc, itemsPerPage = 50, contentType = "") {
  const debug = window.debugLog || (() => {});

  function numberFromStr(s) {
    if (!s) return null;
    const digits = s.replace(/\D/g, "");
    return digits ? parseInt(digits, 10) : null;
  }

  // 1) Попытка найти "последнюю" ссылку
  const lastSelectors = [
    'a[rel="last"]',
    'a[data-test-id$="last-link"]',
    'a[data-test-id*="last"]',
    'a[aria-label*="last"]',
    'a[title*="Последн"]',
    'a[href*="page="][rel="nofollow"]'
  ];
  for (const sel of lastSelectors) {
    const node = doc.querySelector(sel);
    if (node) {
      const href = node.getAttribute('href') || node.textContent || "";
      let m = href.match(/[?&]page=(\d+)/i) || href.match(/\/page\/(\d+)/i) || href.match(/\/p\/(\d+)/i);
      if (m) {
        const p = numberFromStr(m[1]);
        if (p && p > 0) {
          debug(`Найден последний селектор ${sel} -> ${p}`);
          return Math.max(1, p);
        }
      }
      const textNum = numberFromStr(node.textContent);
      if (textNum && textNum > 0) {
        debug(`Найден номер в тексте last-link ${textNum}`);
        return Math.max(1, textNum);
      }
    }
  }

  // 2) Все <a> с числовым текстом
  const numericFromAnchors = [];
  Array.from(doc.querySelectorAll('a')).forEach(a => {
    const t = a.textContent.trim();
    if (/^\d+$/.test(t)) numericFromAnchors.push(parseInt(t, 10));
  });
  if (numericFromAnchors.length) {
    const max = Math.max(...numericFromAnchors);
    debug("Найдены числа в <a> пагинации, max =", max);
    return Math.max(1, max);
  }

  // 3) Поиск номеров в href
  const pageNums = [];
  Array.from(doc.querySelectorAll('a[href]')).forEach(a => {
    const href = a.getAttribute('href');
    let m = href && (href.match(/[?&]page=(\d+)/i) || href.match(/\/page\/(\d+)/i) || href.match(/\/p\/(\d+)/i));
    if (m) {
      const n = numberFromStr(m[1]);
      if (n) pageNums.push(n);
    }
  });
  if (pageNums.length) {
    const max = Math.max(...pageNums);
    debug("Найдены номера страниц в href, max =", max);
    return Math.max(1, max);
  }

  // 4) Иногда пагинация — числа в <button>, <span>, <li>
  const numericOther = [];
  Array.from(doc.querySelectorAll('button, span, li')).forEach(n => {
    const t = n.textContent.trim();
    if (/^\d+$/.test(t)) numericOther.push(parseInt(t, 10));
  });
  if (numericOther.length) {
    const max = Math.max(...numericOther);
    debug("Найдены числа в button/span/li, max =", max);
    return Math.max(1, max);
  }

  // 5) fallback: искать общее количество элементов в тексте
  const bodyText = (doc.body && doc.body.textContent) || "";
  const typeWords = contentType ? contentType : 'фильм';
  const totalRegex = new RegExp(`Все\\s+([\\d\\s\\u00A0]+)\\s+(?:${typeWords}|фильм(?:ов)?|сериал(?:ов)?|видео)`, 'i');
  let tm = bodyText.match(totalRegex);
  
  if (tm) {
    const total = numberFromStr(tm[1]);
    if (total && itemsPerPage > 0) {
      // ПРОВЕРЯЕМ, ЕСТЬ ЛИ НА СТРАНИЦЕ ПАГИНАЦИЯ
      const hasPagination = doc.querySelector('.pagination, [data-test-id="pagination"], .styles_pagination') !== null;
      
      // ЕСЛИ ЭТО ПОПУЛЯРНЫЕ ФИЛЬМЫ И ПАГИНАЦИИ НЕТ - ВОЗВРАЩАЕМ 1 СТРАНИЦУ
      if (!hasPagination && bodyText.includes('популяр')) {
        debug("Популярные фильмы без пагинации - возвращаем 1 страницу");
        return 1;
      }
      
      const pages = Math.max(1, Math.ceil(total / itemsPerPage));
      debug(`Найдено общее количество элементов: ${total} -> pages = ${pages} (itemsPerPage=${itemsPerPage})`);
      return pages;
    }
  }

  // 6) Дополнительная проверка для популярных фильмов
  if (bodyText.includes('популяр') || (doc.querySelector('h1') && doc.querySelector('h1').textContent.includes('популяр'))) {
    // Проверяем наличие пагинации для популярных
    const paginationExists = doc.querySelector('.pagination, [data-test-id="pagination"], a[href*="page="]') !== null;
    if (!paginationExists) {
      debug("Популярные фильмы без пагинации - возвращаем 1 страницу");
      return 1;
    }
  }

  // 7) Если всё не помогло — возвращаем 1
  debug("Не удалось определить пагинацию — возвращаем 1");
  return 1;
}

/* Пример использования в content script (лучше для динамически рендерящихся страниц):
   // В content script:
   const max = parseMaxPageFromDoc(document, 50, 'фильм');
   console.log('max page (in-page):', max);
*/

/* Пример вызова getMaxPage (fetch-версия):
getMaxPage('фильм', `${KINOPOISK_BASE}/lists/movies/`, 50)
  .then(max => console.log('max', max))
  .catch(err => console.error(err));
*/

// Функция для выбора случайного фильма/сериала на странице с фильтрами
async function pickRandomMovie(contentType, page, filterUrl) {
    const separator = filterUrl.includes('?') ? '&' : '?';
    const pageUrl = page > 1 ? `${filterUrl}${separator}page=${page}` : filterUrl;

    try {
        const res = await fetch(pageUrl);
        const text = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, "text/html");

        const filmCards = doc.querySelectorAll('.styles_root__ti07r');
        
        if (!filmCards.length) {
            const selector = contentType === 'series' ? 'a[href^="/series/"]' : 'a[href^="/film/"]';
            const alternativeCards = doc.querySelectorAll(selector);
            if (!alternativeCards.length) throw new Error("Фильмы/сериалы не найдены на странице");
            
            const randomAnchor = alternativeCards[Math.floor(Math.random() * alternativeCards.length)];
            const filmPath = randomAnchor.getAttribute("href");
            const title = randomAnchor.querySelector('img')?.alt || randomAnchor.textContent.trim() || "Неизвестно";
            
            return { 
                vipUrl: WATCH_BASE + filmPath, 
                title: title 
            };
        }

        const randomCard = filmCards[Math.floor(Math.random() * filmCards.length)];
        
        const selector = contentType === 'series' ? 'a[href^="/series/"]' : 'a[href^="/film/"]';
        const linkElement = randomCard.querySelector(selector);
        if (!linkElement) throw new Error("Ссылка не найдена в карточке");

        const filmPath = linkElement.getAttribute("href");
        const title = linkElement.querySelector('img')?.alt || 
                     randomCard.querySelector('h3')?.textContent || 
                     "Неизвестно";

        return { 
            vipUrl: WATCH_BASE + filmPath, 
            title: title.replace('Смотреть ', '').trim() 
        };
        
    } catch (error) {
        debugLog("Ошибка в pickRandomMovie:", error);
        throw error;
    }
}

// Кнопка перехода с Кинопоиска на сайт просмотра / Проверка текущего фильма
document.getElementById("convert").addEventListener("click", async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    const url = tab.url;
    const button = document.getElementById("convert");
    const originalHtml = button.innerHTML;

    const isKinopoiskFilm = url.startsWith(`${KINOPOISK_BASE}/film/`);
    const isKinopoiskSeries = url.startsWith(`${KINOPOISK_BASE}/series/`);
    const isFlcksFilm = url.startsWith(`${FALLBACK_WATCH_BASE}/film/`);
    const isFlcksSeries = url.startsWith(`${FALLBACK_WATCH_BASE}/series/`);

    if (isKinopoiskFilm || isKinopoiskSeries) {
        try {
            button.innerHTML = '<span class="icon">⏳</span>...';
            button.classList.add('loading');
            showMessage("Перенаправляем...", "info");

            const newUrl = url.replace(KINOPOISK_BASE, WATCH_BASE);

            // Save history before navigation because the popup closes.
            const historyTitle = tab.title || "Неизвестно";
            addToHistory(historyTitle, newUrl);

            chrome.tabs.update(tab.id, { url: newUrl });
            
            const onTabUpdated = async (tabId, changeInfo) => {
                if (tabId === tab.id && changeInfo.status === "complete") {
                    chrome.tabs.onUpdated.removeListener(onTabUpdated);
                    
                    setTimeout(async () => {
                        try {
                            const [execResult] = await chrome.scripting.executeScript({
                                target: { tabId: tab.id },
                                func: () => document.title
                            });

                            const title = execResult.result || "Неизвестно";
                            showMessage(`Открыт: "${title}"`, "success");
                            
                            const openButton = document.getElementById("openOnKinopoisk");
                            openButton.style.display = 'flex';
                            
                        } catch (error) {
                            showMessage("Перенаправлено успешно", "success");
                        }
                        
                        button.innerHTML = originalHtml;
                        button.classList.remove('loading');
                    }, 500);
                }
            };
            
            chrome.tabs.onUpdated.addListener(onTabUpdated);
            
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(onTabUpdated);
                button.innerHTML = originalHtml;
                button.classList.remove('loading');
                showMessage("Перенаправлено", "success");
            }, 5000);

        } catch (error) {
            button.innerHTML = originalHtml;
            button.classList.remove('loading');
            showMessage("Ошибка перенаправления", "error");
        }

    } else if (isFlcksFilm || isFlcksSeries) {
        try {
            const [execResult] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => document.title
            });

            const title = execResult.result || "Неизвестно";
            showMessage(`Открыт: "${title}"`, "success");
            
            addToHistory(title, url);
            
        } catch (error) {
            showMessage("Уже открыт", "success");
        }

    } else {
        showMessage("Откройте страницу фильма на Кинопоиске", "error");
    }
});

// Кнопка открытия Кинопоиска (Фильмы) с фильтрами
document.getElementById("kinopoiskFilm").addEventListener("click", () => {
    const { url } = buildFilterUrl('film');
    chrome.tabs.create({ url });
    showMessage("Открываем фильмы...", "info");
});

// Кнопка открытия Кинопоиска (Сериалы) с фильтрами
document.getElementById("kinopoiskSerial").addEventListener("click", () => {
    const { url } = buildFilterUrl('series');
    chrome.tabs.create({ url });
    showMessage("Открываем сериалы...", "info");
});

// Кнопка "Случайный фильм" с фильтрами
document.getElementById("randomFilm").addEventListener("click", async () => {
  const button = document.getElementById("randomFilm");
  const originalHtml = button.innerHTML;
  
  try {
    button.innerHTML = '<span class="icon">⏳</span> Поиск...';
    button.classList.add('loading');
    
    const filterState = showFilterState();
    showMessage("Ищем с текущими фильтрами...", "info");

    const { url: filterUrl, contentType } = buildFilterUrl();
    debugLog("Собранный URL:", filterUrl);
    
    const maxPage = await getMaxPage(contentType, filterUrl);
    debugLog("Определено максимальное количество страниц:", maxPage);
    
    if (maxPage === 0) {
      showMessage("Ничего не найдено с такими фильтрами", "error");
      return;
    }
    
    const randomPage = Math.floor(Math.random() * maxPage) + 1;
    showMessage(`Ищем на странице ${randomPage}/${maxPage}...`, "info");
    debugLog("Выбрана случайная страница:", randomPage);

    const { vipUrl, title } = await pickRandomMovie(contentType, randomPage, filterUrl);

    chrome.tabs.create({ url: vipUrl });

    const genreName = genreFilter.options[genreFilter.selectedIndex]?.text || 'Все жанры';
    const typeName = typeFilter.value ? typeFilter.options[typeFilter.selectedIndex].text : 'Все типы';
    const yearText = yearFilter.value ? ` ${yearFilter.value} г.` : '';
    
    showMessage(`Найден: "${title}"`, "success");
    debugLog("Найден фильм:", title, "URL:", vipUrl);
    
    addToHistory(title, vipUrl);
    
  } catch (err) {
    debugLog("Ошибка в randomFilm:", err);
    showMessage("Ошибка поиска: " + err.message, "error");
  } finally {
    button.innerHTML = originalHtml;
    button.classList.remove('loading');
  }
});

// Кнопка "Открыть на Кинопоиске"
document.getElementById("openOnKinopoisk").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
        showMessage("Ошибка вкладки", "error");
        return;
    }

    const currentUrl = tab.url;
    
    const filmIdRegex = /\/(film|series)\/(\d+)\//;
    const match = currentUrl.match(filmIdRegex);
    
    if (!match) {
        showMessage("Не страница фильма", "error");
        return;
    }

    const type = match[1];
    const id = match[2];
    const kinopoiskUrl = `${KINOPOISK_BASE}/${type}/${id}/`;

    chrome.tabs.create({ url: kinopoiskUrl });
    showMessage("Открываем на КП...", "success");
});

// Функции для работы с историей
function addToHistory(title, url) {
    let history = JSON.parse(localStorage.getItem('kinopoiskHistory') || '[]');
    
    history = history.filter(item => item.url !== url);
    history.unshift({ title, url, timestamp: Date.now() });
    history = history.slice(0, 5);
    
    localStorage.setItem('kinopoiskHistory', JSON.stringify(history));
    updateHistoryView();
}

function updateHistoryView() {
    const history = JSON.parse(localStorage.getItem('kinopoiskHistory') || '[]');
    
    if (history.length > 0) {
        historySection.style.display = 'block';
        historyItems.innerHTML = '';
        
        history.forEach(item => {
            const historyItem = document.createElement('div');
            historyItem.className = 'history-item';
            historyItem.innerHTML = `
                <div class="history-item-title" title="${item.title}" data-url="${item.url}">${item.title}</div>
                <div class="history-item-actions">
                    <button class="history-item-btn tooltip" data-tooltip="Открыть" data-url="${item.url}">▶</button>
                    <button class="history-item-btn tooltip" data-tooltip="Удалить" data-url="${item.url}">✕</button>
                </div>
            `;
            historyItems.appendChild(historyItem);
        });
        
        document.querySelectorAll('.history-item-btn[data-tooltip="Открыть"]').forEach(btn => {
            btn.addEventListener('click', () => {
                chrome.tabs.create({ url: btn.dataset.url });
            });
        });
        
        document.querySelectorAll('.history-item-btn[data-tooltip="Удалить"]').forEach(btn => {
            btn.addEventListener('click', () => {
                removeFromHistory(btn.dataset.url);
            });
        });
        
        document.querySelectorAll('.history-item-title').forEach(titleEl => {
            titleEl.addEventListener('click', () => {
                chrome.tabs.create({ url: titleEl.dataset.url });
            });
        });
    } else {
        historySection.style.display = 'none';
    }
}

function removeFromHistory(url) {
    let history = JSON.parse(localStorage.getItem('kinopoiskHistory') || '[]');
    history = history.filter(item => item.url !== url);
    localStorage.setItem('kinopoiskHistory', JSON.stringify(history));
    updateHistoryView();
}

// Функция для определения текущего фильма/сериала
async function showCurrentMovie() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) {
            showMessage("Выберите фильтры и нажмите 'Случайный'", "info");
            return;
        }

        const openButton = document.getElementById("openOnKinopoisk");
        const url = tab.url;
        
        if (url.startsWith(WATCH_BASE) || url.startsWith(FALLBACK_WATCH_BASE)) {
            openButton.style.display = 'flex';
            
            try {
                const [execResult] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => document.title
                });

                const title = execResult.result || "Неизвестно";
                let type = "фильм";
                if (url.includes("/series/")) type = "сериал";
                
                showMessage(`Текущий ${type}: "${title}"`, "success");
            } catch (error) {
                showMessage("Можно открыть на Кинопоиске", "info");
            }
            
        } else if (url.startsWith(KINOPOISK_BASE) && (url.includes("/film/") || url.includes("/series/"))) {
            openButton.style.display = 'none';
            
            try {
                const [execResult] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => document.title
                });

                const title = execResult.result || "Неизвестно";
                let type = "фильм";
                if (url.includes("/series/")) type = "сериал";
                
                showMessage(`Текущий ${type}: "${title}"`, "success");
            } catch (error) {
                showMessage("Страница Кинопоиска", "info");
            }
            
        } else {
            openButton.style.display = 'none';
            showMessage("Выберите фильтры и нажмите 'Случайный'", "info");
        }

    } catch (error) {
        showMessage("Выберите фильтры и нажмите 'Случайный'", "info");
    }
}
