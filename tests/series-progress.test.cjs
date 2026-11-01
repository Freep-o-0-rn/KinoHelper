'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const start = background.indexOf('// 1.553: Episode checkpoints');
if (start < 0) throw Error('Series checkpoint worker block missing');
const worker = background.slice(start);

function mock() {
  const local = { kinoPlaybackProgressV1: {
    'film:447301': {type:'film',id:'447301',position:100}
  }};
  const session = {};
  let permitted = true;
  let seriesId = '404900';
  const sender = { id:'kino-test', frameId:595, tab:{id:7},
    url:'https://theatre.stravers.live/player?token=DO_NOT_SAVE' };
  function select(season, episode) {
    session['kinoEpisodeSelection:7'] = {
      seriesId, sources: {
        '595': {season, episode, at: Date.now()}
      }
    };
  }
  select(1,3);
  const chrome = {
    storage: {
      local: {get: async key => ({[key]:local[key]}),
        set: async data => Object.assign(local,data)},
      session: { get: async key => ({[key]:session[key]}) }
    },
    permissions:{contains:async()=>permitted}
  };
  const scope = {chrome, Date, Number, Object, String, console,
    RESUME_PLAYER_ORIGIN:'https://theatre.stravers.live/*',
    resumeSourceIsTrusted:s => s?.id === 'kino-test' &&
      s?.tab?.id === 7 &&
      new URL(s.url).origin === 'https://theatre.stravers.live',
    validatePlaybackEvent:data => {
      if (!data || data.currentTime < 1 || data.duration < 60 ||
          data.playedSeconds < 2 || !Number.isFinite(data.currentTime))
        return null;
      return { position: Math.floor(data.currentTime),
        duration:Math.floor(data.duration),
        played:data.playedSeconds,event:data.event };
    },
    trustedSeriesTab:async()=> ({id:seriesId,title:'Тестовый сериал'}),
    episodeKey:tabId=>'kinoEpisodeSelection:'+tabId,
    resolvedEpisode:entry => entry?.sources?.['595']
      ? {season:entry.sources['595'].season,
        episode:entry.sources['595'].episode} : null,
    EPISODE_TTL_MS:20000
  };
  scope.chrome.runtime={onMessage:{addListener(){}}};
  vm.createContext(scope);
  vm.runInContext(worker+'\nthis.saveSeries=saveSeriesEpisodeProgress;',scope);
  return { save:(s,e,position,event='playing',played=40)=>scope.saveSeries(
    {season:s,episode:e,currentTime:position,duration:1800,
      playedSeconds:played,event},sender),local,session,select,
    sender, revoke:()=>{permitted=false;}, scope };
}

test('stores separate checkpoints per episode without touching film history',async()=>{
  const m=mock();
  assert.equal((await m.save(1,3,300)).ok,true);
  m.select(1,4);
  assert.equal((await m.save(1,4,55)).ok,true);
  const records=m.local.kinoSeriesEpisodeProgressV1;
  assert.equal(records['series:404900:1:3'].position,300);
  assert.equal(records['series:404900:1:4'].position,55);
  assert.equal(m.local.kinoPlaybackProgressV1['film:447301'].position,100);
  assert.equal(JSON.stringify(m.local).includes('DO_NOT_SAVE'),false);
});

test('rejects stale series selection and a late checkpoint for old episode',async()=>{
  const m=mock();
  await m.save(1,3,300);
  m.select(1,4);
  const result=await m.save(1,3,355);
  assert.equal(result.ok,false);
  assert.equal(m.local.kinoSeriesEpisodeProgressV1['series:404900:1:3'].position,300);
});

test('rejects unknown sender, permission revocation and malformed metadata',async()=>{
  const m=mock();
  const payload={season:1,episode:3,currentTime:30,duration:1800,
    playedSeconds:12,event:'playing'};
  const a=await m.scope.saveSeriesEpisodeProgress(payload,{
    ...m.sender,url:'https://untrusted.example/player'
  });
  assert.equal(a.ok,false);
  assert.equal((await m.save(1,999,30)).ok,false);
  m.revoke();
  assert.equal((await m.save(1,3,30)).ok,false);
});

test('marks completed episode without making next episode completed',async()=>{
  const m=mock();
  m.local.kinoPlaybackCoverageV1={
    'series:404900:1:3':{duration:1800,ranges:[[0,1540]],updatedAt:Date.now()}
  };
  await m.save(1,3,1799,'ended');
  assert.equal(m.local.kinoSeriesEpisodeProgressV1['series:404900:1:3'].completed,true);
  m.select(1,4);
  await m.save(1,4,60);
  assert.equal(m.local.kinoSeriesEpisodeProgressV1['series:404900:1:4'].completed,false);
});


