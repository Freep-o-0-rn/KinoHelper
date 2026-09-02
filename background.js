const KINOPOISK_BASE = "https://www.kinopoisk.ru";
const WATCH_BASE = "https://www.kinokino.vip";
const FALLBACK_WATCH_BASE = "https://flcksbr.top";

const SESSION_PREFIX = "kinoWatchSession:";
const REDIRECT_WINDOW_MS = 15000;

function sessionKey(tabId) {
  return `${SESSION_PREFIX}${tabId}`;
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function parseMedia(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/(film|series)\/(\d+)(?:\/|$)/);
    if (!match) return null;
    return { type: match[1], id: match[2] };
  } catch {
    return null;
  }
}

function sameMedia(session, url) {
  const media = parseMedia(url);
  return Boolean(media && media.type === session.type && media.id === session.id);
}

async function getSession(tabId) {
  const key = sessionKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function saveSession(tabId, session) {
  await chrome.storage.session.set({ [sessionKey(tabId)]: session });
}

async function clearSession(tabId) {
  await chrome.storage.session.remove(sessionKey(tabId));
}

async function startSession({ tabId, returnUrl, watchUrl, type, id }) {
  if (!Number.isInteger(tabId) || !returnUrl || !watchUrl || !type || !id) {
    throw new Error("Недостаточно данных для запуска просмотра");
  }

  const recognizedOrigins = [
    getOrigin(watchUrl),
    getOrigin(WATCH_BASE),
    getOrigin(FALLBACK_WATCH_BASE)
  ].filter(Boolean);

  const now = Date.now();
  const session = {
    tabId,
    returnUrl,
    watchUrl,
    type,
    id,
    startedAt: now,
    lastNavigationAt: now,
    currentUrl: watchUrl,
    recognizedOrigins: [...new Set(recognizedOrigins)]
  };

  await saveSession(tabId, session);
  return session;
}

function isRedirectNavigation(details) {
  const qualifiers = details.transitionQualifiers || [];
  return qualifiers.includes("server_redirect") || qualifiers.includes("client_redirect");
}

function isKnownWatchOrigin(session, url) {
  const origin = getOrigin(url);
  return Boolean(origin && session.recognizedOrigins.includes(origin));
}

async function handleCommittedNavigation(details) {
  if (details.frameId !== 0) return;

  const session = await getSession(details.tabId);
  if (!session) return;

  const { url } = details;
  const now = Date.now();
  const withinRedirectWindow = now - session.startedAt <= REDIRECT_WINDOW_MS;

  // Новая вкладка для Случайного/истории сначала создаётся как about:blank,
  // чтобы успеть сохранить контекст до её активации.
  if (url === "about:blank" && withinRedirectWindow) return;

  // Возврат на Кинопоиск завершает сессию просмотра.
  if (url.startsWith(KINOPOISK_BASE)) {
    await clearSession(details.tabId);
    return;
  }

  const knownOrigin = isKnownWatchOrigin(session, url);
  const matchingMediaDuringRedirect = withinRedirectWindow && sameMedia(session, url);
  const redirectDuringWindow = withinRedirectWindow && isRedirectNavigation(details);

  // Принимаем только URL, который является частью уже известной цепочки,
  // подтвержденным redirect-событием сразу после запуска или содержит
  // ожидаемый film/series ID во время короткого окна перехода.
  if (!knownOrigin && !matchingMediaDuringRedirect && !redirectDuringWindow) {
    await clearSession(details.tabId);
    return;
  }

  const nextOrigins = new Set(session.recognizedOrigins);
  const origin = getOrigin(url);
  if (origin && (knownOrigin || matchingMediaDuringRedirect || redirectDuringWindow)) {
    nextOrigins.add(origin);
  }

  await saveSession(details.tabId, {
    ...session,
    currentUrl: url,
    lastNavigationAt: now,
    recognizedOrigins: [...nextOrigins]
  });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("КиноПомощник: service worker установлен");
});

chrome.webNavigation.onCommitted.addListener(details => {
  handleCommittedNavigation(details).catch(error => {
    console.warn("КиноПомощник: ошибка отслеживания навигации", error);
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  clearSession(tabId).catch(() => {});
});


function comparableFilterUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.searchParams.delete('page');
    url.searchParams.delete('ysclid');
    [...url.searchParams.keys()].forEach(key => {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    });
    const entries = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
      ak.localeCompare(bk) || av.localeCompare(bv)
    );
    url.search = '';
    entries.forEach(([key, value]) => url.searchParams.append(key, value));
    return url.href;
  } catch {
    return String(rawUrl || '');
  }
}

