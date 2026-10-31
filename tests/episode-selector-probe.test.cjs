'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '..', 'episode-selector-probe.js'), 'utf8');

function uiElement() {
  return {
    hidden: false, disabled: false, textContent: '', callbacks: {},
    addEventListener(name, callback) { this.callbacks[name] = callback; }
  };
}
function playerElement(text, classes = 'season selected') {
  return {
    hidden: false, tagName: 'BUTTON', textContent: text,
    parentElement: { getAttribute: key => key === 'class' ? 'season-dropdown' : null },
    getAttribute(key) {
      if (key === 'class') return classes;
      if (key === 'aria-selected') return 'true';
      return null;
    },
    getBoundingClientRect() {
      return { left: 30, top: 20, width: 130, height: 28, right: 160, bottom: 48 };
    }
  };
}

async function setup() {
  const controls = {};
  for (const name of ['seriesProbeBefore', 'seriesProbeAfter', 'seriesProbeCopy',
      'seriesProbeClear', 'seriesProbeStatus', 'seriesProbeReport']) {
    controls[name] = uiElement();
  }
  let selected = 'Сезон 2 · Серия 4';
  let clipboard = '';
  let order = 0;
  const page = {
    querySelectorAll(selector) {
      if (selector === 'video' || selector === 'iframe' || selector === '*') return [];
      return [playerElement(selected)];
    }
  };
  const chrome = {
    tabs: { query: async () => [{ id: 6, url:
      'https://brogiro.cfd/series/123/?secret=PRIVATE' }] },
    webNavigation: { getAllFrames: async () => [
      { frameId: 0, url: 'https://brogiro.cfd/series/123/?secret=PRIVATE' },
      { frameId: 450, url: 'https://theatre.stravers.live/player?token=TOP_SECRET' }
    ] },
    scripting: {
      executeScript: async ({ target, func }) => {
        order++;
        return [{ frameId: target.frameIds[0],
          result: vm.runInNewContext('(' + func.toString() + ')()', {
            document: page, window: { innerWidth: 1200, innerHeight: 800 }
          }) }];
      }
    },
    runtime: {
      sendMessage: async () => ({ ok: true, session: { type: 'series' } })
    },
    storage: { local: { get: async () => ({ kinoPlaybackProgressV1: {} }) } }
  };
  vm.runInNewContext(code, {
    document: { getElementById: id => controls[id] },
    chrome, URL, setTimeout: callback => callback(),
    navigator: { clipboard: { writeText: async value => { clipboard = value; } } }
  });
  async function settle() {
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return {
    controls,
    setSelected: value => { selected = value; },
    async press(name) { controls[name].callbacks.click(); await settle(); },
    getClipboard: () => clipboard,
    getCalls: () => order
  };
}

test('captures season selector before and after manual episode switch', async () => {
  const ui = await setup();
  await ui.press('seriesProbeBefore');
  assert.match(ui.controls.seriesProbeReport.textContent, /Сезон 2 · Серия 4/);
  ui.setSelected('Сезон 2 · Серия 5');
  await ui.press('seriesProbeAfter');
  const report = ui.controls.seriesProbeReport.textContent;
  assert.match(report, /ИЗМЕНИВШИЕСЯ ЭЛЕМЕНТЫ/);
  assert.match(report, /Было: .*Сезон 2 · Серия 4/);
  assert.match(report, /Стало: .*Сезон 2 · Серия 5/);
  assert.doesNotMatch(report, /PRIVATE|TOP_SECRET|https:\/\//);
  assert.equal(ui.getCalls(), 4);
  await ui.press('seriesProbeCopy');
  assert.equal(ui.getClipboard(), report);
});

test('a second snapshot is not accepted before the first', async () => {
  const ui = await setup();
  await ui.press('seriesProbeAfter');
  assert.match(ui.controls.seriesProbeStatus.textContent, /Сначала/);
  assert.equal(ui.getCalls(), 0);
});

test('clear removes snapshots and hides the report', async () => {
  const ui = await setup();
  await ui.press('seriesProbeBefore');
  await ui.press('seriesProbeClear');
  assert.equal(ui.controls.seriesProbeReport.hidden, true);
  assert.equal(ui.controls.seriesProbeCopy.hidden, true);
});
