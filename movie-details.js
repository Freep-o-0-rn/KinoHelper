// Жанры и описание берём только со страницы соответствующего фильма Кинопоиска.
// Общее для popup, боковой панели и карточек поиска. Не влияет на запросы оценок.
window.KinoMovieDetails = (() => {
    'use strict';

    const CACHE_PREFIX = 'kinoHelperMovieDetailsV1:';
    const CACHE_TTL = 30 * 60 * 1000;
    const memory = new Map();
    const pending = new Map();

    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

    function genresFrom(value) {
        const values = Array.isArray(value) ? value :
            typeof value === 'string' ? value.split(',') : [];
        return [...new Set(values.map(item =>
            clean(typeof item === 'string' ? item : item?.name)
                .toLocaleLowerCase('ru'))
            .filter(item => item.length >= 3 && item.length <= 32 &&
                /^[\p{L}][\p{L}\s-]*$/u.test(item)))].slice(0, 8);
    }

    function descriptionFrom(value) {
        const text = clean(value);
        if (text.length < 35 ||
            /^(?:смотреть онлайн|смотрите онлайн|все о фильме|всё о фильме)/i.test(text)) return '';
        return text.slice(0, 3500);
    }

    function parsePage(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const result = { genres: [], description: '' };

        // Структурированные данные фильма, если Кинопоиск их предоставил.
        for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const data = JSON.parse(script.textContent);
                const candidates = Array.isArray(data) ? data : [data];
                for (const entry of candidates) {
                    const nodes = Array.isArray(entry?.['@graph']) ? entry['@graph'] : [entry];
                    for (const node of nodes) {
                        const kinds = [].concat(node?.['@type'] || []);
                        if (!kinds.some(type => /^(?:Movie|TVSeries|TVEpisode|VideoObject)$/i.test(type))) continue;
                        if (!result.genres.length) result.genres = genresFrom(node.genre);
                        if (!result.description) result.description = descriptionFrom(node.description);
                    }
                }
            } catch {
                // Неверные JSON-LD на странице не должны ломать интерфейс.
            }
        }

        // В информации «О фильме» жанры перечислены рядом с меткой «Жанр».
        if (!result.genres.length) {
            for (const label of doc.querySelectorAll('dt, th, span, div')) {
                if (label.children.length > 1 || clean(label.textContent) !== 'Жанр') continue;
                const row = label.closest('tr, [class*="row"], [class*="Row"]') ||
                    label.parentElement;
                const links = row ? [...row.querySelectorAll('a')]
                    .map(link => clean(link.textContent)) : [];
                const text = clean(row?.textContent).replace(/^Жанр\s*/i, '');
                const genreCandidates = genresFrom(links.length ? links : text);
                if (genreCandidates.length) {
                    result.genres = genreCandidates;
                    break;
                }
            }
        }

        // Описание в содержимом страницы приоритетнее короткого SEO-анонса.
        const descriptionSelectors = [
            '[data-test-id="film-description"]',
            '[data-test-id="movie-description"]',
            '[data-tid="film-description"]',
            '[class*="filmDescription"]',
            '[class*="film-description"]',
            '[class*="synopsis"]',
            '[itemprop="description"]'
        ];
        for (const selector of descriptionSelectors) {
            for (const node of doc.querySelectorAll(selector)) {
                const text = descriptionFrom(node.textContent);
                if (text && text.length > result.description.length) {
                    result.description = text;
                }
            }
        }

        // Если Кинопоиск не отдаёт текст описания в HTML, используем его
        // официальный description-метатег, но не подставляем чужие аннотации.
        if (!result.description) {
            result.description = descriptionFrom(
                doc.querySelector('meta[property="og:description"]')?.content ||
                doc.querySelector('meta[name="description"]')?.content
            );
        }
        return result;
    }

    function validate(media) {
        const id = Number(media?.id);
        const type = media?.type;
        if (!Number.isSafeInteger(id) || id < 1 || !['film', 'series'].includes(type)) {
            throw new Error('Неверный ID фильма');
        }
        return { id, type, key: type + ':' + id };
    }

    async function fetchDetails(media) {
        const url = 'https://www.kinopoisk.ru/' + media.type + '/' + media.id + '/';
        const response = await fetch(url, {
            credentials: 'include',
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error('Страница фильма: HTTP ' + response.status);
        const html = await response.text();
        return parsePage(html);
    }

    async function get(media) {
        const target = validate(media);
        const existing = memory.get(target.key);
        if (existing && Date.now() - existing.savedAt < CACHE_TTL) {
            return existing.details;
        }
        if (pending.has(target.key)) return pending.get(target.key);

        const promise = (async () => {
            const key = CACHE_PREFIX + target.key;
            try {
                const stored = (await chrome.storage.session.get(key))?.[key];
                if (stored && Date.now() - stored.savedAt < CACHE_TTL) {
                    memory.set(target.key, stored);
                    return stored.details;
                }
            } catch {
                // Нет доступа к session storage — загружаем напрямую.
            }

            const details = await fetchDetails(target);
            if (details.genres.length || details.description) {
                const entry = { savedAt: Date.now(), details };
                memory.set(target.key, entry);
                try { await chrome.storage.session.set({ [key]: entry }); } catch {}
            }
            return details;
        })();

        pending.set(target.key, promise);
        try {
            return await promise;
        } finally {
            pending.delete(target.key);
        }
    }

    return { get };
})();
