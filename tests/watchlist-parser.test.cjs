'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const parser=require('../watchlist-parser.js');
function html(items, page=1, last=2) {
 const apolloState={ROOT_QUERY:{'movieReactions({"limit":20})':{__ref:'List'}},
   List:{items:items.map((_,i)=>({__ref:'Reaction:'+i}))}};
 items.forEach((entry,i)=>{
   apolloState['Reaction:'+i]={__typename:'UserMovieReactions',
      movie:{__ref:'Movie:'+i},reactions:[]};
   apolloState['Movie:'+i]={id:entry.id,__typename:entry.kind||'Film',
      title:{russian:entry.title},productionYear:entry.year,
      genres:entry.genres?.map(name=>({name}))||[]};
 });
 return '<html><body><a href="?page='+last+'">Next</a>'+
   '<script>window.Ya.__ssr_initial_data = '+
   JSON.stringify({apolloState})+';</script></body></html>';
}
test('planned list retrieves movies and series separately',()=>{
 const result=parser.parsePage(html([
   {id:10,title:'Обливион',year:2013,genres:['фантастика']},
   {id:11,kind:'TvSeries',title:'Сериал',genres:['драма']}
 ]));
 assert.equal(result.recognized,2);
 assert.equal(result.items[0].type,'film');
 assert.equal(result.items[0].title,'Обливион');
 assert.equal(result.items[0].year,2013);
 assert.equal(result.items[1].type,'series');
 assert.equal(result.items[1].genres[0],'драма');
 assert.equal(result.lastPage,2);
});
test('invalid content and unrelated types cannot enter list',()=>{
 const parsed=parser.parsePage(html([{id:'../13',title:'Bad'},
   {id:45,kind:'Person',title:'Bad'}]));
 assert.equal(parsed.recognized,0);
 assert.equal(parsed.items.length,0);
});
test('duplicate movie reactions collapse by Kinopoisk ID',()=>{
 const parsed=parser.parsePage(html([
   {id:55,title:'Film'}, {id:55,title:'Film'}
 ]));
 assert.equal(parsed.items.length,1);
});
