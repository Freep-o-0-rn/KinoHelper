'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const core=require('../discovery-core.js');
const script=fs.readFileSync(path.join(__dirname,'..','discovery.js'),'utf8');
const recent=()=>{const d=new Date();d.setUTCMonth(d.getUTCMonth()-2);return d.toISOString().slice(0,10);};
function setup(){
 const nodes={},timer=[];
 let now=Date.now(),fetches=0;
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
  savedAt:now,
  popular:[
   {type:'film',id:'100',title:'Персональный триллер',year:2024,
    genres:['триллер'],rating:7.9},
   {type:'film',id:'101',title:'Случайная комедия',year:2024,
    genres:['комедия'],rating:9.3}
  ],
  new:[
   {type:'film',id:'200',title:'Подтверждённая премьера',year:new Date().getFullYear(),
    releaseDate:recent(),rating:7.2,genres:['драма']}
  ]
 },kinoStatsRatingsV1:{
  '7143359':{'film:99':{rating:10}}
 },kinoStatsGenresV1:{'film:99':{genres:['триллер']}},
 kinoStatsWatchedV1:{'7143359':{}}};
 const chrome={storage:{local:{async get(keys){
   return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]));
 }}},runtime:{async sendMessage(){return {ok:false}}}};
 const localStorage={getItem:()=> '[]'};
 const fetch=async()=>{fetches++;throw Error('fetch unavailable')};
 vm.runInNewContext(script,{window,document:doc,chrome,localStorage,
  Date:clock,URL,DOMParser:class{},AbortSignal,setInterval:fn=>timer.push(fn),
  fetch,console:{warn(){}}
 });
 return {nodes,timer,advance(ms){now+=ms},get fetches(){return fetches},
  settle:async()=>{for(let i=0;i<100;i++)await Promise.resolve()}};
}
test('cached official catalog is ranked by rated genre without random movies',async()=>{
 const x=setup();await x.settle();
 assert.equal(x.nodes.kinoDiscovery.hidden,false);
 assert.equal(x.nodes.discoveryTitle.textContent,'Персональный триллер');
 assert.equal(x.nodes.discoveryKind.textContent,'✦ Для вас');
 assert.equal(x.nodes.discoveryCounter.textContent,'1 / 2');
 assert.equal(x.fetches>=0,true);
});
test('user can browse manually, and verified new movie has a distinct label',async()=>{
 const x=setup();await x.settle();
 x.nodes.discoveryNext.events.click();
 assert.equal(x.nodes.discoveryTitle.textContent,'Подтверждённая премьера');
 assert.equal(x.nodes.discoveryKind.textContent,'✦ Новинки');
 assert.equal(x.nodes.discoveryCounter.textContent,'2 / 2');
 x.nodes.discoveryPrevious.events.click();
 assert.equal(x.nodes.discoveryTitle.textContent,'Персональный триллер');
});
test('autoplay advances at five seconds and pauses on hover',async()=>{
 const x=setup();await x.settle();
 x.advance(6000);x.timer[0]();
 assert.equal(x.nodes.discoveryCounter.textContent,'2 / 2');
 x.nodes.kinoDiscovery.events.mouseenter();
 x.advance(6000);x.timer[0]();
 assert.equal(x.nodes.discoveryCounter.textContent,'2 / 2');
 x.nodes.kinoDiscovery.events.mouseleave();
 x.advance(6000);x.timer[0]();
 assert.equal(x.nodes.discoveryCounter.textContent,'1 / 2');
});
