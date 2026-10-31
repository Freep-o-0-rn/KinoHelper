'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const worker = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const marker = '// Resume playback: passive, opt-in host-scoped film autosave.';
const start = worker.indexOf(marker);
if (start < 0) throw Error('Playback background module not found');
const background = worker.slice(worker.lastIndexOf('// -------------------------', start));
const observer = fs.readFileSync(path.join(__dirname, '..', 'playback-tracker.js'), 'utf8');

function makeBackground() {
  const data = {};
  const registered = new Map();
  let granted = true;
  let tab = { id: 7, url: 'https://brogiro.cfd/film/447301/?secret=DO_NOT_SAVE',
    title: 'Астрал' };
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { id: 'kino-test', onInstalled: event(), onStartup: event(),
      onMessage: event() },
    permissions: { contains: async () => granted, onAdded: event(), onRemoved: event() },
    tabs: { get: async () => tab, query: async () => [tab] },
    storage: { local: { get: async key => ({ [key]: data[key] }),
      set: async object => Object.assign(data, object) } },
    scripting: {
      getRegisteredContentScripts: async () => [...registered.values()],
      registerContentScripts: async entries =>
        entries.forEach(entry => registered.set(entry.id, entry)),
      unregisterContentScripts: async () => registered.clear(),
      executeScript: async () => []
    },
    webNavigation: { getAllFrames: async () => [] }
  };
  const parseMedia = raw => {
    const match = new URL(raw).pathname.match(/^\/(film|series)\/(\d+)(?:\/|$)/);
    return match ? { type: match[1], id: match[2] } : null;
  };
  const context = {
    chrome, URL, console,
    WATCH_BASE: 'https://www.kinokino.vip',
    FALLBACK_WATCH_BASE: 'https://flcksbr.top',
    KINOPOISK_BASE: 'https://www.kinopoisk.ru',
    getSession: async () => null,
    parseMedia
  };
  vm.createContext(context);
  vm.runInContext(background + '\nthis.resumeAPI = { saveResumeProgress };', context);
  return { api: context.resumeAPI, data, registered,
    setTab: next => { tab = next; },
    revoke: () => { granted = false; } };
}

test('progress is stored by Kinopoisk film ID, not tab ID or a secret player URL', async () => {
  const { api, data } = makeBackground();
  const sender = {
    id: 'kino-test', tab: { id: 7 },
    url: 'https://theatre.stravers.live/watch?auth=VERY_PRIVATE'
  };
  const send = (position, event = 'playing', played = 45) =>
    api.saveResumeProgress({ currentTime: position, duration: 6722,
      playedSeconds: played, event }, sender);
  const first = await send(87);
  assert.equal(first.ok, true);
  const item = data.kinoPlaybackProgressV1['film:447301'];
  assert.equal(item.position, 87);
  assert.equal(item.title, 'Астрал');
  assert.equal(item.completed, false);
  assert.equal(JSON.stringify(data).includes('DO_NOT_SAVE'), false);
  assert.equal(JSON.stringify(data).includes('VERY_PRIVATE'), false);

  await send(6722, 'ended', 90);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].completed, true);
  await send(6720, 'pagehide', 90);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].completed, true);
  await send(25, 'playing', 20);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].completed, false);
});

test('only trusted player iframe with identified film may write', async () => {
  const { api, data, setTab } = makeBackground();
  const valid = { currentTime: 35, duration: 600, playedSeconds: 10, event: 'playing' };
  const sender = { id: 'kino-test', tab: { id: 7 },
    url: 'https://theatre.stravers.live/watch' };
  assert.equal((await api.saveResumeProgress(valid, { ...sender,
    url: 'https://unknown.example/watch' })).ok, false);
  assert.equal((await api.saveResumeProgress({ ...valid, duration: 0 }, sender)).ok, false);
  setTab({ id: 7, url: 'https://brogiro.cfd/series/447301/',
    title: 'Сериал' });
  assert.equal((await api.saveResumeProgress(valid, sender)).ok, false);
  assert.equal(data.kinoPlaybackProgressV1, undefined);
});

test('dynamic content script is registered only for the permitted iframe host', async () => {
  const { registered } = makeBackground();
  for (let i = 0; i < 10 && !registered.size; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const entry = registered.get('kino-playback-tracker-v1');
  assert.ok(entry);
  assert.deepEqual(Array.from(entry.matches), ['https://theatre.stravers.live/*']);
  assert.deepEqual(Array.from(entry.js), ['playback-tracker.js']);
  assert.equal(entry.persistAcrossSessions, true);
});

test('observer skips invalid ad video and sends real progress and pause', () => {
  const messages = [];
  const handlers = {};
  let milliseconds = 100000;
  let interval;
  const primary = {
    isConnected: true, currentTime: 0, duration: 3127, paused: false,
    ended: false, seeking: false, videoWidth: 854, videoHeight: 480,
    readyState: 4, playbackRate: 1,
    getBoundingClientRect: () => ({ width: 854, height: 480 }),
    addEventListener(name, callback) { (handlers[name] ||= []).push(callback); }
  };
  const empty = {
    ...primary, duration: NaN, readyState: 0, videoWidth: 0,
    videoHeight: 0, paused: true, addEventListener() {}
  };
  const document = {
    documentElement: {},
    querySelectorAll(selector) {
      return selector === 'video' ? [primary, empty] : [];
    }
  };
  const clock = { now: () => milliseconds };
  const context = {
    document, Date: clock, console,
    globalThis: {},
    chrome: { runtime: { id: 'kino-test',
      sendMessage: async message => { messages.push(message); return { ok: true }; } } },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: cb => { interval = cb; return 1; },
    clearInterval() {},
    window: { addEventListener() {} }
  };
  vm.createContext(context);
  vm.runInContext(observer, context);
  for (let i = 0; i < 80; i++) {
    milliseconds += 250;
    primary.currentTime += 0.25;
    for (const callback of handlers.timeupdate || []) callback();
  }
  interval();
  assert.ok(messages.length >= 2);
  assert.ok(messages.every(message =>
    message.action === 'kinoPlaybackProgress' &&
    message.payload.duration === 3127));
  primary.paused = true;
  for (const callback of handlers.pause || []) callback();
  assert.equal(messages[messages.length - 1].payload.event, 'pause');
});


test('revoking optional host permission immediately prevents new progress writes', async () => {
  const { api, data, revoke } = makeBackground();
  const sender = { id: 'kino-test', tab: { id: 7 },
    url: 'https://theatre.stravers.live/player' };
  const payload = { currentTime: 150, duration: 6722,
    playedSeconds: 20, event: 'playing' };
  const first = await api.saveResumeProgress(payload, sender);
  assert.equal(first.ok, true);
  revoke();
  const second = await api.saveResumeProgress({ ...payload, currentTime: 170 }, sender);
  assert.equal(second.ok, false);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].position, 150);
});
