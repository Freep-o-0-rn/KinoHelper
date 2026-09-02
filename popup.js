// Домены сервисов
const KINOPOISK_BASE = "https://www.kinopoisk.ru";
const WATCH_BASE = "https://www.kinokino.vip";
const FALLBACK_WATCH_BASE = "https://flcksbr.top";

const SETTINGS_KEY = 'kinoHelperSettings';
const HISTORY_KEY = 'kinopoiskHistory';
const FILTERS_KEY = 'kinopoiskFilters';
const HISTORY_COLLAPSED_KEY = 'historyCollapsed';

const DEFAULT_SETTINGS = {
    theme: 'system',
    historyMaxItems: 20,
    historyMaxAgeDays: 30,
    excludeHistoryFromRandom: true,
    historyRulesActivated: true
};

// Элементы DOM
const messageBox = document.getElementById('message');
const genreFilter = document.getElementById('genreFilter');
const typeFilter = document.getElementById('typeFilter');
const yearFilter = document.getElementById('yearFilter');
const highRatedCheckbox = document.getElementById('highRatedCheckbox');
const releasedCheckbox = document.getElementById('releasedCheckbox');
const popularCheckbox = document.getElementById('popularCheckbox');
const filtersToggle = document.getElementById('filtersToggle');
const filters = document.getElementById('filters');
const historySection = document.getElementById('history');
const historyItems = document.getElementById('historyItems');
const historyToggle = document.getElementById('historyToggle');
const clearFiltersBtn = document.getElementById('clearFiltersBtn');
const settingsButton = document.getElementById('settingsButton');
const backToMainButton = document.getElementById('backToMain');
const themeSelect = document.getElementById('themeSelect');
const historyMaxItemsSelect = document.getElementById('historyMaxItems');
const historyMaxAgeSelect = document.getElementById('historyMaxAge');
const excludeHistoryCheckbox = document.getElementById('excludeHistoryFromRandom');
const clearHistoryButton = document.getElementById('clearHistoryBtn');
const clearHistoryConfirm = document.getElementById('clearHistoryConfirm');
const confirmClearHistoryButton = document.getElementById('confirmClearHistory');
const cancelClearHistoryButton = document.getElementById('cancelClearHistory');
const ratingCard = document.getElementById('ratingCard');
const ratingScale = document.getElementById('ratingScale');
const ratingCurrent = document.getElementById('ratingCurrent');
const ratingStatus = document.getElementById('ratingStatus');

const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
let currentSettings = null;
let currentRatingContext = null;
let ratingLoadSequence = 0;

const DEBUG = true;
function debugLog(...args) {
    if (DEBUG) console.log('[KinoHelper]', ...args);
}

function safeParse(json, fallback) {
    try {
        return JSON.parse(json);
    } catch {
        return fallback;
    }
}

function parseMediaUrl(url) {
    try {
        const parsed = new URL(url);
        const match = parsed.pathname.match(/^\/(film|series)\/(\d+)(?:\/|$)/);
        if (!match) return null;
        return { type: match[1], id: match[2] };
    } catch {
        return null;
    }
}

function buildKinopoiskUrl(url) {
    const media = parseMediaUrl(url);
    return media ? `${KINOPOISK_BASE}/${media.type}/${media.id}/` : null;
}

function compactTitle(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKinopoiskTitle(value) {
    const title = compactTitle(value);
    if (!title) return '';

    const seoTitle = title.match(/^(.*?)\s+(?:фильм|сериал),\s*(\d{4})\b/i);
    if (seoTitle) return `${seoTitle[1].trim()} (${seoTitle[2]})`;

    return title
        .replace(/\s*[|—-]\s*Кинопоиск.*$/i, '')
        .replace(/\s+на\s+Кинопоиске.*$/i, '')
        .trim();
}

function normalizePlayerTitle(value, fallback = '') {
    const title = compactTitle(value)
        .replace(/\s*[|—]\s*(?:KinoKino|КиноКино).*$/i, '')
        .trim();
    const genericTitle = /^(?:KinoKino|КиноКино|КиноПомощник|about:blank)$/i.test(title);
    return title && !genericTitle ? title : normalizeKinopoiskTitle(fallback);
}

async function getKinopoiskMovieTitle(tab) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.querySelector('h1')?.textContent || document.title
        });
        const pageTitle = normalizeKinopoiskTitle(results?.[0]?.result);
        if (pageTitle) return pageTitle;
    } catch (error) {
        debugLog('Не удалось прочитать заголовок страницы Кинопоиска:', error);
    }

    return normalizeKinopoiskTitle(tab.title);
}

