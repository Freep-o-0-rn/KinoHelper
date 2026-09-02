from pathlib import Path

# 1) Keep exactly one inactive-tab page loader and expose it to filters-ui.js.
p = Path('filters.js')
s = p.read_text(encoding='utf-8')
anchor = s.index('  function buildModel(')
a = s.index('  function delay(ms) {', anchor)
b = s.index('\n\n  function create(options)', a)
loader = r'''  function delay(ms) {
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
  }'''
s = s[:a] + loader + s[b:]
old_export = """  window.KinoFilterEngine = {
    create,
    cleanLabel
  };"""
new_export = """  window.KinoFilterEngine = {
    create,
    cleanLabel,
    readPage: readKinopoiskPageInTab
  };"""
if old_export not in s:
    raise SystemExit('filters.js export block not found')
s = s.replace(old_export, new_export, 1)
p.write_text(s, encoding='utf-8')

# 2) Random selection must use the same browser-tab loader, otherwise direct
# extension fetch can hit the same Yandex SSO CORS redirect.
p = Path('filters-ui.js')
s = p.read_text(encoding='utf-8')
a = s.index('  async function pickRandomMovie(contentType, page, filterUrl) {')
b = s.index('\n\n  async function runRandom(button, dynamicElement)', a)
random_helpers = r'''  async function readKinopoiskDocument(url) {
    const readPage = window.KinoFilterEngine?.readPage;
    if (typeof readPage !== 'function') {
      throw new Error('Модуль чтения Кинопоиска недоступен');
    }

    const page = await readPage(url);
    return {
      page,
      doc: new DOMParser().parseFromString(page.html, 'text/html')
    };
  }

  async function getMaxPageViaTab(contentType, filterUrl) {
    const { doc } = await readKinopoiskDocument(filterUrl);

    if (typeof window.parseMaxPageFromDoc === 'function') {
      return window.parseMaxPageFromDoc(doc, 50, contentType);
    }

    let maxPage = 1;
    doc.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href') || '';
      const match = href.match(/[?&]page=(\d+)/i) || href.match(/\/page\/(\d+)/i);
      if (match) maxPage = Math.max(maxPage, Number(match[1]));
    });
    return maxPage;
  }

  async function pickRandomMovie(contentType, page, filterUrl) {
    const pageUrl = new URL(filterUrl);
    if (page > 1) pageUrl.searchParams.set('page', String(page));
    else pageUrl.searchParams.delete('page');

    const { doc } = await readKinopoiskDocument(pageUrl.href);
    const scope = doc.querySelector('main') || doc;
    const selector = contentType === 'series'
      ? 'a[href^="/series/"]'
      : contentType === 'film'
        ? 'a[href^="/film/"]'
        : 'a[href^="/film/"], a[href^="/series/"]';

    const candidates = new Map();

    scope.querySelectorAll(selector).forEach(anchor => {
      const href = anchor.getAttribute('href');
      if (!href) return;

      let parsed;
      try {
        parsed = new URL(href, KINOPOISK_BASE);
      } catch {
        return;
      }

      const match = parsed.pathname.match(/^\/(film|series)\/(\d+)(?:\/|$)/);
      if (!match) return;
      if (contentType === 'film' && match[1] !== 'film') return;
      if (contentType === 'series' && match[1] !== 'series') return;

      const key = `${match[1]}:${match[2]}`;
      if (candidates.has(key)) return;

      const card = anchor.closest('[class*="styles_root"], article, li, [data-test-id*="item"]');
      const rawTitle = anchor.querySelector('img')?.alt ||
        card?.querySelector('h3, h2, [class*="name"], [class*="title"]')?.textContent ||
        anchor.textContent ||
        'Неизвестно';

      const title = String(rawTitle)
        .replace(/\s+/g, ' ')
        .replace(/^Смотреть\s+/i, '')
        .trim();

      candidates.set(key, {
        vipUrl: `${WATCH_BASE}${parsed.pathname}`,
        title: title || 'Неизвестно'
      });
    });

    const list = [...candidates.values()];
    if (!list.length) throw new Error('Фильмы/сериалы не найдены на странице');

    return list[Math.floor(Math.random() * list.length)];
  }'''
s = s[:a] + random_helpers + s[b:]
old_max = """      if (typeof window.getMaxPage !== 'function') {
        throw new Error('Не удалось определить количество страниц');
      }

      const maxPage = await window.getMaxPage(contentType, filterUrl);"""
new_max = """      const maxPage = await getMaxPageViaTab(contentType, filterUrl);"""
if old_max not in s:
    raise SystemExit('filters-ui.js max page block not found')
s = s.replace(old_max, new_max, 1)
p.write_text(s, encoding='utf-8')
