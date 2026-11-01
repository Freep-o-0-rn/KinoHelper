'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../discovery-core.js');
const film=(id,genres=[],other={})=>({
 type:'film',id:String(id),title:'Фильм '+id,year:2026,
 genres,posterUrl:'https://avatars.mds.yandex.net/get-kinopoisk-image/x/y',
 rating:7.4,...other
});
const date=months=>{const d=new Date();d.setUTCMonth(d.getUTCMonth()+months);
 return d.toISOString().slice(0,10);};
test('production year alone cannot qualify film as a recent new release',()=>{
 const result=core.select({newReleases:[film(101,['драма'])]});
 assert.equal(result.length,0);
});
test('verified premiere within last five months qualifies as new; future and stale films do not',()=>{
 const result=core.select({newReleases:[
   film(11,['триллер'],{releaseDate:date(-2)}),
   film(12,['триллер'],{releaseDate:date(1)}),
   film(13,['триллер'],{releaseDate:date(-11)})
 ]});
 assert.deepEqual(result.map(x=>x.id),['11']);
 assert.equal(result[0].kind,'new');
});
test('popularity or high Kinopoisk score is not a personal recommendation',()=>{
 const result=core.select({recommended:[film(1,['драма'],{rating:9.5})]});
 assert.equal(result.length,0);
});
test('positive rated genre affinity qualifies new films as personal recommendations',()=>{
 const result=core.select({recommended:[
   film(10,['драма'],{rating:9}),
   film(11,['ужасы'],{rating:9})
 ],ratings:{'film:99':{rating:9}},genreRecords:{
   'film:99':{genres:['драма']}
 }});
 assert.deepEqual(result.map(x=>x.id),['10']);
 assert.equal(result[0].kind,'for-you');
});
test('low rated genres lower rather than improve personal affinity',()=>{
 const r=core.select({recommended:[film(10,['ужасы'],{rating:9})],
 ratings:{'film:99':{rating:2}},genreRecords:{
   'film:99':{genres:['ужасы']}
 }});
 assert.equal(r.length,0);
});
test('rated, watched or opened titles are excluded from recommendations',()=>{
 const r=core.select({
 recommended:[film(10,['драма']),film(20,['драма']),film(30,['драма']),film(40,['драма'])],
 ratings:{'film:99':{rating:10},'film:10':{rating:8}},
 genreRecords:{'film:99':{genres:['драма']}},
 watched:{'film:20':{watched:true}},
 history:[{url:'https://www.kinokino.vip/film/30/'}]
 });
 assert.deepEqual(r.map(x=>x.id),['40']);
});
test('invalid new candidate does not prevent a genuine personalized match',()=>{
 const r=core.select({
 recommended:[film(10,['драма'])],
 newReleases:[film(10,['драма'],{releaseDate:''})],
 ratings:{'film:99':{rating:9}},
 genreRecords:{'film:99':{genres:['драма']}}
 });
 assert.equal(r.length,1);
 assert.equal(r[0].kind,'for-you');
});
test('when a film is both genuinely new and personalized it appears once as new',()=>{
 const r=core.select({
 recommended:[film(10,['драма'])],
 newReleases:[film(10,['драма'],{releaseDate:date(-1)})],
 ratings:{'film:99':{rating:9}},
 genreRecords:{'film:99':{genres:['драма']}}
 });
 assert.equal(r.length,1);
 assert.equal(r[0].kind,'new');
});
test('never invent unavailable rating, genres, poster or release date',()=>{
 const result=core.movie({type:'film',id:'77',title:'Название',year:2026},'new');
 assert.equal(result.rating,null);
 assert.equal(result.releaseDate,'');
 assert.deepEqual(result.genres,[]);
 assert.equal(result.posterUrl,'');
});
test('carousel selection is capped at ten movies',()=>{
 const list=Array.from({length:30},(_,i)=>film(i+10,['драма'],{
 releaseDate:date(-1)}));
 const r=core.select({newReleases:list,count:100});
 assert.equal(r.length,10);
});
