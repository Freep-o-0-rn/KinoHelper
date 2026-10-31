'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'player-probe.js'), 'utf8');

async function runProbe(frames, videoFrames = {}, options = {}) {
    const controls = new Map();
    for (const id of ['playerProbeStart', 'playerProbeResult', 'playerProbeStatus', 'playerProbeCopy', 'playerProbeGrant']) {
        controls.set(id, {
            textContent: '', hidden: true, disabled: false, handlers: {},
            addEventListener(type, callback) { this.handlers[type] = callback; }
        });
    }
    let calls = 0;
    const granted = new Set(['https://www.kinokino.vip/*', 'https://flcksbr.top/*']);
    const requests = [];
    const pageForFrame = frameId => ({
        querySelectorAll(selector) {
            if (selector === 'iframe' || selector === '*') return [];
            if (selector !== 'video') return [];
            const data = videoFrames[frameId] || [];
            return data.map(v => ({
                currentTime: v.times[Math.min(calls, v.times.length - 1)],
                duration: v.duration, paused: false, ended: false, readyState: 4
            }));
        }
    });
    const chrome = {
        permissions: {
            contains: async ({ origins }) => origins.every(origin => granted.has(origin)),
            request: ({ origins }) => {
                requests.push(origins);
                if (!options.grant) return Promise.resolve(false);
                for (const origin of origins) granted.add(origin);
                return Promise.resolve(true);
            }
        },
        tabs: { query: async () => [{ id: 5, url: 'https://www.kinokino.vip/film/123/?token=SECRET' }] },
        webNavigation: { getAllFrames: async () => frames },
        scripting: {
            executeScript: async ({ target, func }) => {
                const page = pageForFrame(target.frameIds[0]);
                const value = vm.runInNewContext('(' + func.toString() + ')()', { document: page });
                calls += 1;
                return [{ frameId: target.frameIds[0], result: value }];
            }
        }
    };
    const context = {
        document: { getElementById: id => controls.get(id) },
        chrome, URL, setTimeout: callback => callback(),
        navigator: { clipboard: { writeText: async () => {} } }
    };
    vm.runInNewContext(source, context, { filename: 'player-probe.js' });
    controls.get('playerProbeStart').handlers.click();
    // Ожидаем завершения 2 проб, передача callback имитирует 3 секунды.
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    if (options.clickGrant) {
        controls.get('playerProbeGrant').handlers.click();
        for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    }
    controls.requests = requests;
    return controls;
}

test('probe reads timecode, duration and playback delta without changing the player', async () => {
    const controls = await runProbe(
        [{ frameId: 0, url: 'https://www.kinokino.vip/film/123/' }],
        { 0: [{ times: [120, 123], duration: 600 }] }
    );
    const report = controls.get('playerProbeResult').textContent;
    assert.match(report, /Найдено HTML5-видео: 1/);
    assert.match(report, /2:03 \/ 10:00/);
    assert.match(report, /движение \+3 с/);
    assert.equal(controls.get('playerProbeCopy').hidden, false);
    assert.equal(controls.get('playerProbeStart').disabled, false);
});

test('probe exposes only frame hostnames, not private URL query parameters', async () => {
    const controls = await runProbe([
        { frameId: 0, url: 'https://www.kinokino.vip/film/123/?secret=HIDDEN' },
        { frameId: 2, url: 'https://external-player.example/embed?auth=SECRET' }
    ]);
    const report = controls.get('playerProbeResult').textContent;
    assert.match(report, /external-player.example \(нет разрешения\)/);
    assert.doesNotMatch(report, /HIDDEN|SECRET|token=/);
    assert.match(report, /в доступных фреймах HTML5-видео не найдено/i);
});


test('two optional player origins are requested on consent, then inspected', async () => {
    const controls = await runProbe(
        [
            { frameId: 0, url: 'https://brogiro.cfd/film/447301/' },
            { frameId: 450, url: 'https://theatre.stravers.live/embed?token=SECRET' }
        ],
        { 450: [{ times: [120, 123], duration: 8888 }] },
        { grant: true, clickGrant: true }
    );
    const report = controls.get('playerProbeResult').textContent;
    assert.deepEqual(controls.requests[0], [
        'https://brogiro.cfd/*', 'https://theatre.stravers.live/*'
    ]);
    assert.match(report, /Разрешено проверить: 2/);
    assert.match(report, /Найдено HTML5-видео: 1/);
    assert.match(report, /Фрейм 450 \(theatre\.stravers\.live\)/);
    assert.doesNotMatch(report, /SECRET/);
    assert.equal(controls.get('playerProbeGrant').hidden, true);
});

test('declining player access leaves frames uninspected', async () => {
    const controls = await runProbe(
        [{ frameId: 0, url: 'https://brogiro.cfd/film/447301/' }],
        {}, { grant: false, clickGrant: true }
    );
    assert.match(controls.get('playerProbeResult').textContent, /Разрешено проверить: 0/);
    assert.match(controls.get('playerProbeStatus').textContent, /не предоставлен/);
    assert.equal(controls.requests.length, 1);
});
