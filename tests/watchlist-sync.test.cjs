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

function mock(options={}){
 const data={},events={};
 let account='7143359',planned=Boolean(options.initialPlanned),clicks=0,created=0,closed=0,waits=0;
 const tabArgs=[];
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
     async create(options){created++;tabArgs.push(options);return {id:10};},
     async get(){return {url:'https://www.kinopoisk.ru/film/100/',
       status:'complete'};},
     async remove(){closed++;}
   },
   scripting:{async executeScript({func}){
     const button={
       disabled:false,classList:{contains:()=>false},
       closest(){return this;},getAttribute(){return null;},
       click(){clicks++;if(!options.rejectChange)planned=!planned;}
     };
     const document={querySelectorAll(selector){
       return !options.missingButton &&
         selector==='button[data-test-id="ContentActions_bookmarkButton"]'
           ?[button]:[];
     }};
     const result=new Function('document',
       'return ('+func.toString()+')()')(document);
     return [{result}];
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
     (options.fixture||fixture)(Number(new URLStub(url).searchParams.get('page')))}),
   URLStub,{timeout(){return undefined;}},console,
   async()=>({authorized:true,planned}),fn=>{waits++;fn();}
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
   get clicks(){return clicks;},get planned(){return planned;},
   get created(){return created;},get closed(){return closed;},
   get waits(){return waits;},tabArgs};
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


test('watchlist imports a 20-item page before finalizing remaining pages without pager links',async()=>{
 function listing(page){
   const count=page===1?20:3;
   const state={apolloState:{ROOT_QUERY:{plannedToWatch:{__ref:'List'}},
     List:{items:Array.from({length:count},(_,i)=>({__ref:'Item:'+i}))}}};
   for(let i=0;i<count;i++){
     state.apolloState['Item:'+i]={__typename:'UserMovieReactions',
       movie:{__ref:'Movie:'+i}};
     state.apolloState['Movie:'+i]={__typename:i===0?'TvSeries':'Film',
       id:1000+(page-1)*20+i,title:{russian:'Название '+i}};
   }
   return '<script>window.Ya.__ssr_initial_data = '+JSON.stringify(state)+'</script>';
 }
 const m=mock({fixture:listing});
 await m.message('kinoWatchlistEnsure',{profileId:'7143359'});
 await m.tick();
 assert.equal(Object.keys(m.data.kinoWatchlistProfilesV1['7143359']).length,20);
 assert.equal(m.data.kinoWatchlistImportJobV1.state,'loading');
 await m.tick();
 assert.equal(Object.keys(m.data.kinoWatchlistProfilesV1['7143359']).length,23);
 assert.equal(m.data.kinoWatchlistImportJobV1.state,'completed');
});


test('native bookmark action opens only an inactive temporary tab and closes it',async()=>{
 const m=mock();
 const response=await m.message('kinoWatchlistSet',{
   payload:{movie:{type:'film',id:'100',title:'Тест'},
     desired:true,profileId:'7143359'}
 });
 assert.equal(response.ok,true);
 assert.equal(m.created,1);
 assert.equal(m.closed,1);
 assert.equal(m.tabArgs[0].active,false);
 assert.equal(m.planned,true);
});

test('missing Kinopoisk bookmark button never modifies local state or leaves tabs',async()=>{
 const m=mock({missingButton:true});
 const response=await m.message('kinoWatchlistSet',{
   payload:{movie:{type:'film',id:'100'},desired:true,profileId:'7143359'}
 });
 assert.equal(response.ok,false);
 assert.match(response.error,/штатную кнопку/);
 assert.equal(m.created,1);
 assert.equal(m.closed,1);
 assert.equal(m.planned,false);
 assert.equal(m.data.kinoWatchlistProfilesV1,undefined);
});

test('site that refuses to save is reported as failure without optimistic list changes',async()=>{
 const m=mock({rejectChange:true});
 const response=await m.message('kinoWatchlistSet',{
   payload:{movie:{type:'film',id:'100'},desired:true,profileId:'7143359'}
 });
 assert.equal(response.ok,false);
 assert.match(response.error,/не подтвердил/);
 assert.equal(m.created,1);
 assert.equal(m.closed,1);
 assert.equal(m.data.kinoWatchlistProfilesV1,undefined);
});


test('confirmed X removal updates a pending import snapshot so title cannot reappear on completion',async()=>{
 const m=mock({initialPlanned:true});
 const film={type:'film',id:'100',title:'Тест'};
 m.data.kinoWatchlistProfilesV1={
   '7143359':{'film:100':film},
   '2222':{'film:100':{...film,title:'Чужой профиль'}}
 };
 m.data.kinoWatchlistImportJobV1={
   profileId:'7143359',page:2,done:1,state:'loading',
   staged:{'film:100':film},nextAt:Date.now()+60000
 };
 const reply=await m.message('kinoWatchlistSet',{
   payload:{movie:film,desired:false,profileId:'7143359'}
 });
 assert.equal(reply.ok,true);
 assert.equal(reply.planned,false);
 assert.equal(m.planned,false);
 assert.equal(m.data.kinoWatchlistProfilesV1['7143359']['film:100'],undefined);
 assert.equal(m.data.kinoWatchlistImportJobV1.staged['film:100'],undefined);
 assert.ok(m.data.kinoWatchlistProfilesV1['2222']['film:100']);
});


test('ready page and confirmed Kinopoisk response do not incur artificial waits',async()=>{
 const m=mock();
 const result=await m.message('kinoWatchlistSet',{
   payload:{movie:{type:'film',id:'100'},desired:true,
     profileId:'7143359'}
 });
 assert.equal(result.ok,true);
 assert.equal(m.waits,0);
 assert.equal(m.closed,1);
});
