'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const parser=require('../stats-profile-import.js');
const SOURCE=readFileSync(path.join(__dirname,'..','stats-import-worker.js'),'utf8');
function html(page,total=23) {
  const state={apolloState:{
    ROOT_QUERY:{movieReactions:{__ref:'List'}},
    List:{items:[{__ref:'Entry'}]},
    Entry:{__typename:'UserMovieReactions',movie:{__ref:'Movie'},
      reactions:[{__ref:'Vote'},{__ref:'Watched'}]},
    Movie:{id:100+page,__typename:'Film',genres:[{name:'драма'}]},
    Vote:{__typename:'Vote',value:(page%10)+1},
    Watched:{__typename:'Watched'}
  }};
  return '<html><a href="?page='+total+'">'+total+'</a><script>'+
    'window.Ya.__ssr_initial_data = '+JSON.stringify(state)+
    ';</script></html>';
}
function simulate(shared) {
  const data=shared?.data||{}, listeners={};
  let blockedPage=8,loggedIn='1234567',fetches=0;
  const storage={
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys)?keys:[keys])
        .map(key=>[key,data[key]]));
    },
    async set(values){Object.assign(data,values);}
  };
  const chrome={
    storage:{local:storage},
    alarms:{
      async create(name,opts){listeners.scheduled={name,when:opts.when};},
      onAlarm:{addListener(cb){listeners.alarm=cb;}}
    },
    offscreen:{
      async hasDocument(){return true;},
      async createDocument(){}
    },
    runtime:{
      id:'mock',
      getURL(){return 'chrome-extension://mock/';},
      onMessage:{addListener(cb){listeners.message=cb;}},
      onStartup:{addListener(cb){listeners.startup=cb;}},
      onInstalled:{addListener(cb){listeners.installed=cb;}},
      async sendMessage(msg){
        if(msg.action!=='kinoStatsParseProfilePage')throw Error('unexpected message');
        return {ok:true,result:parser.parsePage(html(msg.page),msg.page)};
      }
    }
  };
  const self={KinoStatsAccount:{
    async detect(){
      return loggedIn ? {status:'logged-in',id:loggedIn} :
        {status:'logged-out',id:''};
    }
  }};
  const fetch=async url=>{
    fetches++;
    const page=Number(new URL(url).searchParams.get('page'));
    if(page===blockedPage)return {ok:false,status:503,url};
    return {ok:true,status:200,url,text:async()=>html(page)};
  };
  new Function('chrome','self','fetch','URL','AbortSignal','console',
    SOURCE)(chrome,self,fetch,URL,AbortSignal,console);
  async function ensure(id='1234567') {
    return new Promise(resolve=>listeners.message({
      action:'statsImportEnsure',profileId:id
    },{id:'mock',url:'chrome-extension://mock/popup.html'},resolve));
  }
  async function tick() {
    listeners.alarm({name:'kinoStatsFullImportV1'});
    for(let i=0;i<25;i++)await new Promise(resolve=>setImmediate(resolve));
  }
  return {
    data,ensure,tick,listeners,
    allowRetries(){blockedPage=-1;},
    logOut(){loggedIn='';},
    logIn(id){loggedIn=id;},
    get fetches(){return fetches;}
  };
}
test('all 23 pages import in background, retry after HTTP 503',async()=>{
  const env=simulate();
  assert.equal((await env.ensure()).ok,true);
  for(let i=0;i<7;i++)await env.tick();
  assert.equal(env.data.kinoStatsImportJobV2.pagesDone,7);
  await env.tick();
  assert.equal(env.data.kinoStatsImportJobV2.nextPage,8);
  assert.equal(env.data.kinoStatsImportJobV2.state,'paused');
  env.allowRetries();
  for(let i=8;i<=23;i++)await env.tick();
  const job=env.data.kinoStatsImportJobV2;
  assert.equal(job.state,'completed');
  assert.equal(job.pagesDone,23);
  assert.equal(job.totalPages,23);
  assert.equal(Object.keys(env.data.kinoStatsRatingsV1['1234567']).length,23);
  assert.deepEqual(env.data.kinoStatsRatingsV1['1234567']['film:101'].genres,['драма']);
  assert.deepEqual(env.data.kinoStatsRatingsV1['1234567']['film:123'].genres,['драма']);
  assert.equal(Object.keys(env.data.kinoStatsWatchedV1['1234567']).length,23);
  assert.equal(job.importedWatched,23);
  assert.equal(env.data.kinoStatsWatchTimeV1,undefined);
  assert.equal(env.data.kinoStatsLibraryV1,undefined);
});
test('service worker restart retains page cursor and does not restart from 1',async()=>{
  const before=simulate();
  await before.ensure();
  for(let i=0;i<4;i++)await before.tick();
  const after=simulate({data:before.data});
  after.allowRetries();
  await after.tick();
  assert.equal(after.data.kinoStatsImportJobV2.pagesDone,5);
  assert.equal(after.data.kinoStatsImportJobV2.nextPage,6);
});
test('different current account pauses without mixing per-account ratings',async()=>{
  const env=simulate();
  await env.ensure();
  await env.tick();
  env.logIn('9876543');
  await env.tick();
  // A profile switch creates a new cursor for the newly verified account;
  // prior account ratings remain isolated in their own scope.
  assert.equal(env.data.kinoStatsImportJobV2.profileId,'9876543');
  assert.equal(env.data.kinoStatsImportJobV2.nextPage,1);
  assert.equal(env.data.kinoStatsRatingsV1['9876543'],undefined);
  assert.equal(Object.keys(env.data.kinoStatsRatingsV1['1234567']).length,1);
});
test('reopening popup preserves queued job rather than rescheduling page one',async()=>{
  const env=simulate();
  await env.ensure();
  for(let i=0;i<3;i++)await env.tick();
  const before=env.data.kinoStatsImportJobV2.nextPage;
  assert.equal((await env.ensure()).ok,true);
  assert.equal(env.data.kinoStatsImportJobV2.nextPage,before);
});


