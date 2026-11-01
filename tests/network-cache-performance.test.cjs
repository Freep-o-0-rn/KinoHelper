'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','background.js'),'utf8');

function imageLoader(fetcher) {
 const start=source.indexOf('const imageDataCache = new Map();');
 const end=source.indexOf('\nfunction convertSuggestedMovie(',start);
 assert.ok(start>=0 && end>start);
 const body=source.slice(start,end);
 return new Function('fetch','URL','AbortSignal','Uint8Array','btoa',
   body+'\nreturn {loadSearchPoster,get size(){return imageDataCache.size;},'+
   'get bytes(){return imageCacheChars}};'
 )(fetcher,URL,AbortSignal,Uint8Array,
   text=>Buffer.from(text,'binary').toString('base64'));
}
function metadataLoader(fetcher) {
 const start=source.indexOf('const searchMetadataCache = new Map();');
 const end=source.indexOf('\nasync function getMovieRating(',start);
 assert.ok(start>=0&&end>start);
 const body=source.slice(start,end);
 return new Function('fetch','URL','AbortSignal','console',
 'normalizeMediaPayload','runRatingRequest','ratingGraphqlUrl',
 'ratingRequestOptions','MOVIE_SEARCH_METADATA_QUERY','MOVIE_PREVIEW_CARD_QUERY',
 body+'\nreturn {getSearchMovieMetadata,get size(){return searchMetadataCache.size;}};'
 )(
 fetcher,URL,AbortSignal,console,
 movie=>({type:movie.type,id:Number(movie.id)}),
 task=>task(),
 operation=>'https://graphql.kinopoisk.ru/graphql/?operationName='+operation,
 ()=>({method:'POST'}),'gallery-query','preview-query');
}
function fakeImage(){
 return {ok:true,headers:{get(name){return name==='content-type'?
     'image/png':null;}},
   async arrayBuffer(){return new Uint8Array([1,2,3,4]).buffer;}};
}

test('simultaneous identical poster downloads share one fetch',async()=>{
 let calls=0;
 const loader=imageLoader(async()=>{calls++;return fakeImage();});
 const movie='https://avatars.mds.yandex.net/get-kinopoisk-image/X/Y/orig';
 const [a,b,c]=await Promise.all([
   loader.loadSearchPoster({url:movie}),
   loader.loadSearchPoster({url:movie}),
   loader.loadSearchPoster({url:movie})
 ]);
 assert.equal(calls,1);
 assert.equal(a,b);assert.equal(b,c);
 assert.match(a,/^data:image\/png;base64,/);
 assert.equal(await loader.loadSearchPoster({url:movie}),a);
 assert.equal(calls,1,'resolved poster is served from memory');
 assert.equal(loader.size,1);
 assert.ok(loader.bytes<1024);
});
test('failed poster fetch is not permanently cached',async()=>{
 let calls=0;
 const loader=imageLoader(async()=>{calls++;if(calls===1)
   throw Error('Temporary network error');
   return fakeImage();
 });
 const url='https://st.kp.yandex.net/images/film_big/100.jpg';
 await assert.rejects(()=>loader.loadSearchPoster({url}));
 assert.match(await loader.loadSearchPoster({url}),/^data:image\/png/);
 assert.equal(calls,2);
});
test('simultaneous metadata requests share GraphQL and cached result',async()=>{
 let calls=0;
 const loader=metadataLoader(async()=>{
   calls++;
   return {ok:true,async json(){return {data:{movie:{
     title:{russian:'Фильм'},productionYear:2020,
     rating:{kinopoisk:{value:7.5}},
     poster:{avatarsUrl:'https://avatars.mds.yandex.net/x'}
   }}};}};
 });
 const movie={type:'film',id:100};
 const [a,b]=await Promise.all([
   loader.getSearchMovieMetadata(movie),
   loader.getSearchMovieMetadata(movie)
 ]);
 assert.equal(calls,1);
 assert.deepEqual(a,b);
 assert.equal(a.year,2020);
 assert.equal((await loader.getSearchMovieMetadata(movie)).title,'Фильм');
 assert.equal(calls,1);
 assert.equal(loader.size,1);
});
test('metadata network failure can be retried',async()=>{
 let calls=0;
 const loader=metadataLoader(async()=>{
   calls++;
   if(calls<=2)throw Error('Service unavailable');
   return {ok:true,async json(){return {data:{movie:{
     title:{russian:'Заголовок'},productionYear:2024
   }}};}};
 });
 await assert.rejects(()=>loader.getSearchMovieMetadata({type:'film',id:101}));
 const meta=await loader.getSearchMovieMetadata({type:'film',id:101});
 assert.equal(meta.year,2024);
 assert.equal(calls,3);
});
