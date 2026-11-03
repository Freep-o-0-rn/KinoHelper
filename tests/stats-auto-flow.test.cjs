'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const core=require('../stats-core.js');
const script=readFileSync(path.join(__dirname,'..','stats.js'),'utf8');
class Element {
  constructor(){this.events={};this.dataset={};this.children=[];this.style={};
    this.textContent='';this.hidden=false;this.disabled=false;this.value='';
    this.max=100;this.classList={add(){},remove(){},toggle(){}};}
  addEventListener(type,fn){this.events[type]=fn;}
  setAttribute(){}
  removeAttribute(key){if(key==='value')this.value=undefined;}
  append(...children){this.children.push(...children);}
  appendChild(child){this.children.push(child);}
  replaceChildren(...children){this.children=children;}
}
function setup(){
  const nodes={},listeners=[];
  const document={body:new Element(),activeElement:null,
    getElementById(id){return nodes[id] ||= new Element();},
    createElement(){return new Element();},
    createElementNS(){return new Element();}
  };
  const accountId='1234567',state={
    kinoStatsProfileId:'',
    kinoStatsImportJobV2:{
      profileId:accountId,pagesDone:3,totalPages:20,nextPage:4,
      importedVotes:41,state:'loading',message:'Импорт продолжается'
    },
    kinoStatsRatingsV1:{[accountId]:{'film:1':{rating:10}}}
  };
  let ensures=0;
  const authOptions=[];
  const chrome={
    storage:{local:{
      async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys])
        .map(k=>[k,state[k]]));},
      async set(values){
        Object.assign(state,values);
        for(const cb of listeners)cb(Object.fromEntries(Object.keys(values)
          .map(k=>[k,{newValue:values[k]}])),'local');
      }
    },onChanged:{addListener(fn){listeners.push(fn);}}},
    runtime:{async sendMessage(msg){
      if(msg.action==='statsImportEnsure'){
        ensures++;
        return {ok:true,job:state.kinoStatsImportJobV2};
      }
      throw Error('Unexpected action '+msg.action);
    }}
  };
  const window={
    KinoStatsCore:core,
    KinoStatsAccount:{async detect(_fetcher,options){
      authOptions.push(options||{});
      return {status:'logged-in',id:accountId};
    }},
    addEventListener(){}
  };
  new Function('window','document','chrome',script)(window,document,chrome);
  const settle=async()=>{
    for(let i=0;i<70;i++)await new Promise(resolve=>setImmediate(resolve));
  };
  return {nodes,state,listeners,authOptions,settle,
    open(){nodes.statsButton.events.click();},
    get ensures(){return ensures;}};
}
test('statistics automatically starts worker and shows progress',async()=>{
  const ui=setup();ui.open();await ui.settle();
  assert.equal(ui.ensures,1);
  assert.equal(ui.state.kinoStatsProfileId,'1234567');
  assert.match(ui.nodes.statsAccountStatus.textContent,/Вход выполнен/);
  assert.match(ui.nodes.statsImportCount.textContent,/3 \/ 20/);
  assert.equal(ui.nodes.statsImportProgress.value,3);
  assert.equal(ui.nodes.statsImportProgress.max,20);
  assert.match(ui.nodes.statsImportStatus.textContent,/в фоне/);
});
test('background page updates refresh score and progress UI automatically',async()=>{
  const ui=setup();ui.open();await ui.settle();
  const job={...ui.state.kinoStatsImportJobV2,pagesDone:20,
    nextPage:21,state:'completed',importedVotes:209};
  ui.state.kinoStatsImportJobV2=job;
  for(const cb of ui.listeners)
    cb({kinoStatsImportJobV2:{newValue:job}},'local');
  await ui.settle();
  assert.match(ui.nodes.statsImportCount.textContent,/20 \/ 20/);
  assert.match(ui.nodes.statsImportStatus.textContent,/Импорт завершён/);
  assert.equal(ui.nodes.statsImportProgress.value,20);
});


test('statistics lists every genre and percentage, including uncommon categories',async()=>{
  const ui=setup();
  const films={}, genres={};
  for(let i=0;i<18;i++){
    const id=String(1000+i);
    films['film:'+id]={type:'film',id,position:120,duration:300,completed:true};
    genres['film:'+id]={genres:['драма','жанр '+(i+1)]};
  }
  ui.state.kinoPlaybackProgressV1=films;
  ui.state.kinoStatsGenresV1=genres;
  ui.open();
  await ui.settle();
  const rows=ui.nodes.statsGenresLegend.children;
  assert.equal(rows.length,19);
  assert.equal(rows[0].children[1].textContent,'драма');
  assert.equal(rows[0].children[2].textContent,'50%');
  assert.ok(rows.some(row=>row.children[1].textContent==='жанр 18'));
  assert.ok(rows.every(row=>row.children[1].textContent!=='Другие'));
  assert.ok(rows.slice(1).every(row=>row.children[2].textContent==='2,8%'));
  assert.match(ui.nodes.statsGenresNote.textContent,/19 жанров/);
});


test('tiny genres can be inspected from full-size legend rows, including keyboard',async()=>{
  const ui=setup(),films={},genres={};
  for(let i=0;i<24;i++){
    const id=String(500+i);
    films['film:'+id]={type:'film',id,position:300,duration:300,completed:true};
    genres['film:'+id]={genres:['комедия','жанр '+(i+1)]};
  }
  ui.state.kinoPlaybackProgressV1=films;
  ui.state.kinoStatsGenresV1=genres;
  ui.open();await ui.settle();
  const legend=ui.nodes.statsGenresLegend.children;
  const tiny=legend.find(row=>row.children[1].textContent==='жанр 24');
  assert.ok(tiny,'minor genres remain listed separately');
  assert.ok(tiny.events.mouseenter,'each genre has a full-row hover target');
  assert.ok(tiny.events.focus,'each genre can be focused via keyboard');
  assert.ok(tiny.events.keydown,'each genre has keyboard activation');
  const donut=ui.nodes.statsGenresChart.children[0];
  const center=donut.children[1].children;
  tiny.events.mouseenter();
  assert.equal(center[1].textContent,'жанр 24');
  assert.match(center[0].textContent,/%/);
  tiny.events.mouseleave();
  assert.equal(center[1].textContent,'комедия');
});


test('import cursor-only updates refresh progress without recreating charts',async()=>{
  const ui=setup();ui.open();await ui.settle();
  const chart=ui.nodes.statsRatingsChart.children[0];
  const job={...ui.state.kinoStatsImportJobV2,
    pagesDone:4,nextPage:5,importedVotes:50};
  for(const callback of ui.listeners)
    callback({kinoStatsImportJobV2:{newValue:job}},'local');
  await ui.settle();
  assert.equal(ui.nodes.statsImportProgress.value,4);
  assert.equal(ui.nodes.statsRatingsChart.children[0],chart,
    'a progress counter update must not recreate the rating donut');
});


test('opening statistics twice avoids forced login checks; refresh button forces one',async()=>{
 const ui=setup();
 ui.open();await ui.settle();
 assert.equal(ui.authOptions.length,1);
 assert.equal(ui.authOptions[0].force,false);
 ui.nodes.statsBack.events.click();
 ui.open();await ui.settle();
 assert.equal(ui.authOptions.length,1,
   'reopen within freshness window should not check again');
 ui.nodes.statsAccountRefresh.events.click();
 await ui.settle();
 assert.equal(ui.authOptions.length,2);
 assert.equal(ui.authOptions[1].force,true,
   'manual refresh must bypass the shared auth cache');
});
