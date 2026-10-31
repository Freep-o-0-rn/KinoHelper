'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const worker = read('background.js');
const seekScript = read('series-playback-resume.js');
const marker = '// 1.555 — one-shot episode restoration';
const endMarker = '// 1.553: Episode checkpoints';
const workerPart = worker.slice(worker.indexOf(marker), worker.indexOf(endMarker));
if (!workerPart.includes('armSeriesResume')) throw Error('Cannot find series resume worker');

function backgroundHarness() {
  const sessionValues = {};
  const local = {kinoSeriesEpisodeProgressV1: {
    'series:404900:2:3': {
      type:'series', id:'404900',season:2,episode:3,
      position:83,duration:2895,completed:false
    }
  }};
  let tab = {id:7,url:'about:blank'};
  const session={id:'404900',type:'series',
    watchUrl:'https://brogiro.cfd/film/404900/',startedAt:Date.now()};
  const events = () => ({addListener() {}});
  const chrome = {
    runtime: {id:'kino-test', getURL:()=> 'chrome-extension://kino-test/',
      onMessage:events()}, tabs: {get:async()=>tab,onRemoved:events()},
    storage: {
      local: {get:async k=>({[k]:local[k]})},
      session: {get:async k=>({[k]:sessionValues[k]}),
        set:async x=>Object.assign(sessionValues,x),
        remove:async k=>{delete sessionValues[k];}}
    }
  };
  let selected = false;
  const ctx = {chrome, Date,
    getSession:async()=>session,
    parseMedia:url=>{const m=/\/(film|series)\/(\d+)(?:\/|$)/.exec(url);
      return m?{type:m[1],id:m[2]}:null;},
    SERIES_PROGRESS_KEY:'kinoSeriesEpisodeProgressV1',
    resumeSourceIsTrusted:sender=>
      sender?.id === 'kino-test' &&
      sender?.tab?.id === 7 &&
      sender?.url?.startsWith('https://theatre.stravers.live/'),
    episodeSourceMatches:async()=>selected
  };
  vm.createContext(ctx);
  vm.runInContext(workerPart+'\nthis.api={armSeriesResume,' +
    'seriesPendingForFrame,confirmSeriesSeek};',ctx);
  return {
    ...ctx.api,
    local,sessionValues,
    extension:{id:'kino-test',url:'chrome-extension://kino-test/sidepanel.html'},
    player:{id:'kino-test',url:'https://theatre.stravers.live/player',
      tab:{id:7},frameId:471},
    navigate(){tab={id:7,url:'https://brogiro.cfd/film/404900/'};},
    confirm(){selected=true;}
  };
}

test('episode resume arm is tied to a stored record and a trusted extension', async()=>{
  const h=backgroundHarness();
  assert.equal((await h.armSeriesResume(7,'404900',2,3,h.extension)).ok,true);
  assert.equal((await h.armSeriesResume(7,'404900',2,4,h.extension)).ok,false);
  assert.equal((await h.armSeriesResume(7,'404900',2,3,
    {id:'kino-test',url:'https://evil.test'})).ok,false);
  assert.equal(h.local.kinoSeriesEpisodeProgressV1['series:404900:2:3'].position,83);
});

test('frame only receives pending episode on matching title and host',async()=>{
  const h=backgroundHarness();
  await h.armSeriesResume(7,'404900',2,3,h.extension);
  h.navigate();
  const value=await h.seriesPendingForFrame(h.player);
  assert.equal(value.episode,3);
  assert.equal(value.position,83);
  assert.equal(await h.seriesPendingForFrame({...h.player,url:'https://evil.test'}),null);
});

test('seek must match verified episode, time and duration before acknowledging',async()=>{
  const h=backgroundHarness();
  await h.armSeriesResume(7,'404900',2,3,h.extension);
  h.navigate();
  const ack=payload=>h.confirmSeriesSeek(h.player,payload);
  assert.equal((await ack({season:2,episode:4,position:83,duration:2895})).ok,false);
  assert.equal((await ack({season:2,episode:3,position:83,duration:2895})).ok,false);
  h.confirm();
  assert.equal((await ack({season:2,episode:3,position:83,duration:1800})).ok,false);
  assert.equal((await ack({season:2,episode:3,position:83,duration:2895})).ok,true);
  assert.equal(Object.keys(h.sessionValues).length,0);
});

async function playerHarness({allowed=true,duration=2895}={}) {
  let ms=100000, interval=null;
  let season=1,episode=1, menu=null, time=0, videoDuration=duration;
  const actions=[];const requests=[];
  const button=kind=>({
    textContent:(kind==='season'?'Сезон ':'Серия ')+(kind==='season'?season:episode),
    click(){menu=kind;actions.push('open:'+kind);}
  });
  const option=(kind,number)=>({
    textContent:(kind==='season'?'Сезон ':'Серия ')+number,
    hidden:false,getAttribute(){return null;},
    getBoundingClientRect(){return{width:130,height:24};},
    click(){
      actions.push('choose:'+kind+':'+number);
      if(kind==='season'){season=number;episode=1;}
      else episode=number;
      menu=null;time=0;
      if(kind==='episode')videoDuration=duration;
    }
  });
  const video={
    readyState:4, videoWidth:854,videoHeight:480,paused:false,seeking:false,
    get duration(){return videoDuration;},
    get currentTime(){return time;},set currentTime(v){time=v;actions.push('seek');},
    getBoundingClientRect(){return{width:854,height:480};}
  };
  const document={
    querySelectorAll(q){
      if(q==='button.select__item')return[button('season'),button('episode')];
      if(q==='button.select__drop-item')return menu?
        (menu==='season'?[1,2,3]:[1,2,3,4]).map(x=>option(menu,x)):[];
      if(q==='video')return[video];
      return[];
    }
  };
  const ctx={
    globalThis:{},document,
    Date:{now:()=>ms},window:{addEventListener(){}},
    chrome:{runtime:{sendMessage:async msg=>{
      requests.push(msg.action);
      if(msg.action==='kinoSeriesResumeGetPending')
        return allowed?{ok:true,pending:{seriesId:'404900',
          season:2,episode:3,position:83,duration:2895}}:{ok:false};
      if(msg.action==='kinoSeriesResumeAcknowledge')return{ok:true};
      return{ok:false};
    }}},
    setInterval:fn=>{interval=fn;return 1;},
    clearInterval:()=>{interval=null;}
  };
  vm.runInNewContext(seekScript,ctx);
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  for(let i=0;i<140 && interval;i++){
    ms+=450;interval();
    for(let j=0;j<2;j++)await new Promise(resolve=>setImmediate(resolve));
  }
  return{season,episode,time,actions,requests};
}

test('one click selects season then episode then seeks exact saved time',async()=>{
  const result=await playerHarness();
  assert.equal(result.season,2);
  assert.equal(result.episode,3);
  assert.equal(result.time,83);
  assert.deepEqual(result.actions.slice(0,4),[
    'open:season','choose:season:2','open:episode','choose:episode:3']);
  assert.equal(result.actions.filter(x=>x==='seek').length,1);
  assert.ok(result.requests.includes('kinoSeriesResumeAcknowledge'));
});

test('no user request means no player actions; wrong duration means no seeking',async()=>{
  const absent=await playerHarness({allowed:false});
  assert.equal(absent.actions.length,0);
  const mismatch=await playerHarness({duration:5000});
  assert.equal(mismatch.actions.includes('seek'),false);
});