async function waitForFilterTab(tabId, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && /\/lists\/movies\//.test(tab.url || '')) {
      await new Promise(resolve => setTimeout(resolve, 700));
      return tab;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Служебная вкладка Кинопоиска не успела загрузиться');
}

async function scrapeFilterPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

      const targets = [
        { key: 'country', title: 'Страны', resetLabel: 'Все страны' },
        { key: 'genre', title: 'Жанры', resetLabel: 'Все жанры' },
        { key: 'year', title: 'Годы', resetLabel: 'Все годы' }
      ];

      const resetUrlFor = key => {
        const url = new URL(location.href);
        const parts = url.pathname
          .slice('/lists/movies/'.length)
          .split('/')
          .filter(Boolean)
          .filter(segment => !segment.startsWith(`${key}--`));
        url.pathname = `/lists/movies/${parts.length ? `${parts.join('/')}/` : ''}`;
        url.searchParams.delete('page');
        url.hash = '';
        return url.href;
      };

      const buildUrlFromValue = (target, value) => {
        if (value == null || value === '') return null;
        const raw = String(value).trim();
        if (!raw || raw.length > 80) return null;

        if (target.key === 'country' && !/^\d+$/.test(raw)) return null;
        if (target.key === 'genre' && !/^[a-z0-9_-]+$/i.test(raw)) return null;
        if (target.key === 'year' && !/^\d{4}(?:[-_]\d{4})?$/.test(raw)) return null;

        const url = new URL(resetUrlFor(target.key));
        const segments = url.pathname
          .slice('/lists/movies/'.length)
          .split('/')
          .filter(Boolean)
          .filter(segment => !segment.startsWith(`${target.key}--`));
        segments.push(`${target.key}--${raw}`);
        url.pathname = `/lists/movies/${segments.join('/')}/`;
        return url.href;
      };

      const readSsrFilterGroups = () => {
        const groups = {};
        const marker = 'window.Ya.__ssr_initial_data = ';

        for (const script of document.scripts) {
          const text = script.textContent || '';
          const markerIndex = text.indexOf(marker);
          if (markerIndex < 0) continue;

          const rawJson = text
            .slice(markerIndex + marker.length)
            .trim()
            .replace(/;\s*$/, '');

          let initialData;
          try {
            initialData = JSON.parse(rawJson);
          } catch {
            continue;
          }

          const apolloState = initialData?.apolloState;
          if (!apolloState || typeof apolloState !== 'object') continue;

          for (const target of targets) {
            const filter = apolloState[`SingleSelectFilter:${target.key}`];
            if (!filter || typeof filter !== 'object') continue;

            const lists = Object.entries(filter)
              .filter(([key, value]) =>
                key.startsWith('values(') && Array.isArray(value?.items)
              )
              .map(([, value]) => value.items)
              .sort((left, right) => right.length - left.length);

            const items = lists[0] || [];
            const optionMap = new Map();

            for (const item of items) {
              if (!item || item.selectable === false) continue;

              const label = clean(
                item.name?.russian ||
                item.label ||
                item.title ||
                item.text
              );
              const url = buildUrlFromValue(target, item.value);

              if (!label || label.length > 80 || !url) continue;
              optionMap.set(String(item.value), { label, url });
            }

            if (!optionMap.size) continue;

            groups[target.key] = {
              key: `path:${target.key}`,
              title: clean(filter.name?.russian) || target.title,
              resetLabel: clean(filter.hint?.russian) || target.resetLabel,
              resetUrl: resetUrlFor(target.key),
              options: [...optionMap.values()]
            };
          }
        }

        return groups;
      };

      const normalizeFilterUrl = (raw, target) => {
        if (typeof raw !== 'string' || !raw) return null;
        const cleaned = raw
          .replace(/\\u002F/gi, '/')
          .replace(/\\\//g, '/')
          .replace(/&amp;/g, '&');
        try {
          const url = new URL(cleaned, location.href);
          if (!/^(?:www\.)?kinopoisk\.ru$/i.test(url.hostname)) return null;
          if (!url.pathname.startsWith('/lists/movies/')) return null;
          if (!url.pathname.includes(`${target.key}--`)) return null;
          url.protocol = 'https:';
          url.hostname = 'www.kinopoisk.ru';
          url.hash = '';
          url.searchParams.delete('page');
          return url.href;
        } catch {
          return null;
        }
      };

      const reactRoots = (...nodes) => {
        const roots = [];
        const seen = new Set();
        for (const node of nodes.filter(Boolean)) {
          let current = node;
          for (let up = 0; current && up < 3; up += 1, current = current.parentElement) {
            for (const propName of Object.getOwnPropertyNames(current)) {
              if (!propName.startsWith('__reactProps$') && !propName.startsWith('__reactFiber$')) continue;
              let value;
              try { value = current[propName]; } catch { continue; }
              if (value && !seen.has(value)) {
                seen.add(value);
                roots.push(value);
              }
            }
          }
        }
        return roots;
      };

      const findDirectUrl = (root, target, maxDepth = 9) => {
        const seen = new Set();
        let visited = 0;
        const walk = (value, depth) => {
          if (value == null || depth > maxDepth || visited > 30000) return null;
          visited += 1;
          if (typeof value === 'string') return normalizeFilterUrl(value, target);
          if (typeof value !== 'object' && typeof value !== 'function') return null;
          if (seen.has(value)) return null;
          seen.add(value);
          let keys;
          try { keys = Object.keys(value).slice(0, 120); } catch { return null; }
          for (const key of keys) {
            let child;
            try { child = value[key]; } catch { continue; }
            const found = walk(child, depth + 1);
            if (found) return found;
          }
          return null;
        };
        return walk(root, 0);
      };

      const valueScore = (key, value, target) => {
        const name = String(key || '').toLowerCase();
        const raw = String(value ?? '').trim();
        if (!raw) return -1;

        if (target.key === 'country') {
          if (!/^\d+$/.test(raw)) return -1;
          if (name === 'countryid' || name === 'country_id') return 120;
          if (name === 'value') return 110;
          if (name === 'id') return 90;
          if (name.includes('country')) return 80;
          return -1;
        }

        if (target.key === 'genre') {
          if (!/^[a-z0-9_-]+$/i.test(raw)) return -1;
          if (name === 'slug') return 120;
          if (name === 'value') return 110;
          if (name === 'genre') return 105;
          if (name === 'genreid' || name === 'genre_id') return 100;
          if (name === 'code') return 90;
          return -1;
        }

        if (target.key === 'year') {
          if (!/^\d{4}(?:[-_]\d{4})?$/.test(raw)) return -1;
          if (name === 'year') return 120;
          if (name === 'value') return 110;
          if (name === 'id') return 80;
          return -1;
        }
        return -1;
      };

      const findValueNearLabel = (roots, label, target) => {
        let best = null;
        const seen = new Set();
        let visited = 0;

        const walk = (value, depth) => {
          if (value == null || depth > 10 || visited > 50000) return;
          visited += 1;
          if (typeof value !== 'object' && typeof value !== 'function') return;
          if (seen.has(value)) return;
          seen.add(value);

          let keys;
          try { keys = Object.keys(value).slice(0, 140); } catch { return; }
          const entries = [];
          for (const key of keys) {
            let child;
            try { child = value[key]; } catch { continue; }
            entries.push([key, child]);
          }

          const hasLabel = entries.some(([, child]) =>
            typeof child === 'string' && clean(child) === label
          );

          if (hasLabel) {
            for (const [key, child] of entries) {
              if (typeof child !== 'string' && typeof child !== 'number') continue;
              const score = valueScore(key, child, target);
              if (score >= 0 && (!best || score > best.score)) {
                best = { score, value: String(child) };
              }
            }
            const direct = findDirectUrl(value, target, 4);
            if (direct) best = { score: 1000, url: direct };
          }

          for (const [, child] of entries) {
            if (child && (typeof child === 'object' || typeof child === 'function')) {
              walk(child, depth + 1);
            }
          }
        };

        roots.forEach(root => walk(root, 0));
        return best;
      };

      const resolveOptionUrl = (option, menu, trigger, target, label) => {
        if (label === target.resetLabel) return resetUrlFor(target.key);

        const roots = reactRoots(option, menu, trigger);
        for (const root of roots) {
          const direct = findDirectUrl(root, target);
          if (direct) return direct;
        }

        const matched = findValueNearLabel(roots, label, target);
        if (matched?.url) return matched.url;
        if (matched?.value) return buildUrlFromValue(target, matched.value);
        return null;
      };

      const waitForListbox = async trigger => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const controlledId = trigger.getAttribute('aria-controls');
          const byId = controlledId ? document.getElementById(controlledId) : null;
          const byLabel = document.querySelector(
            `[role="listbox"][aria-label="${CSS.escape(trigger.getAttribute('aria-label') || '')}"]`
          );
          const listbox = byId || byLabel;
          if (listbox && listbox.querySelector('[role="option"]')) return listbox;
          await delay(100);
        }
        return null;
      };

      // Кинопоиск хранит полный каталог закрытых dropdown в SSR Apollo cache.
      // Он формируется отдельно для текущего URL (?b=films / ?b=series),
      // поэтому не смешиваем варианты фильмов и сериалов. DOM-разбор ниже
      // остаётся резервом на случай изменения структуры initial data.
      const groups = readSsrFilterGroups();
      const diagnostics = {};

      for (const target of targets) {
        if (groups[target.key]?.options?.length) {
          diagnostics[target.key] = {
            source: 'ssr',
            resolved: groups[target.key].options.length
          };
          continue;
        }

        const trigger = document.querySelector(
          `button[role="combobox"][aria-label="${CSS.escape(target.title)}"]`
        );

        if (!trigger) {
          diagnostics[target.key] = { error: 'combobox not found' };
          continue;
        }

        let openedByUs = false;
        try {
          if (trigger.getAttribute('aria-expanded') !== 'true') {
            trigger.click();
            openedByUs = true;
          }

          const listbox = await waitForListbox(trigger);
          if (!listbox) {
            diagnostics[target.key] = { error: 'listbox not found' };
            continue;
          }

          const optionNodes = [...listbox.querySelectorAll('[role="option"]')];
          const options = [];
          const unresolved = [];

          for (const option of optionNodes) {
            const label = clean(option.getAttribute('aria-label') || option.textContent);
            if (!label || label.length > 80) continue;
            const url = resolveOptionUrl(option, listbox, trigger, target, label);
            if (!url) {
              unresolved.push(label);
              continue;
            }
            options.push({
              label,
              url,
              selected: option.getAttribute('aria-selected') === 'true'
            });
          }

          diagnostics[target.key] = {
            source: 'dom',
            total: optionNodes.length,
            resolved: options.length,
            unresolved: unresolved.slice(0, 12)
          };

          if (options.length) {
            groups[target.key] = {
              key: `path:${target.key}`,
              title: target.title,
              resetLabel: target.resetLabel,
              resetUrl: resetUrlFor(target.key),
              options: options.filter(option => option.label !== target.resetLabel)
            };
          }
        } finally {
          if (openedByUs && trigger.getAttribute('aria-expanded') === 'true') {
            try { trigger.click(); } catch {}
            await delay(80);
          }
        }
      }

      return {
        html: document.documentElement.outerHTML,
        url: location.href,
        groups,
        diagnostics
      };
    }
  });

  const page = results?.[0]?.result;
  if (!page?.html || !page?.url) throw new Error('Не удалось прочитать DOM Кинопоиска');
  console.log('[KinoHelper filters] listbox scrape:', page.diagnostics || {});
  return page;
}

