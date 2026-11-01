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
 const fetch=async url=>{
  fetches++;urls.push(String(url));
  if(!options.catalogData)throw Error('fetch unavailable');
  const path=String(url);
  let source='';
  if(path.includes('/popular-series/year--'))source='seriesNew';
  else if(path.includes('/popular/year--'))source='filmsNew';
  else if(path.includes('/popular-series/'))source='seriesPopular';
  else if(path.includes('/popular/'))source='filmsPopular';
  if(source)return {ok:true,url:path,text:async()=>source};
  const match=path.match(/\/(film|series)\/([1-9]\d*)\//);
  if(match)return {ok:true,url:path,text:async()=>match[1]+':'+match[2]};
  throw Error('unexpected network resource');
 };
 class FakeDOMParser {
  parseFromString(markup){
   if(options.catalogData?.[markup]){
    const anchors=options.catalogData[markup].map(movie=>{
     const img={getAttribute:()=>null};
     const card={textContent:movie.title+' '+movie.year+' Россия • '+movie.genre,
      querySelector(selector){
       if(selector.startsWith('h3'))return {textContent:movie.title};
       if(selector.includes('ratingValue'))return {textContent:'7,8'};
       if(selector==='img')return img;
       return null;
      }};
     return {getAttribute:key=>key==='href'?movie.href:null,
      closest:()=>card,querySelector:()=>img,parentElement:card,
      textContent:movie.title};
    });
    const body={querySelectorAll:()=>anchors};
    return {body,querySelector:()=>body};
   }
   const match=String(markup).match(/^(film|series):([1-9]\d*)$/);
   const date=new Date();date.setUTCMonth(date.getUTCMonth()-1);
   const months=['января','февраля','марта','апреля','мая','июня',
    'июля','августа','сентября','октября','ноября','декабря'];
   const dateText=date.getUTCDate()+' '+months[date.getUTCMonth()]+' '+date.getUTCFullYear();
   return {
    querySelectorAll(selector){
     if(selector.includes('application/ld+json'))
      return [{textContent:JSON.stringify({'@type':match?.[1]==='series'?'TVSeries':'Movie',
       name:'Проверенный '+(match?.[2]||''),genre:'драма',
       description:'Описание из официальной карточки'})}];
     if(selector==='dt, th, span, div')
      return [{textContent:'Премьера в мире',children:[],
       closest:()=>({textContent:'Премьера в мире '+dateText})}];
     return [];
    },
    querySelector:()=>null
   };
  }
 }
 vm.runInNewContext(script,{window,document:doc,chrome,localStorage,
  Date:clock,URL,DOMParser:FakeDOMParser,AbortSignal,setInterval:fn=>timer.push(fn),
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

test('actual film/series catalog parses and survives reopening without re-fetch',async()=>{
 const yr=new Date().getFullYear();
 const catalogData={
  filmsPopular:[{href:'/film/601/',title:'Детектив 601',year:yr-1,genre:'триллер'}],
  seriesPopular:[{href:'/film/602/',title:'Сериал 602',year:yr-1,genre:'драма'}],
  filmsNew:[{href:'/film/603/',title:'Премьера 603',year:yr,genre:'драма'}],
  seriesNew:[{href:'/series/604/',title:'Новый сериал 604',year:yr,genre:'драма'}]
 };
 const first=setup({noCache:true,catalogData});await first.settle();
 assert.equal(first.urls.filter(u=>u.includes('/lists/movies/')).length,4);
 assert.equal(first.data.kinoDiscoveryCatalogV1.popular.length,2);
 assert.equal(first.data.kinoDiscoveryCatalogV1.new.length,2);
 assert.equal(first.data.kinoDiscoveryCatalogV1.new.every(x=>Boolean(x.releaseDate)),true);
 assert.equal(first.data.kinoDiscoveryCatalogV1.enrichedAt>0,true);
 const second=setup({data:first.data,catalogData});await second.settle();
 assert.equal(second.urls.length,0);
 assert.equal(second.nodes.discoveryCounter.textContent,'1 / 4');
 second.nodes.discoveryNext.events.click();
 assert.equal(second.nodes.discoveryKind.textContent,'✦ Новинки');
});
