'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'resume-ui.js'), 'utf8');

function node(tag = 'div', cls = '') {
  const element = {
    tag, className: cls, hidden: false, textContent: '', dataset: {},
    style: {}, attrs: {}, children: [], events: {},
    classList: { add(value) { element.className += ' ' + value; } },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(key, callback) { this.events[key] = callback; },
    append(...children) { for (const child of children) this.appendChild(child); },
    appendChild(child) { this.children.push(child); child.parent = this; },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    remove() {
      if (this.parent) this.parent.children =
        this.parent.children.filter(item => item !== this);
    },
    querySelector(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : selector;
      for (const child of this.children) {
        if (child.className.split(/\s+/).includes(cls)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
  };
  return element;
}

async function setup({ data = {}, history = [], current = 'https://www.kinopoisk.ru/' } = {}) {
  const elements = {
    resumeLast: node('section'), resumeLastTitle: node(),
    resumeLastMeta: node(), resumeLastProgress: node(),
    resumeLastOpen: node('button')
  };
  let tabUrl = current;
  const rows = history.map(entry => {
    const row = node('div', 'history-item');
    const match = new URL(entry.url).pathname.match(/^\/(film|series)\/(\d+)/);
    if (match) row.dataset.kinoMediaKey = match[1] + ':' + match[2];
    row.appendChild(node('div', 'history-item-main'));
    return row;
  });
  const doc = {
    getElementById: id => elements[id],
    querySelectorAll: selector => selector.includes('history-item')
      ? rows.filter(row => row.dataset.kinoMediaKey) : [],
    createElement: tag => node(tag)
  };
  const changes = [];
  const tabs = {};
  const opened = [];
  const openedOptions = [];
  const context = {
    URL, console,
    document: doc,
    chrome: {
      tabs: {
        query: async () => [{ id: 1, url: tabUrl }],
        create: async ({ url }) => opened.push(url),
        onActivated: { addListener(cb) { tabs.activated = cb; } },
        onUpdated: { addListener(cb) { tabs.updated = cb; } },
        onRemoved: { addListener(cb) { tabs.removed = cb; } }
      },
      storage: {
        local: { get: async () => ({ kinoPlaybackProgressV1: data }) },
        onChanged: { addListener(cb) { changes.push(cb); } }
      }
    },
    window: { addEventListener() {},
      openHistoryUrl: async (url, title, options) => {
        opened.push(url);
        openedOptions.push(options);
      } }
  };
  vm.runInNewContext(source, context);
  context.window.KinoResumeUI.updateHistory(history);
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  return { elements, rows, changes, tabs, opened, openedOptions,
    updateHistory: context.window.KinoResumeUI.updateHistory,
    refresh: context.window.KinoResumeUI.readStorage,
    setTab(url) { tabUrl = url; },
    setData(next) { data = next; } };
}

const movie = { type: 'film', id: '447301', title: 'Астрал',
  position: 150, duration: 600, updatedAt: 10000, completed: false };
const filmHistory = [{ title: 'Астрал', timestamp: 5000,
  url: 'https://www.kinokino.vip/film/447301/' }];

test('history progress bar uses saved position and latest card shows same movie', async () => {
  const ui = await setup({
    data: { 'film:447301': movie }, history: filmHistory
  });
  const bar = ui.rows[0].querySelector('.history-progress-track');
  assert.ok(bar);
  assert.equal(bar.attrs['aria-valuenow'], '25');
  assert.equal(ui.rows[0].querySelector('.history-progress-label').textContent,
    '2:30 / 10:00 · 25%');
  assert.equal(ui.elements.resumeLast.hidden, false);
  assert.equal(ui.elements.resumeLastTitle.textContent, 'Астрал');
  assert.match(ui.elements.resumeLastMeta.textContent, /2:30 \/ 10:00 · 25%/);
  ui.elements.resumeLastOpen.events.click();
  assert.deepEqual(ui.opened, [filmHistory[0].url]);
  assert.equal(ui.openedOptions[0].resume, true);
  assert.equal(ui.elements.resumeLastOpen.textContent, '▶ Продолжить');
});

test('completed films are excluded from last card but retain 100% history bar', async () => {
  const ui = await setup({
    data: { 'film:447301': { ...movie, completed: true } },
    history: filmHistory
  });
  assert.equal(ui.elements.resumeLast.hidden, true);
  assert.equal(ui.rows[0].querySelector('.history-progress-track')
    .attrs['aria-valuenow'], '100');
});

test('series appear as last opened without false episode progress', async () => {
  const series = [{ title: 'Сериал', timestamp: 5000,
    url: 'https://www.kinokino.vip/series/123/' }];
  const ui = await setup({ history: series });
  assert.equal(ui.elements.resumeLast.hidden, false);
  assert.match(ui.elements.resumeLastMeta.textContent, /таймкод серии пока недоступен/);
  assert.equal(ui.elements.resumeLastProgress.hidden, true);
  assert.equal(ui.rows[0].querySelector('.history-item-progress'), null);
});

test('active film is not repeated in last card', async () => {
  const ui = await setup({
    history: filmHistory, data: { 'film:447301': movie },
    current: 'https://brogiro.cfd/film/447301/'
  });
  assert.equal(ui.elements.resumeLast.hidden, true);
  ui.setTab('https://www.kinopoisk.ru/');
  await ui.tabs.activated();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(ui.elements.resumeLast.hidden, false);
});

test('storage updates redraw progress while the history data stays intact', async () => {
  const ui = await setup({
    history: filmHistory, data: { 'film:447301': movie }
  });
  const changed = { ...movie, position: 300, updatedAt: 30000 };
  ui.setData({ 'film:447301': changed });
  ui.changes[0]({ kinoPlaybackProgressV1: { newValue: changed } }, 'local');
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.rows[0].querySelector('.history-progress-track')
    .attrs['aria-valuenow'], '50');
  assert.equal(filmHistory[0].title, 'Астрал');
});

test('out-of-range or mismatched data are not shown as progress', async () => {
  const ui = await setup({
    history: filmHistory,
    data: { 'film:447301': { ...movie, id: '123', position: 99999 } }
  });
  assert.equal(ui.rows[0].querySelector('.history-progress-track'), null);
  assert.equal(ui.elements.resumeLastProgress.hidden, true);
});


test('series remains ordinary open action without a false seek request', async () => {
  const history = [{ title: 'Сериал', timestamp: 5000,
    url: 'https://www.kinokino.vip/series/123/' }];
  const ui = await setup({ history });
  assert.equal(ui.elements.resumeLastOpen.textContent, '▶ Открыть');
  ui.elements.resumeLastOpen.events.click();
  assert.equal(ui.openedOptions[0].resume, false);
});
