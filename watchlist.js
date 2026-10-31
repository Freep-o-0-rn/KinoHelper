// Локальный список «Буду смотреть». Независим от истории и оценок.
(() => {
    'use strict';

    const STORAGE_KEY = 'kinoHelperWatchlistV1';
    const COLLAPSED_KEY = 'kinoHelperWatchlistCollapsed';
    const MAX_ITEMS = 1000;
    const KINOPOISK_ORIGIN = 'https://www.kinopoisk.ru';
    const WATCH_ORIGIN = 'https://www.kinokino.vip';
    const posterCache = new Map();
    const hydrationStarted = new Set();
    const pendingHydration = [];
    let hydrationActive = 0;
    let listObserver = null;
    const MAX_PARALLEL = 2;

    function validPoster(raw) {
        if (typeof raw !== 'string' || !raw.trim()) return '';
        try {
            const url = new URL(raw);
            if (url.protocol !== 'https:') return '';
            const host = url.hostname.toLowerCase();
            return host === 'kinopoisk.ru' || host.endsWith('.kinopoisk.ru') ||
                host === 'yandex.net' || host.endsWith('.yandex.net') ||
                host === 'yandex.ru' || host.endsWith('.yandex.ru')
                ? url.href : '';
        } catch {
            return '';
        }
    }

    function cleanGenres(value) {
        const input = Array.isArray(value) ? value :
            typeof value === 'string' ? value.split(',') : [];
        return [...new Set(input.map(entry =>
            String(typeof entry === 'string' ? entry : entry?.name || '')
                .replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru'))
            .filter(item => item.length >= 3 && item.length <= 32 &&
                /^[\p{L}][\p{L}\s-]*$/u.test(item)))].slice(0, 8);
    }

    function normalize(movie) {
        if (!movie || !['film', 'series'].includes(movie.type)) return null;
        const id = String(movie.id ?? '');
        if (!/^[1-9]\d{0,12}$/.test(id)) return null;
        const type = movie.type;
        const year = Number(movie.year);
        const posterUrl = validPoster(movie.posterUrl) ||
            validPoster(movie.poster) || validPoster(movie.posterFallback);

        return {
            id, type,
            title: String(movie.title || (type === 'series' ? 'Сериал №' : 'Фильм №') + id)
                .replace(/\s+/g, ' ').trim().slice(0, 200),
            year: Number.isInteger(year) && year >= 1888 && year <= 2200 ? year : null,
            posterUrl,
            genres: cleanGenres(movie.genres),
            addedAt: Number.isFinite(movie.addedAt) && movie.addedAt > 0
                ? movie.addedAt : Date.now()
        };
    }

    function keyOf(movie) {
        const item = normalize(movie);
        return item ? item.type + ':' + item.id : null;
    }

    function getAll() {
        let raw;
        try {
            raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        } catch {
            return [];
        }
        if (!Array.isArray(raw)) return [];

        const unique = new Map();
        for (const input of raw.slice(0, MAX_ITEMS)) {
            const item = normalize(input);
            if (!item) continue;
            const key = item.type + ':' + item.id;
            if (!unique.has(key)) unique.set(key, item);
        }
        return [...unique.values()].sort((a, b) => b.addedAt - a.addedAt);
    }

    function contains(movie) {
        const key = keyOf(movie);
        return Boolean(key && getAll().some(item => keyOf(item) === key));
    }

    function save(items) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        } catch (error) {
            console.warn('[KinoHelper] Не удалось сохранить «Буду смотреть»:', error);
            const status = document.getElementById('watchlistStatus');
            if (status) {
                status.textContent = 'Не удалось сохранить список. Проверьте место в хранилище.';
                status.hidden = false;
            }
            return false;
        }
        window.dispatchEvent(new Event('kino-watchlist-updated'));
        return true;
    }

    function toggle(movie) {
        const next = normalize(movie);
        if (!next) return false;
        const old = getAll();
        const key = keyOf(next);
        const existing = old.find(item => keyOf(item) === key);
        const items = existing ? old.filter(item => keyOf(item) !== key) : [next, ...old];
        if (!existing && items.length > MAX_ITEMS) return false;
        const ok = save(items);
        if (ok && !existing) {
            if (movie.posterDataUrl) adoptPoster(next, movie.posterDataUrl);
            enqueueHydration(next);
        }
        return ok;
    }

    // Обогащение уже сохранённой записи не меняет порядок и не создаёт дубль.
    function updateMetadata(movie, metadata = movie) {
        const key = keyOf(movie);
        if (!key) return false;
        const old = getAll();
        const index = old.findIndex(item => keyOf(item) === key);
        if (index < 0) return false;

        const previous = old[index];
        const incoming = normalize({ ...previous, ...metadata,
            id: previous.id, type: previous.type, addedAt: previous.addedAt });
        if (!incoming) return false;

        // Не стираем уже полученные значения пустыми результатами.
        const goodTitle = incoming.title && !/^(фильм|сериал) №\d+$/i.test(incoming.title);
        const merged = {
            ...previous,
            title: goodTitle ? incoming.title : previous.title,
            year: incoming.year || previous.year,
            genres: incoming.genres.length ? incoming.genres : previous.genres,
            posterUrl: incoming.posterUrl || previous.posterUrl
        };
        if (JSON.stringify(previous) === JSON.stringify(merged)) return false;
        old[index] = merged;
        return save(old);
    }

    function adoptPoster(movie, dataUrl) {
        const key = keyOf(movie);
        if (!key || !contains(movie) || typeof dataUrl !== 'string' ||
            !/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(dataUrl)) return;
        if (posterCache.get(key) === dataUrl) return;
        posterCache.set(key, dataUrl);
        if (posterCache.size > 30) posterCache.delete(posterCache.keys().next().value);
        renderList();
    }

    function makeButton(label, className, action, title) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.title = title;
        button.addEventListener('click', action);
        return button;
    }

    function syncSearchButton(button, movie) {
        if (!button || !normalize(movie)) return;
        button._kinoMovie = movie;
        const saved = contains(movie);
        button.textContent = saved ? '✓ В списке' : '☆ Буду смотреть';
        button.setAttribute('aria-pressed', String(saved));
        button.title = saved ? 'Убрать из «Буду смотреть»' : 'Добавить в «Буду смотреть»';
        button.classList.toggle('saved', saved);
    }

    function createSearchButton(movie) {
        const button = makeButton('', 'title-search-action watchlist-bookmark',
            () => toggle(button._kinoMovie), 'Буду смотреть');
        syncSearchButton(button, movie);
        return button;
    }

    let current = null;

    function setCurrent(movie) {
        current = normalize(movie);
        const button = document.getElementById('watchlistCurrentAction');
        if (!button) return;
        button.hidden = !current;
        if (!current) return;
        const saved = contains(current);
        button.textContent = saved ? '✓ В списке «Буду смотреть»' : '☆ В «Буду смотреть»';
        button.setAttribute('aria-pressed', String(saved));
        button.title = saved ? 'Убрать из списка' : 'Сохранить на потом';
        button.classList.toggle('saved', saved);
    }

    async function openWatch(item) {
        const url = WATCH_ORIGIN + '/' + item.type + '/' + item.id + '/';
        const kpUrl = KINOPOISK_ORIGIN + '/' + item.type + '/' + item.id + '/';
        try {
            if (typeof window.openTrackedWatchTab === 'function') {
                await window.openTrackedWatchTab(url, kpUrl, item.title);
            } else {
                await chrome.tabs.create({ url });
            }
            // Открытие по «Смотреть» учитывается в существующей истории.
            // При этом закладка НЕ удаляется и статус просмотра НЕ меняется.
            if (typeof window.addToHistory === 'function') {
                window.addToHistory(item.title, url);
            }
        } catch (error) {
            console.warn('[KinoHelper] Не удалось открыть сохранённый фильм:', error);
            showStatus('Не удалось открыть фильм');
        }
    }

    function showStatus(message) {
        const status = document.getElementById('watchlistStatus');
        if (!status) return;
        status.textContent = message;
        status.hidden = !message;
    }

    function posterSources(item) {
        const sources = [];
        const append = raw => {
            const valid = validPoster(raw);
            if (!valid) return;
            const url = new URL(valid);
            const pathname = url.pathname.replace(/\/+$/, '');
            const avatar = url.hostname === 'avatars.mds.yandex.net' &&
                /^\/get-kinopoisk-image\/[^/]+\/[^/]+/.test(pathname);
            if (avatar) {
                const base = pathname.replace(/\/(?:orig|\d+x\d+)$/i, '');
                for (const size of ['280x420', '300x450', 'orig']) {
                    const candidate = url.origin + base + '/' + size;
                    if (!sources.includes(candidate)) sources.push(candidate);
                }
            } else if (!sources.includes(valid)) sources.push(valid);
        };
        append(item.posterUrl);
        // Старый путь иногда работает как резерв, как и в обычном поиске.
        append('https://st.kp.yandex.net/images/film_iphone/iphone360_' + item.id + '.jpg');
        append('https://st.kp.yandex.net/images/film_big/' + item.id + '.jpg');
        return sources.slice(0, 6);
    }

    async function requestPoster(item) {
        const key = keyOf(item);
        if (posterCache.has(key)) return;
        let urls = posterSources(item);
        if (!item.posterUrl) {
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'findPosterOnMoviePage',
                    payload: { id: item.id, type: item.type }
                });
                const poster = validPoster(response?.poster);
                if (response?.ok && poster) {
                    updateMetadata(item, { posterUrl: poster });
                    urls = posterSources({ ...item, posterUrl: poster });
                }
            } catch { /* Продолжаем с резервными URL. */ }
        }
        for (const url of urls) {
            if (!contains(item)) return;
            try {
                const result = await chrome.runtime.sendMessage({
                    action: 'loadSearchPoster', payload: { url }
                });
                if (result?.ok && result.dataUrl && contains(item)) {
                    adoptPoster(item, result.dataUrl);
                    return;
                }
            } catch { /* Пробуем следующий адрес. */ }
        }
    }

    async function hydrate(item) {
        if (!contains(item)) return;
        const current = getAll().find(entry => keyOf(entry) === keyOf(item));
        if (!current) return;

        // Из GraphQL получаем год и исходный URL постера. Жанр —
        // из уже существующего парсера страницы Кинопоиска.
        const tasks = [];
        if (!current.year || !current.posterUrl) {
            tasks.push((async () => {
                try {
                    const reply = await chrome.runtime.sendMessage({
                        action: 'getSearchMovieMetadata',
                        payload: { id: current.id, type: current.type }
                    });
                    if (reply?.ok && reply.metadata) {
                        const m = reply.metadata;
                        updateMetadata(current, {
                            year: m.year,
                            title: m.title,
                            posterUrl: validPoster(m.poster) || validPoster(m.posterFallback)
                        });
                    }
                } catch { /* Отсутствие метаданных не блокирует закладку. */ }
            })());
        }
        if (!current.genres.length && window.KinoMovieDetails?.get) {
            tasks.push((async () => {
                try {
                    const details = await window.KinoMovieDetails.get(current);
                    if (details?.genres?.length) updateMetadata(current, { genres: details.genres });
                } catch { /* Кинопоиск может не предоставить жанр. */ }
            })());
        }
        // Готовый URL постера можно загрузить сразу, не ожидая жанры.
        if (current.posterUrl && !posterCache.has(keyOf(item))) {
            tasks.push(requestPoster(current));
        }
        await Promise.allSettled(tasks);
        if (!posterCache.has(keyOf(item))) {
            const latest = getAll().find(entry => keyOf(entry) === keyOf(item));
            if (latest) await requestPoster(latest);
        }
    }

    function pumpHydration() {
        while (hydrationActive < MAX_PARALLEL && pendingHydration.length) {
            const item = pendingHydration.shift();
            hydrationActive++;
            Promise.resolve().then(() => hydrate(item)).catch(error => {
                console.warn('[KinoHelper] Ошибка загрузки данных закладки:', error);
            }).finally(() => {
                hydrationActive--;
                pumpHydration();
            });
        }
    }

    function enqueueHydration(item) {
        const key = keyOf(item);
        if (!key || hydrationStarted.has(key)) return;
        hydrationStarted.add(key);
        pendingHydration.push(item);
        pumpHydration();
    }

    function renderList() {
        const itemsBox = document.getElementById('watchlistItems');
        const count = document.getElementById('watchlistCount');
        const empty = document.getElementById('watchlistEmpty');
        if (!itemsBox || !count || !empty) return;

        const items = getAll();
        count.textContent = String(items.length);
        empty.hidden = items.length !== 0;
        if (listObserver) listObserver.disconnect();
        const nodes = items.map(item => {
            const row = document.createElement('div');
            row.className = 'watchlist-item';
            row._kinoMovie = item;

            const poster = document.createElement('div');
            poster.className = 'watchlist-poster';
            poster.textContent = item.type === 'series' ? '📺' : '🎬';
            const loadedPoster = posterCache.get(keyOf(item));
            if (loadedPoster) {
                const image = document.createElement('img');
                image.alt = '';
                image.src = loadedPoster;
                poster.replaceChildren(image);
            }

            const info = document.createElement('div');
            info.className = 'watchlist-info';
            const name = document.createElement('div');
            name.className = 'watchlist-name';
            name.textContent = item.title;
            name.title = item.title;
            const meta = document.createElement('div');
            meta.className = 'watchlist-meta';
            meta.textContent = (item.type === 'series' ? 'Сериал' : 'Фильм') +
                (item.year ? ' · ' + item.year : '');
            info.append(name, meta);
            if (item.genres.length) {
                const genres = document.createElement('div');
                genres.className = 'watchlist-genres';
                genres.textContent = 'Жанр: ' + item.genres.join(', ');
                genres.title = genres.textContent;
                info.appendChild(genres);
            }

            const actions = document.createElement('div');
            actions.className = 'watchlist-actions';
            const watch = makeButton('▶', 'watchlist-item-action watch',
                () => void openWatch(item), 'Смотреть');
            watch.setAttribute('aria-label', 'Смотреть: ' + item.title);
            const kp = makeButton('КП', 'watchlist-item-action',
                () => void chrome.tabs.create({
                    url: KINOPOISK_ORIGIN + '/' + item.type + '/' + item.id + '/'
                }), 'Открыть Кинопоиск');
            kp.setAttribute('aria-label', 'Кинопоиск: ' + item.title);
            const remove = makeButton('✕', 'watchlist-item-action',
                () => toggle(item), 'Удалить из «Буду смотреть»');
            remove.setAttribute('aria-label', 'Удалить из списка: ' + item.title);
            actions.append(watch, kp, remove);
            row.append(poster, info, actions);
            return row;
        });
        itemsBox.replaceChildren(...nodes);
        if (listObserver) {
            for (const row of nodes) listObserver.observe(row);
        } else {
            for (const item of items.slice(0, 8)) enqueueHydration(item);
        }
    }

    function refresh() {
        renderList();
        setCurrent(current);
        for (const button of document.querySelectorAll('.watchlist-bookmark')) {
            syncSearchButton(button, button._kinoMovie);
        }
    }

    function init() {
        const section = document.getElementById('watchlist');
        const toggleButton = document.getElementById('watchlistToggle');
        const itemsBox = document.getElementById('watchlistBody');
        const currentButton = document.getElementById('watchlistCurrentAction');
        if (!section || !toggleButton || !itemsBox || !currentButton) return;
        const collapsed = localStorage.getItem(COLLAPSED_KEY) === 'true';

        function setCollapsed(value) {
            section.classList.toggle('collapsed', value);
            itemsBox.hidden = value;
            toggleButton.textContent = value ? '▶ Показать' : '▼ Скрыть';
            toggleButton.setAttribute('aria-expanded', String(!value));
            localStorage.setItem(COLLAPSED_KEY, String(value));
        }

        if (typeof IntersectionObserver !== 'undefined') {
            listObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        listObserver.unobserve(entry.target);
                        enqueueHydration(entry.target._kinoMovie);
                    }
                }
            }, { root: document.getElementById('watchlistItems'),
                 rootMargin: '100px 0px' });
        }

        // Первое состояние из localStorage применяем, не затрагивая историю.
        setCollapsed(collapsed);
        toggleButton.addEventListener('click',
            () => setCollapsed(!section.classList.contains('collapsed')));
        currentButton.addEventListener('click', () => {
            if (current) toggle(current);
        });
        window.addEventListener('kino-watchlist-updated', () => {
            showStatus('');
            refresh();
        });
        // Вторая открытая панель/окно использует то же хранилище расширения.
        window.addEventListener('storage', event => {
            if (event.key === STORAGE_KEY) refresh();
            if (event.key === COLLAPSED_KEY && event.newValue !== null) {
                setCollapsed(event.newValue === 'true');
            }
        });
        window.addEventListener('focus', refresh);
        refresh();
    }

    window.KinoWatchlist = { getAll, contains, toggle, setCurrent,
        createSearchButton, syncSearchButton, updateMetadata, adoptPoster };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