async function sendBackgroundMessage(message) {
    try {
        return await chrome.runtime.sendMessage(message);
    } catch (error) {
        debugLog('Ошибка связи с service worker:', error);
        return null;
    }
}

async function startWatchSessionForTab(tabId, returnUrl, watchUrl, title = '') {
    const media = parseMediaUrl(returnUrl) || parseMediaUrl(watchUrl);
    if (!media) return false;

    const response = await sendBackgroundMessage({
        action: 'startWatchSession',
        payload: {
            tabId,
            returnUrl: returnUrl || `${KINOPOISK_BASE}/${media.type}/${media.id}/`,
            watchUrl,
            type: media.type,
            id: media.id,
            title: normalizeKinopoiskTitle(title)
        }
    });

    return Boolean(response?.ok);
}

async function getWatchSession(tabId) {
    const response = await sendBackgroundMessage({
        action: 'getWatchSession',
        tabId
    });
    return response?.ok ? response.session : null;
}

async function endWatchSession(tabId) {
    await sendBackgroundMessage({
        action: 'endWatchSession',
        tabId
    });
}

async function openTrackedWatchTab(watchUrl, returnUrl = null, title = '') {
    const resolvedReturnUrl = returnUrl || buildKinopoiskUrl(watchUrl);

    if (!resolvedReturnUrl) {
        return chrome.tabs.create({ url: watchUrl });
    }

    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    await startWatchSessionForTab(tab.id, resolvedReturnUrl, watchUrl, title);
    await chrome.tabs.update(tab.id, { url: watchUrl, active: true });
    return tab;
}

async function openHistoryUrl(url, title = '') {
    if (parseMediaUrl(url)) {
        await openTrackedWatchTab(url, buildKinopoiskUrl(url), title);
        return;
    }
    await chrome.tabs.create({ url });
}

function setRatingStatus(text = '', type = 'info') {
    ratingStatus.textContent = text;
    ratingStatus.className = `rating-status ${type}`;
}

function setRatingButtonsDisabled(disabled) {
    ratingScale.querySelectorAll('.rating-button').forEach(button => {
        button.disabled = disabled;
    });
}

function applyCurrentRating(rating) {
    const normalized = Number.isInteger(Number(rating)) ? Number(rating) : null;
    ratingCurrent.textContent = normalized ? `Ваша: ${normalized}` : 'Не оценено';
    ratingScale.querySelectorAll('.rating-button').forEach(button => {
        const isActive = Number(button.dataset.rating) === normalized;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    });
}

function hideRatingCard() {
    ratingLoadSequence += 1;
    currentRatingContext = null;
    ratingCard.hidden = true;
    applyCurrentRating(null);
    setRatingStatus('');
}

async function submitRating(rating) {
    const context = currentRatingContext;
    if (!context) return;

    const previousRating = context.rating;
    applyCurrentRating(rating);
    setRatingButtonsDisabled(true);
    setRatingStatus(`Отправляем оценку ${rating}...`, 'info');

    const response = await sendBackgroundMessage({
        action: 'setMovieRating',
        payload: {
            id: context.id,
            type: context.type,
            rating
        }
    });

    if (currentRatingContext !== context) return;

    if (response?.ok) {
        context.rating = rating;
        applyCurrentRating(rating);
        setRatingStatus(`Оценка ${rating} сохранена`, 'success');
    } else {
        applyCurrentRating(previousRating);
        const message = response?.authRequired
            ? 'Для отправки оценки войдите в Кинопоиск'
            : 'Не удалось отправить оценку. Проверьте авторизацию на Кинопоиске';
        setRatingStatus(message, 'error');
    }

    setRatingButtonsDisabled(false);
}

