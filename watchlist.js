// Локальный список «Буду смотреть». Независим от истории и оценок.
(() => {
    'use strict';

    const STORAGE_KEY = 'kinoHelperWatchlistV1';
    const COLLAPSED_KEY = 'kinoHelperWatchlistCollapsed';
    const MAX_ITEMS = 1000;
    const KINOPOISK_ORIGIN = 'https://www.kinopoisk.ru';
    const WATCH_ORIGIN = 'https://www.kinokino.vip';

    function normalize(movie) {
        if (!movie || !['film', 'series'].includes(movie.type)) return null;
        const id = String(movie.id ?? '');
        if (!/^[1-9]\d{0,12}$/.test(id)) return null;
        const type = movie.type;
        const year = Number(movie.year);
        let posterUrl = '';
        try {
            const candidate = movie.posterUrl || movie.poster || movie.posterFallback || '';
            const url = new URL(candidate);
            if (url.protocol === 'https:' &&
                ['avatars.mds.yandex.net', 'st.kp.yandex.net'].includes(url.hostname)) {
                posterUrl = url.href;
            }
        } catch { /* Отсутствие постера допустимо. */ }

        return {
            id, type,
            title: String(movie.title || (type === 'series' ? 'Сериал №' : 'Фильм №') + id)
                .replace(/\s+/g, ' ').trim().slice(0, 200),
            year: Number.isInteger(year) && year >= 1888 && year <= 2200 ? year : null,
            posterUrl,
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
        return save(items);
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

    function renderList() {
        const itemsBox = document.getElementById('watchlistItems');
        const count = document.getElementById('watchlistCount');
        const empty = document.getElementById('watchlistEmpty');
        if (!itemsBox || !count || !empty) return;

        const items = getAll();
        count.textContent = String(items.length);
        empty.hidden = items.length !== 0;
        const nodes = items.map(item => {
            const row = document.createElement('div');
            row.className = 'watchlist-item';

            const poster = document.createElement('div');
            poster.className = 'watchlist-poster';
            poster.textContent = item.type === 'series' ? '📺' : '🎬';
            if (item.posterUrl) {
                const image = document.createElement('img');
                image.alt = '';
                image.loading = 'lazy';
                image.src = item.posterUrl;
                image.addEventListener('load', () => { poster.textContent = ''; });
                image.addEventListener('error', () => { image.remove(); });
                poster.appendChild(image);
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
        createSearchButton, syncSearchButton };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
