'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','stats-account.js'),'utf8');
const CACHE='kinoVerifiedAuthSessionV1';

function fixture(){
 const state={};
 const storage={
   async get(keys){
     return Object.fromEntries((Array.isArray(keys)?keys:[keys])
       .map(k=>[k,state[k]]));
   },
   async set(values){Object.assign(state,values);},
   async remove(key){delete state[key];}
 };
 let now=1000000;
 let calls=0;
 let id='1234567';
 let block=false;
 let gate=null;
 const response=(url,html='',status=200)=>({url,status,
   ok:status>=200&&status<300,async text(){return html}});
 function page(){
   calls++;
   if(gate)return gate;
   if(block)return Promise.reject(new TypeError('Failed to fetch'));
   return Promise.resolve(response('https://www.kinopoisk.ru/user/'+id+'/'));
 }
 function context(){
   const mod={exports:{}};
   class Clock extends Date {static now(){return now;}}
   vm.runInNewContext(source,{
     module:mod,chrome:{storage:{session:storage}},fetch:page,
     URL,Date:Clock,AbortSignal:{timeout:()=>undefined}
   },{filename:'stats-account.js'});
   return mod.exports;
 }
 return {storage,state,context,setId(v){id=v;},
   setBlock(v){block=v;},
   advance(ms){now+=ms;},
   setGate(g){gate=g;},
   get calls(){return calls;}};
}

test('the same verified profile is shared between popup and worker contexts',async()=>{
 const env=fixture();
 const popup=env.context(),worker=env.context();
 const first=await popup.detect();
 assert.equal(first.status,'logged-in');
 assert.equal(first.id,'1234567');
 assert.equal(env.calls,1);
 const second=await worker.detect();
 assert.equal(second.id,'1234567');
 assert.equal(second.cached,true);
 assert.equal(env.calls,1);
 assert.equal(env.state[CACHE].id,'1234567');
});

test('the second opening and repeated focus checks do not fetch within TTL',async()=>{
 const env=fixture(),account=env.context();
 await account.detect();
 env.advance(45000);
 const same=await account.detect();
 assert.equal(same.cached,true);
 assert.equal(env.calls,1);
 env.advance(76000);
 const stale=await account.detect();
 assert.equal(stale.cached,undefined);
 assert.equal(env.calls,2);
});

test('a forced refresh changes the cached profile and propagates to other views',async()=>{
 const env=fixture(),view=env.context(),background=env.context();
 await view.detect();
 env.setId('7654321');
 const changed=await view.detect(undefined,{force:true});
 assert.equal(changed.id,'7654321');
 assert.equal(env.calls,2);
 const shared=await background.detect();
 assert.equal(shared.id,'7654321');
 assert.equal(shared.cached,true);
});

test('simultaneous requests within a view share one in-flight authentication probe',async()=>{
 const env=fixture(),account=env.context();
 let release;
 env.setGate(new Promise(resolve=>{release=resolve;}));
 const a=account.detect(),b=account.detect(),c=account.detect();
 for(let i=0;i<10;i++)await Promise.resolve();
 assert.equal(env.calls,1);
 release({url:'https://www.kinopoisk.ru/user/1234567/',
   ok:true,status:200,text:async()=>''});
 const all=await Promise.all([a,b,c]);
 assert.equal(all.length,3);
 assert.ok(all.every(x=>x.id==='1234567'));
 assert.equal(env.calls,1);
});

test('unavailable authentication is cached briefly, never treated as logged-in',async()=>{
 const env=fixture(),panel=env.context();
 env.setBlock(true);
 const first=await panel.detect();
 assert.equal(first.status,'unavailable');
 const count=env.calls;
 assert.equal(count,2);
 const again=await panel.detect();
 assert.equal(again.status,'unavailable');
 assert.equal(again.cached,true);
 assert.equal(env.calls,count);
 env.advance(31000);
 const retry=await panel.detect();
 assert.equal(retry.status,'unavailable');
 assert.equal(env.calls,count+2);
});

test('manual refresh clears negative auth result immediately and invalidation removes cache',async()=>{
 const env=fixture(),account=env.context();
 env.setBlock(true);
 await account.detect();
 env.setBlock(false);
 const refreshed=await account.detect(undefined,{force:true});
 assert.equal(refreshed.id,'1234567');
 await account.clearCache();
 assert.equal(env.state[CACHE],undefined);
 await account.detect();
 assert.equal(env.calls,4);
});

test('custom test fetchers bypass cache and cannot impersonate a session',async()=>{
 const env=fixture(),account=env.context();
 await account.detect(async()=>({url:'https://www.kinopoisk.ru/user/3333333/',
   ok:true,status:200,text:async()=>''}));
 assert.equal(env.state[CACHE],undefined);
 assert.equal(env.calls,0);
 const actual=await account.detect();
 assert.equal(actual.id,'1234567');
});
