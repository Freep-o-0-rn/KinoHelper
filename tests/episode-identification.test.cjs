'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const detector = fs.readFileSync(path.join(__dirname, '..', 'episode-detector.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const workerIndex = worker.indexOf('// 1.550: season/episode recognition');
assert.ok(workerIndex >= 0);
const episodeWorker = worker.slice(workerIndex);

async function detect({ url = 'https://theatre.stravers.live/player',
    controls = [], playerButtons = [], activeOptions = [], runTicks = 1 } = {}) {
  const messages = [];
  let now = 100000;
  let tick;
  const context = {
    globalThis: {}, URL,
    location: { href: url },
    Date: { now: () => now },
    document: {
      documentElement: {},
      querySelectorAll: selector => selector === 'button.select__item'
        ? playerButtons : selector === 'button.select__drop-item.active'
          ? activeOptions : selector.includes('aria-selected') ? controls : []
    },
    chrome: { runtime: { sendMessage: async message => {
      messages.push(message);
      return { ok: true };
    } } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    window: { addEventListener() {} }
  };
  vm.runInNewContext(detector, context);
  for (let i = 0; i < runTicks; i++) {
    now += 2500;
    tick();
  }
  await Promise.resolve();
  return messages;
}

function activeControl(text, attrs = {}) {
  return {
    hidden: false,
    textContent: text,
    getAttribute: name => attrs[name] || null,
    getBoundingClientRect: () => ({ width: 100, height: 30 })
  };
}

test('extracts explicit season/episode from player URL without sharing token', async () => {
  const messages = await detect({
    url: 'https://theatre.stravers.live/player?season=2&episode=4&token=SECRET'
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), {
    action: 'kinoSeriesEpisodeObserved',
    payload: { season: 2, episode: 4 }
  });
  assert.equal(JSON.stringify(messages).includes('SECRET'), false);
});

test('accepts unambiguous selected episode labels', async () => {
  const messages = await detect({
    controls: [activeControl('Сезон 2 серия 4')]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].payload)),
    { season: 2, episode: 4 });
});

test('accepts two selected controls but never an unselected episode', async () => {
  const messages = await detect({
    controls: [activeControl('Сезон 3'), activeControl('Серия 11')]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].payload)),
    { season: 3, episode: 11 });
});

test('conflicting or incomplete selection is not reported', async () => {
  const conflicting = await detect({
    url: 'https://theatre.stravers.live/player?season=2&episode=3',
    controls: [activeControl('Сезон 2 серия 4')]
  });
  assert.equal(conflicting.length, 0);
  const incomplete = await detect({
    controls: [activeControl('Сезон 2')]
  });
  assert.equal(incomplete.length, 0);
});

test('unknown player markup does not report guessed episode numbers', async () => {
  assert.equal((await detect({
    controls: [activeControl('1'), activeControl('2')]
  })).length, 0);
});

function makeWorker() {
  const sessionData = {};
  const tab = { id: 7, url: 'https://brogiro.cfd/series/123/',
    title: 'Сериал 123' };
  const notifications = [];
  let currentSession = { type: 'series', id: '123', title: 'Сериал 123',
    currentUrl: tab.url };
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      id: 'kino-test',
      getURL: path => 'chrome-extension://kino-test/' + path,
      sendMessage: async message => { notifications.push(message); },
      onMessage: event()
    },
    storage: { session: {
      get: async key => ({ [key]: sessionData[key] }),
      set: async obj => Object.assign(sessionData, obj),
      remove: async key => { delete sessionData[key]; }
    } },
    tabs: { get: async () => tab, onRemoved: event() },
    webNavigation: { onCommitted: event() }
  };
  const context = {
    chrome, URL, Date, resumeOrigin: raw => new URL(raw).origin,
    WATCH_BASE: 'https://www.kinokino.vip',
    FALLBACK_WATCH_BASE: 'https://flcksbr.top',
    parseMedia: raw => {
      const match = new URL(raw).pathname.match(/^\/(film|series)\/(\d+)\/?/);
      return match ? { type: match[1], id: match[2] } : null;
    },
    getSession: async () => currentSession
  };
  vm.runInNewContext(episodeWorker +
    '\nthis.api = { saveEpisodeObservation, getEpisodeIdentity };', context);
  return {
    api: context.api, sessionData, notifications, tab,
    setSession: value => { currentSession = value; },
    sender: frameId => ({
      id: 'kino-test', frameId, tab: { id: 7 },
      url: 'https://theatre.stravers.live/player?token=PRIVATE'
    }),
    extension: { id: 'kino-test',
      url: 'chrome-extension://kino-test/sidepanel.html' }
  };
}