function setupRatingButtons() {
    for (let rating = 1; rating <= 10; rating += 1) {
        const button = document.createElement('button');
        button.className = 'rating-button';
        button.type = 'button';
        button.dataset.rating = String(rating);
        button.textContent = String(rating);
        button.setAttribute('aria-label', `Оценка ${rating}`);
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => {
            void submitRating(rating);
        });
        ratingScale.appendChild(button);
    }
}

async function showRatingCard(media) {
    const sequence = ++ratingLoadSequence;
    const context = {
        id: Number(media.id),
        type: media.type,
        rating: null
    };
    currentRatingContext = context;
    ratingCard.hidden = false;
    applyCurrentRating(null);
    setRatingButtonsDisabled(true);
    setRatingStatus('Проверяем вашу оценку...', 'info');

    const response = await sendBackgroundMessage({
        action: 'getMovieRating',
        payload: { id: context.id, type: context.type }
    });

    if (sequence !== ratingLoadSequence || currentRatingContext !== context) return;

    if (!response?.ok) {
        setRatingStatus('Не удалось загрузить оценку. Проверьте авторизацию на Кинопоиске', 'error');
        setRatingButtonsDisabled(false);
        return;
    }

    if (!response.authorized) {
        setRatingStatus('Для отправки оценки войдите в Кинопоиск', 'error');
        setRatingButtonsDisabled(false);
        return;
    }

    context.rating = Number.isInteger(Number(response.rating)) ? Number(response.rating) : null;
    applyCurrentRating(context.rating);
    setRatingStatus(context.rating ? 'Нажмите число, чтобы изменить оценку' : 'Нажмите число, чтобы поставить оценку', 'info');
    setRatingButtonsDisabled(false);
}

function setConvertButtonMode(mode, returnUrl = '') {
    const button = document.getElementById('convert');
    button.dataset.mode = mode;
    button.dataset.returnUrl = returnUrl || '';

    if (mode === 'return') {
        button.innerHTML = '<span class="icon">←</span> На Кинопоиск';
        button.style.opacity = '';
        button.style.cursor = 'pointer';
        button.setAttribute('aria-disabled', 'false');
        return;
    }

    button.innerHTML = '<span class="icon">▶</span> Смотреть';

    if (mode === 'watch') {
        button.style.opacity = '';
        button.style.cursor = 'pointer';
        button.setAttribute('aria-disabled', 'false');
    } else {
        button.style.opacity = '0.55';
        button.style.cursor = 'not-allowed';
        button.setAttribute('aria-disabled', 'true');
    }
}

function getHistory() {
    const history = safeParse(localStorage.getItem(HISTORY_KEY) || '[]', []);
    return Array.isArray(history) ? history : [];
}

function saveHistory(history) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function normalizeLimit(value) {
    return value === 'unlimited' || value === null ? null : Number(value);
}

function loadSettings() {
    const saved = safeParse(localStorage.getItem(SETTINGS_KEY) || 'null', null);
    if (saved) {
        return {
            ...DEFAULT_SETTINGS,
            ...saved,
            historyMaxItems: saved.historyMaxItems === null ? null : Number(saved.historyMaxItems ?? DEFAULT_SETTINGS.historyMaxItems),
            historyMaxAgeDays: saved.historyMaxAgeDays === null ? null : Number(saved.historyMaxAgeDays ?? DEFAULT_SETTINGS.historyMaxAgeDays)
        };
    }

    // Сохраняем старую историю при первом обновлении до версии с настройками.
    // Ограничения начнут применяться после того, как пользователь изменит
    // хотя бы одну настройку хранения истории.
    const hasExistingHistory = getHistory().length > 0;
    const legacyDarkTheme = localStorage.getItem('darkTheme');
    const settings = {
        ...DEFAULT_SETTINGS,
        theme: legacyDarkTheme === 'true' ? 'dark' : legacyDarkTheme === 'false' ? 'light' : 'system',
        historyRulesActivated: !hasExistingHistory
    };

    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return settings;
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings));
}

