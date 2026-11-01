'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const worker=fs.readFileSync(
  path.join(__dirname,'..','watchlist-sync-worker.js'),'utf8');

function mock({failure=false}={}){
 const data={kinoWatchlistProfilesV1:{
   '7143359':{'film:100':{type:'film',id:'100',title:'Тест',addedAt:1}},
   '2222':{'film:100':{type:'film',id:'100',title:'Чужой профиль',addedAt:1}}
 }};
 const events=[],messages=[];
 let account='7143359',remotePlanned=true,clicks=0;
 const chrome={
   storage:{local:{
     async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
       .map(k=>[k,data[k]]));},
     async set(values){Object.assign(data,values);}
   }},
   alarms:{async create(){},onAlarm:{addListener(cb){events.push(cb);}}},
   offscreen:{async hasDocument(){return true;},async createDocument(){}},
   runtime:{
     id:'test',getURL:()=> 'chrome-extension://test/',
     onMessage:{addListener(cb){messages.push(cb);}},
     onStartup:{addListener(){}},onInstalled:{addListener(){}}
   },
   tabs:{
     async create(){return {id:5};},
     async get(){return {url:'https://www.kinopoisk.ru/film/100/',
       status:'complete'};},
     async remove(){}
   },
   scripting:{async executeScript({args}){
     if(args){clicks++;remotePlanned=Boolean(args[0]);return [{result:true}];}
     return [{result:[]}];
   }}
 };
 const self={KinoStatsAccount:{async detect(){
   return {status:'logged-in',id:account};
 }}};
 new Function('chrome','self','fetch','URL','AbortSignal',
   'console','getMovieRating','setTimeout',worker)(
   chrome,self,async()=>({}),URL,{timeout(){return undefined;}},
   console,async movie=>failure?{authorized:true,planned:null}
     :{authorized:true,planned:String(movie?.id)==='100' && remotePlanned},
     fn=>fn());
 return {data,self,chrome,events,messages,
   async settle(){for(let i=0;i<150;i++)await Promise.resolve();},
   setAccount(id){account=id;},
   get clicks(){return clicks;},
   get remotePlanned(){return remotePlanned;}
 };
}

test('completed film leaves only its confirmed account after remote removal',async()=>{
 const m=mock();
 const result=await m.self.KinoWatchlistAutoComplete.onFilmCompleted('film:100');
 assert.equal(result.queued,true);
 await m.settle();
 assert.equal(m.remotePlanned,false);
 assert.equal(m.clicks,1);
 assert.equal(m.data.kinoWatchlistProfilesV1['7143359']['film:100'],undefined);
 assert.ok(m.data.kinoWatchlistProfilesV1['2222']['film:100']);
 assert.deepEqual(Object.keys(m.data.kinoWatchlistAutoRemoveV1['7143359']),[]);
});

test('site refusal preserves the film and queues a visible retry',async()=>{
 const m=mock({failure:true});
 await m.self.KinoWatchlistAutoComplete.onFilmCompleted('film:100');
 await m.settle();
 assert.ok(m.data.kinoWatchlistProfilesV1['7143359']['film:100']);
 const pending=m.data.kinoWatchlistAutoRemoveV1['7143359']['film:100'];
 assert.equal(pending.state,'retry');
 assert.equal(pending.attempts,1);
 assert.ok(pending.error);
});

test('unrelated title or missing profile entry causes no site writes',async()=>{
 const m=mock();
 const first=await m.self.KinoWatchlistAutoComplete.onFilmCompleted('film:101');
 const second=await m.self.KinoWatchlistAutoComplete.onFilmCompleted(
   'series:100:1:1');
 await m.settle();
 assert.equal(first.queued,false);
 assert.equal(second.ok,false);
 assert.equal(m.clicks,0);
});


test('an unimported planned film can still be removed after confirmed viewing',async()=>{
 const m=mock();
 delete m.data.kinoWatchlistProfilesV1['7143359']['film:100'];
 const queued=await m.self.KinoWatchlistAutoComplete.onFilmCompleted('film:100');
 assert.equal(queued.queued,true);
 await m.settle();
 assert.equal(m.remotePlanned,false);
 assert.equal(m.clicks,1);
});
