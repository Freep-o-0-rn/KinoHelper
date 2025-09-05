const messageBox = document.getElementById("message");
const genreFilter = document.getElementById("genreFilter");
const typeFilter = document.getElementById("typeFilter");
const yearFilter = document.getElementById("yearFilter");
const highRatedCheckbox = document.getElementById("highRatedCheckbox");
const releasedCheckbox = document.getElementById("releasedCheckbox");

// Включить логирование
const DEBUG = true;
function debugLog(...args) {
  if (DEBUG) {
    console.log('[Kinopoisk Extension]', ...args);
  }
}

// Вывод сообщений
function showMessage(text, type = "error") {
  messageBox.textContent = text;
  messageBox.className = type;
}

// Функция для построения URL с фильтрами
function buildFilterUrl(baseType = '') {
  let url = 'https://www.kinopoisk.ru/lists/movies/';
  const params = [];

  // Добавляем жанр (в формате /genre--anime/)
  const genre = genreFilter.value;
  if (genre) {
    url += `genre--${genre}/`;
  }

  // Добавляем год (в формате /year--1998/)
  const year = yearFilter.value.trim();
  if (year) {
    url += `year--${year}/`;
  }

  // Добавляем тип (фильмы/сериалы) как query параметр
  const type = typeFilter.value;
  if (type) {
    params.push(`b=${type}`);
  }

  // Добавляем высокий рейтинг (если выбран)
  if (highRatedCheckbox.checked) {
    params.push('b=high_rated');
  }

  // Добавляем "уже вышедшие" (если выбрано)
  if (releasedCheckbox.checked) {
    params.push('b=released');
  }

  // Определяем базовый тип (фильм/сериал)
  let contentType = baseType;
  if (!contentType) {
    contentType = type === 'series' ? 'series' : 'film';
  }

  // Добавляем query параметры если есть
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

    // Способ 1: Ищем все элементы пагинации и берем самый большой номер
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

    // Способ 2: Ищем через ссылки с page=
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

    // Способ 3: Ищем в тексте страницы
    const pageMatches = text.match(/page=(\d+)/g);
    if (pageMatches) {
      pageMatches.forEach(match => {
        const pageNum = parseInt(match.split('=')[1]);
        if (!isNaN(pageNum) && pageNum > maxPage) {
          maxPage = pageNum;
          foundPages = true;
        }
      });
      
      if (foundPages) {
        debugLog(`Найдено страниц через анализ текста: ${maxPage}`);
        return maxPage;
      }
    }

    // Способ 4: Проверяем есть ли вообще фильмы на странице
    const filmCards = doc.querySelectorAll('.styles_root__ti07r, .selection-list-item, .styles_root__wBCe5');
    const alternativeCards = doc.querySelectorAll('a[href^="/film/"], a[href^="/series/"]');
    
    if (filmCards.length > 0 || alternativeCards.length > 0) {
      debugLog("Найдены фильмы, но нет пагинации - вероятно 1 страница");
      return 1;
    }

    // Если ничего не нашли
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

    // Ищем все карточки фильмов
    const filmCards = doc.querySelectorAll('.styles_root__ti07r');
    
    if (!filmCards.length) {
      // Альтернативный селектор
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

    // Выбираем случайную карточку
    const randomCard = filmCards[Math.floor(Math.random() * filmCards.length)];
    
    // Ищем ссылку внутри карточки
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

  // Определяем сайт и тип
  const isKinopoiskFilm = url.startsWith("https://www.kinopoisk.ru/film/");
  const isKinopoiskSeries = url.startsWith("https://www.kinopoisk.ru/series/");
  const isFlcksFilm = url.startsWith("https://flcksbr.top/film/");
  const isFlcksSeries = url.startsWith("https://flcksbr.top/series/");

  if (isKinopoiskFilm || isKinopoiskSeries) {
    // Перенаправляем вкладку на VIP
    const newUrl = url.replace(".ru", ".vip");
    chrome.tabs.update(tab.id, { url: newUrl });
    showMessage("Успех! Перенаправляем…", "success");

    // Ждём загрузки страницы и обновляем сообщение с названием фильма/сериала
    const listener = async (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);

        // Получаем title
        const [execResult] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.title
        });

        const title = execResult.result || "Неизвестно";
        showMessage(`Текущий ${url.includes("/film/") ? 'фильм' : 'сериал'}: "${title}" 🎬`, "success");
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

  } else if (isFlcksFilm || isFlcksSeries) {
    // Пользователь уже на flcksbr.top с фильмом/сериалом
    const [execResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.title
    });

    const title = execResult.result || "Неизвестно";
    showMessage(`Фильм уже открыт: "${title}" 🎬`, "success");

  } else {
    // Любой другой сайт
    showMessage("Работает только на страницах фильмов/сериалов 🎬. Откройте вкладку с фильмом/сериалом на Кинопоиске и нажмите Смотреть", "error");
  }
});

