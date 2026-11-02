'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');

const background=readFileSync(path.join(__dirname,'..','background.js'),'utf8');
const from=background.indexOf("const DISPLAY_MODE_STORAGE_KEY =");
const until=background.indexOf("// Resume playback:",from);
assert.ok(from>=0&&until>from,'display mode background block exists');
const modeCode=background.slice(from,until);
const settingsCode=readFileSync(path.join(__dirname,'..','display-mode.js'),'utf8');

function backgroundHarness(saved){
  const calls=[],writes=[],listeners=[];
  const chrome={
    sidePanel:{
      async setOptions(opts){calls.push(['options',opts]);},
      async setPanelBehavior(opts){calls.push(['behavior',opts]);}
    },
    action:{async setPopup(opts){calls.push(['popup',opts]);}},
    storage:{local:{
      async get(){return saved===undefined?{}:{kinoHelperDisplayMode:saved};},
      async set(value){writes.push(value);}
    }},
    runtime:{onMessage:{addListener(fn){listeners.push(fn);}}}
  };
  new Function('chrome','console',modeCode)(chrome,{warn(){}});
  return {
    calls,writes,
    settle:async()=>{for(let i=0;i<25;i++)await Promise.resolve();},
    async switchTo(mode){
      return new Promise(resolve=>listeners[0]({
        action:'setKinoHelperDisplayMode',mode
      },{},resolve));
    }
  };
}
function settingsHarness(saved){
  const elements={
    displayModeToggle:{checked:false,disabled:false,listeners:{},
      addEventListener(k,fn){this.listeners[k]=fn;}},
    displayModeStatus:{textContent:'',classList:{toggle(){}}}
  };
  let request=null;
  const chrome={
    storage:{
      local:{async get(){return saved===undefined?{}:{kinoHelperDisplayMode:saved};}},
      onChanged:{addListener(){}}
    },
    runtime:{async sendMessage(msg){
      request=msg;
      return {ok:true,mode:msg.mode};
    }}
  };
  new Function('chrome','document','console',settingsCode)(
    chrome,{getElementById:id=>elements[id]},{warn(){}});
  return {
    input:elements.displayModeToggle,
    get request(){return request;},
    settle:async()=>{for(let i=0;i<10;i++)await Promise.resolve();}
  };
}

test('a new installation opens Chrome Side Panel by default',async()=>{
  const h=backgroundHarness(undefined);await h.settle();
  assert.deepEqual(h.calls,[
    ['options',{path:'sidepanel.html',enabled:true}],
    ['popup',{popup:''}],
    ['behavior',{openPanelOnActionClick:true}]
  ]);
  assert.deepEqual(h.writes,[],'initial default is not an explicit preference');
});
test('a previously selected popup stays enabled after updating extension',async()=>{
  const h=backgroundHarness('popup');await h.settle();
  assert.deepEqual(h.calls,[
    ['behavior',{openPanelOnActionClick:false}],
    ['popup',{popup:'popup.html'}]
  ]);
});
test('an existing side panel preference continues working',async()=>{
  const h=backgroundHarness('sidepanel');await h.settle();
  assert.equal(h.calls.at(-1)[1].openPanelOnActionClick,true);
});
test('user can explicitly switch back to popup and preference persists',async()=>{
  const h=backgroundHarness(undefined);await h.settle();
  const response=await h.switchTo('popup');
  assert.deepEqual(response,{ok:true,mode:'popup'});
  assert.deepEqual(h.writes,[{kinoHelperDisplayMode:'popup'}]);
  assert.deepEqual(h.calls.at(-1),['popup',{popup:'popup.html'}]);
});
test('settings toggle matches default side panel but honors saved popup',async()=>{
  const fresh=settingsHarness(undefined);await fresh.settle();
  assert.equal(fresh.input.checked,true);
  const existing=settingsHarness('popup');await existing.settle();
  assert.equal(existing.input.checked,false);
});
test('settings popup choice sends explicit action to background',async()=>{
  const h=settingsHarness(undefined);await h.settle();
  h.input.checked=false;
  await h.input.listeners.change();
  assert.deepEqual(h.request,{action:'setKinoHelperDisplayMode',mode:'popup'});
});
