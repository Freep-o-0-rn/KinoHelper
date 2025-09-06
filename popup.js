// Элементы DOM
const messageBox = document.getElementById("message");
const genreFilter = document.getElementById("genreFilter");
const typeFilter = document.getElementById("typeFilter");
const yearFilter = document.getElementById("yearFilter");
const highRatedCheckbox = document.getElementById("highRatedCheckbox");
const releasedCheckbox = document.getElementById("releasedCheckbox");
const filtersToggle = document.getElementById("filtersToggle");
const filters = document.getElementById("filters");
const themeToggle = document.getElementById("themeToggle");
const historySection = document.getElementById("history");
const historyItems = document.getElementById("historyItems");

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

// Загрузка сохраненной темы
document.addEventListener('DOMContentLoaded', () => {
    const isDark = localStorage.getItem('darkTheme') === 'true';
    if (isDark) {
        document.body.classList.add('dark-theme');
        themeToggle.textContent = '☀️';
    }
    
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
    let url = 'https://www.kinopoisk.ru/lists/movies/';
    const params = [];

    const genre = genreFilter.value;
    if (genre) {
        url += `genre--${genre}/`;
    }

    const year = yearFilter.value.trim();
    if (year) {
        url += `year--${year}/`;
    }

    // ОСНОВНОЕ ИЗМЕНЕНИЕ: Правильная обработка типа контента
    if (baseType === 'series') {
        params.push('type=series');
        params.push('b=series');
    } else if (baseType === 'film') {
        // Для фильмов можно явно указать type=film или не указывать
        params.push('b=films');
    }

    const type = typeFilter.value;
    if (type && !baseType) { // Только если baseType не указан
        params.push(`b=${type}`);
    }

    if (highRatedCheckbox.checked) {
        params.push('b=high_rated');
    }

    if (releasedCheckbox.checked) {
        params.push('b=released');
    }

    let contentType = baseType;
    if (!contentType) {
        contentType = type === 'series' ? 'series' : 'film';
    }

    if (params.length > 0) {
        const separator = url.includes('?') ? '&' : '?';
        url += separator + params.join('&');
    }

    return { url, contentType };
}

// Функция для получения максимального количества страниц с фильтрами
async function getMaxPage(contentType, filterUrl) {
  try {
    debugLog("Загружаем страницу для определения количества страниц:", filterUrl);
    const res = await fetch(filterUrl);
    
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    
    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    const paginationElements = doc.querySelectorAll('a[data-test-id="next-link"]');
    let maxPage = 1;
    let foundPages = false;
    
    if (paginationElements.length > 0) {
      paginationElements.forEach(element => {
        const pageText = element.textContent;
        const pageNum = parseInt(pageText);
        if (!isNaN(pageNum) && pageNum > maxPage) {
          maxPage = pageNum;
          foundPages = true;
        }
      });
      
      if (foundPages) {
        debugLog(`Найдено страниц через пагинацию: ${maxPage}`);
        return maxPage;
      }
    }

    const pageLinks = doc.querySelectorAll('a[href*="page="]');
    if (pageLinks.length > 0) {
      pageLinks.forEach(link => {
        const href = link.getAttribute('href');
        const pageMatch = href.match(/page=(\d+)/);
        if (pageMatch) {
          const pageNum = parseInt(pageMatch[1]);
          if (!isNaN(pageNum) && pageNum > maxPage) {
            maxPage = pageNum;
            foundPages = true;
          }
        }
      });
      
      if (foundPages) {
        debugLog(`Найдено страниц через анализ ссылок: ${maxPage}`);
        return maxPage;
      }
    }

    const filmCards = doc.querySelectorAll('.styles_root__ti07r, .selection-list-item, .styles_root__wBCe5');
    const alternativeCards = doc.querySelectorAll('a[href^="/film/"], a[href^="/series/"]');
    
    if (filmCards.length > 0 || alternativeCards.length > 0) {
      debugLog("Найдены фильмы, но нет пагинации - вероятно 1 страница");
      return 1;
    }

    throw new Error("Не удалось определить количество страниц");
    
  } catch (error) {
    debugLog("Ошибка при получении количества страниц:", error);
    throw new Error(`Ошибка при определении количества страниц: ${error.message}`);
  }
}

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
                vipUrl: "https://www.kinopoisk.vip" + filmPath, 
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
            vipUrl: "https://www.kinopoisk.vip" + filmPath, 
            title: title.replace('Смотреть ', '').trim() 
        };
        
    } catch (error) {
        debugLog("Ошибка в pickRandomMovie:", error);
        throw error;
    }
}

