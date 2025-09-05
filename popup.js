const messageBox = document.getElementById("message");
const genreFilter = document.getElementById("genreFilter");
const typeFilter = document.getElementById("typeFilter");
const yearFilter = document.getElementById("yearFilter");

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
    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    // Ищем все элементы пагинации
    const paginationElements = doc.querySelectorAll('a.styles_page__gAaYU.styles_smaller__cfxLE[data-test-id="next-link"]');
    
    if (paginationElements.length > 0) {
      // Берем последний элемент пагинации (самую большую страницу)
      const lastPageElement = paginationElements[paginationElements.length - 1];
      const pageText = lastPageElement.textContent;
      const lastPage = parseInt(pageText);
      
      if (!isNaN(lastPage)) {
        debugLog(`Найдено страниц через пагинацию: ${lastPage}`);
        return lastPage;
      }
    }
    
    // Альтернативный способ: ищем элемент с наибольшим номером
    const allPageElements = doc.querySelectorAll('a[data-test-id="next-link"]');
    let maxPage = 1;
    
    allPageElements.forEach(element => {
      const pageNum = parseInt(element.textContent);
      if (!isNaN(pageNum) && pageNum > maxPage) {
        maxPage = pageNum;
      }
    });
    
    if (maxPage > 1) {
      debugLog(`Найдено страниц через поиск максимума: ${maxPage}`);
      return maxPage;
    }

    // Если не нашли пагинацию, проверяем есть ли вообще фильмы
    const filmCards = doc.querySelectorAll('.styles_root__ti07r');
    if (filmCards.length === 0) {
      const alternativeCards = doc.querySelectorAll('a[href^="/film/"], a[href^="/series/"]');
      if (alternativeCards.length === 0) {
        throw new Error("На этой странице нет фильмов/сериалов");
      }
      debugLog("Найдены фильмы, но нет пагинации - вероятно 1 страница");
      return 1;
    }

    debugLog("Не удалось определить количество страниц, используем значение по умолчанию: 1");
    return 1;
    
  } catch (error) {
    debugLog("Ошибка при получении количества страниц:", error);
    throw error;
  }
}

// Функция для выбора случайного фильма/сериала на странице с фильтрами
async function pickRandomMovie(contentType, page, filterUrl) {
  try {
    // Формируем URL с пагинацией
    let pageUrl = filterUrl;
    if (page > 1) {
      const separator = filterUrl.includes('?') ? '&' : '?';
      pageUrl = `${filterUrl}${separator}page=${page}`;
    }

    debugLog("Загружаем страницу с фильмами:", pageUrl);
    const res = await fetch(pageUrl);
    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    // Пробуем разные селекторы для карточек
    let filmCards = doc.querySelectorAll('.styles_root__ti07r');
    
    if (filmCards.length === 0) {
      // Альтернативные селекторы
      filmCards = doc.querySelectorAll('.selection-list-item');
      if (filmCards.length === 0) {
        filmCards = doc.querySelectorAll('.styles_root__wBCe5');
      }
    }

    // Если все еще не нашли, ищем по ссылкам
    if (filmCards.length === 0) {
      const selector = contentType === 'series' ? 'a[href^="/series/"]' : 'a[href^="/film/"]';
      const alternativeCards = doc.querySelectorAll(selector);
      
      if (alternativeCards.length === 0) {
        debugLog("HTML страницы:", text.substring(0, 1000)); // Логируем часть HTML для отладки
        throw new Error(`Фильмы/сериалы не найдены на странице. Проверьте URL: ${pageUrl}`);
      }
      
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
    
    if (!linkElement) {
      // Если не нашли ссылку в карточке, ищем любую ссылку в карточке
      const anyLink = randomCard.querySelector('a[href*="/film/"], a[href*="/series/"]');
      if (!anyLink) throw new Error("Ссылка не найдена в карточке");
      
      const filmPath = anyLink.getAttribute("href");
      const title = anyLink.querySelector('img')?.alt || 
                   randomCard.querySelector('h3, h4, .name')?.textContent || 
                   "Неизвестно";

      return { 
        vipUrl: "https://www.kinopoisk.vip" + filmPath, 
        title: title.replace('Смотреть ', '').trim() 
      };
    }

    const filmPath = linkElement.getAttribute("href");
    const title = linkElement.querySelector('img')?.alt || 
                 randomCard.querySelector('h3, h4, .name')?.textContent || 
                 "Неизвестно";

    return { 
      vipUrl: "https://www.kinopoisk.vip" + filmPath, 
      title: title.replace('Смотреть ', '').trim() 
    };
    
  } catch (error) {
    debugLog("Ошибка в pickRandomMovie:", error);
    throw new Error(`Не удалось выбрать фильм: ${error.message}`);
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

    // Получаем русское название жанра для сообщения
    const genreName = genreFilter.options[genreFilter.selectedIndex]?.text || 'Все жанры';
    const typeName = typeFilter.value ? typeFilter.options[typeFilter.selectedIndex].text : 'Фильмы и сериалы';
    const yearText = yearFilter.value ? ` ${yearFilter.value} года` : '';
    
    showMessage(`Случайный: "${title}" (${genreName}, ${typeName}${yearText}) 🎬`, "success");
    
  } catch (err) {
    debugLog("Ошибка:", err);
    showMessage(err.message || "Не удалось выбрать случайный фильм/сериал", "error");
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
    showMessage(`Текущий ${type === 'film' ? 'фильм' : 'seриал'}: "${title}" 🎬`, "success");
  } else {
    showMessage("На этой вкладке нет фильма/сериала", "error");
  }
}

// При открытии popup показываем текущий фильм/сериал
showCurrentMovie();