function applyTheme() {
    const useDark = currentSettings.theme === 'dark' ||
        (currentSettings.theme === 'system' && systemThemeQuery.matches);
    document.body.classList.toggle('dark-theme', useDark);
}

function syncSettingsControls() {
    themeSelect.value = currentSettings.theme;
    historyMaxItemsSelect.value = currentSettings.historyMaxItems === null ? 'unlimited' : String(currentSettings.historyMaxItems);
    historyMaxAgeSelect.value = currentSettings.historyMaxAgeDays === null ? 'unlimited' : String(currentSettings.historyMaxAgeDays);
    excludeHistoryCheckbox.checked = currentSettings.excludeHistoryFromRandom;
}

function pruneHistory(history) {
    if (!currentSettings.historyRulesActivated) return history;

    let result = [...history];

    if (currentSettings.historyMaxAgeDays !== null) {
        const cutoff = Date.now() - currentSettings.historyMaxAgeDays * 24 * 60 * 60 * 1000;
        result = result.filter(item => !item.timestamp || item.timestamp >= cutoff);
    }

    if (currentSettings.historyMaxItems !== null) {
        result = result.slice(0, currentSettings.historyMaxItems);
    }

    return result;
}

function applyHistoryRules() {
    if (!currentSettings.historyRulesActivated) return;
    const history = getHistory();
    const pruned = pruneHistory(history);
    if (pruned.length !== history.length) saveHistory(pruned);
}

function historyContains(url) {
    return getHistory().some(item => item.url === url);
}

function addToHistory(title, url) {
    let history = getHistory();
    history = history.filter(item => item.url !== url);
    history.unshift({ title, url, timestamp: Date.now() });
    history = pruneHistory(history);
    saveHistory(history);
    updateHistoryView();
}

function removeFromHistory(url) {
    const history = getHistory().filter(item => item.url !== url);
    saveHistory(history);
    updateHistoryView();
}

function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    updateHistoryView();
}

function setHistoryCollapsed(collapsed) {
    historyItems.classList.toggle('collapsed', collapsed);
    historyToggle.innerHTML = collapsed
        ? '<span class="icon">▶</span> Показать'
        : '<span class="icon">▼</span> Скрыть';
    historyToggle.setAttribute('aria-expanded', String(!collapsed));
    localStorage.setItem(HISTORY_COLLAPSED_KEY, String(collapsed));
}

function updateHistoryView() {
    const history = getHistory();

    if (!history.length) {
        historySection.style.display = 'none';
        historyItems.innerHTML = '';
        return;
    }

    historySection.style.display = 'block';
    historyItems.innerHTML = '';

    history.forEach(item => {
        const historyItem = document.createElement('div');
        historyItem.className = 'history-item';

        const title = document.createElement('div');
        title.className = 'history-item-title';
        title.textContent = item.title || 'Неизвестно';
        title.title = item.title || 'Неизвестно';
        title.addEventListener('click', () => {
            void openHistoryUrl(item.url, item.title);
        });

        const actions = document.createElement('div');
        actions.className = 'history-item-actions';

        const openButton = document.createElement('button');
        openButton.className = 'history-item-btn';
        openButton.type = 'button';
        openButton.textContent = '▶';
        openButton.title = 'Открыть';
        openButton.addEventListener('click', () => {
            void openHistoryUrl(item.url, item.title);
        });

        const removeButton = document.createElement('button');
        removeButton.className = 'history-item-btn';
        removeButton.type = 'button';
        removeButton.textContent = '✕';
        removeButton.title = 'Удалить';
        removeButton.addEventListener('click', () => removeFromHistory(item.url));

        actions.append(openButton, removeButton);
        historyItem.append(title, actions);
        historyItems.appendChild(historyItem);
    });
}

