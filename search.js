// Поиск по названию. Работает с существующими правами на kinopoisk.ru.
(() => {
    'use strict';

    const SEARCH_URL = 'https://www.kinopoisk.ru/index.php?kp_query=';
    const WATCH_ORIGIN = 'https://www.kinokino.vip';
    const SEARCH_DELAY = 450;
    const MIN_QUERY_LENGTH = 2;
    const MAX_RESULTS = 30;
    const CACHE_LIFETIME = 2 * 60 * 1000;
    const cache = new Map();

    const form = document.getElementById('titleSearchForm');
    const input = document.getElementById('titleSearchInput');
    const clearButton = document.getElementById('titleSearchClear');
    const resultsBox = document.getElementById('titleSearchResults');
    const status = document.getElementById('titleSearchStatus');
    const itemsBox = document.getElementById('titleSearchItems');
    const openSearchButton = document.getElementById('titleSearchOnKinopoisk');
    const diagnosticBox = document.getElementById('titleSearchDiagnosticText');
    const diagnostics = { source: '', api: '', poster: '' };
    function updateDiagnostics() {
        if (!diagnosticBox) return;
        diagnosticBox.textContent = [
            diagnostics.source && 'Источник: ' + diagnostics.source,
            diagnostics.api && 'GraphQL: ' + diagnostics.api,
            diagnostics.poster && 'Постер: ' + diagnostics.poster
        ].filter(Boolean).join('\n') || 'Нет данных';
    }


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

    // У Яндекс.Аватаров GraphQL иногда возвращает URL без суффикса размера.
    // Для <img> нужен /280x420 (либо /orig). Проверяем несколько вариантов.
    const failedPosters = new Set();
    function getPosterSources(movie) {
        const urls = [];
        const add = raw => {
            const normalized = safePoster(raw, movie.kpUrl);
            if (!normalized) return;
            const url = new URL(normalized);
            const pathname = url.pathname.replace(/\/+$/, '');
            const isAvatar = url.hostname === 'avatars.mds.yandex.net' &&
                /^\/get-[^/]+\/[^/]+\/[^/]+/.test(pathname);
            if (isAvatar) {
                const isSized = /\/(?:orig|\d+x\d+)$/i.test(pathname);
                const base = isSized ? pathname.replace(/\/(?:orig|\d+x\d+)$/i, '') : pathname;
                // Маленькие изображения лучше для компактного popup.
                for (const size of ['280x420', '300x450', 'orig']) {
                    const candidate = url.origin + base + '/' + size;
                    if (!urls.includes(candidate)) urls.push(candidate);
                }
            } else if (!urls.includes(url.href)) {
                urls.push(url.href);
            }
        };
        add(movie.poster);
        add(movie.posterFallback);
        return urls.filter(url => !failedPosters.has(url));
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

    function extractTitle(anchor, card, query) {
        const ignored = /^(?:актеры|актёры|актерский состав|в ролях|режиссеры|режиссёры|фото|трейлер|трейлеры|кадры|отзывы|рецензии|постеры|смотреть|подробнее|о фильме|о сериале)$/i;
        const headings = [
            card.querySelector('h2 a[href], h3 a[href], h2, h3'),
            card.querySelector('[class*="name"] a[href], [class*="title"] a[href]'),
            card.querySelector('[data-test-id*="title"]')
        ];
        const candidates = [
            ...headings.map(node => cleanText(node?.textContent)),
            cleanText(anchor.querySelector('img')?.getAttribute('alt')),
            cleanText(anchor.textContent)
        ];

        const normalizedQuery = cleanText(query).toLocaleLowerCase();
        let best = '';
        let bestScore = -1;
        for (const candidate of candidates) {
            const title = candidate.replace(/^Смотреть\s+/i, '').trim().slice(0, 160);
            if (!title || title.length < 2 || ignored.test(title) || /^https?:\/\//i.test(title)) continue;
            const normalized = title.toLocaleLowerCase();
            const score = (normalized === normalizedQuery ? 15 : 0) +
                (normalized.includes(normalizedQuery) ? 5 : 0) -
                (title.length > 75 ? 3 : 0);
            if (score > bestScore) {
                best = title;
                bestScore = score;
            }
        }
        return { title: best, score: bestScore };
    }

    function parseSearchPage(html, pageUrl, query) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const root = doc.querySelector('.search_results, [data-test-id="search-results"], ' +
            '[class*="searchResults"], [class*="search-results"]') ||
            doc.querySelector('main, #block_left, #content') || doc.body;
        const found = new Map();
        const anchors = root.querySelectorAll('a[href*="/film/"], a[href*="/series/"]');

        anchors.forEach(anchor => {
            const href = anchor.getAttribute('href');
            const media = getMediaUrl(href, pageUrl);
            if (!media) return;

            const card = findCard(anchor);
            const { title, score } = extractTitle(anchor, card, query);
            const description = cleanText(card.textContent).slice(0, 600);
            const yearMatch = description.match(/(?:18|19|20)\d{2}/);
            const poster = extractPoster(card, pageUrl);
            const rating = extractRating(card);

            // Приоритет — ссылка на сам фильм, а не /cast/, /reviews/ и т.п.
            const path = new URL(href, pageUrl).pathname.replace(/\/+$/, '');
            const isCanonical = path === '/' + media.type + '/' + media.id;
            const rank = (isCanonical ? 10 : 0) + score + (poster ? 2 : 0);
            const key = media.type + ':' + media.id;
            const previous = found.get(key);
            const fallbackTitle = (media.type === 'series' ? 'Сериал №' : 'Фильм №') + media.id;

            if (previous && previous._rank >= rank) return;

            found.set(key, {
                ...media,
                title: title || previous?.title || fallbackTitle,
                year: yearMatch ? Number(yearMatch[0]) : (previous?.year || null),
                rating: rating ?? previous?.rating ?? null,
                poster: poster || previous?.poster || '',
                _rank: rank
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
        const sources = getPosterSources(movie);
        if (movie.posterDataUrl || sources.length) {
            const image = document.createElement('img');
            image.loading = 'eager';
            image.referrerPolicy = 'no-referrer';
            image.alt = '';
            let index = 0;
            async function tryProxy() {
                for (const src of sources.slice(0, 3)) {
                    try {
                        const response = await chrome.runtime.sendMessage({
                            action: 'loadSearchPoster',
                            payload: { url: src }
                        });
                        if (response?.ok && response.dataUrl) {
                            movie.posterDataUrl = response.dataUrl;
                            image.src = movie.posterDataUrl;
                            diagnostics.poster = 'загружен через фоновый процесс';
                            updateDiagnostics();
                            return;
                        }
                        diagnostics.poster = response?.error || 'не удалось загрузить изображение';
                    } catch (error) {
                        diagnostics.poster = error.message;
                    }
                }
                diagnostics.poster = diagnostics.poster || 'адрес изображения не отвечает';
                updateDiagnostics();
                image.remove();
            }
            image.addEventListener('error', () => {
                if (movie.posterDataUrl) {
                    diagnostics.poster = 'не удалось отобразить встроенное изображение';
                    updateDiagnostics();
                    image.remove();
                    return;
                }
                if (index < sources.length) failedPosters.add(sources[index]);
                index++;
                if (index < sources.length) {
                    image.src = sources[index];
                } else {
                    void tryProxy();
                }
            });
            image.src = movie.posterDataUrl || sources[0];
            poster.appendChild(image);
        } else {
            diagnostics.poster = 'Кинопоиск не вернул URL постера для ID ' + movie.id;
            updateDiagnostics();
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

    // Для каждого найденного ID уточняем данные непосредственно у Кинопоиска.
    // Результаты остаются видны, пока карточки постепенно обновляются.
    async function enrichResults(movies, searchId) {
        await Promise.allSettled(movies.filter(movie => !movie._metadataLoaded).slice(0, 8).map(async movie => {
            if (movie._metadataLoaded) return;
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'getSearchMovieMetadata',
                    payload: { id: movie.id, type: movie.type }
                });
                // Не обновляем результаты старого запроса и не помечаем
                // карточку завершённой, если пользователь уже изменил поиск.
                if (searchId !== requestNumber || !response?.ok) return;
                const meta = response.metadata;
                if (!meta) return;
                movie._metadataLoaded = true;
                if (meta?.title) movie.title = cleanText(meta.title);
                if (meta?.year) movie.year = meta.year;
                if (meta?.rating != null) movie.rating = meta.rating;
                const officialPoster = safePoster(meta?.poster, movie.kpUrl);
                const fallback = safePoster(meta?.posterFallback, movie.kpUrl);
                if (officialPoster) movie.poster = officialPoster;
                movie.posterFallback = fallback && fallback !== officialPoster ? fallback : '';
                renderResults(movies);
                if (!getPosterSources(movie).length && searchId === requestNumber) {
                    try {
                        const pagePoster = await chrome.runtime.sendMessage({
                            action: 'findPosterOnMoviePage',
                            payload: { id: movie.id, type: movie.type }
                        });
                        if (pagePoster?.ok && pagePoster.poster && searchId === requestNumber) {
                            movie.poster = safePoster(pagePoster.poster, movie.kpUrl);
                            renderResults(movies);
                        } else if (searchId === requestNumber) {
                            diagnostics.poster = pagePoster?.error || 'Страница фильма не содержит og:image';
                            updateDiagnostics();
                        }
                    } catch (error) {
                        diagnostics.poster = error.message;
                        updateDiagnostics();
                    }
                }
            } catch (error) {
                if (searchId === requestNumber) {
                    diagnostics.poster = 'Ошибка получения данных фильма: ' + error.message;
                    updateDiagnostics();
                }
            }
        }));
    }

    async function runSearch(query) {
        const currentRequest = ++requestNumber;
        resultsBox.hidden = false;
        itemsBox.replaceChildren();
        setStatus('Ищем фильмы и сериалы…');
        diagnostics.source = '';
        diagnostics.api = '';
        diagnostics.poster = '';
        updateDiagnostics();
        openSearchButton.href = searchPageUrl(query);

        const cacheKey = query.toLocaleLowerCase('ru');
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.savedAt < CACHE_LIFETIME) {
            diagnostics.source = 'кэш';
            updateDiagnostics();
            renderResults(cached.items);
            void enrichResults(cached.items, currentRequest);
            return;
        }

        const abort = new AbortController();
        controller = abort;
        const results = new Map();
        const sources = new Set();
        const errors = [];
        const normalize = value => cleanText(value).toLocaleLowerCase('ru')
            .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const needle = normalize(query);

        function rank(movie) {
            const title = normalize(movie.title);
            if (title === needle) return 1000;
            if (title.startsWith(needle + ' ')) {
                const ending = title.slice(needle.length).trim();
                return /^\d{1,2}$/.test(ending) ? 900 - Number(ending) : 850;
            }
            if (title.startsWith(needle)) return 800;
            if (title.includes(needle)) return 600;
            const words = needle.split(' ').filter(word => word.length > 1);
            return words.length
                ? 400 * words.filter(word => title.includes(word)).length / words.length
                : 0;
        }

        function merge(items, source) {
            if (currentRequest !== requestNumber || !Array.isArray(items)) return;
            for (const movie of items) {
                if (!movie || !movie.id || !['film', 'series'].includes(movie.type)) continue;
                const key = movie.type + ':' + movie.id;
                const prev = results.get(key);
                if (!prev) {
                    results.set(key, { ...movie });
                } else {
                    results.set(key, {
                        ...prev,
                        ...(movie.title && !/^(?:фильм|сериал) №/i.test(movie.title) ?
                            { title: movie.title } : {}),
                        year: movie.year || prev.year,
                        rating: movie.rating ?? prev.rating,
                        poster: movie.poster || prev.poster,
                        posterFallback: movie.posterFallback || prev.posterFallback,
                        _metadataLoaded: Boolean(movie._metadataLoaded || prev._metadataLoaded),
                        posterDataUrl: prev.posterDataUrl
                    });
                }
            }
            if (items.length) sources.add(source);
            diagnostics.source = [...sources].join(' + ') || 'нет результатов';
            updateDiagnostics();
            const sorted = [...results.values()]
                .sort((a, b) => rank(b) - rank(a) ||
                    (b.rating || 0) - (a.rating || 0))
                .slice(0, MAX_RESULTS);
            renderResults(sorted);
            if (sorted.length) {
                cache.set(cacheKey, { items: sorted, savedAt: Date.now() });
                if (cache.size > 20) cache.delete(cache.keys().next().value);
            }
        }

        async function htmlLookup(text) {
            if (abort.signal.aborted || currentRequest !== requestNumber) return [];
            try {
                const response = await fetch(searchPageUrl(text), {
                    credentials: 'include',
                    signal: abort.signal
                });
                if (!response.ok) throw new Error('HTML: HTTP ' + response.status);
                const html = await response.text();
                return parseSearchPage(html, response.url, text);
            } catch (error) {
                if (error.name !== 'AbortError') errors.push(error.message);
                return [];
            }
        }

        const graphqlTask = (async () => {
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'searchMovieTitles',
                    payload: { query }
                });
                if (currentRequest !== requestNumber) return;
                if (!response?.ok) {
                    throw new Error(response?.error || 'сервис не ответил');
                }
                const movies = Array.isArray(response.movies) ? response.movies : [];
                diagnostics.api = 'получено ' + movies.length;
                updateDiagnostics();
                merge(movies.map(movie => ({
                    ...movie,
                    _metadataLoaded: Boolean(movie.title && movie.poster && movie.rating != null)
                })), 'GraphQL');
            } catch (error) {
                if (currentRequest !== requestNumber) return;
                diagnostics.api = 'ошибка: ' + error.message;
                updateDiagnostics();
                errors.push(error.message);
            }
        })();

        const htmlTask = (async () => {
            let movies = await htmlLookup(query);
            if (currentRequest !== requestNumber) return;
            // Не открываем служебную вкладку при вводе текста.
            // Пустой прямой HTML-ответ оставляем пустым.
            if (currentRequest !== requestNumber) return;
            merge(movies, 'HTML');

            // При малом числе совпадений проверяем реальные страницы поиска
            // продолжений, а не создаём вымышленные фильмы или ID.
            if (results.size < 6 && query.split(/\s+/).length >= 2 &&
                !/\d\s*$/.test(query)) {
                const variants = [2, 3, 4, 5, 6].map(i => query + ' ' + i);
                // Три одновременных запроса без постоянных фоновых вкладок.
                for (let i = 0; i < variants.length; i += 3) {
                    const batches = await Promise.all(
                        variants.slice(i, i + 3).map(htmlLookup)
                    );
                    if (currentRequest !== requestNumber) return;
                    for (const entries of batches) merge(entries, 'HTML-продолжения');
                    if (results.size >= 10) break;
                }
            }
        })();

        await Promise.allSettled([graphqlTask, htmlTask]);
        if (currentRequest !== requestNumber) return;
        const movies = [...results.values()]
            .sort((a, b) => rank(b) - rank(a) ||
                (b.rating || 0) - (a.rating || 0))
            .slice(0, MAX_RESULTS);

        if (!movies.length) {
            setStatus(errors.length
                ? 'Не удалось получить результаты: ' + errors[0]
                : 'Совпадений не найдено', Boolean(errors.length));
        } else {
            cache.set(cacheKey, { items: movies, savedAt: Date.now() });
            renderResults(movies);
            void enrichResults(movies, currentRequest);
        }
        if (currentRequest === requestNumber) controller = null;
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
