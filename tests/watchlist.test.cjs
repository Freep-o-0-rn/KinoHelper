'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'watchlist.js'), 'utf8');

function harness(initial = {}) {
    const memory = new Map(Object.entries(initial));
    const localStorage = {
        getItem: key => memory.has(key) ? memory.get(key) : null,
        setItem: (key, value) => memory.set(key, String(value)),
        removeItem: key => memory.delete(key)
    };
    const window = {
        addEventListener() {},
        dispatchEvent() {}
    };
    const document = {
        readyState: 'loading',
        addEventListener() {},
        querySelectorAll() { return []; },
        getElementById() { return null; },
        createElement() {
            return {
                classList: { toggle() {} },
                listeners: {},
                addEventListener(name, cb) { this.listeners[name] = cb; },
                setAttribute(name, value) { this[name] = value; }
            };
        }
    };
    vm.runInNewContext(source, { window, document, localStorage,
        Event: class { constructor(type) { this.type = type; } },
        URL, console, chrome: { tabs: { create: async () => {} } }
    }, { filename: 'watchlist.js' });
    return { api: window.KinoWatchlist, memory };
}

test('adding, removing and reopening preserve the local list without altering history', () => {
    const initialHistory = '[{"title":"Saved","url":"https://example.com","timestamp":123}]';
    const { api, memory } = harness({ kinopoiskHistory: initialHistory });
    assert.equal(api.getAll().length, 0);
    assert.equal(api.toggle({ type: 'film', id: 258687, title: 'Интерстеллар', year: 2014 }), true);
    assert.equal(api.contains({ type: 'film', id: '258687' }), true);
    assert.equal(api.getAll()[0].year, 2014);
    assert.equal(memory.get('kinopoiskHistory'), initialHistory);
    assert.equal(api.toggle({ type: 'film', id: 258687 }), true);
    assert.equal(api.getAll().length, 0);

    api.toggle({ type: 'film', id: 258687, title: 'Интерстеллар' });
    const reloaded = harness(Object.fromEntries(memory)).api;
    assert.equal(reloaded.contains({ type: 'film', id: '258687' }), true);
});

test('film and series IDs are independent and invalid IDs are rejected', () => {
    const { api } = harness();
    api.toggle({ type: 'film', id: 99, title: 'Film' });
    api.toggle({ type: 'series', id: 99, title: 'Series' });
    assert.equal(api.getAll().length, 2);
    assert.equal(api.toggle({ type: 'film', id: 99 }), true);
    assert.equal(api.getAll().length, 1);
    assert.equal(api.getAll()[0].type, 'series');
    assert.equal(api.toggle({ type: 'film', id: '../99' }), false);
    assert.equal(api.toggle({ type: 'other', id: 99 }), false);
});

test('bookmark state updates when toggling the search button', () => {
    const { api } = harness();
    const button = api.createSearchButton({ type: 'series', id: 123, title: 'Example' });
    assert.equal(button.textContent, '☆ Буду смотреть');
    button.listeners.click();
    assert.equal(api.contains({ type: 'series', id: 123 }), true);
    api.syncSearchButton(button, button._kinoMovie);
    assert.equal(button.textContent, '✓ В списке');
    button.listeners.click();
    assert.equal(api.contains({ type: 'series', id: 123 }), false);
});

test('untrusted poster URLs are not stored', () => {
    const { api } = harness();
    api.toggle({ type: 'film', id: 123, title: 'Example', poster: 'javascript:alert(1)' });
    assert.equal(api.getAll()[0].posterUrl, '');
});

test('invalid JSON is handled without throwing on reads', () => {
    const { api } = harness({ kinoHelperWatchlistV1: '{corrupted' });
    assert.deepEqual(Array.from(api.getAll()), []);
});
