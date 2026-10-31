// Поиск по названию. Работает с существующими правами на kinopoisk.ru.
(() => {
    'use strict';

    const SEARCH_URL = 'https://www.kinopoisk.ru/index.php?kp_query=';
    const WATCH_ORIGIN = 'https://www.kinokino.vip';
    const SEARCH_DELAY = 350;
    const MIN_QUERY_LENGTH = 2;
    const MAX_RESULTS = 30;
    const QUICK_RESULT_TARGET = 10;
    const SEARCH_CONCURRENCY = 5;
    const POSTER_CONCURRENCY = 2;
    const CACHE_LIFETIME = 10 * 60 * 1000;
    const STORAGE_CACHE_KEY = 'kinoHelperSearchCacheV2';
    const STORAGE_CACHE_LIMIT = 12;
    const cache = new Map();

    // Кэш результатов на время сеанса Chrome: при повторном открытии
    // расширения не нужно заново выполнять все запросы продолжений.
    // Сохраняем только метаданные фильмов, без картинок и DOM.
    async function getSessionResults(key) {
        try {
            const stored = (await chrome.storage.session.get(STORAGE_CACHE_KEY))
                ?.[STORAGE_CACHE_KEY] || {};
            const entry = stored[key];
            if (!entry || !Array.isArray(entry.items) ||
                Date.now() - entry.savedAt >= CACHE_LIFETIME) return null;
            return entry.items.map(item => ({ ...item }));
        } catch {
            return null;
        }
    }

    async function saveSessionResults(key, movies) {
        try {
            const stored = (await chrome.storage.session.get(STORAGE_CACHE_KEY))
                ?.[STORAGE_CACHE_KEY] || {};
            const entry = {
                savedAt: Date.now(),
                items: movies.map(movie => ({
                    id: movie.id, type: movie.type,
                    kpUrl: movie.kpUrl, watchUrl: movie.watchUrl,
                    title: movie.title, year: movie.year, rating: movie.rating,
                    genres: movie.genres || [],
                    poster: movie.poster || '', posterFallback: movie.posterFallback || ''
                }))
            };
            const entries = Object.entries({ ...stored, [key]: entry })
                .filter(([, item]) => item?.savedAt &&
                    Date.now() - item.savedAt < CACHE_LIFETIME)
                .sort((a, b) => b[1].savedAt - a[1].savedAt)
                .slice(0, STORAGE_CACHE_LIMIT);
            await chrome.storage.session.set({
                [STORAGE_CACHE_KEY]: Object.fromEntries(entries)
            });
        } catch {
            // Отсутствие доступа к кэшу не препятствует поиску.
        }
    }

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
                host === 'yandex.ru' || host.endsWith('.yandex.ru') ||
                host === 'st.kp.yandex.net';
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
                /^\/get-kinopoisk-image\/[^/]+\/[^/]+/.test(pathname);
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
        // Старый статический каталог Кинопоиска как резервный источник.
        // Реальные ссылки проверяются загрузкой; не заявляем их рабочими заранее.
        if (/^\d+$/.test(String(movie.id || ''))) {
            add('https://st.kp.yandex.net/images/film_iphone/iphone360_' + movie.id + '.jpg');
            add('https://st.kp.yandex.net/images/film_big/' + movie.id + '.jpg');
        }

        // Адреса, которые не показал <img>, всё равно передаются фоновому
        // загрузчику. Не вычёркиваем их глобально после первой ошибки.
        return urls;
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

    function updateMovieCard(movie) {
        const title = movie._titleNode;
        const meta = movie._metaNode;
        if (!title || !meta) return;
        title.textContent = movie.title;
        title.title = movie.title;
        const typeName = movie.type === 'series' ? 'Сериал' : 'Фильм';
        meta.textContent = typeName + (movie.year ? ' · ' + movie.year : '');
        if (movie.rating != null) {
            const rating = document.createElement('span');
            rating.className = 'title-search-rating';
            rating.textContent = '★ ' + Number(movie.rating).toFixed(1);
            meta.append(' · ', rating);
        }
        if (movie._genresNode) {
            const genres = Array.isArray(movie.genres) ? movie.genres : [];
            movie._genresNode.textContent = genres.length ? 'Жанр: ' + genres.join(', ') : '';
            movie._genresNode.hidden = !genres.length;
        }
    }

    function renderItem(movie) {
        const item = document.createElement('div');
        item.className = 'title-search-item';
        movie._cardNode = item;

        const poster = document.createElement('div');
        poster.className = 'title-search-poster';
        const details = document.createElement('div');
        details.className = 'title-search-details';
        const title = document.createElement('div');
        title.className = 'title-search-title';
        const meta = document.createElement('div');
        meta.className = 'title-search-meta';
        const genres = document.createElement('div');
        genres.className = 'title-search-genres';
        genres.hidden = true;
        const actions = document.createElement('div');
        actions.className = 'title-search-actions';
        actions.append(
            makeAction('▶ Смотреть', 'watch', movie, true),
            makeAction('Кинопоиск', 'kinopoisk', movie, false)
        );
        details.append(title, meta, genres);
        if (typeof window.historyContains === 'function' &&
            window.historyContains(movie.watchUrl)) {
            const watched = document.createElement('div');
            watched.className = 'title-search-watched';
            watched.textContent = 'Уже в истории';
            details.appendChild(watched);
        }
        details.appendChild(actions);
        item.append(poster, details);
        movie._posterNode = poster;
        movie._titleNode = title;
        movie._metaNode = meta;
        movie._genresNode = genres;
        updateMovieCard(movie);
        if (movie.posterDataUrl) {
            const image = document.createElement('img');
            image.alt = '';
            image.src = movie.posterDataUrl;
            poster.appendChild(image);
        }
        return item;
    }

    function renderResults(movies, searching = false) {
        // Повторно используем DOM карточек, чтобы не сбрасывать постеры
        // во время появления новых результатов из параллельного поиска.
        const nodes = movies.map(movie => {
            if (movie._cardNode) {
                updateMovieCard(movie);
                return movie._cardNode;
            }
            return renderItem(movie);
        });
        const orderChanged = nodes.length !== itemsBox.children.length ||
            nodes.some((node, index) => itemsBox.children[index] !== node);
        if (orderChanged) itemsBox.replaceChildren(...nodes);
        setStatus(movies.length
            ? 'Найдено: ' + movies.length + (searching ? ' · ищем ещё…' : '')
            : (searching ? 'Ищем фильмы и сериалы…' : 'Совпадений не найдено'));
    }


    // Жанры загружаем лишь для видимых карточек и рядом с ними.
    // Не вмешиваемся в быстрый поиск и очередь загрузки постеров.
    const GENRE_CONCURRENCY = 2;
    const genreQueue = [];
    let activeGenreJobs = 0;
    const genreObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            genreObserver.unobserve(entry.target);
            const movie = entry.target._kinoMovie;
            if (!movie || movie._genreQueued || movie._genreLoaded ||
                (movie._genreAttempts || 0) > 0) continue;
            const searchId = movie._genreSearchId;
            movie._genreQueued = true;
            genreQueue.push({ movie, searchId });
        }
        pumpGenreQueue();
    }, { root: resultsBox, rootMargin: '180px 0px' });

    function pumpGenreQueue() {
        while (activeGenreJobs < GENRE_CONCURRENCY && genreQueue.length) {
            const { movie, searchId } = genreQueue.shift();
            movie._genreQueued = false;
            if (searchId !== requestNumber || !movie._cardNode?.isConnected) continue;
            movie._genreAttempts = (movie._genreAttempts || 0) + 1;
            activeGenreJobs++;
            Promise.resolve().then(() => window.KinoMovieDetails.get({
                id: movie.id, type: movie.type
            })).then(details => {
                if (searchId !== requestNumber || !movie._cardNode?.isConnected) return;
                movie.genres = details.genres || [];
                movie._genreLoaded = true;
                updateMovieCard(movie);
            }).catch(error => {
                console.warn('[KinoHelper search] Не удалось получить жанр:', movie.id, error);
            }).finally(() => {
                activeGenreJobs--;
                pumpGenreQueue();
            });
        }
    }

    function observeResultGenres(movies, searchId) {
        if (searchId !== requestNumber) return;
        for (const movie of movies) {
            if (movie._genreLoaded || (movie._genreAttempts || 0) > 0 ||
                !movie._cardNode?.isConnected) continue;
            movie._cardNode._kinoMovie = movie;
            movie._genreSearchId = searchId;
            genreObserver.observe(movie._cardNode);
        }
    }

    // Лимит одновременно загружаемых постеров; не перегружаем сервис.
    let posterJobsActive = 0;
    const posterJobQueue = [];
    function queuePoster(task) {
        return new Promise(resolve => {
            posterJobQueue.push({ task, resolve });
            pumpPosterQueue();
        });
    }
    function pumpPosterQueue() {
        while (posterJobsActive < POSTER_CONCURRENCY && posterJobQueue.length) {
            const job = posterJobQueue.shift();
            posterJobsActive++;
            Promise.resolve().then(job.task)
                .catch(() => {})
                .finally(() => {
                    posterJobsActive--;
                    job.resolve();
                    pumpPosterQueue();
                });
        }
    }

    async function loadPoster(movie, searchId) {
        if (movie._posterLoading || movie.posterDataUrl) return;
        movie._posterLoading = true;
        const errors = [];
        const current = () =>
            searchId === requestNumber && movie._posterNode?.isConnected !== false;
        try {
            // Запрашиваем действительный URL страницы фильма, если
            // поисковая выдача и метаданные его не содержали.
            if (!movie.poster && !movie.posterFallback) {
                try {
                    const response = await chrome.runtime.sendMessage({
                        action: 'findPosterOnMoviePage',
                        payload: { id: movie.id, type: movie.type }
                    });
                    if (!current()) return;
                    if (response?.ok && response.poster) {
                        movie.poster = safePoster(response.poster, movie.kpUrl);
                    } else {
                        errors.push(response?.error || 'нет постера в HTML');
                    }
                } catch (error) {
                    errors.push(error.message);
                }
            }
            const sources = getPosterSources(movie);
            for (const url of sources.slice(0, 6)) {
                if (!current()) return;
                try {
                    const response = await chrome.runtime.sendMessage({
                        action: 'loadSearchPoster',
                        payload: { url }
                    });
                    if (!current()) return;
                    if (!response?.ok || !response.dataUrl) {
                        errors.push(response?.error || 'изображение не получено');
                        continue;
                    }
                    movie.posterDataUrl = response.dataUrl;
                    const image = document.createElement('img');
                    image.alt = '';
                    image.loading = 'lazy';
                    image.src = response.dataUrl;
                    movie._posterNode.replaceChildren(image);
                    diagnostics.poster = 'загружено для «' + movie.title + '»';
                    updateDiagnostics();
                    return;
                } catch (error) {
                    errors.push(error.message);
                }
            }
            if (current()) {
                diagnostics.poster = movie.title + ': ' +
                    [...new Set(errors)].slice(0, 3).join('; ');
                console.warn('[KinoHelper search] Постер не загружен:',
                    movie.id, diagnostics.poster);
                updateDiagnostics();
            }
        } finally {
            movie._posterLoading = false;
        }
    }

    function startPosterDownloads(movies, searchId) {
        movies.forEach(movie => {
            if (movie.posterDataUrl || movie._posterLoading ||
                movie._posterQueued || (movie._posterAttempts || 0) >= 2) return;
            movie._posterQueued = true;
            void queuePoster(async () => {
                movie._posterQueued = false;
                if (searchId !== requestNumber ||
                    movie._posterNode?.isConnected === false) return;
                movie._posterAttempts = (movie._posterAttempts || 0) + 1;
                await loadPoster(movie, searchId);
            });
        });
    }

    // После обновления данных меняем существующие DOM-узлы, не перерисовывая
    // список: иначе картинки теряют родителя во время асинхронной загрузки.
    async function enrichResults(movies, searchId) {
        // Картинки начинаем получать сразу, не дожидаясь очереди GraphQL
        // для заголовков и рейтингов остальных фильмов.
        startPosterDownloads(movies, searchId);
        const toEnrich = movies.filter(movie =>
            !movie._metadataLoaded && !movie._metadataQueued &&
            (movie._metadataAttempts || 0) < 1).slice(0, 8);
        toEnrich.forEach(movie => {
            movie._metadataQueued = true;
            movie._metadataAttempts = (movie._metadataAttempts || 0) + 1;
        });
        await Promise.allSettled(toEnrich.map(async movie => {
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'getSearchMovieMetadata',
                    payload: { id: movie.id, type: movie.type }
                });
                if (searchId !== requestNumber) return;
                if (!response?.ok || !response.metadata) {
                    if (!response?.ok) {
                        diagnostics.api = 'данные карточек: ' +
                            (response?.error || 'запрос не удался');
                        console.warn('[KinoHelper search] Метаданные недоступны:',
                            movie.id, diagnostics.api);
                        updateDiagnostics();
                    }
                    return;
                }
                const meta = response.metadata;
                movie._metadataLoaded = true;
                if (meta.title) movie.title = cleanText(meta.title);
                if (meta.year) movie.year = meta.year;
                if (meta.rating != null) movie.rating = meta.rating;
                if (safePoster(meta.poster, movie.kpUrl)) {
                    movie.poster = safePoster(meta.poster, movie.kpUrl);
                }
                if (safePoster(meta.posterFallback, movie.kpUrl)) {
                    movie.posterFallback = safePoster(meta.posterFallback, movie.kpUrl);
                }
                updateMovieCard(movie);
            } catch (error) {
                if (searchId === requestNumber) {
                    diagnostics.api = 'данные карточек: ' + error.message;
                    updateDiagnostics();
                }
            } finally {
                movie._metadataQueued = false;
            }
        }));
        observeResultGenres(movies, searchId);
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

        const sessionResults = await getSessionResults(cacheKey);
        if (currentRequest !== requestNumber) return;
        if (sessionResults?.length) {
            cache.set(cacheKey, { items: sessionResults, savedAt: Date.now() });
            renderResults(sessionResults);
            void enrichResults(sessionResults, currentRequest);
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
            let changed = false;
            for (const movie of items) {
                if (!movie || !movie.id || !['film', 'series'].includes(movie.type)) continue;
                const key = movie.type + ':' + movie.id;
                const prev = results.get(key);
                if (!prev) {
                    results.set(key, { ...movie });
                    changed = true;
                } else {
                    // Сохраняем ссылку на объект и DOM существующей карточки.
                    // Кнопки просмотра, постер и загрузка по ID остаются прежними.
                    const isValidTitle = movie.title &&
                        !/^(?:фильм|сериал) №/i.test(movie.title);
                    if (isValidTitle && (!prev.title ||
                        /^(?:фильм|сериал) №/i.test(prev.title))) {
                        prev.title = movie.title;
                    }
                    prev.year ||= movie.year;
                    prev.rating ??= movie.rating;
                    prev.genres ||= movie.genres;
                    prev.poster ||= movie.poster;
                    prev.posterFallback ||= movie.posterFallback;
                    changed = true;
                }
            }
            if (items.length) sources.add(source);
            if (!changed) return;
            diagnostics.source = [...sources].join(' + ') || 'нет результатов';
            updateDiagnostics();
            const sorted = [...results.values()]
                .sort((a, b) => rank(b) - rank(a) ||
                    (b.rating || 0) - (a.rating || 0))
                .slice(0, MAX_RESULTS);
            renderResults(sorted, true);
            // Не кэшируем промежуточную выдачу: если пользователь изменил
            // запрос во время поиска продолжений, нельзя сохранять неполный список.
            // Показываем результаты и запускаем постеры сразу после каждой
            // новой порции, не дожидаясь всех запросов продолжений.
            startPosterDownloads(sorted, currentRequest);
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

        // GraphQL SuggestSearch сейчас отвечает HTTP 400 в браузере.
        // Не отправляем заведомо неуспешные запросы во время ввода текста.
        diagnostics.api = 'подсказки отключены (HTTP 400); данные карточек по ID';
        updateDiagnostics();

        // Основной запрос и продолжения запускаются сразу, а не
        // последовательно. Ответ каждого запроса немедленно пополняет выдачу.
        // При 10 релевантных результатах оставшуюся работу прекращаем.
        const canExpand = query.length >= 4 && !/\d\s*$/.test(query);
        const variants = [query];
        if (canExpand) {
            // Сначала разные номерные части — они обычно дают больше
            // уникальных ID, чем альтернативные названия тех же фильмов.
            for (let n = 2; n <= 10; n++) variants.push(query + ' ' + n);
            if (query.trim().split(/\s+/).length === 1) {
                variants.push('Двойной ' + query, 'Тройной ' + query);
            }
        }
        let cursor = 0;
        let primaryFinished = false;
        const relevantCount = () => [...results.values()]
            .filter(movie => normalize(movie.title).includes(needle)).length;
        const targetReached = () =>
            primaryFinished && relevantCount() >= QUICK_RESULT_TARGET;

        const workers = Array.from(
            { length: Math.min(SEARCH_CONCURRENCY, variants.length) },
            async () => {
                while (cursor < variants.length &&
                    currentRequest === requestNumber &&
                    !abort.signal.aborted && !targetReached()) {
                    const variant = variants[cursor++];
                    const isPrimary = variant === query;
                    const entries = await htmlLookup(variant);
                    if (currentRequest !== requestNumber) return;
                    const accepted = isPrimary
                        ? entries
                        : entries.filter(movie =>
                            normalize(movie.title).includes(needle)
                        );
                    merge(accepted, isPrimary ? 'HTML' : 'HTML-продолжения');
                    if (isPrimary) primaryFinished = true;

                    // Уже показали достаточно фильмов, включая основной поиск.
                    // Прерываем оставшиеся поисковые HTTP-запросы.
                    // Загрузка постеров идёт отдельными сообщениями и не
                    // зависит от AbortController поисковой выдачи.
                    if (targetReached() && !abort.signal.aborted) {
                        abort.abort();
                        break;
                    }
                }
            }
        );
        const htmlTask = Promise.allSettled(workers);

        await htmlTask;
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
            // Карточки уже показаны по мере поступления результатов.
            cache.set(cacheKey, { items: movies, savedAt: Date.now() });
            if (cache.size > 20) cache.delete(cache.keys().next().value);
            renderResults(movies);
            void enrichResults(movies, currentRequest);
            void saveSessionResults(cacheKey, movies);
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