function showMessage(text, type = 'info') {
    messageBox.textContent = text;
    messageBox.className = type;
}

function openSettings() {
    document.body.classList.add('settings-open');
    clearHistoryConfirm.classList.remove('visible');
}

function closeSettings() {
    document.body.classList.remove('settings-open');
    clearHistoryConfirm.classList.remove('visible');
}

// Сохранение фильтров
function saveFiltersToStorage() {
    const state = {
        genre: genreFilter.value,
        type: typeFilter.value,
        year: yearFilter.value,
        highRated: highRatedCheckbox.checked,
        released: releasedCheckbox.checked,
        popular: popularCheckbox.checked,
        savedAt: new Date().toLocaleString()
    };
    localStorage.setItem(FILTERS_KEY, JSON.stringify(state));
}

function loadFiltersFromStorage() {
    return safeParse(localStorage.getItem(FILTERS_KEY) || 'null', null);
}

function applySavedFilters(saved) {
    if (!saved) return;
    if (saved.genre) genreFilter.value = saved.genre;
    if (saved.type) typeFilter.value = saved.type;
    if (saved.year) yearFilter.value = saved.year;
    highRatedCheckbox.checked = Boolean(saved.highRated);
    releasedCheckbox.checked = Boolean(saved.released);
    popularCheckbox.checked = Boolean(saved.popular);
}

function clearFilters() {
    genreFilter.value = '';
    typeFilter.value = '';
    yearFilter.value = '';
    highRatedCheckbox.checked = false;
    releasedCheckbox.checked = false;
    popularCheckbox.checked = false;
    localStorage.removeItem(FILTERS_KEY);
    showMessage('Фильтры очищены', 'info');
}

function debounce(func, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

function setupFilterListeners() {
    [genreFilter, typeFilter, highRatedCheckbox, releasedCheckbox, popularCheckbox].forEach(element => {
        element.addEventListener('change', saveFiltersToStorage);
    });
    yearFilter.addEventListener('change', saveFiltersToStorage);
    yearFilter.addEventListener('input', debounce(saveFiltersToStorage, 700));
}

function showFilterState() {
    const state = {
        genre: genreFilter.value || 'Все жанры',
        type: typeFilter.value || 'Все типы',
        year: yearFilter.value || 'Любой год',
        highRated: highRatedCheckbox.checked ? 'Да' : 'Нет',
        released: releasedCheckbox.checked ? 'Да' : 'Нет',
        popular: popularCheckbox.checked ? 'Да' : 'Нет'
    };
    debugLog('Текущие фильтры:', state);
    return state;
}

function buildFilterUrl(baseType = '') {
    let url = `${KINOPOISK_BASE}/lists/movies/`;
    const params = [];

    if (popularCheckbox.checked) {
        if (baseType === 'series' || typeFilter.value === 'series') {
            url = `${KINOPOISK_BASE}/lists/movies/popular-series/`;
        } else {
            url = `${KINOPOISK_BASE}/lists/movies/popular-films/`;
        }
    }

    if (genreFilter.value) url += `genre--${genreFilter.value}/`;
    const year = yearFilter.value.trim();
    if (year) url += `year--${year}/`;

    if (!popularCheckbox.checked) {
        if (baseType === 'series') {
            params.push('type=series', 'b=series');
        } else if (baseType === 'film') {
            params.push('b=films');
        }

        if (typeFilter.value && !baseType) params.push(`b=${typeFilter.value}`);
    }

    if (highRatedCheckbox.checked) params.push('b=high_rated');
    if (releasedCheckbox.checked) params.push('b=released');

    let contentType = baseType;
    if (!contentType) contentType = typeFilter.value === 'series' ? 'series' : 'film';

    if (params.length) url += `${url.includes('?') ? '&' : '?'}${params.join('&')}`;
    return { url, contentType };
}

async function getMaxPage(contentType, filterUrl, itemsPerPage = 50) {
    const res = await fetch(filterUrl);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return parseMaxPageFromDoc(doc, itemsPerPage, contentType);
}

function parseMaxPageFromDoc(doc, itemsPerPage = 50, contentType = '') {
    function numberFromStr(value) {
        if (!value) return null;
        const digits = value.replace(/\D/g, '');
        return digits ? parseInt(digits, 10) : null;
    }

    const lastSelectors = [
        'a[rel="last"]',
        'a[data-test-id$="last-link"]',
        'a[data-test-id*="last"]',
        'a[aria-label*="last"]',
        'a[title*="Последн"]',
        'a[href*="page="][rel="nofollow"]'
    ];

    for (const selector of lastSelectors) {
        const node = doc.querySelector(selector);
        if (!node) continue;
        const source = node.getAttribute('href') || node.textContent || '';
        const match = source.match(/[?&]page=(\d+)/i) || source.match(/\/page\/(\d+)/i) || source.match(/\/p\/(\d+)/i);
        if (match) return Math.max(1, Number(match[1]));
        const textNumber = numberFromStr(node.textContent);
        if (textNumber) return Math.max(1, textNumber);
    }

    const hrefPages = [];
    doc.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href') || '';
        const match = href.match(/[?&]page=(\d+)/i) || href.match(/\/page\/(\d+)/i) || href.match(/\/p\/(\d+)/i);
        if (match) hrefPages.push(Number(match[1]));
    });
    if (hrefPages.length) return Math.max(1, ...hrefPages);

    const paginationNumbers = [];
    doc.querySelectorAll('.pagination a, [data-test-id="pagination"] a, [class*="pagination"] a').forEach(node => {
        const text = node.textContent.trim();
        if (/^\d+$/.test(text)) paginationNumbers.push(Number(text));
    });
    if (paginationNumbers.length) return Math.max(1, ...paginationNumbers);

    const bodyText = doc.body?.textContent || '';
    const typeWords = contentType || 'фильм';
    const totalRegex = new RegExp(`Все\\s+([\\d\\s\\u00A0]+)\\s+(?:${typeWords}|фильм(?:ов)?|сериал(?:ов)?|видео)`, 'i');
    const totalMatch = bodyText.match(totalRegex);
    if (totalMatch) {
        const total = numberFromStr(totalMatch[1]);
        if (total && itemsPerPage > 0) return Math.max(1, Math.ceil(total / itemsPerPage));
    }

    return 1;
}

