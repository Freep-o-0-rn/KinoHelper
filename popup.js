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

const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
let currentSettings = null;

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
        title.addEventListener('click', () => chrome.tabs.create({ url: item.url }));

        const actions = document.createElement('div');
        actions.className = 'history-item-actions';

        const openButton = document.createElement('button');
        openButton.className = 'history-item-btn';
        openButton.type = 'button';
        openButton.textContent = '▶';
        openButton.title = 'Открыть';
        openButton.addEventListener('click', () => chrome.tabs.create({ url: item.url }));

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
        if (!tab?.url) {
            showMessage("Выберите фильтры и нажмите 'Случайный'", 'info');
            return;
        }

        const openButton = document.getElementById('openOnKinopoisk');
        const url = tab.url;

        if (url.startsWith(WATCH_BASE) || url.startsWith(FALLBACK_WATCH_BASE)) {
            openButton.style.display = 'flex';
            try {
                const [result] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => document.title
                });
                const type = url.includes('/series/') ? 'сериал' : 'фильм';
                showMessage(`Текущий ${type}: "${result.result || 'Неизвестно'}"`, 'success');
            } catch {
                showMessage('Можно открыть на Кинопоиске', 'info');
            }
            return;
        }

        if (url.startsWith(KINOPOISK_BASE) && (url.includes('/film/') || url.includes('/series/'))) {
            openButton.style.display = 'none';
            try {
                const [result] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => document.title
                });
                const type = url.includes('/series/') ? 'сериал' : 'фильм';
                showMessage(`Текущий ${type}: "${result.result || 'Неизвестно'}"`, 'success');
            } catch {
                showMessage('Страница Кинопоиска', 'info');
            }
            return;
        }

        openButton.style.display = 'none';
        showMessage("Выберите фильтры и нажмите 'Случайный'", 'info');
    } catch {
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

// Кнопка перехода с Кинопоиска на сайт просмотра
 document.getElementById('convert').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    const url = tab.url;
    const isKinopoisk = url.startsWith(`${KINOPOISK_BASE}/film/`) || url.startsWith(`${KINOPOISK_BASE}/series/`);
    const isWatch = url.startsWith(`${WATCH_BASE}/film/`) || url.startsWith(`${WATCH_BASE}/series/`) ||
        url.startsWith(`${FALLBACK_WATCH_BASE}/film/`) || url.startsWith(`${FALLBACK_WATCH_BASE}/series/`);

    if (isKinopoisk) {
        const newUrl = url.replace(KINOPOISK_BASE, WATCH_BASE);
        addToHistory(tab.title || 'Неизвестно', newUrl);
        showMessage('Перенаправляем...', 'info');
        chrome.tabs.update(tab.id, { url: newUrl });
        return;
    }

    if (isWatch) {
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => document.title
            });
            const title = result.result || 'Неизвестно';
            addToHistory(title, url);
            showMessage(`Открыт: "${title}"`, 'success');
        } catch {
            showMessage('Уже открыт', 'success');
        }
        return;
    }

    showMessage('Откройте страницу фильма на Кинопоиске', 'error');
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
                chrome.tabs.create({ url: movie.vipUrl });
                showMessage(`Найден: "${movie.title}"`, 'success');
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

document.getElementById('openOnKinopoisk').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
        showMessage('Ошибка вкладки', 'error');
        return;
    }

    const match = tab.url.match(/\/(film|series)\/(\d+)\//);
    if (!match) {
        showMessage('Не страница фильма', 'error');
        return;
    }

    chrome.tabs.create({ url: `${KINOPOISK_BASE}/${match[1]}/${match[2]}/` });
    showMessage('Открываем на КП...', 'success');
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

    showCurrentMovie();
});
