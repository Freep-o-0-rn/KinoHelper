'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const worker = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const marker = '// Resume playback: passive, manifest-scoped film autosave.';
const start = worker.indexOf(marker);
if (start < 0) throw Error('Playback background module not found');
const background = worker.slice(worker.lastIndexOf('// -------------------------', start));
const observer = fs.readFileSync(path.join(__dirname, '..', 'playback-tracker.js'), 'utf8');

function makeBackground() {
  const data = {};
  const sessionData = {};
  const registered = new Map();
  let granted = true;
  let tab = { id: 7, url: 'https://brogiro.cfd/film/447301/?secret=DO_NOT_SAVE',
    title: 'Астрал' };
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { id: 'kino-test',
      getURL: path => 'chrome-extension://kino-test/' + path,
      onInstalled: event(), onStartup: event(),
      onMessage: event() },
    permissions: { contains: async () => granted, onAdded: event(), onRemoved: event() },
    tabs: { get: async () => tab, query: async () => [tab],
      onRemoved: event() },
    storage: {
      local: { get: async key => ({ [key]: data[key] }),
        set: async object => Object.assign(data, object) },
      session: { get: async key => ({ [key]: sessionData[key] }),
        set: async object => Object.assign(sessionData, object),
        remove: async key => { delete sessionData[key]; } }
    },
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
    getSession: async () => ({
      id: '447301', type: 'film', title: 'Астрал',
      startedAt: Date.now(), recognizedOrigins: ['https://brogiro.cfd'],
      currentUrl: tab.url
    }),
    parseMedia
  };
  vm.createContext(context);
  vm.runInContext(background + '\nthis.resumeAPI = { saveResumeProgress, armResumeForTab, readPendingResume, acknowledgeResume };', context);
  return { api: context.resumeAPI, data, sessionData, registered,
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

  // Switching tabs flushes the checkpoint without periodic background writes.
  await send(95, 'hidden', 45);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].position, 95);

  // Existing verified coverage from an earlier session allows the real
  // video-ended event to finish without replaying the opening.
  data.kinoPlaybackCoverageV1={
    'film:447301':{duration:6722,ranges:[[0,5800]],updatedAt:Date.now()}
  };
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

test('manifest auto-injects both tracker and seek only into the known iframe host', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..',
    'manifest.json'), 'utf8'));
  assert.ok(manifest.host_permissions.includes('https://theatre.stravers.live/*'));
  assert.ok(manifest.host_permissions.includes('https://brogiro.cfd/*'));
  assert.deepEqual(manifest.content_scripts[0].js,
    ['playback-tracker.js', 'playback-resume.js']);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.optional_host_permissions, undefined);
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
  const documentEvents = {};
  const document = {
    documentElement: {},
    hidden: false,
    addEventListener(name, cb) { documentEvents[name] = cb; },
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
  // Over 40 seconds: first checkpoint after confirming playback, then ~5s cadence.
  for (let i = 0; i < 160; i++) {
    milliseconds += 250;
    primary.currentTime += 0.25;
    for (const callback of handlers.timeupdate || []) callback();
  }
  interval();
  const periodic = messages.filter(message => message.payload.event === 'playing');
  assert.equal(periodic.length, 8);
  for (let i = 1; i < periodic.length; i++) {
    const gap = periodic[i].payload.currentTime - periodic[i - 1].payload.currentTime;
    assert.ok(gap >= 4.8 && gap <= 5.2,
      'Expected ~5-second checkpoint interval, got ' + gap);
  }
  assert.ok(messages.every(message =>
    message.action === 'kinoPlaybackProgress' &&
    message.payload.duration === 3127));
  primary.paused = true;
  for (const callback of handlers.pause || []) callback();
  assert.equal(messages[messages.length - 1].payload.event, 'pause');
  assert.equal(messages[messages.length - 1].payload.currentTime, 40);
  primary.currentTime = 120;
  for (const callback of handlers.seeked || []) callback();
  assert.equal(messages[messages.length - 1].payload.event, 'seeked');
  assert.equal(messages[messages.length - 1].payload.currentTime, 120);
  primary.currentTime = 122;
  document.hidden = true;
  documentEvents.visibilitychange();
  assert.equal(messages[messages.length - 1].payload.event, 'hidden');
  assert.equal(messages[messages.length - 1].payload.currentTime, 122);
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


test('resuming protects the previous checkpoint until the player confirms a seek', async () => {
  const { api, data, sessionData } = makeBackground();
  data.kinoPlaybackProgressV1 = {
    'film:447301': { type: 'film', id: '447301', title: 'Астрал',
      position: 150, duration: 600, updatedAt: Date.now(), completed: false }
  };
  const extension = { id: 'kino-test',
    url: 'chrome-extension://kino-test/sidepanel.html' };
  const playerSender = { id: 'kino-test',
    url: 'https://theatre.stravers.live/player',
    tab: { id: 7 }, frameId: 333 };
  const armed = await api.armResumeForTab(7, '447301', extension);
  assert.equal(armed.ok, true);
  assert.equal((await api.readPendingResume(playerSender)).position, 150);
  const initial = await api.saveResumeProgress({
    currentTime: 4, duration: 600, playedSeconds: 5, event: 'playing'
  }, playerSender);
  assert.equal(initial.ok, false);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].position, 150);
  assert.equal((await api.acknowledgeResume(playerSender, 3)).ok, false);
  assert.equal((await api.acknowledgeResume(playerSender, 151)).ok, true);
  assert.equal(Object.keys(sessionData).length, 0);
  const next = await api.saveResumeProgress({
    currentTime: 172, duration: 600, playedSeconds: 15, event: 'playing'
  }, playerSender);
  assert.equal(next.ok, true);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].position, 172);
});