// Кнопка замены .ru → .vip / Проверка текущего фильма
document.getElementById("convert").addEventListener("click", async () => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    const url = tab.url;
    const button = document.getElementById("convert");
    const originalHtml = button.innerHTML;

    const isKinopoiskFilm = url.startsWith("https://www.kinopoisk.ru/film/");
    const isKinopoiskSeries = url.startsWith("https://www.kinopoisk.ru/series/");
    const isFlcksFilm = url.startsWith("https://flcksbr.top/film/");
    const isFlcksSeries = url.startsWith("https://flcksbr.top/series/");

    if (isKinopoiskFilm || isKinopoiskSeries) {
        try {
            button.innerHTML = '<span class="icon">⏳</span>...';
            button.classList.add('loading');
            showMessage("Перенаправляем...", "info");

            const newUrl = url.replace(".ru", ".vip");
            chrome.tabs.update(tab.id, { url: newUrl });
            
            // Слушаем завершение загрузки страницы
            const onTabUpdated = async (tabId, changeInfo) => {
                if (tabId === tab.id && changeInfo.status === "complete") {
                    chrome.tabs.onUpdated.removeListener(onTabUpdated);
                    
                    // Даем странице немного времени на полную загрузку
                    setTimeout(async () => {
                        try {
                            const [execResult] = await chrome.scripting.executeScript({
                                target: { tabId: tab.id },
                                func: () => document.title
                            });

                            const title = execResult.result || "Неизвестно";
                            showMessage(`Открыт: "${title}"`, "success");
                            
                            // Обновляем состояние кнопки "Открыть на Кинопоиске"
                            const openButton = document.getElementById("openOnKinopoisk");
                            openButton.style.display = 'flex';
                            
                            // Добавляем в историю
                            addToHistory(title, newUrl);
                            
                        } catch (error) {
                            showMessage("Перенаправлено успешно", "success");
                        }
                        
                        button.innerHTML = originalHtml;
                        button.classList.remove('loading');
                    }, 500);
                }
            };
            
            chrome.tabs.onUpdated.addListener(onTabUpdated);
            
            // Таймаут на случай если страница не загрузится
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
            
            // Добавляем в историю
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
        showMessage("Ищем...", "info");

        const { url: filterUrl, contentType } = buildFilterUrl();
        
        const maxPage = await getMaxPage(contentType, filterUrl);
        
        if (maxPage === 0) {
            showMessage("Ничего не найдено", "error");
            return;
        }
        
        const randomPage = Math.floor(Math.random() * maxPage) + 1;
        showMessage(`Страница ${randomPage}/${maxPage}`, "info");

        const { vipUrl, title } = await pickRandomMovie(contentType, randomPage, filterUrl);

        chrome.tabs.create({ url: vipUrl });

        const genreName = genreFilter.options[genreFilter.selectedIndex]?.text || 'Все жанры';
        const typeName = typeFilter.value ? typeFilter.options[typeFilter.selectedIndex].text : 'Все типы';
        const yearText = yearFilter.value ? ` ${yearFilter.value} г.` : '';
        
        showMessage(`Найден: "${title}"`, "success");
        
        // Добавляем в историю
        addToHistory(title, vipUrl);
        
    } catch (err) {
        debugLog("Ошибка:", err);
        showMessage("Ошибка поиска", "error");
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
    const kinopoiskUrl = `https://www.kinopoisk.ru/${type}/${id}/`;

    chrome.tabs.create({ url: kinopoiskUrl });
    showMessage("Открываем на КП...", "success");
});

// Функции для работы с историей
function addToHistory(title, url) {
    let history = JSON.parse(localStorage.getItem('kinopoiskHistory') || '[]');
    
    // Удаляем дубликаты
    history = history.filter(item => item.url !== url);
    
    // Добавляем новый элемент в начало
    history.unshift({ title, url, timestamp: Date.now() });
    
    // Ограничиваем историю 5 элементами
    history = history.slice(0, 5);
    
    // Сохраняем
    localStorage.setItem('kinopoiskHistory', JSON.stringify(history));
    
    // Обновляем отображение
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
        
        // Добавляем обработчики событий для кнопок истории
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
        
        // Обработчик клика по названию фильма
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
        
        // Показываем/скрываем кнопку в зависимости от URL
        if (url.includes('kinopoisk.vip') || url.includes('flcksbr.top')) {
            openButton.style.display = 'flex';
            
            // Пытаемся получить название
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
            
        } else if (url.includes('kinopoisk.ru') && (url.includes("/film/") || url.includes("/series/"))) {
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