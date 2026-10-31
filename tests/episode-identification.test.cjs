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
    controls = [], runTicks = 1 } = {}) {
  const messages = [];
  let now = 100000;
  let tick;
  const context = {
    globalThis: {}, URL,
    location: { href: url },
    Date: { now: () => now },
    document: {
      documentElement: {},
      querySelectorAll: selector => selector.includes('aria-selected') ? controls : []
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