function playerButton(text, cls = 'select__item') {
  return {
    hidden: false,
    textContent: text,
    getAttribute(name) { return name === 'class' ? cls : null; },
    getBoundingClientRect() { return { width: 160, height: 34 }; }
  };
}

test('changing a selected episode replaces the old identity and clears on ambiguity', async () => {
  const messages = [];
  let time = 100000;
  let tick;
  let current = [playerButton('Сезон 1'), playerButton('Серия 1')];
  const context = {
    globalThis: {}, URL,
    location: { href: 'https://theatre.stravers.live/player' },
    Date: { now: () => time },
    document: {
      documentElement: {},
      querySelectorAll(selector) {
        if (selector === 'button.select__item') return current;
        return [];
      }
    },
    chrome: { runtime: { sendMessage: async message => {
      messages.push(message.payload); return { ok: true };
    } } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    window: { addEventListener() {} }
  };
  vm.runInNewContext(detector, context);
  time += 2500;
  tick();
  current = [playerButton('Сезон 1'), playerButton('Серия 2')];
  time += 2500;
  tick(); // changing identity starts a new confirmation interval
  time += 2500;
  tick();
  current = [playerButton('Серия 3')]; // no season -> unknown
  time += 2500;
  tick();
  time += 2500;
  tick();
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { clear: true }
  ]);
});

test('real player selector: season 1 episode 1 shown with dropdown open', async () => {
  const messages = await detect({
    playerButtons: [playerButton('Сезон 1'), playerButton('Серия 1')],
    activeOptions: [playerButton('Серия 1', 'select__drop-item active')],
    // The old generic detector could see this all-episodes container.
    controls: [activeControl('Серия 1 Серия 2 Серия 3 Серия 4')]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].payload)),
    { season: 1, episode: 1 });
});

test('real player selector: episode 2 recognized with closed dropdown', async () => {
  const messages = await detect({
    playerButtons: [playerButton('Сезон 1'), playerButton('Серия 2')],
    controls: []
  });
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].payload)),
    { season: 1, episode: 2 });
});

test('conflicting dropdown state or missing chosen season is not inferred', async () => {
  const mismatch = await detect({
    playerButtons: [playerButton('Сезон 1'), playerButton('Серия 2')],
    activeOptions: [playerButton('Серия 1', 'select__drop-item active')]
  });
  assert.equal(mismatch.length, 0);
  const missingSeason = await detect({
    playerButtons: [playerButton('Серия 2')],
    controls: [activeControl('Сезон 1 Серия 2')]
  });
  assert.equal(missingSeason.length, 0);
});

test('player selector requires both values to be independently unambiguous', async () => {
  const messages = await detect({
    playerButtons: [playerButton('Сезон 1'), playerButton('Сезон 2'),
      playerButton('Серия 2')]
  });
  assert.equal(messages.length, 0);
});

test('background accepts same series across frames, rejects a disagreement', async () => {
  const t = makeWorker();
  assert.equal((await t.api.saveEpisodeObservation(
    { season: 2, episode: 4 }, t.sender(457))).ok, true);
  let reply = await t.api.getEpisodeIdentity(7, t.extension);
  assert.equal(reply?.episode, 4);
  await t.api.saveEpisodeObservation({ season: 2, episode: 4 }, t.sender(0));
  reply = await t.api.getEpisodeIdentity(7, t.extension);
  assert.equal(reply?.season, 2);
  await t.api.saveEpisodeObservation({ season: 2, episode: 5 }, t.sender(0));
  assert.equal(await t.api.getEpisodeIdentity(7, t.extension), null);
  assert.equal(JSON.stringify(t.sessionData).includes('PRIVATE'), false);
});

test('a lost episode selection clears stale metadata', async () => {
  const t = makeWorker();
  const sender = t.sender(457);
  assert.equal((await t.api.saveEpisodeObservation(
    { season: 1, episode: 2 }, sender)).ok, true);
  assert.equal((await t.api.getEpisodeIdentity(7, t.extension)).episode, 2);
  assert.equal((await t.api.saveEpisodeObservation(
    { clear: true }, sender)).ok, true);
  assert.equal(await t.api.getEpisodeIdentity(7, t.extension), null);
});

test('background refuses film tabs and untrusted sender origins', async () => {
  const t = makeWorker();
  const untrusted = await t.api.saveEpisodeObservation(
    { season: 1, episode: 1 }, { ...t.sender(0),
      url: 'https://unknown.example/player' });
  assert.equal(untrusted.ok, false);
  t.tab.url = 'https://brogiro.cfd/film/123/';
  t.setSession({ type: 'film', id: '123', currentUrl: t.tab.url });
  assert.equal((await t.api.saveEpisodeObservation(
    { season: 1, episode: 1 }, t.sender(0))).ok, false);
});