async function fetchFilterPage(url) {
  const requestedUrl = String(url || '');
  if (!requestedUrl.startsWith('https://www.kinopoisk.ru/lists/movies/')) {
    throw new Error('Недопустимый URL фильтров');
  }

  const existing = await chrome.tabs.query({
    url: ['https://www.kinopoisk.ru/lists/movies/*', 'https://kinopoisk.ru/lists/movies/*']
  });
  const matching = existing.find(tab => Number.isInteger(tab.id) && !tab.discarded && tab.url &&
    comparableFilterUrl(tab.url) === comparableFilterUrl(requestedUrl));

  let tabId = matching?.id ?? null;
  let created = false;
  try {
    if (!Number.isInteger(tabId)) {
      const tab = await chrome.tabs.create({ url: requestedUrl, active: false });
      tabId = tab.id;
      created = true;
    }
    if (!Number.isInteger(tabId)) throw new Error('Не удалось создать служебную вкладку');
    await waitForFilterTab(tabId);
    return await scrapeFilterPage(tabId);
  } finally {
    if (created && Number.isInteger(tabId)) {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.action === "fetchFilterPage") {
    fetchFilterPage(message.payload?.url)
      .then(page => sendResponse({ ok: true, page }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "startWatchSession") {
    startSession(message.payload)
      .then(session => sendResponse({ ok: true, session }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "getWatchSession") {
    getSession(message.tabId)
      .then(session => sendResponse({ ok: true, session }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "endWatchSession") {
    clearSession(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