async function pickRandomMovie(contentType, page, filterUrl) {
    const separator = filterUrl.includes('?') ? '&' : '?';
    const pageUrl = page > 1 ? `${filterUrl}${separator}page=${page}` : filterUrl;
    const res = await fetch(pageUrl);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const selector = contentType === 'series' ? 'a[href^="/series/"]' : 'a[href^="/film/"]';
    const filmCards = doc.querySelectorAll('.styles_root__ti07r');

    if (filmCards.length) {
        const candidates = Array.from(filmCards)
            .map(card => {
                const link = card.querySelector(selector);
                if (!link) return null;
                return {
                    vipUrl: WATCH_BASE + link.getAttribute('href'),
                    title: (link.querySelector('img')?.alt || card.querySelector('h3')?.textContent || 'Неизвестно')
                        .replace('Смотреть ', '')
                        .trim()
                };
            })
            .filter(Boolean);

        if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
    }

    const anchors = Array.from(doc.querySelectorAll(selector));
    if (!anchors.length) throw new Error('Фильмы/сериалы не найдены на странице');

    const anchor = anchors[Math.floor(Math.random() * anchors.length)];
    return {
        vipUrl: WATCH_BASE + anchor.getAttribute('href'),
        title: anchor.querySelector('img')?.alt || anchor.textContent.trim() || 'Неизвестно'
    };
}

