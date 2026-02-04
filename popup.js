const messageBox = document.getElementById("message");

// Вывод сообщений
function showMessage(text, type = "error") {
  messageBox.textContent = text;
  messageBox.className = type;
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


// Кнопка открытия Кинопоиска (Фильмы)
document.getElementById("kinopoiskFilm").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.kinopoisk.ru/lists/movies/?b=films" });
});

// Кнопка открытия Кинопоиска (Сериалы)
document.getElementById("kinopoiskSerial").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.kinopoisk.ru/lists/movies/?type=series&b=series" });
});

// Функция для получения максимального количества страниц
async function getMaxPage(randomType) {
  const url = randomType === 'film'
    ? 'https://www.kinopoisk.ru/lists/movies/'
    : 'https://www.kinopoisk.ru/lists/movies/?type=series';

  const res = await fetch(url);
  const text = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/html");

  const lastPageAnchor = doc.querySelector('a[data-test-id="next-link"]:last-of-type');
  if (!lastPageAnchor) return 100; // запасное значение

  const match = lastPageAnchor.getAttribute('href').match(/page=(\d+)/);
  return match ? parseInt(match[1]) : 100;
}

// Функция для определения текущего фильма/сериала
async function showCurrentMovie() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

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

// Функция для выбора случайного фильма/сериала на странице
async function pickRandomMovie(randomType, page) {
  let baseUrl = randomType === 'film'
    ? 'https://www.kinopoisk.ru/lists/movies/'
    : 'https://www.kinopoisk.ru/lists/movies/?type=series';

  const pageUrl = page > 1
    ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${page}`
    : baseUrl;

  const res = await fetch(pageUrl);
  const text = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/html");

  const anchors = Array.from(doc.querySelectorAll(randomType === 'film'
    ? 'a[href^="/film/"]'
    : 'a[href^="/series/"]'));

  if (!anchors.length) throw new Error("Фильмы/сериалы не найдены");

  const randomAnchor = anchors[Math.floor(Math.random() * anchors.length)];
  const vipUrl = "https://www.kinopoisk.vip" + randomAnchor.getAttribute("href");
  const title = randomAnchor.querySelector('img')?.alt || "Неизвестно";

  return { vipUrl, title };
}

// Кнопка "Случайный фильм"
document.getElementById("randomFilm").addEventListener("click", async () => {
  showMessage("Открывается случайный фильм/сериал… 🍿", "success");

  const types = ['film', 'series'];
  const randomType = types[Math.floor(Math.random() * types.length)];

  try {
    const maxPage = await getMaxPage(randomType);
    const randomPage = Math.floor(Math.random() * maxPage) + 1;

    const { vipUrl, title } = await pickRandomMovie(randomType, randomPage);

    // Открываем вкладку с фильмом/сериалом
    chrome.tabs.create({ url: vipUrl });

    showMessage(`Случайный ${randomType === 'film' ? 'фильм' : 'сериал'}: "${title}" 🎬`, "success");
  } catch (err) {
    console.error(err);
    showMessage("Не удалось выбрать случайный фильм/сериал", "error");
  }
});

// При открытии popup показываем текущий фильм/сериал
showCurrentMovie();
