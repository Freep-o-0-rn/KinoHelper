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
 assert.deepEqual(result.map(x=>x.id),['10','11']);
 assert.equal(result[0].kind,'for-you');
 assert.equal(result[1].kind,'popular');
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

test('poster source candidates include resized Yandex images and verified legacy fallbacks',()=>{
 const base='https://avatars.mds.yandex.net/get-kinopoisk-image/4774061/abc123';
 const sources=core.posterSources({type:'series',id:'123',posterUrl:base});
 assert.equal(sources[0],base+'/280x420');
 assert.equal(sources[1],base+'/300x450');
 assert.equal(sources[2],base+'/orig');
 assert.equal(sources.includes('https://st.kp.yandex.net/images/film_big/123.jpg'),true);
 assert.equal(sources.length,new Set(sources).size);
});
test('poster candidates use backup url and do not accept arbitrary external hosts',()=>{
 const fallback='https://avatars.mds.yandex.net/get-kinopoisk-image/111/222/orig';
 const sources=core.posterSources({
  id:'123',posterUrl:'https://example.com/untrusted.jpg',posterFallback:fallback
 });
 assert.equal(sources[0],fallback.replace('/orig','/280x420'));
 assert.equal(sources.some(u=>u.includes('example.com')),false);
 assert.equal(core.poster('//avatars.mds.yandex.net/get-kinopoisk-image/x/y/orig'),
  'https://avatars.mds.yandex.net/get-kinopoisk-image/x/y/orig');
 assert.equal(core.poster('javascript:alert(1)'),'');
});

test('only suitably large portrait images qualify as carousel posters',()=>{
 assert.equal(core.isPosterShape(280,420),true);
 assert.equal(core.isPosterShape(300,450),true);
 assert.equal(core.isPosterShape(150,200),true);
 assert.equal(core.isPosterShape(640,360),false,'landscape video thumbnail');
 assert.equal(core.isPosterShape(400,400),false,'square screenshot');
 assert.equal(core.isPosterShape(32,48),false,'tiny badge');
 assert.equal(core.isPosterShape(100,350),false,'invalid extreme portrait');
 assert.equal(core.isPosterShape(0,0),false);
});

test('all imported personal ratings with embedded genres contribute to preference ranking',()=>{
 const votes={};
 for(let i=1;i<=40;i++) votes['film:'+i]={
  rating:i<=30?9:2,
  genres:i<=30?['фантастика','приключения']:['ужасы']
 };
 const options=[
  film(600,['ужасы'],{rating:9.7}),
  film(601,['фантастика'],{rating:7.6}),
  film(602,['приключения'],{rating:7.7})
 ];
 const result=core.select({recommended:options,ratings:votes,genreRecords:{}});
 assert.deepEqual(result.map(x=>x.id),['601','602','600']);
 assert.equal(result[0].kind,'for-you');
 assert.equal(result[2].kind,'popular');
});
test('votes with genres can override positive stale genre-index data',()=>{
 const r=core.select({
  recommended:[film(80,['ужасы']),film(81,['драма'])],
  ratings:{'film:77':{rating:2,genres:['ужасы']}},
  genreRecords:{'film:77':{genres:['драма']}}
 });
 assert.equal(r.find(x=>x.id==='80').kind,'popular');
 assert.equal(r.find(x=>x.id==='81').kind,'popular');
});
test('unknown genres do not create imaginary matches from imported votes',()=>{
 const r=core.select({recommended:[film(501,['детектив'])],
  ratings:{'film:1':{rating:10},'film:2':{rating:9}}});
 assert.equal(r.length,1);
 assert.equal(r[0].kind,'popular');
});

test('popular fallback deprioritizes genres disliked across imported votes',()=>{
 const result=core.select({
  recommended:[film(801,['ужасы']),film(802,['детектив'])],
  ratings:{'film:90':{rating:1,genres:['ужасы']}}
 });
 assert.deepEqual(result.map(x=>x.id),['802','801']);
 assert.equal(result[0].kind,'popular');
});
