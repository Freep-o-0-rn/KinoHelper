'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const identity={status:'logged-in',id:'7143359'};
const minute=60000;
const day=24*60*minute;

function storage(initial={}){
  const data={...initial};
  const local={
    async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
      .map(k=>[k,data[k]]));},
    async set(items){Object.assign(data,items);}
  };
  return {data,local};
}
function chromeMock(state,parse){
  const events={alarms:[],created:[],startup:[],installed:[]};
  const chrome={
    storage:{local:state.local},
    alarms:{
      async get(){return null;},
      async create(name,options){events.created.push({name,...options});},
      onAlarm:{addListener(fn){events.alarms.push(fn);}}
    },
    offscreen:{async hasDocument(){return true;},async createDocument(){}},
    runtime:{
      id:'test',
      getURL:()=> 'chrome-extension://test/',
      onMessage:{addListener(){}},
      onStartup:{addListener(fn){events.startup.push(fn);}},
      onInstalled:{addListener(fn){events.installed.push(fn);}},
      async sendMessage(message){return {ok:true,result:parse(message)};}
    },
    tabs:{async create(){throw Error('Minute poll must not open tabs');}},
    scripting:{async executeScript(){throw Error('Unexpected script');}}
  };
  return {chrome,events};
}

test('ratings minute sync detects recent votes and watched marks without restarting full import',async()=>{
  const state=storage({
    kinoStatsImportJobV2:{
      profileId:'7143359',state:'completed',watchedVersion:1,
      nextPage:21,pagesDone:20,totalPages:20,scanId:'original',
      nextAt:Date.now()+day,importedVotes:209,importedWatched:376
    },
    kinoStatsRatingsV1:{'7143359':{
      'film:10':{rating:4,source:'kinopoisk-profile',updatedAt:1}
    }},
    kinoStatsWatchedV1:{'7143359':{}}
  });
  const {chrome}=chromeMock(state,()=>({
    votes:[{type:'film',id:'10',rating:9},
           {type:'series',id:'20',rating:7}],
    watched:[{type:'film',id:'10',genres:['драма']}],
    source:'ssr',recognized:2,lastPage:20
  }));
  const self={KinoStatsAccount:{async detect(){return identity;}}};
  const fetch=async url=>({
    ok:true,status:200,url,text:async()=>'<html>rated and watched</html>'
  });
  new Function('chrome','self','fetch','URL','AbortSignal','console',
    read('stats-import-worker.js'))(chrome,self,fetch,URL,AbortSignal,console);
  const outcome=await self.KinoStatsMinuteSync.run(identity);
  assert.equal(outcome.ok,true);
  assert.equal(outcome.changed,3);
  assert.equal(state.data.kinoStatsRatingsV1['7143359']['film:10'].rating,9);
  assert.equal(state.data.kinoStatsRatingsV1['7143359']['series:20'].rating,7);
  assert.equal(state.data.kinoStatsWatchedV1['7143359']['film:10'].watched,true);
  const job=state.data.kinoStatsImportJobV2;
  assert.equal(job.pagesDone,20);
  assert.equal(job.nextPage,21);
  assert.equal(job.state,'completed');
  assert.equal(job.scanId,'original');
  const unchanged=await self.KinoStatsMinuteSync.run(identity);
  assert.equal(unchanged.changed,0);
});
test('ratings minute polling stays out of unfinished full import',async()=>{
  const state=storage({kinoStatsImportJobV2:{
    profileId:'7143359',state:'loading',nextPage:7,
    pagesDone:6,totalPages:20,nextAt:Date.now()+30000
  }});
  const {chrome}=chromeMock(state,()=>{throw Error('Unexpected parser');});
  const self={KinoStatsAccount:{async detect(){return identity;}}};
  let requests=0;
  new Function('chrome','self','fetch','URL','AbortSignal','console',
    read('stats-import-worker.js'))(chrome,self,async()=>{requests++;},URL,AbortSignal,console);
  const outcome=await self.KinoStatsMinuteSync.run(identity);
  assert.match(outcome.skipped,/full-import/);
  assert.equal(state.data.kinoStatsImportJobV2.nextPage,7);
  assert.equal(requests,0);
});
test('watchlist minute sync replaces a confirmed single-page list including removals',async()=>{
  const state=storage({
    kinoWatchlistImportJobV1:{
      profileId:'7143359',state:'completed',done:1,
      page:2,total:1,nextAt:Date.now()+day,count:2
    },
    kinoWatchlistProfilesV1:{
      '7143359':{
        'film:10':{type:'film',id:'10',title:'Keep'},
        'film:99':{type:'film',id:'99',title:'Removed'}
      },
      '2222':{'film:50':{type:'film',id:'50',title:'Another profile'}}
    }
  });
  const {chrome}=chromeMock(state,()=>({
    recognized:2,items:[
      {type:'film',id:'10',title:'Keep'},
      {type:'series',id:'20',title:'New'}
    ],lastPage:1
  }));
  const self={KinoStatsAccount:{async detect(){return identity;}}};
  new Function('chrome','self','fetch','URL','AbortSignal','console',
    'setTimeout','getMovieRating',read('watchlist-sync-worker.js'))(
    chrome,self,async url=>({ok:true,status:200,url,text:async()=>'<html>watchlist</html>'}),
    URL,AbortSignal,console,fn=>fn(),async()=>({authorized:true,planned:false})
  );
  const result=await self.KinoWatchlistMinuteSync.run(identity);
  assert.equal(result.ok,true);
  const scope=state.data.kinoWatchlistProfilesV1['7143359'];
  assert.deepEqual(Object.keys(scope).sort(),['film:10','series:20']);
  assert.ok(state.data.kinoWatchlistProfilesV1['2222']['film:50']);
  assert.equal(state.data.kinoWatchlistImportJobV1.state,'completed');
  assert.equal(state.data.kinoWatchlistImportJobV1.done,1);
});
test('multi-page head sync never deletes items from other pages',async()=>{
  const state=storage({
    kinoWatchlistImportJobV1:{
      profileId:'7143359',state:'completed',done:20,total:20,
      nextAt:Date.now()+day
    },
    kinoWatchlistProfilesV1:{
      '7143359':{'film:99':{type:'film',id:'99',title:'Older page'}}
    }
  });
  const {chrome}=chromeMock(state,()=>({
    items:[{type:'film',id:'10',title:'Recent'}],recognized:1,lastPage:20
  }));
  const self={KinoStatsAccount:{async detect(){return identity;}}};
  new Function('chrome','self','fetch','URL','AbortSignal','console',
    'setTimeout','getMovieRating',read('watchlist-sync-worker.js'))(
    chrome,self,async url=>({ok:true,status:200,url,text:async()=>'<html>watchlist</html>'}),
    URL,AbortSignal,console,fn=>fn(),async()=>({authorized:true,planned:false})
  );
  const result=await self.KinoWatchlistMinuteSync.run(identity);
  assert.equal(result.ok,true);
  assert.equal(result.partial,true);
  assert.ok(state.data.kinoWatchlistProfilesV1['7143359']['film:99']);
  assert.ok(state.data.kinoWatchlistProfilesV1['7143359']['film:10']);
});
test('one-minute alarm runs both checks, retains account scope and schedules itself',async()=>{
  const state=storage();
  const {chrome,events}=chromeMock(state,()=>null);
  let ratings=0,planned=0;
  const self={
    KinoStatsAccount:{async detect(){return identity;}},
    KinoStatsMinuteSync:{async run(){ratings++;return {ok:true,changed:1};}},
    KinoWatchlistMinuteSync:{async run(){planned++;return {ok:true,changed:2};}}
  };
  new Function('chrome','self','console',read('profile-minute-sync-worker.js'))(
    chrome,self,console);
  await self.KinoProfileMinuteSync.ensureAlarm();
  const outcome=await self.KinoProfileMinuteSync.synchronize();
  assert.equal(outcome.ok,true);
  assert.equal(ratings,1);
  assert.equal(planned,1);
  assert.equal(state.data.kinoProfileMinuteSyncStatusV1.profileId,'7143359');
  assert.equal(state.data.kinoProfileMinuteSyncStatusV1.ratings.changed,1);
  assert.ok(events.created.some(v=>v.name==='kinoProfileMinuteSyncV1'&&
    v.periodInMinutes===1));
});
test('sync failure backs off while keeping other domain operational',async()=>{
  const state=storage();
  const {chrome}=chromeMock(state,()=>null);
  let errors=0,successes=0;
  const self={
    KinoStatsAccount:{async detect(){return identity;}},
    KinoStatsMinuteSync:{async run(){errors++;return {ok:false,error:'429'};}},
    KinoWatchlistMinuteSync:{async run(){successes++;return {ok:true,changed:0};}}
  };
  new Function('chrome','self','console',read('profile-minute-sync-worker.js'))(
    chrome,self,console);
  await self.KinoProfileMinuteSync.synchronize();
  await self.KinoProfileMinuteSync.synchronize();
  assert.equal(errors,1,'blocked endpoint is not polled every minute');
  assert.equal(successes,2,'working endpoint continues to synchronize');
});
