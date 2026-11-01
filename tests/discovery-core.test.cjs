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
test('popular title is visibly labelled popular, not a personal recommendation',()=>{
 const result=core.select({recommended:[film(1,['драма'],{rating:9.5})]});
 assert.equal(result.length,1);
 assert.equal(result[0].kind,'popular');
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
 assert.equal(r.length,1);
 assert.equal(r[0].kind,'popular');
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

test('Russian premiere dates are parsed exactly and invalid dates are rejected',()=>{
 assert.equal(core.premiereDate('Премьера в мире 5 февраля 2026, ...'),'2026-02-05');
 assert.equal(core.premiereDate('Премьера в России 1 ноября 2026'),'2026-11-01');
 assert.equal(core.premiereDate('Премьера в мире 31 февраля 2026'),'');
 assert.equal(core.premiereDate('2026'), '');
});
test('a vintage film rerelease does not count as a new movie',()=>{
 const result=core.select({newReleases:[film(101,['драма'],{
   year:2010,releaseDate:date(-1)
 })]});
 assert.equal(result.length,0);
});

test('series are candidates, can match positively rated genres and keep type',()=>{
 const r=core.select({recommended:[
  {...film(55,['драма']),type:'series',title:'Сериал 55'},
  film(56,['фантастика'])
 ],ratings:{'film:100':{rating:9}},
 genreRecords:{'film:100':{genres:['драма']}}});
 assert.equal(r[0].id,'55');
 assert.equal(r[0].type,'series');
 assert.equal(r[0].kind,'for-you');
 assert.equal(r[1].kind,'popular');
});
test('history and ratings suppress the same catalog id across film and series URLs',()=>{
 const r=core.select({recommended:[
  {...film(55,['драма']),type:'series'},film(56,['драма'])
 ],ratings:{'film:55':{rating:8},'film:100':{rating:9}},
 genreRecords:{'film:100':{genres:['драма']}}});
 assert.deepEqual(r.map(x=>x.id),['56']);
 const h=core.select({recommended:[film(55,['драма'])],
  history:[{url:'https://www.kinopoisk.ru/series/55/'}]});
 assert.deepEqual(h,[]);
});
test('a series needs a verified recent premiere to be labelled new',()=>{
 const series={...film(75,['драма'],{releaseDate:date(-1)}),type:'series'};
 const r=core.select({newReleases:[series]});
 assert.equal(r[0].kind,'new');
 assert.equal(r[0].type,'series');
 assert.equal(core.select({newReleases:[{...series,releaseDate:''}]}).length,0);
});
