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


test('verified empty reaction list is distinguished from parse failure',()=>{
 const state={apolloState:{ROOT_QUERY:{movieReactions:{__ref:'List'}},
   List:{items:[]}}};
 const html='<script>window.Ya.__ssr_initial_data = '+JSON.stringify(state)+';</script>';
 const empty=parser.parsePage(html);
 assert.equal(empty.recognized,0);
 assert.equal(empty.verifiedEmpty,true);
 assert.equal(empty.items.length,0);
 assert.equal(parser.parsePage('<html></html>').verifiedEmpty,false);
});


test('planned-list SSR may expose movie nodes instead of UserMovieReactions',()=>{
 const apolloState={
   ROOT_QUERY:{plannedToWatch:{__ref:'Connection:1'}},
   'Connection:1':{edges:[{node:{__ref:'Film:123'}},
     {node:{__ref:'TvSeries:456'}}]},
   'Film:123':{__typename:'Film',id:123,
     title:{russian:'Фильм'},productionYear:2021},
   'TvSeries:456':{__typename:'TvSeries',id:456,
     title:{russian:'Сериал'}}
 };
 const result=parser.parsePage('<script>window.Ya.__ssr_initial_data = '+
   JSON.stringify({apolloState})+';</script>');
 assert.deepEqual(result.items.map(x=>x.type+':'+x.id),
   ['film:123','series:456']);
 assert.equal(result.verifiedEmpty,false);
});

test('one unrelated empty list cannot overwrite a nonempty planned list',()=>{
 const apolloState={
   ROOT_QUERY:{
     movieReactions:{__ref:'Empty'},
     plannedToWatch:{__ref:'Planned'}
   },
   Empty:{items:[]},
   Planned:{items:[{__ref:'Film:8'}]},
   'Film:8':{__typename:'Film',id:8,title:{russian:'Фильм'}}
 };
 const result=parser.parsePage('<script>window.Ya.__ssr_initial_data = '+
   JSON.stringify({apolloState})+';</script>');
 assert.equal(result.items.length,1);
 assert.equal(result.verifiedEmpty,false);
});


test('planned list excludes unrelated recommendation or rating reactions',()=>{
 const apolloState={
   ROOT_QUERY:{movieReactions:{__ref:'Ratings'},plannedToWatch:{__ref:'Planned'}},
   Ratings:{items:[{__ref:'Film:99'}]},
   Planned:{items:[{node:{__ref:'Film:42'}}]},
   'Film:99':{__typename:'Film',id:99,title:{russian:'Не добавлен'}},
   'Film:42':{__typename:'Film',id:42,title:{russian:'Мой список'}}
 };
 const result=parser.parsePage('<script>window.Ya.__ssr_initial_data = '+
   JSON.stringify({apolloState})+';</script>');
 assert.deepEqual(result.items.map(x=>x.id),['42']);
});
