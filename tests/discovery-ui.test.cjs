'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const core=require('../discovery-core.js');
const script=fs.readFileSync(path.join(__dirname,'..','discovery.js'),'utf8');
const recent=()=>{const d=new Date();d.setUTCMonth(d.getUTCMonth()-2);return d.toISOString().slice(0,10);};
function setup(options={}){
 const nodes={},timer=[];
 let now=Date.now(),fetches=0;
 const urls=[];
 const handlers={};
 class Element {
  constructor(id=''){this.id=id;this.textContent='';this.hidden=false;
   this.src='';this.href='';this.children=[];this.attributes={};this.events={};
   this.classList={toggle(){},add(){},remove(){}};
  }
  addEventListener(k,fn){this.events[k]=fn}
  setAttribute(k,v){this.attributes[k]=v}
  removeAttribute(k){delete this.attributes[k];}
  replaceChildren(...children){this.children=children}
  appendChild(child){this.children.push(child)}
  getClientRects(){return [{}]}
  contains(){return false}
 }
 for(const id of ['kinoDiscovery','discoveryTitle','discoveryKind',
  'discoveryYear','discoveryGenres','discoveryDescription','discoveryRating',
  'discoveryPoster','discoveryBackdrop','discoveryPosterEmpty',
  'discoveryCounter','discoveryDots','discoveryOpen','discoveryPrevious','discoveryNext'])
   nodes[id]=new Element(id);
 const doc={hidden:false,body:{classList:{contains(){return false}}},
  getElementById:id=>nodes[id]||null,createElement:()=>new Element()};
 const clock=class extends Date{static now(){return now}};
 const window={KinoDiscoveryCore:core,
  KinoStatsAccount:{async detect(){return {status:'logged-in',id:'7143359'}}},
  matchMedia:()=>({matches:false})};
 const data={kinoDiscoveryCatalogV1:{
  schema:2,enrichedAt:now,savedAt:now,
  popular:[
   {type:'film',id:'100',title:'Персональный триллер',year:2024,
    genres:['триллер'],rating:7.9},
   {type:'film',id:'101',title:'Популярная комедия',year:2024,
    genres:['комедия'],rating:9.3},
   {type:'series',id:'102',title:'Популярный сериал',year:2025,
    genres:['драма'],rating:8.2}
  ],
  new:[
   {type:'film',id:'200',title:'Подтверждённая премьера',year:new Date().getFullYear(),
    releaseDate:recent(),rating:7.2,genres:['драма']}
  ]
 },kinoStatsRatingsV1:{
  '7143359':{'film:99':{rating:10}}
 },kinoStatsGenresV1:{'film:99':{genres:['триллер']}},
 kinoStatsWatchedV1:{'7143359':{}},
 kinoDiscoveryFactsV1:{'film:100':{genres:['триллер'],
  description:'Настоящее описание',cachedAt:now}}};
 if(options.data)Object.assign(data,options.data);
 if(options.noCache)delete data.kinoDiscoveryCatalogV1;
 const chrome={storage:{local:{async get(keys){
   return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]));
 },async set(values){Object.assign(data,values);}}},runtime:{async sendMessage(){return {ok:false}}}};
 const localStorage={getItem:()=> '[]'};
 const fetch=async url=>{fetches++;urls.push(String(url));throw Error('fetch unavailable')};
 vm.runInNewContext(script,{window,document:doc,chrome,localStorage,
  Date:clock,URL,DOMParser:class{},AbortSignal,setInterval:fn=>timer.push(fn),
  fetch,console:{warn(){}}
 });
 return {nodes,timer,data,urls,advance(ms){now+=ms},get fetches(){return fetches},
  settle:async()=>{for(let i=0;i<100;i++)await Promise.resolve()}};
}
test('cached official catalog is ranked by rated genre without random movies',async()=>{
 const x=setup();await x.settle();
 assert.equal(x.nodes.kinoDiscovery.hidden,false);
 assert.equal(x.nodes.discoveryTitle.textContent,'Персональный триллер');
 assert.equal(x.nodes.discoveryKind.textContent,'✦ Для вас');
 assert.equal(x.nodes.discoveryCounter.textContent,'1 / 4');
 assert.equal(x.fetches,0);
});
test('user can browse manually, and verified new movie has a distinct label',async()=>{
 const x=setup();await x.settle();
 x.nodes.discoveryNext.events.click();
 assert.equal(x.nodes.discoveryTitle.textContent,'Подтверждённая премьера');
 assert.equal(x.nodes.discoveryKind.textContent,'✦ Новинки');
 assert.equal(x.nodes.discoveryCounter.textContent,'2 / 4');
 x.nodes.discoveryPrevious.events.click();
 assert.equal(x.nodes.discoveryTitle.textContent,'Персональный триллер');
});
test('autoplay advances at five seconds and pauses on hover',async()=>{
 const x=setup();await x.settle();
 x.advance(6000);x.timer[0]();
 assert.equal(x.nodes.discoveryCounter.textContent,'2 / 4');
 x.nodes.kinoDiscovery.events.mouseenter();
 x.advance(6000);x.timer[0]();
 assert.equal(x.nodes.discoveryCounter.textContent,'2 / 4');
 x.nodes.kinoDiscovery.events.mouseleave();
 x.advance(6000);x.timer[0]();
 assert.equal(x.nodes.discoveryCounter.textContent,'3 / 4');
});

test('uncategorized source-ranked movie and series stay in popular, never for-you',async()=>{
 const x=setup();await x.settle();
 x.nodes.discoveryNext.events.click();
 x.nodes.discoveryNext.events.click();
 assert.equal(x.nodes.discoveryTitle.textContent,'Популярная комедия');
 assert.equal(x.nodes.discoveryKind.textContent,'✦ Популярное');
 x.nodes.discoveryNext.events.click();
 assert.equal(x.nodes.discoveryTitle.textContent,'Популярный сериал');
 assert.equal(x.nodes.discoveryOpen.href,'https://www.kinopoisk.ru/series/102/');
});

test('failed source fetches are throttled across separate popup launches',async()=>{
 const first=setup({noCache:true});await first.settle();
 assert.equal(first.urls.filter(u=>u.includes('/lists/movies/')).length,4);
 assert.equal(first.data.kinoDiscoveryCatalogV1.retryAt>Date.now(),true);
 const second=setup({data:first.data});await second.settle();
 assert.equal(second.urls.length,0);
 assert.equal(second.nodes.discoveryCounter.textContent,'0 / 0');
});
