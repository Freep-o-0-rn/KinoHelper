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
      const visible = element => {
        if (!(element instanceof Element)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };

      const targets = [
        { key: 'country', title: 'Страны', resetLabel: 'Все страны' },
        { key: 'genre', title: 'Жанры', resetLabel: 'Все жанры' },
        { key: 'year', title: 'Годы', resetLabel: 'Все годы' }
      ];

      const exactVisible = text => [...document.querySelectorAll('div, span, button, label, p, a')]
        .filter(node => visible(node) && clean(node.textContent) === text)
        .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0] || null;

      const clickableFor = target => {
        const reset = exactVisible(target.resetLabel);
        if (reset) {
          const clickable = reset.closest(
            'button, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]'
          );
          if (clickable) return clickable;
          let current = reset.parentElement;
          for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
            if (visible(current) && current.getBoundingClientRect().width > 120) return current;
          }
        }

        const heading = exactVisible(target.title);
        let root = heading?.parentElement || null;
        for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
          const candidate = [...root.querySelectorAll(
            'button, [role="button"], [role="combobox"], [aria-haspopup], [tabindex]'
          )].filter(visible).find(node => {
            const text = clean(node.textContent);
            return text && text !== target.title && text.length < 80;
          });
          if (candidate) return candidate;
        }
        return null;
      };

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

      const findStringDeep = (value, predicate, depth = 0, seen = new Set()) => {
        if (depth > 5 || value == null) return null;
        if (typeof value === 'string') return predicate(value) ? value : null;
        if (typeof value !== 'object' && typeof value !== 'function') return null;
        if (seen.has(value)) return null;
        seen.add(value);
        let keys;
        try { keys = Object.keys(value).slice(0, 80); } catch { return null; }
        for (const key of keys) {
          let child;
          try { child = value[key]; } catch { continue; }
          const found = findStringDeep(child, predicate, depth + 1, seen);
          if (found) return found;
        }
        return null;
      };

      const optionUrlFromNode = (node, target) => {
        const candidates = [node, node.closest?.('a'), node.querySelector?.('a')].filter(Boolean);
        for (const element of candidates) {
          const attrs = [
            element.getAttribute?.('href'),
            element.getAttribute?.('data-href'),
            element.getAttribute?.('data-url'),
            element.getAttribute?.('data-link')
          ].filter(Boolean);
          for (const raw of attrs) {
            try {
              const url = new URL(raw, location.href);
              if (url.pathname.startsWith('/lists/movies/') && url.pathname.includes(`${target.key}--`)) {
                return url.href;
              }
            } catch {}
          }
        }

        // React props often keep the destination even when the visible option is a div/li.
        for (const owner of candidates) {
          for (const propName of Object.getOwnPropertyNames(owner)) {
            if (!propName.startsWith('__reactProps$') && !propName.startsWith('__reactFiber$')) continue;
            let root;
            try { root = owner[propName]; } catch { continue; }
            const raw = findStringDeep(root, text =>
              text.includes('/lists/movies/') && text.includes(`${target.key}--`)
            );
            if (raw) {
              try { return new URL(raw, location.href).href; } catch {}
            }
          }
        }

        const rawValue = node.getAttribute?.('data-value') ||
          node.getAttribute?.('data-id') || node.getAttribute?.('value');
        if (rawValue && /^[\w-]+$/u.test(rawValue)) {
          const url = new URL(resetUrlFor(target.key));
          const segments = url.pathname
            .slice('/lists/movies/'.length)
            .split('/')
            .filter(Boolean)
            .filter(segment => !segment.startsWith(`${target.key}--`));
          segments.push(`${target.key}--${rawValue}`);
          url.pathname = `/lists/movies/${segments.join('/')}/`;
          return url.href;
        }
        return null;
      };

      const menuFor = (trigger, target) => {
        const controlledId = trigger.getAttribute?.('aria-controls');
        if (controlledId) {
          const controlled = document.getElementById(controlledId);
          if (controlled && visible(controlled)) return controlled;
        }

        const listboxes = [...document.querySelectorAll('[role="listbox"], [role="menu"], ul')]
          .filter(visible)
          .filter(node => clean(node.textContent).includes(target.resetLabel));
        if (listboxes.length) {
          return listboxes.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
        }

        const reset = exactVisible(target.resetLabel);
        if (!reset) return null;
        let current = reset.parentElement;
        for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
          if (!visible(current)) continue;
          const rect = current.getBoundingClientRect();
          const optionCount = current.querySelectorAll(
            '[role="option"], [role="menuitem"], li, a, button, [data-value], [data-id]'
          ).length;
          if (rect.height >= 70 && optionCount >= 2) return current;
        }
        return null;
      };

      const collectMenuOptions = (menu, target) => {
        const nodes = [...menu.querySelectorAll(
          '[role="option"], [role="menuitem"], li, a, button, [data-value], [data-id]'
        )].filter(visible);
        const result = new Map();

        for (const node of nodes) {
          const label = clean(node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.textContent);
          if (!label || label === target.resetLabel || label.length > 70) continue;
          // Ignore wrapper nodes containing several visible option rows.
          const childRows = [...node.querySelectorAll('[role="option"], [role="menuitem"], li')]
            .filter(child => child !== node && visible(child));
          if (childRows.length > 1) continue;

          const url = optionUrlFromNode(node, target);
          if (!url) continue;
          result.set(label, { label, url });
        }
        return [...result.values()];
      };

      const groups = {};
      for (const target of targets) {
        const trigger = clickableFor(target);
        if (!trigger) continue;
        let opened = false;
        try {
          trigger.click();
          opened = true;
          await delay(250);

          let menu = null;
          for (let attempt = 0; attempt < 12 && !menu; attempt += 1) {
            menu = menuFor(trigger, target);
            if (!menu) await delay(100);
          }
          if (!menu) continue;

          const options = collectMenuOptions(menu, target);
          if (options.length) {
            groups[target.key] = {
              key: `path:${target.key}`,
              title: target.title,
              resetLabel: target.resetLabel,
              resetUrl: resetUrlFor(target.key),
              options
            };
          }
        } finally {
          if (opened) {
            try { trigger.click(); } catch {}
            await delay(80);
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true
            }));
            await delay(80);
          }
        }
      }

      return {
        html: document.documentElement.outerHTML,
        url: location.href,
        groups
      };
    }
  });

  const page = results?.[0]?.result;
  if (!page?.html || !page?.url) throw new Error('Не удалось прочитать DOM Кинопоиска');
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
