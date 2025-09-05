const messageBox = document.getElementById("message");

// Вывод сообщений
function showMessage(text, type = "error") {
  messageBox.textContent = text;
  messageBox.className = type;
}

// Кнопка замены .ru → .vip
document.getElementById("convert").addEventListener("click", async () => {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const url = tab.url;
  const isKinopoiskFilm = url.startsWith("https://www.kinopoisk.ru/film/");
  const isKinopoiskSeries = url.startsWith("https://www.kinopoisk.ru/series/");

  if (isKinopoiskFilm || isKinopoiskSeries) {
    const newUrl = url.replace(".ru", ".vip");
    chrome.tabs.update(tab.id, { url: newUrl });
    showMessage("Успех! Перенаправляем…", "success");
  } else {
    showMessage("Работает только на страницах фильмов/сериалов 🎬", "error");
  }
});

// Кнопка открытия Кинопоиска (Фильмы)
document.getElementById("kinopoiskFilm").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.kinopoisk.ru/lists/movies/" });
});

// Кнопка открытия Кинопоиска (Сериалы)
document.getElementById("kinopoiskSerial").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.kinopoisk.ru/lists/movies/?type=series" });
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

  const anchors = Array.from(doc.querySelectorAll('a[href^="/film/"]'));
  if (!anchors.length) throw new Error("Фильмы не найдены");

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