test('upgrading a finished ratings-only job restarts its watched scan from page one',async()=>{
  const env=simulate({data:{
    kinoStatsImportJobV2:{
      profileId:'1234567',state:'completed',nextPage:21,
      pagesDone:20,totalPages:20,importedVotes:209,nextAt:Date.now()+86400000
    }
  }});
  const response=await env.ensure();
  assert.equal(response.ok,true);
  assert.equal(env.data.kinoStatsImportJobV2.nextPage,1);
  assert.equal(env.data.kinoStatsImportJobV2.watchedVersion,1);
  await env.tick();
  assert.equal(Object.keys(env.data.kinoStatsWatchedV1['1234567']).length,1);
});


test('completed SSR scan prunes outdated votes and watched marks of the active account',async()=>{
  const env=simulate({data:{
    kinoStatsRatingsV1:{
      '1234567':{'film:999':{rating:2,source:'kinopoisk-profile',updatedAt:1}},
      '9876543':{'film:777':{rating:10,source:'kinopoisk-profile',updatedAt:1}}
    },
    kinoStatsWatchedV1:{
      '1234567':{'film:999':{watched:true,source:'kinopoisk-profile',updatedAt:1}}
    }
  }});
  env.allowRetries();
  await env.ensure();
  for(let i=0;i<23;i++)await env.tick();
  assert.equal(env.data.kinoStatsImportJobV2.state,'completed');
  assert.equal(env.data.kinoStatsRatingsV1['1234567']['film:999'],undefined);
  assert.equal(env.data.kinoStatsWatchedV1['1234567']['film:999'],undefined);
  assert.equal(env.data.kinoStatsRatingsV1['9876543']['film:777'].rating,10);
});
