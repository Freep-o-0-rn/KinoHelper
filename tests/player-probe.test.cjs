'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'player-probe.js'), 'utf8');

function player({ time = 0, duration = NaN, paused = true, readyState = 0,
    rate = 0, width = 0, height = 0 }) {
    const listeners = {};
    return {
        time, duration, paused, readyState, videoWidth: width, videoHeight: height,
        get currentTime() { return this.time; },
        addEventListener(event, cb) { (listeners[event] ||= []).push(cb); },
        removeEventListener(event, cb) {
            listeners[event] = (listeners[event] || []).filter(item => item !== cb);
        },
        getBoundingClientRect() { return { width, height }; },
        tick() {
            this.time += rate;
            for (const cb of listeners.timeupdate || []) cb();
        }
    };
}

async function probe({ allow = true, players = [], frames = [
    { frameId: 0, url: 'https://brogiro.cfd/film/447301/?secret=PRIVATE' },
    { frameId: 457, url: 'https://theatre.stravers.live/player?token=TOPSECRET' }
] } = {}) {
    const controls = {};
    const ids = ['playerProbeStart', 'playerProbeResult', 'playerProbeStatus',
        'playerProbeCopy', 'playerProbeGrant', 'playerProbeLive', 'playerProbeStopLive'];
    for (const id of ids) {
        controls[id] = {
            hidden: true, disabled: false, textContent: '', handlers: {},
            addEventListener(type, cb) { this.handlers[type] = cb; }
        };
    }
    const liveTimers = new Map();
    let timerNumber = 0;
    const previouslyGranted = new Set();
    const requests = [];
    const page = {
        querySelectorAll(selector) {
            return selector === 'video' ? players :
                selector === 'iframe' ? [{}] : [];
        }
    };
    const chrome = {
        permissions: {
            request: ({ origins }) => {
                requests.push([...origins]);
                if (allow) origins.forEach(origin => previouslyGranted.add(origin));
                return Promise.resolve(allow);
            },
            contains: async ({ origins }) => origins.every(origin => previouslyGranted.has(origin))
        },
        tabs: { query: async () => [{ id: 123, url: frames[0].url }] },
        webNavigation: { getAllFrames: async () => frames },
        scripting: {
            executeScript: async ({ target, func, args }) => {
                const document = target.frameIds[0] === 457 ? page :
                    { querySelectorAll() { return []; } };
                let tick;
                const input = Array.isArray(args) ? JSON.stringify(args[0]) : '';
                const value = await vm.runInNewContext('(' + func.toString() + ')(' + input + ')', {
                    document,
                    setInterval(cb) { tick = cb; return 1; },
                    clearInterval() {},
                    setTimeout(cb) {
                        for (let i = 0; i < 5; i++) {
                            for (const video of players) video.tick();
                            tick();
                        }
                        cb();
                    }
                });
                return [{ frameId: target.frameIds[0], result: value }];
            }
        }
    };
    vm.runInNewContext(source, {
        document: {
            hidden: false,
            body: { classList: { contains: name => name === 'settings-open' } },
            getElementById: id => controls[id],
            addEventListener() {}
        },
        chrome, URL,
        setInterval(cb) {
            const id = ++timerNumber;
            liveTimers.set(id, cb);
            return id;
        },
        clearInterval(id) { liveTimers.delete(id); },
        navigator: { clipboard: { writeText: async () => {} } }
    });
    controls.playerProbeStart.handlers.click();
    for (let i = 0; i < 12; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    return {
        controls, requests,
        async advanceLive(seconds = 2) {
            for (const v of players) v.time += seconds;
            for (const cb of [...liveTimers.values()]) cb();
            for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
        },
        activeTimers: () => liveTimers.size
    };
}

test('automatically asks for two specific hosts on the first probe click', async () => {
    const { controls, requests } = await probe({
        players: [
            player({ time: 26, duration: 6722, paused: false,
                readyState: 4, rate: 2, width: 1280, height: 720 }),
            player({ time: 0, paused: true, readyState: 0 })
        ]
    });
    assert.deepEqual(requests, [[
        'https://brogiro.cfd/*', 'https://theatre.stravers.live/*'
    ]]);
    const report = controls.playerProbeResult.textContent;
    assert.match(report, /Найдено HTML5-видео: 2/);
    assert.match(report, /Видео 1: .*воспроизведение подтверждено/);
    assert.match(report, /Видео 2: .*не готов\/неактивен/);
    assert.match(report, /timeupdate: 5/);
    assert.doesNotMatch(report, /PRIVATE|TOPSECRET/);
    assert.equal(controls.playerProbeStart.disabled, false);
});

test('paused movie does not falsely count as verified playback', async () => {
    const { controls } = await probe({
        players: [player({ time: 45, duration: 6722, paused: true,
            readyState: 4, rate: 0 })]
    });
    assert.match(controls.playerProbeResult.textContent, /пауза весь замер/);
    assert.doesNotMatch(controls.playerProbeResult.textContent, /изменение подтверждено/);
});

test('denied permissions never attempt injection and never expose URL parameters', async () => {
    const { controls } = await probe({ allow: false });
    assert.match(controls.playerProbeResult.textContent, /Разрешено проверить: 0/);
    assert.match(controls.playerProbeResult.textContent, /нет разрешения/);
    assert.doesNotMatch(controls.playerProbeResult.textContent, /PRIVATE|TOPSECRET/);
});

test('uninstrumented, unknown frame does not cause requesting all-sites access', async () => {
    const { controls, requests } = await probe({
        frames: [
            { frameId: 0, url: 'https://brogiro.cfd/film/447301/' },
            { frameId: 457, url: 'https://other.example/embed?token=SECRET' }
        ]
    });
    assert.deepEqual(requests[0], [
        'https://brogiro.cfd/*', 'https://theatre.stravers.live/*'
    ]);
    assert.match(controls.playerProbeResult.textContent, /other.example \(нет разрешения\)/);
    assert.doesNotMatch(controls.playerProbeResult.textContent, /SECRET/);
});


test('time changing only through paused seeking is not treated as confirmed playback', async () => {
    const stationary = player({ time: 10, duration: 6722, paused: true,
        readyState: 4, rate: 2 });
    const { controls } = await probe({ players: [stationary] });
    assert.match(controls.playerProbeResult.textContent,
        /время менялось, но воспроизведение не подтверждено/);
    assert.doesNotMatch(controls.playerProbeStatus.textContent,
        /Воспроизведение подтверждено/);
});


test('live clock updates after a static diagnostic report', async () => {
    const movie = player({ time: 26, duration: 6722, paused: false,
        readyState: 4, rate: 2, width: 854, height: 480 });
    const result = await probe({ players: [movie] });
    const reportBefore = result.controls.playerProbeResult.textContent;
    const liveBefore = result.controls.playerProbeLive.textContent;
    assert.match(liveBefore, /Живой таймкод/);
    assert.equal(result.activeTimers(), 1);
    await result.advanceLive(4);
    const liveAfter = result.controls.playerProbeLive.textContent;
    assert.notEqual(liveBefore, liveAfter);
    assert.equal(result.controls.playerProbeResult.textContent, reportBefore);
    assert.match(liveAfter, /обновление каждые 2 секунды/);
    result.controls.playerProbeStopLive.handlers.click();
    assert.equal(result.activeTimers(), 0);
    assert.match(result.controls.playerProbeLive.textContent, /остановлен/);
});

test('zero duration and empty video does not become live tracking target', async () => {
    const empty = player({ time: 0, duration: NaN, paused: true,
        readyState: 0, rate: 0, width: 0, height: 0 });
    const result = await probe({ players: [empty] });
    assert.equal(result.activeTimers(), 0);
    assert.equal(result.controls.playerProbeLive.hidden, true);
});
