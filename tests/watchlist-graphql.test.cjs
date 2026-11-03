'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'..','background.js'),'utf8');

function api(fakeFetch){
  const qStart=code.indexOf('const MOVIE_SET_PLANNED_QUERY = ');
  const qEnd=code.indexOf('const MOVIE_SET_VOTE_QUERY = ',qStart);
  const fnStart=code.indexOf('async function setMoviePlanned(payload, desired) {');
  const fnEnd=code.indexOf('function notifyWatchSessionChanged(',fnStart);
  assert.ok(qStart>=0 && qEnd>qStart && fnStart>=0 && fnEnd>fnStart);
  const source=code.slice(qStart,qEnd)+code.slice(fnStart,fnEnd)+
    '\nreturn setMoviePlanned;';
  return new Function('fetch','normalizeMediaPayload',
    'runRatingRequest','ratingGraphqlUrl','ratingRequestOptions',source)(
    fakeFetch,
    x=>{if(!['film','series'].includes(x?.type) || !/^\d+$/.test(String(x.id)))
      throw Error('Неверный фильм');return {id:Number(x.id),type:x.type};},
    fn=>fn(),
    op=>'https://graphql.kinopoisk.ru/graphql/?operationName='+op,
    (operationName,variables,query)=>({
      method:'POST',credentials:'include',cache:'no-store',
      headers:{'Content-Type':'application/json',
        'service-id':'25','source-id':'1','x-preferred-language':'ru'},
      body:JSON.stringify({operationName,variables,query})
    })
  );
}
function validReply(body,status=200){
  return {ok:status>=200&&status<300,status,
    async json(){return body;}};
}
test('direct add sends precise Kinopoisk mutation without opening a browser tab',async()=>{
 let calls=0;
 const set=api(async (url,opts)=>{
   calls++;const input=JSON.parse(opts.body);
   assert.match(url,/operationName=MovieSetPlannedToWatch/);
   assert.equal(input.operationName,'MovieSetPlannedToWatch');
   assert.deepEqual(input.variables,{movieId:100});
   assert.match(input.query,/plannedToWatch\s*\{\s*set\(input:/);
   assert.equal(opts.credentials,'include');
   assert.equal(opts.method,'POST');
   return validReply({data:{movie:{plannedToWatch:{
     set:{status:'SUCCESS',error:null}}}}});
 });
 assert.deepEqual(await set({type:'film',id:'100'},true),
   {ok:true,planned:true});
 assert.equal(calls,1);
});
test('direct removal sends MovieRemovePlannedToWatch, never a toggle',async()=>{
 const remove=api(async (url,opts)=>{
   const data=JSON.parse(opts.body);
   assert.match(url,/MovieRemovePlannedToWatch/);
   assert.match(data.query,/plannedToWatch\s*\{\s*remove\(input:/);
   assert.deepEqual(data.variables,{movieId:55});
   return validReply({data:{movie:{plannedToWatch:{
     remove:{status:'SUCCESS'}}}}});
 });
 assert.deepEqual(await remove({type:'series',id:55},false),
   {ok:true,planned:false});
});
test('refused request and auth failure never claim successful removal',async()=>{
 const denied=api(async()=>validReply({data:{movie:{plannedToWatch:{
   remove:{status:'FAILURE',error:{message:'Access denied'}}}}}}));
 const result=await denied({type:'film',id:99},false);
 assert.equal(result.ok,false);
 assert.match(result.error,/Access denied/);
 const noAuth=api(async()=>validReply({},401));
 const auth=await noAuth({type:'film',id:99},true);
 assert.equal(auth.ok,false);assert.equal(auth.authRequired,true);
});
test('GraphQL errors are surfaced instead of being interpreted as success',async()=>{
 const bad=api(async()=>validReply({errors:[
   {message:'Unknown mutation'}],data:{movie:{plannedToWatch:{
     set:{status:'SUCCESS'}}}}}));
 const result=await bad({type:'film',id:99},true);
 assert.equal(result.ok,false);
 assert.match(result.error,/Unknown mutation/);
});
test('Origin/Referer workaround includes the exact two new operations',()=>{
 assert.match(code,/MovieSetPlannedToWatch\|MovieRemovePlannedToWatch/);
 assert.match(code,/requestMethods:\s*\["post"\]/);
 assert.match(code,/runRatingRequest\(async \(\) => \{/);
});