test('94% timeline does not complete without 85% unique viewed coverage',async()=>{
  const {api,data}=makeBackground();
  const sender={id:'kino-test',tab:{id:7},
    url:'https://theatre.stravers.live/player'};
  await api.saveResumeProgress({
    currentTime:6580,duration:6989,playedSeconds:140,event:'playing',
    watchedRanges:[[6550,6555]]
  },sender);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].completed,false);
  assert.ok(data.kinoPlaybackCoverageV1['film:447301'].ranges.length===1);
});

test('verified repeated intervals are counted once, even across sessions',async()=>{
  const {api,data}=makeBackground();
  const sender={id:'kino-test',tab:{id:7},
    url:'https://theatre.stravers.live/player'};
  const send=(a,b,event='playing')=>api.saveResumeProgress({
    currentTime:b,duration:600,playedSeconds:120,event,
    watchedRanges:[[a,b]]
  },sender);
  for(let start=0;start<300;start+=5)await send(start,start+5);
  for(let start=0;start<300;start+=5)await send(start,start+5);
  const covered=data.kinoPlaybackCoverageV1['film:447301'].ranges;
  assert.equal(covered.length,1);
  assert.equal(covered[0][1]-covered[0][0],300);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].completed,false);
  for(let start=300;start<510;start+=5)await send(start,start+5);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].completed,false,
    '85% only grants eligibility, not automatic completion');
  await send(595,600,'ended');
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].completed,true,
    'confirmed video end with 85% unique coverage completes');
});

test('seeking to credits followed by ended cannot finish with insufficient coverage',async()=>{
  const {api,data}=makeBackground();
  const sender={id:'kino-test',tab:{id:7},
    url:'https://theatre.stravers.live/player'};
  await api.saveResumeProgress({
    currentTime:590,duration:600,playedSeconds:140,event:'seeked'
  },sender);
  await api.saveResumeProgress({
    currentTime:600,duration:600,playedSeconds:140,event:'ended',
    watchedRanges:[[590,600]]
  },sender);
  assert.equal(data.kinoPlaybackProgressV1['film:447301'].completed,false);
});


test('verified film completion triggers one transition, not one per checkpoint',async()=>{
  const {api,data}=makeBackground();
  const sender={id:'kino-test',tab:{id:7},
    url:'https://theatre.stravers.live/player'};
  data.kinoPlaybackCoverageV1={
    'film:447301':{duration:600,ranges:[[0,520]],updatedAt:Date.now()}
  };
  const first=await api.saveResumeProgress({
    currentTime:599,duration:600,playedSeconds:140,event:'ended'
  },sender);
  assert.equal(first.completed,true);
  assert.equal(first.newlyCompleted,true);
  const next=await api.saveResumeProgress({
    currentTime:599,duration:600,playedSeconds:141,event:'pause'
  },sender);
  assert.equal(next.completed,true);
  assert.equal(next.newlyCompleted,false);
});
