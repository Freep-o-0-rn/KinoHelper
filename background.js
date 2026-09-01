// Домены сервисов
const KINOPOISK_BASE = "https://www.kinopoisk.ru";
const WATCH_BASE = "https://www.kinokino.vip";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Расширение RU→VIP установлено");
});
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg.action === "getRandomFilm") {
    try {
      const res = await fetch(`${KINOPOISK_BASE}/lists/movies/`);
      const text = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");

      const lastPageAnchor = doc.querySelector('a[data-test-id="next-link"]:last-of-type');
      let totalPages = 100;
      if (lastPageAnchor) {
        const href = lastPageAnchor.getAttribute("href");
        const match = href.match(/page=(\d+)/);
        if (match) totalPages = parseInt(match[1]);
      }

      const randomPage = Math.floor(Math.random() * totalPages) + 1;
      const pageRes = await fetch(`${KINOPOISK_BASE}/lists/movies/?page=${randomPage}`);
      const pageText = await pageRes.text();
      const pageDoc = parser.parseFromString(pageText, "text/html");
      const filmAnchors = Array.from(pageDoc.querySelectorAll('a[href^="/film/"]'));
      if (filmAnchors.length === 0) throw new Error("Фильмы не найдены");

      const randomAnchor = filmAnchors[Math.floor(Math.random() * filmAnchors.length)];
      const vipUrl = WATCH_BASE + randomAnchor.getAttribute("href");

      sendResponse({ url: vipUrl });
    } catch (err) {
      sendResponse({ error: err.message });
    }

    // указываем, что ответ будет асинхронный
    return true;
  }
});
