'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','watchlist.js'),'utf8');

function setup(count=120,{withUI=false}={}){
 const entries=Array.from({length:count},(_,i)=>({
   id:String(1000+i),type:'film',title:'Фильм '+i,addedAt:i+1
 }));
 const data=new Map([['kinoHelperWatchlistV1',JSON.stringify(entries)]]);
 let parses=0,created=0,replacements=0;
 const json={parse(v){parses++;return JSON.parse(v)},
   stringify(v){return JSON.stringify(v)}};
 class El {
   constructor(){this.children=[];this.listeners={};this.attrs={};
     this.dataset={};this.style={};this.textContent='';this.hidden=false;
     this.classList={add(){},remove(){},contains(){return false},toggle(){}};}
   addEventListener(name,fn){this.listeners[name]=fn}
   setAttribute(k,v){this.attrs[k]=v}
   append(...nodes){this.children.push(...nodes)}
   appendChild(node){this.children.push(node)}
   replaceChildren(...nodes){replacements++;this.children=nodes}
 }
 const ids=['watchlist','watchlistToggle','watchlistBody',
   'watchlistCurrentAction','watchlistSync','watchlistItems',
   'watchlistCount','watchlistEmpty','watchlistStatus'];
 const nodes=Object.fromEntries(ids.map(id=>[id,new El()]));
 const document={
   readyState:withUI?'complete':'loading',
   getElementById:id=>withUI?nodes[id]||null:null,
   querySelectorAll(){return []},
   addEventListener(){},
   createElement(){created++;return new El()}
 };
 const window={addEventListener(){},dispatchEvent(){}};
 const localStorage={
   getItem:key=>data.get(key)||null,
   setItem(key,value){data.set(key,String(value))},
   removeItem:key=>data.delete(key)
 };
 const chrome={
   tabs:{async create(){}},
   storage:{local:{async get(){return {}}},onChanged:{addListener(){}}},
   runtime:{async sendMessage(){return {ok:true}}}
 };
 const IntersectionObserver=class{
   observe(){}unobserve(){}disconnect(){}
 };
 vm.runInNewContext(source,{window,document,localStorage,chrome,
   IntersectionObserver,Event:class{constructor(type){this.type=type}},
   URL,console,JSON:json},{filename:'watchlist.js'});
 return {api:window.KinoWatchlist,nodes,data,
   setRaw(value){data.set('kinoHelperWatchlistV1',value)},
   get parses(){return parses},get created(){return created},
   get replacements(){return replacements}};
}

test('repeated membership checks reuse one normalization and JSON parse',()=>{
 const h=setup(400);
 for(let i=0;i<1000;i++)
   assert.equal(h.api.contains({type:'film',id:String(1000+i%400)}),true);
 assert.equal(h.parses,1,'list should be parsed once, not per button');
 assert.equal(h.api.getAll().length,400);
 assert.equal(h.parses,1);
 h.api.toggle({type:'film',id:'1000'});
 assert.equal(h.api.contains({type:'film',id:'1000'}),false);
 assert.equal(h.parses,2,'a local mutation invalidates cached results');
});
test('direct localStorage changes refresh cache without restarting extension',()=>{
 const h=setup(2);
 assert.equal(h.api.contains({type:'film',id:'1000'}),true);
 h.setRaw('[]');
 assert.equal(h.api.contains({type:'film',id:'1000'}),false);
 assert.equal(h.parses,2);
});
test('poster hydration replaces only one image, not all watchlist rows',()=>{
 const h=setup(22,{withUI:true});
 const rows=h.nodes.watchlistItems.children;
 assert.equal(rows.length,22);
 const beforeRows=[...rows],created=h.created,replacements=h.replacements;
 h.api.adoptPoster({type:'film',id:'1000'},
   'data:image/png;base64,ZmFrZQ==');
 assert.equal(h.nodes.watchlistItems.children.length,22);
 assert.equal(h.nodes.watchlistItems.children[21],beforeRows[21]);
 assert.equal(h.created,created+1,'only one new img expected');
 assert.equal(h.replacements,replacements+1,'only one poster holder replaced');
});
