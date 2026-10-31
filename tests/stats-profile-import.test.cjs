'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../stats-profile-import.js');

function page(body,links='') {
  const state=JSON.stringify(body).replace(/</g,'\\u003c');
  return '<html><body>'+links+
    '<script data-tid="ssr">window.Ya.__ssr_initial_data = '+
    state+';</script></body></html>';
}
const state={
  apolloState:{
    ROOT_QUERY:{"movieReactions({\"limit\":20})":{__ref:"List:1"}},
    "List:1":{items:[
      {__ref:"Reaction:1"}, {__ref:"Reaction:2"}, {__ref:"Reaction:3"}
    ]},
    "Reaction:1":{
      __typename:"UserMovieReactions",movie:{__ref:"Film:123"},
      "reactions({})":[{__ref:"Vote:1"}]},
    "Reaction:2":{
      __typename:"UserMovieReactions",movie:{__ref:"Series:456"},
      reactions:[{__ref:"Vote:2"}]},
    "Reaction:3":{
      __typename:"UserMovieReactions",movie:{__ref:"Film:789"},
      reactions:[{__ref:"Watched:3"}]},
    "Film:123":{id:123,__typename:"Film",rating:{kinopoisk:{value:9.9}}},
    "Series:456":{id:456,__typename:"TvSeries"},
    "Film:789":{id:789,__typename:"Film"},
    "Vote:1":{__typename:"Vote",value:10},
    "Vote:2":{__typename:"Vote",value:7},
    "Watched:3":{__typename:"Watched"}
  }
};

test('personal votes are extracted by explicit Vote objects only',()=>{
  const parsed=parser.parsePage(page(state,'<a href="?page=2">2</a>'));
  assert.equal(parsed.source,'ssr');
  assert.equal(parsed.lastPage,2);
  assert.deepEqual(parsed.votes,[{type:'film',id:'123',rating:10},
    {type:'series',id:'456',rating:7}]);
});
test('public movie score and watched-only records do not count as votes',()=>{
  const x=JSON.parse(JSON.stringify(state));
  x.apolloState['Reaction:1'].reactions=[{__ref:'Watched:3'}];
  delete x.apolloState['Reaction:1']['reactions({})'];
  const votes=parser.parsePage(page(x)).votes;
  assert.equal(votes.length,1);
  assert.equal(votes[0].id,'456');
});
test('malformed JSON, missing user reactions and unsafe types return no votes',()=>{
  assert.deepEqual(parser.readSSRRecords({apolloState:{ROOT_QUERY:{}}}),[]);
  assert.equal(parser.parsePage('<html></html>').votes.length,0);
  const bad=JSON.parse(JSON.stringify(state));
  bad.apolloState['Film:123'].__typename='Person';
  assert.equal(parser.readSSRRecords(bad).find(v=>v.id==='123'),undefined);
});
test('several ratings do not duplicate the same movie ID',()=>{
  const x=JSON.parse(JSON.stringify(state));
  x.apolloState['List:1'].items.push({__ref:'Reaction:1'});
  assert.equal(parser.parsePage(page(x)).votes.length,2);
});
test('verified page count is derived from pagination, not assumed',()=>{
  assert.equal(parser.parsePage(page(state)).lastPage,null);
  assert.equal(parser.parsePage(page(state,'<a href="?page=5">5</a>')).lastPage,5);
});
