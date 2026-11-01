'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const worker=fs.readFileSync(path.join(__dirname,'..','watchlist-sync-worker.js'),'utf8');
const parser=require('../watchlist-parser.js');

function fixture(page) {
 const state={apolloState:{
   ROOT_QUERY:{movieReactions:{__ref:'List'}},
   List:{items:[{__ref:'Reaction'}]},
   Reaction:{__typename:'UserMovieReactions',movie:{__ref:'Movie'}},
   Movie:{id:100+page,__typename:page===2?'TvSeries':'Film',
     title:{russian:'Тест '+page},productionYear:2013}
 }};
 return '<a href="?page=2">2</a><script>window.Ya.__ssr_initial_data = '+
    JSON.stringify(state)+';</script>';
}

function mock(){
 const data={},events={};
 let account='7143359',planned=false,clicks=0;
 const chrome={
   storage:{local:{
     async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
       .map(k=>[k,data[k]]));},
     async set(values){Object.assign(data,values);}
   }},
   alarms:{async create(){},onAlarm:{addListener(cb){events.alarm=cb;}}},
   offscreen:{async hasDocument(){return true;},async createDocument(){}},
   runtime:{
     id:'test',getURL:()=> 'chrome-extension://test/',
     onMessage:{addListener(cb){events.message=cb;}},
     onStartup:{addListener(){}},onInstalled:{addListener(){}},
     async sendMessage({html,page}){return {ok:true,result:parser.parsePage(html,page)};}
   },
   tabs:{
     async create(){return {id:10};},
     async get(){return {url:'https://www.kinopoisk.ru/film/100/',
       status:'complete'};},
     async remove(){}
   },
   scripting:{async executeScript({args}){
     if(args){planned=args[0];clicks++;}
     return [{result:true}];
   }}
 };
 const self={KinoStatsAccount:{async detect(){
   return {status:'logged-in',id:account};
 }}};
 const URLStub=class{
   constructor(input){
     const source=String(input);
     this.protocol='https:';
     this.hostname='www.kinopoisk.ru';
     const match=source.match(/https:\/\/[^/]+(\/[^?]*)(.*)/);
     this.pathname=match?.[1]||'/';
     this.searchParams={get:key=>match?.[2].match(
       new RegExp('[?&]'+key+'=(\\d+)'))?.[1]||null};
   }
 };
 new Function('chrome','self','fetch','URL','AbortSignal','console',
   'getMovieRating','setTimeout',worker)(
   chrome,self,
   async url=>({ok:true,url,status:200,text:async()=>
     fixture(Number(new URLStub(url).searchParams.get('page')))}),
   URLStub,{timeout(){return undefined;}},console,
   async()=>({authorized:true,planned}),fn=>fn()
 );
 function message(action,details={}){
   return new Promise(resolve=>events.message({action,...details},
     {id:'test',url:'chrome-extension://test/popup.html'},resolve));
 }
 async function tick(){
   events.alarm({name:'kinoWatchlistImportV1'});
   for(let i=0;i<80;i++)await Promise.resolve();
 }
 return {data,message,tick,setAccount(id){account=id;},
   get clicks(){return clicks;},get planned(){return planned;}};
}
test('complete profile scan imports film and series independently',async()=>{
 const m=mock();
 assert.equal((await m.message('kinoWatchlistEnsure',{profileId:'7143359'})).ok,true);
 await m.tick();await m.tick();
 const scope=m.data.kinoWatchlistProfilesV1['7143359'];
 assert.deepEqual(Object.keys(scope).sort(),['film:101','series:102']);
 assert.equal(m.data.kinoWatchlistImportJobV1.state,'completed');
});
test('verified add and remove affect only the active account',async()=>{
 const m=mock();
 const film={type:'film',id:'100',title:'Тест'};
 assert.equal((await m.message('kinoWatchlistSet',{
   payload:{movie:film,desired:true,profileId:'7143359'}
 })).ok,true);
 assert.equal(m.planned,true);
 assert.ok(m.data.kinoWatchlistProfilesV1['7143359']['film:100']);
 assert.equal((await m.message('kinoWatchlistSet',{
   payload:{movie:film,desired:false,profileId:'7143359'}
 })).ok,true);
 assert.equal(m.planned,false);
 assert.equal(m.data.kinoWatchlistProfilesV1['7143359']['film:100'],undefined);
 assert.equal((await m.message('kinoWatchlistSet',{
   payload:{movie:film,desired:true,profileId:'999999'}
 })).ok,false);
 assert.equal(m.clicks,2);
});
