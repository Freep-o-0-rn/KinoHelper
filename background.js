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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

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
