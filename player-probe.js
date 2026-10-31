// Шаг 1 функции «Продолжить просмотр»: безопасная диагностика HTML5-плеера.
// Запускается ТОЛЬКО по нажатию в настройках. Не изменяет видео и не сохраняет историю.
(() => {
    'use strict';

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

    // Исследуем один и тот же video-элемент на протяжении 10 секунд.
    // Только чтение: никакого play(), pause(), currentTime= или сохранения потоков.
    async function monitorVideos(durationMs) {
        const nodes = new WeakMap();
        const records = [];
        const cleaners = [];
        const seconds = value => Number.isFinite(value) && value >= 0
            ? Math.round(value * 10) / 10 : null;

        function scan() {
            const roots = [document];
            let visited = 0;
            for (let i = 0; i < roots.length && i < 25; i++) {
                const root = roots[i];
                for (const video of root.querySelectorAll('video')) {
                    if (!nodes.has(video) && records.length < 12) {
                        const entry = {
                            index: records.length, first: null, last: null,
                            min: null, max: null, duration: null,
                            readyState: 0, paused: true, playingObserved: false,
                            pausedSamples: 0, samples: 0, timeupdates: 0,
                            playEvents: 0, seekingEvents: 0,
                            width: 0, height: 0, visible: null
                        };
                        records.push(entry);
                        nodes.set(video, entry);
                        const event = name => () => { entry[name] += 1; };
                        for (const [eventName, key] of [
                            ['timeupdate', 'timeupdates'],
                            ['play', 'playEvents'],
                            ['seeking', 'seekingEvents']
                        ]) {
                            const listener = event(key);
                            video.addEventListener(eventName, listener);
                            cleaners.push(() => video.removeEventListener(eventName, listener));
                        }
                    }
                    const entry = nodes.get(video);
                    if (!entry) continue;
                    const time = seconds(video.currentTime);
                    const duration = seconds(video.duration);
                    if (time != null) {
                        if (entry.first == null) entry.first = time;
                        entry.last = time;
                        entry.min = entry.min == null ? time : Math.min(entry.min, time);
                        entry.max = entry.max == null ? time : Math.max(entry.max, time);
                    }
                    if (duration != null && duration > 0) entry.duration = duration;
                    entry.readyState = Number(video.readyState) || 0;
                    entry.paused = Boolean(video.paused);
                    entry.playingObserved ||= !video.paused && !video.ended;
                    entry.pausedSamples += Number(Boolean(video.paused));
                    entry.width = Number(video.videoWidth) || 0;
                    entry.height = Number(video.videoHeight) || 0;
                    if (typeof video.getBoundingClientRect === 'function') {
                        const rect = video.getBoundingClientRect();
                        entry.visible = Boolean(rect.width >= 80 && rect.height >= 60);
                    }
                    entry.samples++;
                }
                for (const node of root.querySelectorAll('*')) {
                    if (++visited > 2500 || roots.length >= 25) break;
                    if (node.shadowRoot) roots.push(node.shadowRoot);
                }
            }
        }

        scan();
        await new Promise(resolve => {
            const timer = setInterval(scan, 500);
            setTimeout(() => {
                clearInterval(timer);
                scan();
                resolve();
            }, durationMs);
        });
        for (const release of cleaners) release();
        return {
            iframeCount: document.querySelectorAll('iframe').length,
            videos: records.map(v => {
                const movement = v.min != null && v.max != null
                    ? Math.round((v.max - v.min) * 10) / 10 : null;
                const delta = v.first != null && v.last != null
                    ? Math.round((v.last - v.first) * 10) / 10 : null;
                return {
                    index: v.index, time: v.last, duration: v.duration,
                    paused: v.paused, everPlaying: v.playingObserved,
                    readyState: v.readyState, movement, delta,
                    timeupdates: v.timeupdates, playEvents: v.playEvents,
                    seekingEvents: v.seekingEvents, samples: v.samples,
                    width: v.width, height: v.height, visible: v.visible
                };
            })
        };
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

    async function inspectFrame(tabId, frame) {
        const samples = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            world: 'ISOLATED',
            func: monitorVideos,
            args: [10000]
        });
        return {
            id: frame.frameId,
            host: hostname(frame.url),
            ...samples?.[0]?.result || { videos: [], iframeCount: 0 }
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
                const valid = video.readyState >= 2 && video.duration >= 60;
                const status = !valid ? 'не готов/неактивен' :
                    video.movement >= 1 ? 'изменение подтверждено' :
                    video.paused && !video.everPlaying ? 'пауза весь замер' :
                    'время НЕ изменилось';
                lines.push('  Видео ' + (video.index + 1) + ': ' +
                    formatTime(video.time) + ' / ' + formatTime(video.duration) +
                    ' · ' + status +
                    ' · движение ' + (video.movement == null ? '—' : video.movement + ' с') +
                    ' · timeupdate: ' + video.timeupdates +
                    ' · play: ' + video.playEvents +
                    ' · paused: ' + video.paused +
                    ' · было воспроизведение: ' + video.everPlaying +
                    ' · readyState=' + video.readyState +
                    ' · video=' + video.width + '×' + video.height +
                    ' · видно=' + video.visible);
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
        status.textContent = 'Наблюдаем видео и события 10 секунд. После запуска проверки включи воспроизведение.';
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
                ? 'Готово. Проверь поле «изменение подтверждено» для основного видео.'
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
