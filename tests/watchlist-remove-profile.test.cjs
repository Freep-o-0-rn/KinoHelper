'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const SOURCE=fs.readFileSync(path.join(__dirname,'..','watchlist.js'),'utf8');

class Element {
  constructor(tag='div'){
    this.tag=tag;this.children=[];this.listeners={};this.attrs={};
    this.textContent='';this.hidden=false;this.disabled=false;
    this.dataset={};this.className='';this.style={};
    this.classList={toggle(){},contains(){return false;},add(){},remove(){}};
  }
  append(...elements){this.children.push(...elements);}
  appendChild(element){this.children.push(element);}
  replaceChildren(...elements){this.children=[...elements];}
  addEventListener(name,fn){this.listeners[name]=fn;}
  setAttribute(key,value){this.attrs[key]=value;}
  getAttribute(key){return this.attrs[key];}
}
function setup({reject=false,profile='7143359'}={}){
  const movie={id:'100',type:'film',title:'Тестовый фильм',year:2013,
    addedAt:1700000000000};
  const data={
    kinoWatchlistProfilesV1:{
      '7143359':{'film:100':movie},
      '2222':{'film:200':{id:'200',type:'film',title:'Чужой фильм'}}
    },
    kinoWatchlistImportJobV1:{profileId:'7143359',state:'completed',count:1}
  };
  const nodes=Object.fromEntries([
    'watchlist','watchlistToggle','watchlistBody','watchlistCurrentAction',
    'watchlistSync','watchlistItems','watchlistCount','watchlistEmpty',
    'watchlistStatus'
  ].map(id=>[id,new Element()]));
  const calls=[];
  const document={
    readyState:'complete',
    getElementById:id=>nodes[id]||null,
    addEventListener(){},
    querySelectorAll:()=>[],
    createElement:tag=>new Element(tag)
  };
  const localStorage={getItem:()=>null,setItem(){},removeItem(){}};
  const window={
    addEventListener(){},dispatchEvent(){},
    KinoStatsAccount:{async detect(){return {status:'logged-in',id:profile};}}
  };
  const chrome={
    storage:{
      local:{async get(keys){
        return Object.fromEntries((Array.isArray(keys)?keys:[keys])
          .map(key=>[key,data[key]]));
      }},
      onChanged:{addListener(){}}
    },
    runtime:{async sendMessage(message){
      calls.push(message);
      if(message.action==='kinoWatchlistSet'){
        if(reject)return {ok:false,error:'Кинопоиск отклонил изменение'};
        const {movie:target,desired,profileId}=message.payload;
        const scope={...data.kinoWatchlistProfilesV1[profileId]};
        const key=target.type+':'+target.id;
        if(desired)scope[key]=target;
        else delete scope[key];
        data.kinoWatchlistProfilesV1={
          ...data.kinoWatchlistProfilesV1,[profileId]:scope};
        return {ok:true,planned:desired,profileId};
      }
      return {ok:true};
    }},
    tabs:{async create(){}}
  };
  const IntersectionObserver=class{
    observe(){}disconnect(){}unobserve(){}
  };
  vm.runInNewContext(SOURCE,{
    window,document,localStorage,chrome,IntersectionObserver,
    Event:class{constructor(type){this.type=type;}},URL,console
  },{filename:'watchlist.js'});
  return {api:window.KinoWatchlist,data,calls,nodes,movie};
}
async function ready(env){
  await env.api.refreshProfile(true);
  for(let i=0;i<30;i++)await Promise.resolve();
}
test('X on profile item explicitly requests Kinopoisk removal, then updates local UI',async()=>{
  const env=setup();
  await ready(env);
  assert.equal(env.nodes.watchlistCount.textContent,'1');
  const row=env.nodes.watchlistItems.children[0];
  const actions=row.children.at(-1);
  const remove=actions.children[2];
  assert.equal(remove.textContent,'✕');
  assert.equal(typeof remove.listeners.click,'function');
  remove.listeners.click();
  await Promise.resolve();
  assert.ok(env.calls.some(c=>c.action==='kinoWatchlistSet' &&
    c.payload.desired===false && c.payload.profileId==='7143359'));
  for(let i=0;i<50;i++)await Promise.resolve();
  assert.equal(env.nodes.watchlistCount.textContent,'0');
  assert.equal(env.data.kinoWatchlistProfilesV1['7143359']['film:100'],undefined);
  assert.ok(env.data.kinoWatchlistProfilesV1['2222']['film:200']);
});
test('failed remote removal keeps X item and reports error',async()=>{
  const env=setup({reject:true});
  await ready(env);
  const row=env.nodes.watchlistItems.children[0];
  row.children.at(-1).children[2].listeners.click();
  for(let i=0;i<50;i++)await Promise.resolve();
  assert.equal(env.nodes.watchlistCount.textContent,'1');
  assert.ok(env.data.kinoWatchlistProfilesV1['7143359']['film:100']);
  assert.match(env.nodes.watchlistStatus.textContent,/отклонил/);
});
test('remove API never toggles a missing title back into planned list',async()=>{
  const env=setup();
  await ready(env);
  assert.equal(await env.api.removeFromList(env.movie),true);
  assert.equal(await env.api.removeFromList(env.movie),true);
  assert.ok(env.calls.filter(c=>c.action==='kinoWatchlistSet')
    .every(c=>c.payload.desired===false));
  assert.equal(env.nodes.watchlistCount.textContent,'0');
});


test('unchanged background profile refresh keeps existing list rows',async()=>{
 const env=setup();
 await ready(env);
 const row=env.nodes.watchlistItems.children[0];
 await env.api.refreshProfile(true);
 assert.equal(env.nodes.watchlistItems.children[0],row);
 // A real removal is still applied immediately after server confirmation.
 assert.equal(await env.api.removeFromList(env.movie),true);
 assert.equal(env.nodes.watchlistItems.children.length,0);
});
