'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const parser=require('../stats-profile-import.js');
const code=readFileSync(path.join(__dirname,'..','stats-offscreen.js'),'utf8');
function setup(){
  let listener=null;
  const chrome={runtime:{
    id:'extension-test',
    getURL(name){return 'chrome-extension://extension-test/'+name;},
    onMessage:{addListener(fn){listener=fn;}}
  }};
  const window={KinoProfileVotes:parser};
  new Function('chrome','window',code)(chrome,window);
  function send(payload,sender){
    let response;
    listener(payload,sender,answer=>{response=answer;});
    return response;
  }
  return {send,chrome};
}
function profileHTML() {
  const data={apolloState:{
    ROOT_QUERY:{movieReactions:{__ref:'List'}},
    List:{items:[{__ref:'Reaction'}]},
    Reaction:{__typename:'UserMovieReactions',
      movie:{__ref:'Movie'},reactions:[{__ref:'Vote'}]},
    Movie:{__typename:'Film',id:123},
    Vote:{__typename:'Vote',value:10}
  }};
  return '<script>window.Ya.__ssr_initial_data = '+
    JSON.stringify(data)+';</script>';
}
test('offscreen DOM parser accepts background service worker messages',()=>{
  const env=setup();
  const reply=env.send({action:'kinoStatsParseProfilePage',
    html:profileHTML(),page:1},{
    id:'extension-test',
    url:'chrome-extension://extension-test/background.js'
  });
  assert.equal(reply.ok,true);
  assert.equal(reply.result.votes.length,1);
  assert.equal(reply.result.votes[0].rating,10);
});
test('offscreen parser rejects messages from content script or extension tab',()=>{
  const env=setup();
  const msg={action:'kinoStatsParseProfilePage',
    html:profileHTML(),page:1};
  assert.equal(env.send(msg,{
    id:'extension-test',
    url:'https://www.kinopoisk.ru/film/123/',tab:{id:5}
  }).ok,false);
  assert.equal(env.send(msg,{
    id:'extension-test',
    url:'chrome-extension://extension-test/popup.html'
  }).ok,false);
});
test('offscreen parser declines malformed inputs',()=>{
  const env=setup();
  const reply=env.send({action:'kinoStatsParseProfilePage',
    html:123,page:0},{
    id:'extension-test',
    url:'chrome-extension://extension-test/background.js'
  });
  assert.equal(reply.ok,false);
});