async function showCurrentMovie() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const legacyOpenButton = document.getElementById('openOnKinopoisk');
        if (legacyOpenButton) legacyOpenButton.style.display = 'none';

        if (!tab?.url) {
            hideRatingCard();
            setConvertButtonMode('unavailable');
            showMessage("Выберите фильтры и нажмите 'Случайный'", 'info');
            return;
        }

        const url = tab.url;
        const media = parseMediaUrl(url);
        const isKinopoiskMedia = url.startsWith(KINOPOISK_BASE) && Boolean(media);

        if (isKinopoiskMedia) {
            setConvertButtonMode('watch');
            const type = media.type === 'series' ? 'сериал' : 'фильм';
            const title = await getKinopoiskMovieTitle(tab);
            showMessage(`Текущий ${type}: «${title || 'Страница Кинопоиска'}»`, 'success');
            await showRatingCard(media);
            return;
        }

        const session = await getWatchSession(tab.id);
        if (session?.returnUrl) {
            setConvertButtonMode('return', session.returnUrl);
            const title = normalizePlayerTitle(tab.title, session.title);
            showMessage(title ? `Сейчас смотрите: «${title}»` : 'Сейчас идёт просмотр', 'success');
            await showRatingCard({ type: session.type, id: session.id });
            return;
        }

        const isKnownWatchSite = url.startsWith(WATCH_BASE) || url.startsWith(FALLBACK_WATCH_BASE);
        if (isKnownWatchSite && media) {
            setConvertButtonMode('return', `${KINOPOISK_BASE}/${media.type}/${media.id}/`);
            const title = normalizePlayerTitle(tab.title);
            showMessage(title ? `Сейчас смотрите: «${title}»` : 'Сейчас идёт просмотр', 'success');
            await showRatingCard(media);
            return;
        }

        hideRatingCard();
        setConvertButtonMode('unavailable');
        showMessage('Откройте страницу фильма на Кинопоиске', 'info');
    } catch (error) {
        debugLog('Ошибка определения текущей страницы:', error);
        hideRatingCard();
        setConvertButtonMode('unavailable');
        showMessage("Выберите фильтры и нажмите 'Случайный'", 'info');
    }
}

// Навигация и настройки
settingsButton.addEventListener('click', openSettings);
backToMainButton.addEventListener('click', closeSettings);

filtersToggle.addEventListener('click', () => {
    filters.classList.toggle('active');
    filtersToggle.classList.toggle('active');
});

historyToggle.addEventListener('click', () => {
    setHistoryCollapsed(!historyItems.classList.contains('collapsed'));
});

clearFiltersBtn.addEventListener('click', clearFilters);

themeSelect.addEventListener('change', () => {
    currentSettings.theme = themeSelect.value;
    saveSettings();
    applyTheme();
});

historyMaxItemsSelect.addEventListener('change', () => {
    currentSettings.historyMaxItems = normalizeLimit(historyMaxItemsSelect.value);
    currentSettings.historyRulesActivated = true;
    saveSettings();
    applyHistoryRules();
    updateHistoryView();
});

historyMaxAgeSelect.addEventListener('change', () => {
    currentSettings.historyMaxAgeDays = normalizeLimit(historyMaxAgeSelect.value);
    currentSettings.historyRulesActivated = true;
    saveSettings();
    applyHistoryRules();
    updateHistoryView();
});

excludeHistoryCheckbox.addEventListener('change', () => {
    currentSettings.excludeHistoryFromRandom = excludeHistoryCheckbox.checked;
    saveSettings();
});

clearHistoryButton.addEventListener('click', () => {
    clearHistoryConfirm.classList.add('visible');
});

cancelClearHistoryButton.addEventListener('click', () => {
    clearHistoryConfirm.classList.remove('visible');
});

confirmClearHistoryButton.addEventListener('click', () => {
    clearHistory();
    clearHistoryConfirm.classList.remove('visible');
});

systemThemeQuery.addEventListener('change', () => {
    if (currentSettings?.theme === 'system') applyTheme();
});