// Кнопка открытия Кинопоиска (Фильмы) с фильтрами
document.getElementById("kinopoiskFilm").addEventListener("click", () => {
  const { url } = buildFilterUrl('film');
  chrome.tabs.create({ url });
});

// Кнопка открытия Кинопоиска (Сериалы) с фильтрами
document.getElementById("kinopoiskSerial").addEventListener("click", () => {
  const { url } = buildFilterUrl('series');
  chrome.tabs.create({ url });
});

// Кнопка "Случайный фильм" с фильтрами
document.getElementById("randomFilm").addEventListener("click", async () => {
  const button = document.getElementById("randomFilm");
  const originalText = button.textContent;
  
  try {
    button.textContent = "🔄 Ищем...";
    button.disabled = true;
    
    // Строим URL с фильтрами
    const { url: filterUrl, contentType } = buildFilterUrl();
    showMessage("Определяем количество страниц...", "success");

    // Получаем реальное количество страниц
    const maxPage = await getMaxPage(contentType, filterUrl);
    
    if (maxPage === 0) {
      showMessage("По выбранным фильтрам не найдено ни одного фильма/сериала", "error");
      return;
    }
    
    const randomPage = Math.floor(Math.random() * maxPage) + 1;
    showMessage(`Выбрана страница ${randomPage} из ${maxPage}...`, "success");

    const { vipUrl, title } = await pickRandomMovie(contentType, randomPage, filterUrl);

    // Открываем вкладку с фильмом/сериалом
    chrome.tabs.create({ url: vipUrl });

    // Получаем информацию о фильтрах для сообщения
    const genreName = genreFilter.options[genreFilter.selectedIndex]?.text || 'Все жанры';
    const typeName = typeFilter.value ? typeFilter.options[typeFilter.selectedIndex].text : 'Фильмы и сериалы';
    const yearText = yearFilter.value ? ` ${yearFilter.value} года` : '';
    const highRatedText = highRatedCheckbox.checked ? ', высокий рейтинг' : '';
    const releasedText = releasedCheckbox.checked ? ', уже вышедшие' : '';
    
    showMessage(`Случайный: "${title}" (${genreName}, ${typeName}${yearText}${highRatedText}${releasedText}) 🎬`, "success");
    
  } catch (err) {
    debugLog("Ошибка:", err);
    showMessage("Не удалось выбрать случайный фильм/сериал", "error");
  } finally {
    button.textContent = originalText;
    button.disabled = false;
  }
});

// Кнопка "Открыть на Кинопоиске" (улучшенная версия)
document.getElementById("openOnKinopoisk").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    showMessage("Не удалось получить информацию о вкладке", "error");
    return;
  }

  const currentUrl = tab.url;
  
  // Регулярное выражение для поиска ID фильма/сериала
  const filmIdRegex = /\/(film|series)\/(\d+)\//;
  const match = currentUrl.match(filmIdRegex);
  
  if (!match) {
    showMessage("На этой странице нет ID фильма или сериала", "error");
    return;
  }

  const type = match[1]; // 'film' или 'series'
  const id = match[2];   // числовой ID
  const kinopoiskUrl = `https://www.kinopoisk.ru/${type}/${id}/`;

  // Открываем на Кинопоиске
  chrome.tabs.create({ url: kinopoiskUrl });
  showMessage(`Открываем ${type === 'film' ? 'фильм' : 'сериал'} на Кинопоиске...`, "success");
});

// Функция для определения текущего фильма/сериала
async function showCurrentMovie() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const openButton = document.getElementById("openOnKinopoisk");
  
  // Показываем/скрываем кнопку в зависимости от URL
  if (tab.url.includes('kinopoisk.') || tab.url.includes('flcksbr.top')) {
    openButton.style.display = 'block';
  } else {
    openButton.style.display = 'none';
  }

  // Определяем тип
  let type = null;
  if (tab.url.includes("/film/")) type = "film";
  else if (tab.url.includes("/series/")) type = "series";

  if (type) {
    // Получаем название из <title>
    const [execResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.title
    });

    const title = execResult.result || "Неизвестно";
    showMessage(`Текущий ${type === 'film' ? 'фильм' : 'сериал'}: "${title}" 🎬`, "success");
  } else {
    showMessage("На этой вкладке нет фильма/сериала", "error");
  }
}

// При открытии popup показываем текущий фильм/сериал
showCurrentMovie();