// Поиск по названию. Работает с существующими правами на kinopoisk.ru.
(() => {
    'use strict';

    const SEARCH_URL = 'https://www.kinopoisk.ru/index.php?kp_query=';
    const WATCH_ORIGIN = 'https://www.kinokino.vip';
    const SEARCH_DELAY = 450;
    const MIN_QUERY_LENGTH = 2;
    const MAX_RESULTS = 10;
    const CACHE_LIFETIME = 2 * 60 * 1000;
    const cache = new Map();

    const form = document.getElementById('titleSearchForm');
    const input = document.getElementById('titleSearchInput');
    const clearButton = document.getElementById('titleSearchClear');
    const resultsBox = document.getElementById('titleSearchResults');
    const status = document.getElementById('titleSearchStatus');
    const itemsBox = document.getElementById('titleSearchItems');
    const openSearchButton = document.getElementById('titleSearchOnKinopoisk');

    if (!form || !input || !clearButton || !resultsBox ||
        !status || !itemsBox || !openSearchButton) return;

    let timer = null;
    let controller = null;
    let requestNumber = 0;

    function searchPageUrl(query) {
        return SEARCH_URL + encodeURIComponent(query);
    }

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function getMediaUrl(href, baseUrl) {
        try {
            const url = new URL(href, baseUrl);
            if (url.hostname !== 'www.kinopoisk.ru' &&
                url.hostname !== 'kinopoisk.ru') return null;
            const match = url.pathname.match(/^\/(film|series)\/(\d+)(?:\/|$)/);
            if (!match) return null;
            return {
                type: match[1],
                id: match[2],
                kpUrl: 'https://www.kinopoisk.ru/' + match[1] + '/' + match[2] + '/',
                watchUrl: WATCH_ORIGIN + '/' + match[1] + '/' + match[2] + '/'
            };
        } catch {
            return null;
        }
    }

    function safePoster(raw, baseUrl) {
        if (!raw) return '';
        try {
            const url = new URL(raw, baseUrl);
            if (url.protocol !== 'https:') return '';
            const host = url.hostname.toLowerCase();
            // Только изображения Кинопоиска и Яндекса.
            const allowed = host === 'kinopoisk.ru' || host.endsWith('.kinopoisk.ru') ||
                host === 'yandex.net' || host.endsWith('.yandex.net') ||
                host === 'yandex.ru' || host.endsWith('.yandex.ru');
            return allowed ? url.href : '';
        } catch {
            return '';
        }
    }

    function extractPoster(card, baseUrl) {
        const img = card.querySelector('img');
        if (!img) return '';
        const raw = img.getAttribute('data-src') ||
            img.getAttribute('data-original') ||
            img.getAttribute('data-lazy-src') ||
            img.getAttribute('src') ||
            (img.getAttribute('srcset') || '').split(',')[0].trim().split(' ')[0];
        return safePoster(raw, baseUrl);
    }

    function extractRating(card) {
        const node = card.querySelector(
            '[data-test-id*="rating"], [class*="ratingValue"], ' +
            '[class*="ratingPositive"], [class*="ratingNeutral"], ' +
            '.rating, [class*="rating__value"]'
        );
        const text = cleanText(node?.textContent);
        const match = text.match(/^(\d{1,2}(?:[.,]\d{1,2})?)(?:\b|$)/);
        if (!match) return null;
        const rating = Number(match[1].replace(',', '.'));
        return rating > 0 && rating <= 10 ? rating : null;
    }

    function findCard(anchor) {
        return anchor.closest(
            '.element, [class*="searchResult"], [class*="search-result"], ' +
            '[class*="search_result"], [data-test-id*="search-result"], ' +
            'article, li, [class*="styles_root"]'
        ) || anchor.parentElement?.parentElement || anchor;
    }

    function extractTitle(anchor, card) {
        const anchorText = cleanText(anchor.textContent);
        const imageText = cleanText(anchor.querySelector('img')?.getAttribute('alt'));
        const heading = card.querySelector('h2, h3, [class*="name"] a, [class*="title"] a');
        const headingText = cleanText(heading?.textContent);
        const title = anchorText || headingText || imageText;
        return title.replace(/^Смотреть\s+/i, '').trim().slice(0, 160);
    }

    function parseSearchPage(html, pageUrl, query) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const root = doc.querySelector('.search_results, [data-test-id="search-results"], ' +
            '[class*="searchResults"], [class*="search-results"]') ||
            doc.querySelector('main, #block_left, #content') || doc.body;
        const found = new Map();
        const anchors = root.querySelectorAll('a[href*="/film/"], a[href*="/series/"]');

        anchors.forEach(anchor => {
            const media = getMediaUrl(anchor.getAttribute('href'), pageUrl);
            if (!media || found.has(media.type + ':' + media.id)) return;

            const card = findCard(anchor);
            const title = extractTitle(anchor, card);
            if (!title || title.length < 2 || /^смотреть$/i.test(title)) return;
            const description = cleanText(card.textContent).slice(0, 600);
            const yearMatch = description.match(/(?:18|19|20)\d{2}/);
            const poster = extractPoster(card, pageUrl);
            const rating = extractRating(card);

            found.set(media.type + ':' + media.id, {
                ...media,
                title,
                year: yearMatch ? Number(yearMatch[0]) : null,
                rating,
                poster
            });
        });

        // Некоторые точные запросы сразу перенаправляют на страницу фильма.
        if (!found.size) {
            const media = getMediaUrl(pageUrl, pageUrl);
            if (media) {
                const title = cleanText(doc.querySelector('h1')?.textContent) || query;
                const yearMatch = cleanText(doc.title).match(/(?:18|19|20)\d{2}/);
                found.set(media.type + ':' + media.id, {
                    ...media,
                    title,
                    year: yearMatch ? Number(yearMatch[0]) : null,
                    rating: null,
                    poster: safePoster(doc.querySelector('meta[property="og:image"]')?.content, pageUrl)
                });
            }
        }

        return [...found.values()].slice(0, MAX_RESULTS);
    }

    function setStatus(text, isError = false) {
        status.textContent = text;
        status.classList.toggle('error', isError);
        status.hidden = !text;
    }

    function hideResults() {
        resultsBox.hidden = true;
        status.hidden = true;
        itemsBox.replaceChildren();
    }

    function cancelRequest() {
        clearTimeout(timer);
        if (controller) controller.abort();
        controller = null;
        requestNumber += 1;
    }

    async function openFilm(movie, watch) {
        try {
            if (watch) {
                // Не записываем фильм в историю до выбора «Смотреть».
                if (typeof window.addToHistory === 'function') {
                    window.addToHistory(movie.title, movie.watchUrl);
                }
                if (typeof window.openTrackedWatchTab === 'function') {
                    await window.openTrackedWatchTab(movie.watchUrl, movie.kpUrl, movie.title);
                } else {
                    await chrome.tabs.create({ url: movie.watchUrl });
                }
            } else {
                await chrome.tabs.create({ url: movie.kpUrl });
            }
        } catch (error) {
            setStatus('Не удалось открыть фильм: ' + error.message, true);
        }
    }

    function makeAction(text, className, movie, watch) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'title-search-action ' + className;
        button.textContent = text;
        button.addEventListener('click', () => void openFilm(movie, watch));
        return button;
    }

    function renderItem(movie) {
        const item = document.createElement('div');
        item.className = 'title-search-item';

        const poster = document.createElement('div');
        poster.className = 'title-search-poster';
        if (movie.poster) {
            const image = document.createElement('img');
            image.src = movie.poster;
            image.loading = 'lazy';
            image.referrerPolicy = 'no-referrer';
            image.alt = '';
            image.addEventListener('error', () => image.remove(), { once: true });
            poster.appendChild(image);
        }
        const details = document.createElement('div');
        details.className = 'title-search-details';
        const title = document.createElement('div');
        title.className = 'title-search-title';
        title.textContent = movie.title;
        title.title = movie.title;

        const meta = document.createElement('div');
        meta.className = 'title-search-meta';
        const typeName = movie.type === 'series' ? 'Сериал' : 'Фильм';
        meta.textContent = typeName + (movie.year ? ' · ' + movie.year : '');
        if (movie.rating != null) {
            const rating = document.createElement('span');
            rating.className = 'title-search-rating';
            rating.textContent = '★ ' + movie.rating.toFixed(1);
            meta.append(' · ', rating);
        }
        if (typeof window.historyContains === 'function' &&
            window.historyContains(movie.watchUrl)) {
            const watched = document.createElement('div');
            watched.className = 'title-search-watched';
            watched.textContent = 'Уже в истории';
            details.append(title, meta, watched);
        } else {
            details.append(title, meta);
        }

        const actions = document.createElement('div');
        actions.className = 'title-search-actions';
        actions.append(
            makeAction('▶ Смотреть', 'watch', movie, true),
            makeAction('Кинопоиск', 'kinopoisk', movie, false)
        );
        details.appendChild(actions);
        item.append(poster, details);
        return item;
    }

    function renderResults(movies) {
        itemsBox.replaceChildren(...movies.map(renderItem));
        setStatus(movies.length ? 'Найдено: ' + movies.length : 'Совпадений не найдено');
    }

    async function runSearch(query) {
        const currentRequest = ++requestNumber;
        resultsBox.hidden = false;
        itemsBox.replaceChildren();
        setStatus('Ищем фильмы и сериалы…');
        openSearchButton.href = searchPageUrl(query);
        const cached = cache.get(query.toLocaleLowerCase());
        if (cached && Date.now() - cached.savedAt < CACHE_LIFETIME) {
            renderResults(cached.items);
            return;
        }
        const abort = new AbortController();
        controller = abort;
        try {
            const response = await fetch(searchPageUrl(query), {
                credentials: 'include',
                signal: abort.signal
            });
            if (!response.ok) throw new Error('Кинопоиск вернул HTTP ' + response.status);
            const html = await response.text();
            if (currentRequest !== requestNumber) return;
            const movies = parseSearchPage(html, response.url, query);
            if (!movies.length && !/search_results|searchResults|search-results|Ничего не найдено|не найдено/i.test(html)) {
                throw new Error('Не удалось прочитать результаты на странице Кинопоиска');
            }
            cache.set(query.toLocaleLowerCase(), { items: movies, savedAt: Date.now() });
            if (cache.size > 20) cache.delete(cache.keys().next().value);
            renderResults(movies);
        } catch (error) {
            if (currentRequest !== requestNumber || error.name === 'AbortError') return;
            itemsBox.replaceChildren();
            setStatus('Поиск недоступен: ' + error.message, true);
        } finally {
            if (currentRequest === requestNumber) controller = null;
        }
    }

    function handleInput() {
        cancelRequest();
        const query = input.value.trim();
        clearButton.hidden = !query;
        if (query.length < MIN_QUERY_LENGTH) {
            hideResults();
            return;
        }
        resultsBox.hidden = false;
        itemsBox.replaceChildren();
        openSearchButton.href = searchPageUrl(query);
        setStatus('Введите название…');
        timer = setTimeout(() => void runSearch(query), SEARCH_DELAY);
    }

    form.addEventListener('submit', event => {
        event.preventDefault();
        cancelRequest();
        const query = input.value.trim();
        if (query.length < MIN_QUERY_LENGTH) {
            hideResults();
            return;
        }
        void runSearch(query);
    });
    input.addEventListener('input', handleInput);
    clearButton.addEventListener('click', () => {
        input.value = '';
        handleInput();
        input.focus();
    });
})();