// Контекстная кнопка: Кинопоиск → Смотреть, наш плеер → На Кинопоиск
document.getElementById('convert').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    const button = document.getElementById('convert');
    const mode = button.dataset.mode || 'unavailable';

    if (mode === 'return') {
        const returnUrl = button.dataset.returnUrl;
        if (!returnUrl) {
            showMessage('Не удалось определить страницу Кинопоиска', 'error');
            return;
        }

        showMessage('Возвращаемся на Кинопоиск...', 'info');
        await endWatchSession(tab.id);
        await chrome.tabs.update(tab.id, { url: returnUrl });
        return;
    }

    const media = parseMediaUrl(tab.url);
    const isKinopoiskMedia = tab.url.startsWith(KINOPOISK_BASE) && Boolean(media);

    if (mode !== 'watch' || !isKinopoiskMedia) {
        showMessage('Откройте страницу фильма на Кинопоиске', 'error');
        return;
    }

    const watchUrl = tab.url.replace(KINOPOISK_BASE, WATCH_BASE);

    const title = await getKinopoiskMovieTitle(tab);
    await startWatchSessionForTab(tab.id, tab.url, watchUrl, title);
    addToHistory(title || 'Неизвестно', watchUrl);
    showMessage('Перенаправляем...', 'info');
    await chrome.tabs.update(tab.id, { url: watchUrl });
});


document.getElementById('kinopoiskFilm').addEventListener('click', () => {
    const { url } = buildFilterUrl('film');
    chrome.tabs.create({ url });
    showMessage('Открываем фильмы...', 'info');
});

document.getElementById('kinopoiskSerial').addEventListener('click', () => {
    const { url } = buildFilterUrl('series');
    chrome.tabs.create({ url });
    showMessage('Открываем сериалы...', 'info');
});

document.getElementById('randomFilm').addEventListener('click', async () => {
    const button = document.getElementById('randomFilm');
    const originalHtml = button.innerHTML;

    try {
        button.innerHTML = '<span class="icon">⏳</span> Поиск...';
        button.classList.add('loading');
        showFilterState();
        showMessage('Ищем с текущими фильтрами...', 'info');

        const { url: filterUrl, contentType } = buildFilterUrl();
        const maxPage = await getMaxPage(contentType, filterUrl);
        if (!maxPage) throw new Error('Ничего не найдено с такими фильтрами');

        const attempts = currentSettings.excludeHistoryFromRandom ? 10 : 1;
        let lastError = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const randomPage = Math.floor(Math.random() * maxPage) + 1;
            showMessage(
                currentSettings.excludeHistoryFromRandom
                    ? `Ищем новый вариант: ${attempt}/10...`
                    : `Ищем на странице ${randomPage}/${maxPage}...`,
                'info'
            );

            try {
                const movie = await pickRandomMovie(contentType, randomPage, filterUrl);
                if (currentSettings.excludeHistoryFromRandom && historyContains(movie.vipUrl)) {
                    debugLog('Пропускаем просмотренный:', movie.title, movie.vipUrl);
                    continue;
                }

                addToHistory(movie.title, movie.vipUrl);
                showMessage(`Найден: "${movie.title}"`, 'success');
                await openTrackedWatchTab(movie.vipUrl, buildKinopoiskUrl(movie.vipUrl), movie.title);
                return;
            } catch (error) {
                lastError = error;
                debugLog(`Ошибка случайного выбора, попытка ${attempt}:`, error);
            }
        }

        if (currentSettings.excludeHistoryFromRandom) {
            throw new Error('Не удалось найти непросмотренный фильм за 10 попыток');
        }
        throw lastError || new Error('Не удалось выбрать фильм');
    } catch (error) {
        showMessage(`Ошибка поиска: ${error.message}`, 'error');
    } finally {
        button.innerHTML = originalHtml;
        button.classList.remove('loading');
    }
});


document.addEventListener('DOMContentLoaded', () => {
    currentSettings = loadSettings();
    applyTheme();
    syncSettingsControls();

    const savedFilters = loadFiltersFromStorage();
    applySavedFilters(savedFilters);
    setupFilterListeners();

    applyHistoryRules();
    updateHistoryView();
    setHistoryCollapsed(localStorage.getItem(HISTORY_COLLAPSED_KEY) === 'true');

    setupRatingButtons();
    showCurrentMovie();
});
