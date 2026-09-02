from pathlib import Path

p = Path("filters.js")
s = p.read_text(encoding="utf-8")
a = s.index("  async function fetchModel(sourceUrl, contentType) {")
b = s.index("\n\n  function create(options)", a)

replacement = r"""  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isKinopoiskListsUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return /^(?:www\.)?kinopoisk\.ru$/i.test(url.hostname) &&
        url.pathname.startsWith('/lists/movies/');
    } catch {
      return false;
    }
  }

  async function readKinopoiskPageInTab(sourceUrl) {
    const tab = await chrome.tabs.create({ url: sourceUrl, active: false });
    if (!tab?.id) throw new Error('Не удалось создать служебную вкладку');

    const tabId = tab.id;
    const deadline = Date.now() + 20000;
    let lastUrl = sourceUrl;

    try {
      while (Date.now() < deadline) {
        const currentTab = await chrome.tabs.get(tabId);
        lastUrl = currentTab.url || currentTab.pendingUrl || lastUrl;

        if (currentTab.status === 'complete' && isKinopoiskListsUrl(lastUrl)) {
          await delay(900);
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({
              html: document.documentElement?.outerHTML || '',
              url: location.href
            })
          });

          const page = results?.[0]?.result;
          if (!page?.html) throw new Error('Не удалось прочитать страницу Кинопоиска');
          if (!isKinopoiskListsUrl(page.url)) throw new Error('Кинопоиск открыл неожиданную страницу');
          return page;
        }

        await delay(250);
      }

      if (/passport\.yandex\.ru/i.test(lastUrl)) {
        throw new Error('Кинопоиск запросил авторизацию через Яндекс ID');
      }

      throw new Error('Тайм-аут загрузки фильтров Кинопоиска');
    } finally {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
  }

  async function fetchModel(sourceUrl, contentType) {
    const page = await readKinopoiskPageInTab(sourceUrl);
    const doc = new DOMParser().parseFromString(page.html, 'text/html');

    if (!doc.querySelector('h1') && !doc.body?.textContent?.includes('Кинопоиск')) {
      throw new Error('Получена некорректная страница Кинопоиска');
    }

    return buildModel(doc, page.url || sourceUrl, contentType);
  }"""

p.write_text(s[:a] + replacement + s[b:], encoding="utf-8")
