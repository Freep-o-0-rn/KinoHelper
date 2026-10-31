'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const core=require('../stats-core.js');
const parser=require('../stats-profile-import.js');
const script=readFileSync(path.join(__dirname,'..','stats.js'),'utf8');

class Element {
  constructor(){
    this.events={};this.dataset={};this.children=[];this.style={};
    this.textContent='';this.hidden=false;this.disabled=false;this.value='';
    this.classList={add(){},remove(){},toggle(){}};
  }
  addEventListener(name,handler){this.events[name]=handler;}
  setAttribute(){}
  append(...children){this.children.push(...children);}
  appendChild(child){this.children.push(child);}
  replaceChildren(...children){this.children=children;}
}
function ssr(id,rating){
  return '<html><a href="?page=1">1</a><script>' +
    'window.Ya.__ssr_initial_data = '+
    JSON.stringify({apolloState:{
      ROOT_QUERY:{movieReactions:{__ref:'List'}},
      List:{items:[{__ref:'Reaction'}]},
      Reaction:{__typename:'UserMovieReactions',movie:{__ref:'Movie'},
        reactions:[{__ref:'Vote'}]},
      Movie:{__typename:'Film',id},
      Vote:{__typename:'Vote',value:rating}
    }})+';</script></html>';
}
function setup(){
  const elements={};
  const doc={
    body:new Element(),activeElement:null,
    getElementById(id){return elements[id] ||= new Element();},
    createElement(){return new Element();},
    createElementNS(){return new Element();}
  };
  const values={
    kinoStatsProfileId:'987654',
    kinoStatsRatingsV1:{'987654':{'film:9':{rating:2}}}
  };
  const callbacks=[];
  const chrome={
    storage:{
      local:{
        async get(keys){return Object.fromEntries(
          (Array.isArray(keys)?keys:[keys]).map(k=>[k,values[k]]));},
        async set(data){
          Object.assign(values,data);
          const changes=Object.fromEntries(Object.entries(data)
            .map(([key,value])=>[key,{newValue:value}]));
          for(const cb of callbacks)cb(changes,'local');
        }
      },
      onChanged:{addListener(cb){callbacks.push(cb);}}
    },
    runtime:{async sendMessage(){return {ok:false};}}
  };
  let current='logged-in',id='1234567',requests=0;
  const window={
    KinoStatsCore:core,KinoProfileVotes:parser,
    KinoStatsAccount:{async detect(){
      return current==='logged-in' ? {status:current,id} :
        {status:current,reason:'unavailable'};
    }},
    addEventListener(){}
  };
  const fetch=async url=>{
    requests++;
    const requested=new URL(url);
    const movieId=requested.pathname.includes('/1234567/')?'101':'202';
    return {ok:true,status:200,url,
      text:async()=>ssr(movieId,movieId==='101'?10:7)};
  };
  new Function('window','document','chrome','fetch','URL','AbortSignal',
    script)(window,doc,chrome,fetch,URL,AbortSignal);
  const wait=async()=>{
    for(let i=0;i<60;i++)await new Promise(r=>setImmediate(r));
  };
  return {elements,values,wait,
    open(){elements.statsButton.events.click();},
    refresh(){elements.statsAccountRefresh.events.click();},
    switchTo(newStatus,newId){current=newStatus;id=newId;},
    get requests(){return requests;}
  };
}
test('automatic detection, logout and account switch keep votes isolated',async()=>{
  const ui=setup();
  ui.open();
  await ui.wait();
  assert.equal(ui.values.kinoStatsProfileId,'1234567');
  assert.equal(ui.values.kinoStatsRatingsV1['1234567']['film:101'].rating,10);
  assert.equal(ui.values.kinoStatsRatingsV1['987654']['film:9'].rating,2);
  assert.equal(ui.values.kinoStatsWatchTimeV1,undefined);

  ui.switchTo('logged-out');
  ui.refresh();
  await ui.wait();
  assert.equal(ui.values.kinoStatsProfileId,'');
  assert.equal(ui.elements.statsProfileImport.disabled,true);
  assert.match(ui.elements.statsAccountStatus.textContent,/Вход не найден/);
  const before=ui.requests;
  ui.elements.statsProfileImport.events.click();
  await ui.wait();
  assert.equal(ui.requests,before,'no import while signed out');

  ui.switchTo('unavailable');
  ui.refresh();
  await ui.wait();
  assert.equal(ui.values.kinoStatsProfileId,'');
  assert.equal(ui.requests,before);

  ui.switchTo('logged-in','2233445');
  ui.refresh();
  await ui.wait();
  assert.equal(ui.values.kinoStatsProfileId,'2233445');
  assert.equal(ui.values.kinoStatsRatingsV1['2233445']['film:202'].rating,7);
  assert.equal(ui.values.kinoStatsRatingsV1['1234567']['film:101'].rating,10);
  assert.equal(ui.values.kinoStatsRatingsV1['987654']['film:9'].rating,2);
  assert.equal(ui.values.kinoStatsWatchTimeV1,undefined);
});
