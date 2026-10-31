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
    KinoStatsAccount:{async detect(){return {
      status:'logged-in',id:accountId
    };}},
    addEventListener(){}
  };
  new Function('window','document','chrome',script)(window,document,chrome);
  const settle=async()=>{
    for(let i=0;i<70;i++)await new Promise(resolve=>setImmediate(resolve));
  };
  return {nodes,state,listeners,settle,open(){nodes.statsButton.events.click();},
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
