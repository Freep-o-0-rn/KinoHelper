'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const marker = '// Resume playback: passive, manifest-scoped film autosave.';
const index = background.indexOf(marker);
if (index < 0) throw Error('Resume module not found');
const resumeModule = background.slice(background.lastIndexOf('// -------------------------', index));

function harness() {
  const local = {};
  const storage = {};
  const tab = {id: 7, url: 'https://brogiro.cfd/film/404900/',
    title: 'Во все тяжкие (сериал)'};
  const session = { type: 'film', id: '404900', title: tab.title,
    currentUrl: tab.url, startedAt: Date.now(),
    recognizedOrigins: ['https://brogiro.cfd'] };
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { id:'kino-test',
      getURL: name => 'chrome-extension://kino-test/' + name,
      sendMessage: async () => {},
      onInstalled: event(), onStartup: event(), onMessage: event() },
    tabs: { get: async () => tab, query: async () => [], onRemoved: event() },
    webNavigation: { getAllFrames: async () => [], onCommitted: event() },
    permissions: { contains: async () => true },
    scripting: { executeScript: async () => [],
      getRegisteredContentScripts: async () => [],
      unregisterContentScripts: async () => {} },
    storage: {
      local: { get: async key => ({ [key]:local[key] }),
        set: async values => Object.assign(local, values) },
      session: { get: async key => ({ [key]:storage[key] }),
        set: async values => Object.assign(storage, values),
        remove: async key => { delete storage[key]; } }
    }
  };
  const parseMedia = raw => {
    const match = new URL(raw).pathname.match(/^\/(film|series)\/(\d+)(?:\/|$)/);
    return match ? {type:match[1],id:match[2]} : null;
  };
  const context = {
    chrome, URL, Date, console,
    WATCH_BASE:'https://www.kinokino.vip',
    FALLBACK_WATCH_BASE:'https://flcksbr.top',
    KINOPOISK_BASE:'https://www.kinopoisk.ru',
    getSession: async () => session,
    parseMedia
  };
  vm.createContext(context);
  vm.runInContext(resumeModule + '\nthis.api = {' +
    'saveEpisodeObservation,getEpisodeIdentity,saveSeriesEpisodeProgress,' +
    'resumeIdentifyFilm,trustedSeriesTab};',context);
  const frame = { id:'kino-test', frameId:595, tab:{id:7},
    url:'https://theatre.stravers.live/player?token=PRIVATE' };
  const ext = { id:'kino-test',url:'chrome-extension://kino-test/sidepanel.html' };
  const checkpoint = (episode, position) =>
    context.api.saveSeriesEpisodeProgress({
      season:1,episode,currentTime:position,duration:3486,
      playedSeconds:35,event:'playing'
    },frame);
  return { ...context.api, local,storage,frame,ext,checkpoint };
}

test('film-shaped series URL requires actual iframe selection', async () => {
  const api = harness();
  assert.equal(await api.getEpisodeIdentity(7, api.ext), null);
  assert.equal(await api.trustedSeriesTab(7), null);
  assert.equal((await api.saveSeriesEpisodeProgress({
    season:1,episode:3,currentTime:40,duration:3486,
    playedSeconds:20,event:'playing'
  },api.frame)).ok,false);

  const observed = await api.saveEpisodeObservation({
    season:1,episode:3
  }, api.frame);
  assert.equal(observed.ok,true);
  const identity = await api.getEpisodeIdentity(7,api.ext);
  assert.equal(identity?.seriesId,'404900');
  assert.equal(identity?.season,1);
  assert.equal(identity?.episode,3);
  assert.equal(await api.resumeIdentifyFilm(7),null);
});

test('progress remains independent after switching verified episodes',async()=>{
  const api = harness();
  await api.saveEpisodeObservation({season:1,episode:3},api.frame);
  assert.equal((await api.checkpoint(3,42)).ok,true);
  await api.saveEpisodeObservation({season:1,episode:4},api.frame);
  assert.equal((await api.checkpoint(3,60)).ok,false);
  assert.equal((await api.checkpoint(4,20)).ok,true);
  const entries = api.local.kinoSeriesEpisodeProgressV1;
  assert.equal(entries['series:404900:1:3'].position,42);
  assert.equal(entries['series:404900:1:4'].position,20);
  assert.equal(api.local.kinoPlaybackProgressV1,undefined);
  assert.equal(JSON.stringify(api.local).includes('PRIVATE'),false);
});