test('video observer never assigns old stream progress to newly selected episode', async () => {
  const tracker = fs.readFileSync(path.join(__dirname, '..',
    'series-progress-tracker.js'), 'utf8');
  const callbacks = {};
  const messages = [];
  let timeMs = 100000;
  let videoTime = 0;
  let source = 'blob:episode-3';
  let episode = 3;
  let selectorPresent = true;
  const video = {
    isConnected: true, duration: 1800, readyState: 4, paused: false,
    seeking: false, ended: false, videoWidth: 854, videoHeight: 480,
    playbackRate: 1,
    get currentTime() { return videoTime; },
    get currentSrc() { return source; },
    getBoundingClientRect() { return { width: 854, height: 480 }; },
    addEventListener(name, callback) { (callbacks[name] ||= []).push(callback); }
  };
  const btn = text => ({
    textContent: text, hidden: false,
    getAttribute() { return null; },
    getBoundingClientRect() { return { width: 120, height: 32 }; }
  });
  const page = {
    documentElement: {}, hidden: false,
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector === 'video') return [video];
      if (selector === 'button.select__item') return selectorPresent ?
        [btn('Сезон 1'), btn('Серия ' + episode)] : [];
      return [];
    }
  };
  const context = {
    globalThis: {}, document: page, Date: { now: () => timeMs },
    chrome: { runtime: { id:'kino-test',
      sendMessage: async message => { messages.push(message); return {ok:true}; } } },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval() { return 1; }, clearInterval() {},
    window: { addEventListener() {} }
  };
  vm.createContext(context);
  vm.runInContext(tracker, context);
  const step = count => {
    for (let i=0; i<count; i++) {
      timeMs += 250;
      videoTime += 0.25;
      for (const fn of callbacks.timeupdate || []) fn();
    }
  };
  step(60);
  const original = messages.length;
  assert.ok(original >= 2);
  assert.ok(messages.every(m=>m.payload.episode===3));
  selectorPresent = false;
  step(1);
  selectorPresent = true;
  episode = 4;
  step(20);
  assert.equal(messages.length, original);
  // The new source and fresh playback validate the new episode.
  source = 'blob:episode-4';
  videoTime = 0;
  step(60);
  const next = messages.slice(original);
  assert.ok(next.length >= 2);
  assert.ok(next.every(m=>m.payload.episode===4));
  assert.ok(next[0].payload.currentTime < 10);
  assert.equal(JSON.stringify(messages).includes('blob:episode'), false);
});

test('without explicit selected season and episode, video time is not recorded', () => {
  const tracker = fs.readFileSync(path.join(__dirname, '..',
    'series-progress-tracker.js'), 'utf8');
  const sent = [];
  const handlers = {};
  let clock = 100000;
  let currentTime = 0;
  const video = {
    isConnected:true,readyState:4,duration:1500,paused:false,
    seeking:false,ended:false,videoWidth:854,videoHeight:480,playbackRate:1,
    get currentTime(){return currentTime;},
    getBoundingClientRect(){return{width:854,height:480}},
    addEventListener(event,cb){(handlers[event] ||= []).push(cb)}
  };
  const context={
    globalThis:{},Date:{now:()=>clock},
    document:{documentElement:{},hidden:false,addEventListener(){},
      querySelectorAll:s=>s==='video'?[video]:[]},
    chrome:{runtime:{id:'kino-test',sendMessage:async m=>sent.push(m)}},
    MutationObserver:class{observe(){}disconnect(){}},
    window:{addEventListener(){}},
    setInterval(){return 1},clearInterval(){}
  };
  vm.runInNewContext(tracker,context);
  for(let i=0;i<60;i++){
    clock+=250;currentTime+=0.25;
    for(const cb of handlers.timeupdate||[])cb();
  }
  assert.equal(sent.length,0);
});



test('85% unique episode coverage is eligible but not completed until the end',async()=>{
  const m=mock();
  m.local.kinoPlaybackCoverageV1={
    'series:404900:1:3':{duration:1800,ranges:[[0,1530]],updatedAt:Date.now()}
  };
  await m.save(1,3,1690,'playing',130);
  assert.equal(m.local.kinoSeriesEpisodeProgressV1['series:404900:1:3'].completed,false);
  await m.save(1,3,1799,'ended',130);
  assert.equal(m.local.kinoSeriesEpisodeProgressV1['series:404900:1:3'].completed,true);
  m.select(1,4);
  await m.save(1,4,120,'playing',130);
  assert.equal(m.local.kinoSeriesEpisodeProgressV1['series:404900:1:4'].completed,false);
});

test('episode reaching credits after seek is not completed',async()=>{
  const m=mock();
  await m.save(1,3,1740,'seeked',130);
  await m.save(1,3,1799,'ended',130);
  assert.equal(m.local.kinoSeriesEpisodeProgressV1['series:404900:1:3'].completed,false);
});
