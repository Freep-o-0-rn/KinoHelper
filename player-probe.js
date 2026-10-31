// Шаг 1 функции «Продолжить просмотр»: безопасная диагностика HTML5-плеера.
// Запускается ТОЛЬКО по нажатию в настройках. Не изменяет видео и не сохраняет историю.
(() => {
    'use strict';

    const sampleDelayMs = 3000;
    const maxFrames = 12;
    let busy = false;
    let lastReport = '';

    const $ = id => document.getElementById(id);
    const button = $('playerProbeStart');
    const result = $('playerProbeResult');
    const status = $('playerProbeStatus');
    const copy = $('playerProbeCopy');
    const grantButton = $('playerProbeGrant');
    if (!button || !result || !status || !copy || !grantButton) return;
    const optionalOrigins = [
        'https://brogiro.cfd/*',
        'https://theatre.stravers.live/*'
    ];
    const knownHosts = new Map([
        ['www.kinokino.vip', 'https://www.kinokino.vip/*'],
        ['flcksbr.top', 'https://flcksbr.top/*'],
        ['www.kinopoisk.ru', 'https://www.kinopoisk.ru/*'],
        ['brogiro.cfd', optionalOrigins[0]],
        ['theatre.stravers.live', optionalOrigins[1]]
    ]);
    let pendingOrigins = [];

    // Возвращаемые данные НЕ включают URL видео, cookies или содержимое страницы.
    // Chrome сериализует эту функцию и исполняет в изолированном контексте фрейма.
    function readVideos() {
        const videos = [];
        const seen = new Set();
        function addFrom(root) {
            for (const node of root.querySelectorAll('video')) {
                if (!seen.has(node) && videos.length < 10) {
                    seen.add(node);
                    const toSeconds = value =>
                        Number.isFinite(value) && value >= 0
                            ? Math.round(value * 10) / 10 : null;
                    videos.push({
                        index: videos.length,
                        time: toSeconds(node.currentTime),
                        duration: toSeconds(node.duration),
                        paused: Boolean(node.paused),
                        ended: Boolean(node.ended),
                        readyState: Number(node.readyState) || 0
                    });
                }
            }
            // Некоторые проигрыватели используют открытые shadow roots.
            // Ограничиваем обход, чтобы не тормозить большие страницы.
            let scanned = 0;
            for (const element of root.querySelectorAll('*')) {
                if (++scanned > 1800 || videos.length >= 10) break;
                if (element.shadowRoot) addFrom(element.shadowRoot);
            }
        }
        addFrom(document);
        return { videos, iframeCount: document.querySelectorAll('iframe').length };
    }

    function hostname(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : parsed.protocol;
        } catch {
            return 'неизвестный адрес';
        }
    }

    // Проверяем фактически предоставленный Chrome доступ к каждому фрейму.
    // Наличие шаблона в manifest само по себе не означает, что доступ разрешён.
    function originPattern(frameUrl) {
        try {
            const url = new URL(frameUrl);
            return url.protocol === 'https:' ? knownHosts.get(url.hostname.toLowerCase()) : null;
        } catch {
            return null;
        }
    }

    async function accessFor(frame) {
        const pattern = originPattern(frame.url);
        if (!pattern) return { frame, pattern: null, allowed: false };
        try {
            return {
                frame, pattern,
                allowed: Boolean(await chrome.permissions.contains({ origins: [pattern] }))
            };
        } catch {
            return { frame, pattern, allowed: false };
        }
    }

    function formatTime(seconds) {
        if (!Number.isFinite(seconds)) return '—';
        const total = Math.floor(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return (h ? String(h) + ':' + String(m).padStart(2, '0') :
            String(m)) + ':' + String(s).padStart(2, '0');
    }

    async function sample(tabId, frameId) {
        const frames = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            world: 'ISOLATED',
            func: readVideos
        });
        return frames?.[0]?.result || { videos: [], iframeCount: 0 };
    }

    async function inspectFrame(tabId, frame) {
        const first = await sample(tabId, frame.frameId);
        await new Promise(resolve => setTimeout(resolve, sampleDelayMs));
        const second = await sample(tabId, frame.frameId);
        const videos = second.videos.map((video, index) => {
            const before = first.videos[index];
            const delta = before?.time != null && video.time != null
                ? Math.round((video.time - before.time) * 10) / 10 : null;
            return { ...video, delta };
        });
        return {
            id: frame.frameId,
            host: hostname(frame.url),
            iframeCount: second.iframeCount,
            videos
        };
    }

    function formatReport(tab, frameList, successes, failures, accessible) {
        const lines = [
            'KinoHelper — проверка видеоплеера',
            'Страница: ' + hostname(tab.url || ''),
            'Всего фреймов: ' + frameList.length,
            'Разрешено проверить: ' + accessible.size,
            'Найдено HTML5-видео: ' + successes.reduce((sum, frame) => sum + frame.videos.length, 0),
            ''
        ];

        for (const frame of successes) {
            lines.push('Фрейм ' + frame.id + ' (' + frame.host + ')');
            if (!frame.videos.length) {
                lines.push('  Видео не найдено · вложенных iframe: ' + frame.iframeCount);
            }
            for (const video of frame.videos) {
                const state = video.ended ? 'завершено' : video.paused ? 'пауза' : 'воспроизведение';
                const moved = video.delta == null ? 'изменение неизвестно' :
                    video.delta > 0.4 ? 'движение +' + video.delta + ' с' :
                    video.delta < -0.4 ? 'перемотка ' + video.delta + ' с' :
                    'позиция не изменилась';
                lines.push('  Видео ' + (video.index + 1) + ': ' +
                    formatTime(video.time) + ' / ' + formatTime(video.duration) +
                    ' · ' + state + ' · ' + moved +
                    ' · readyState=' + video.readyState);
            }
        }

        for (const frame of frameList) {
            if (!accessible.has(frame.frameId)) {
                lines.push('Не проверен iframe ' + frame.frameId + ': ' +
                    hostname(frame.url) + ' (нет разрешения)');
            }
        }

        for (const item of failures) {
            lines.push('Не удалось проверить фрейм ' + item.id +
                ' (' + item.host + ')');
        }

        if (!successes.some(f => f.videos.length)) {
            lines.push('', 'В доступных фреймах HTML5-видео не найдено.');
            lines.push('Это НЕ доказывает отсутствие плеера: он может быть');
            lines.push('во внешнем iframe или использовать иной механизм.');
        }

        lines.push('', 'Проверка только читает состояние; видео не перематывалось.');
        return lines.join('\n');
    }

    async function run() {
        if (busy) return;
        busy = true;
        button.disabled = true;
        copy.hidden = true;
        grantButton.hidden = true;
        pendingOrigins = [];
        result.hidden = true;
        status.textContent = 'Проверяем текущую вкладку (два замера с интервалом 3 секунды)…';
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!Number.isInteger(tab?.id) || !tab.url) {
                throw new Error('Открой страницу фильма и включи воспроизведение.');
            }
            let frames;
            try {
                frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
            } catch (error) {
                throw new Error('Chrome не предоставил список фреймов: ' + error.message);
            }
            if (!Array.isArray(frames) || !frames.length) {
                throw new Error('Вкладка не содержит доступных фреймов. Попробуй обновить страницу.');
            }
            const permissions = await Promise.all(frames.map(accessFor));
            const allowed = permissions.filter(item => item.allowed)
                .map(item => item.frame).slice(0, maxFrames);
            const accessible = new Set(allowed.map(f => f.frameId));
            pendingOrigins = [...new Set(permissions.filter(item =>
                !item.allowed && optionalOrigins.includes(item.pattern))
                .map(item => item.pattern))];
            grantButton.hidden = pendingOrigins.length === 0;
            if (pendingOrigins.length) {
                grantButton.textContent = pendingOrigins.length === 1
                    ? 'Разрешить доступ к плееру (1 сайт)'
                    : 'Разрешить доступ к плееру (2 сайта)';
            }
            const responses = await Promise.allSettled(allowed.map(f => inspectFrame(tab.id, f)));
            const successes = [], failures = [];
            responses.forEach((response, i) => {
                if (response.status === 'fulfilled') successes.push(response.value);
                else failures.push({ id: allowed[i].frameId, host: hostname(allowed[i].url) });
            });
            lastReport = formatReport(tab, frames, successes, failures, accessible);
            result.textContent = lastReport;
            result.hidden = false;
            copy.hidden = false;
            const count = successes.reduce((sum, f) => sum + f.videos.length, 0);
            status.textContent = count
                ? 'Готово. Проверь, меняется ли таймкод во время воспроизведения.'
                : 'Готово. Видео не найдено в доступных фреймах — посмотри домены iframe в отчёте.';
        } catch (error) {
            status.textContent = 'Ошибка проверки: ' + String(error.message || error);
        } finally {
            button.disabled = false;
            busy = false;
        }
    }

    button.addEventListener('click', () => void run());

    grantButton.addEventListener('click', () => {
        // Важно: request() должен вызваться непосредственно из обработчика
        // пользовательского нажатия, БЕЗ предварительных await.
        const origins = [...pendingOrigins];
        if (!origins.length) return;
        grantButton.disabled = true;
        status.textContent = 'Chrome запросит доступ только к указанным сайтам.';
        let permissionRequest;
        try {
            permissionRequest = chrome.permissions.request({ origins });
        } catch (error) {
            grantButton.disabled = false;
            status.textContent = 'Не удалось запросить доступ: ' + String(error.message || error);
            return;
        }
        Promise.resolve(permissionRequest).then(granted => {
            if (granted) {
                status.textContent = 'Доступ разрешён. Повторяем проверку.';
                return run();
            }
            status.textContent = 'Доступ не предоставлен. Без разрешения таймкод недоступен.';
        }).catch(error => {
            status.textContent = 'Ошибка разрешений: ' + String(error.message || error);
        }).finally(() => {
            grantButton.disabled = false;
        });
    });

    copy.addEventListener('click', async () => {
        if (!lastReport) return;
        try {
            await navigator.clipboard.writeText(lastReport);
            status.textContent = 'Отчёт скопирован. В нём нет URL видео и параметров страницы.';
        } catch {
            status.textContent = 'Не удалось скопировать автоматически. Выдели текст отчёта вручную.';
        }
    });
})();
