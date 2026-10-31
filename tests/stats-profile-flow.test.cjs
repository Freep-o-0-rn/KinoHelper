'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const core = require('../stats-core.js');
const parser = require('../stats-profile-import.js');

const script = readFileSync(path.join(__dirname, '..', 'stats.js'),'utf8');
class Node {
  constructor() {
    this.events = {}; this.children = []; this.style = {}; this.dataset = {};
    this.hidden = false; this.value = ''; this.textContent = '';
    this.classList = { add(){}, remove(){}, toggle(){} };
  }
  addEventListener(name, cb) { this.events[name] = cb; }
  setAttribute() {}
  replaceChildren(...values) { this.children = values; }
  append(...values) { this.children.push(...values); }
  appendChild(value) { this.children.push(value); }
}
const ssr = (id,rating) => ({
  apolloState:{
    ROOT_QUERY: { movieReactions: {__ref:'Listing'} },
    Listing:{items:[{__ref:'Reaction'}]},
    Reaction:{__typename:'UserMovieReactions',
      movie:{__ref:'Movie'},reactions:[{__ref:'Vote'}]},
    Movie:{__typename:'Film',id},
    Vote:{__typename:'Vote',value:rating}
  }
});
const pageHTML = (id,rating) =>
  '<html><a href="?page=2">2</a><script data-tid="ssr">' +
  'window.Ya.__ssr_initial_data = ' + JSON.stringify(ssr(id,rating)) +
  ';</script></html>';

function setup() {
  const elements = {};
  const doc = {
    body: new Node(), activeElement:null,
    getElementById(id){ return elements[id] ||= new Node(); },
    createElement(){return new Node();},
    createElementNS(){return new Node();}
  };
  const values={kinoStatsProfileId:'1234567'};
  const chrome={
    storage:{
      local:{
        async get(keys){
          const result={};
          for(const k of Array.isArray(keys)?keys:[keys])result[k]=values[k];
          return result;
        },
        async set(updates){Object.assign(values,updates);}
      },
      onChanged:{addListener(){}}
    },
    runtime:{async sendMessage(){return {ok:false};}}
  };
  const requested=[];
  let failSecond=true;
  const fetch=async url=>{
    const page=Number(new URL(url).searchParams.get('page'));
    requested.push(page);
    if(page===2 && failSecond)return {url,ok:false,status:503};
    return {url,ok:true,status:200,
      text:async()=>pageHTML(page===1?123:456,page===1?10:7)};
  };
  const window={
    KinoStatsCore:core, KinoProfileVotes:parser,
    KinoStatsAccount:{detect:async()=>({status:'logged-in',id:'1234567'})},
    addEventListener(){}
  };
  new Function('window','document','chrome','fetch','URL','AbortSignal',
    script)(window,doc,chrome,fetch,URL,AbortSignal);
  const openStats=doc.getElementById('statsButton');
  const button=doc.getElementById('statsProfileImport');
  const wait = async () => {
    for(let i=0;i<50;i++)await new Promise(resolve=>setImmediate(resolve));
  };
  return {
    values,requested,button,openStats,wait,
    retry(){failSecond=false;},
    getStatus(){return doc.getElementById('statsImportStatus').textContent;}
  };
}

test('partial failures persist verified votes; retry resumes next page',async()=>{
  const ui=setup();
  // Opening statistics automatically detects the current user and starts import.
  ui.openStats.events.click();
  await ui.wait();
  assert.equal(ui.values.kinoStatsRatingsV1['1234567']['film:123'].rating,10);
  assert.equal(ui.values.kinoStatsRatingsV1['1234567']['film:456'],undefined);
  assert.equal(ui.values.kinoStatsProfileImportV1['1234567'].nextPage,2);
  assert.match(ui.getStatus(),/503/);
  ui.retry();
  ui.button.events.click();
  await ui.wait();
  const account=ui.values.kinoStatsRatingsV1['1234567'];
  assert.equal(account['film:123'].rating,10);
  assert.equal(account['film:456'].rating,7);
  assert.deepEqual(ui.requested,[1,2,2]);
  assert.equal(ui.values.kinoStatsProfileImportV1['1234567'].pages,2);
  assert.equal(ui.values.kinoStatsProfileImportV1['1234567'].votes,2);
  assert.equal(ui.values.kinoStatsWatchTimeV1,undefined);
  assert.equal(ui.values.kinoStatsLibraryV1,undefined);
});
