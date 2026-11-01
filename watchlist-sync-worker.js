// Per-account Kinopoisk watchlist sync. No guessed GraphQL mutation.
(() => {
 'use strict';
 const STORE='kinoWatchlistProfilesV1', JOB='kinoWatchlistImportJobV1';
 const ALARM='kinoWatchlistImportV1', STEP=30000, DAY=86400000;
 const validId=id=>/^[1-9]\d{0,12}$/.test(String(id));
 const obj=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
 const keyOf=m=>['film','series'].includes(m?.type)&&validId(m.id)?
   m.type+':'+m.id:null;
 const path=id=>'https://www.kinopoisk.ru/user/'+id+'/movies/planned-to-watch/';
 let current=null;
 const getJob=async()=> (await chrome.storage.local.get(JOB))[JOB]||null;
 const putJob=async job=>{const next={...job,updatedAt:Date.now()};
   await chrome.storage.local.set({[JOB]:next});return next};
 const schedule=async when=>chrome.alarms.create(ALARM,{
   when:Math.max(Date.now()+30000,Number(when)||Date.now()+30000)});
 async function ensureOffscreen(){
   if(await chrome.offscreen.hasDocument())return;
   try{await chrome.offscreen.createDocument({url:'stats-offscreen.html',
     reasons:['DOM_PARSER'],justification:'Read planned films from Kinopoisk profile HTML'});}
   catch(err){if(!await chrome.offscreen.hasDocument())throw err;}
 }
 async function parse(html,page){
   await ensureOffscreen();
   const response=await chrome.runtime.sendMessage({
     action:'kinoWatchlistParsePage',html,page});
   if(!response?.ok)throw Error(response?.error||'Не удалось распознать список');
   return response.result;
 }
 async function ensure(id){
   id=String(id||'');
   const auth=await self.KinoStatsAccount.detect();
   if(!validId(id)||auth.status!=='logged-in'||auth.id!==id)
     return {ok:false,error:'Не удалось подтвердить аккаунт Кинопоиска'};
   let job=await getJob();
   if(job?.profileId!==id){
     job=await putJob({profileId:id,page:1,done:0,total:null,
       staged:{},state:'loading',nextAt:Date.now(),count:0,
       failures:0,message:'Загрузка списка'});
   } else if(job.state==='paused'&&job.message==='Авторизация не подтверждена'){
     job=await putJob({...job,state:'loading',failures:0,nextAt:Date.now()});
   }
   await schedule(job.nextAt);
   return {ok:true,job};
 }
 async function scan(){
   if(current)return current;
   current=(async()=>{
     let job=await getJob();
     if(!validId(job?.profileId))return null;
     const auth=await self.KinoStatsAccount.detect();
     if(auth.status==='logged-in'&&auth.id!==job.profileId)
       return ensure(auth.id);
     if(auth.status!=='logged-in'){
       job=await putJob({...job,state:'paused',nextAt:Date.now()+3600000,
         message:'Авторизация не подтверждена'});
       await schedule(job.nextAt);return job;
     }
     if(job.state==='completed'){
       job=await putJob({profileId:job.profileId,page:1,done:0,
         staged:{},total:null,state:'loading',count:0,failures:0,
         nextAt:Date.now(),message:'Проверяем изменения'});
     }
     try{
       if(job.page>2000)throw Error('Превышено число страниц');
       const response=await fetch(path(job.profileId)+'?page='+job.page,{
         credentials:'include',cache:'no-store',signal:AbortSignal.timeout(20000)});
       if(!response.ok)throw Error('HTTP '+response.status);
       const target=new URL(response.url);
       if(target.protocol!=='https:'||
          !['kinopoisk.ru','www.kinopoisk.ru'].includes(target.hostname)||
          target.pathname.replace(/\/+$/,'')!==
            new URL(path(job.profileId)).pathname.replace(/\/+$/,''))
         throw Error('Кинопоиск перенаправил запрос');
       const html=await response.text();
       if(html.length>9e6)throw Error('Слишком большой ответ');
       const result=await parse(html,job.page);
       if(!Array.isArray(result?.items)||
          (!result.recognized && !(job.page===1 && result.verifiedEmpty))){
         // Empty lists need explicit evidence. Preserve existing data.
         throw Error('Список не распознан — данные оставлены без изменений');
       }
       const actual=await getJob();
       if(actual?.profileId!==job.profileId||actual.page!==job.page)return actual;
       const staged={...obj(job.staged)};
       for(const item of result.items){
         const key=keyOf(item);if(key)staged[key]={...item,source:'kinopoisk'};
       }
       if(!result.lastPage && result.items.length>=20)
         throw Error('Нет подтверждённой пагинации; список оставлен без изменений');
       const total=Number(result.lastPage)||job.total||1;
       const complete=job.page>=total;
       if(complete){
         const again=await self.KinoStatsAccount.detect();
         if(again.status!=='logged-in'||again.id!==job.profileId)
           throw Error('Профиль изменился');
         const stored=(await chrome.storage.local.get(STORE))[STORE];
         const profiles={...obj(stored)};
         const old=obj(profiles[job.profileId]);
         profiles[job.profileId]=Object.fromEntries(
           Object.entries(staged).map(([k,v])=>[k,{
             ...v,addedAt:old[k]?.addedAt||Date.now()}]));
         await chrome.storage.local.set({[STORE]:profiles});
       }
       job=await putJob({...job,page:job.page+1,done:job.page,total,
         staged:complete?{}:staged,count:Object.keys(staged).length,
         state:complete?'completed':'loading',failures:0,
         nextAt:Date.now()+(complete?DAY:STEP),
         message:complete?'Список обновлён':'Загружаем список'});
       await schedule(job.nextAt);
       return job;
     }catch(err){
       const message=String(err?.message||err).slice(0,150);
       const delay=/HTTP (401|403|429|503)|captcha|проверку|авторизац/i.test(message)
         ?3600000:300000;
       job=await putJob({...job,state:'retry',
         failures:(job.failures||0)+1,
         nextAt:Date.now()+delay,message});
       await schedule(job.nextAt);return job;
     }
   })().finally(()=>{current=null});
   return current;
 }
 async function refresh(id){
   const allowed=await ensure(id);if(!allowed.ok)return allowed;
   await putJob({profileId:String(id),page:1,done:0,total:null,
     staged:{},state:'loading',count:0,failures:0,nextAt:Date.now()});
   return {ok:true,job:await scan()};
 }
 async function mutate({movie,desired,profileId}){
   const key=keyOf(movie);
   if(!key||typeof desired!=='boolean')return {ok:false,error:'Неверный фильм'};
   const login=await self.KinoStatsAccount.detect();
   if(login.status!=='logged-in')
     return {ok:false,error:'Авторизуйтесь на Кинопоиске'};
   if(String(profileId||'')!==login.id)
     return {ok:false,error:'Аккаунт Кинопоиска изменился. Обновите панель.'};
   const filmUrl='https://www.kinopoisk.ru/'+movie.type+'/'+movie.id+'/';
   const existing=await getMovieRating(movie).catch(()=>null);
   if(existing?.authorized!==true||typeof existing?.planned!=='boolean')
     return {ok:false,error:'Не удалось проверить «Буду смотреть» на Кинопоиске'};
   let confirmed=existing.planned===desired;
   const tab=confirmed?null:await chrome.tabs.create({url:filmUrl,active:false});
   try{
     for(let attempt=0;!confirmed&&attempt<24;attempt++){
       await new Promise(done=>setTimeout(done,600));
       const info=await chrome.tabs.get(tab.id).catch(()=>null);
       if(!info?.url?.startsWith(filmUrl))break;
       if(info.status!=='complete')continue;
       const click=await chrome.scripting.executeScript({
         target:{tabId:tab.id},args:[desired],
         func:want=>{
           const norm=x=>String(x||'').replace(/\s+/g,' ').trim().toLowerCase();
           const buttons=[...document.querySelectorAll('button,[role="button"]')];
           for(const el of buttons){
             if(el.disabled||el.getAttribute('aria-disabled')==='true')continue;
             const t=norm(el.getAttribute('aria-label')||el.innerText||el.textContent);
             const add=t==='буду смотреть'||t==='в буду смотреть'||
               /^добавить в .?буду смотреть/.test(t);
             const remove=(t==='буду смотреть'||t==='в буду смотреть')||
               (/^(?:убрать|удалить|не буду смотреть|в списке)/.test(t)
               && /смотр|списк/.test(t));
             if(want?add:remove){el.click();return true;}
           }
           return false;
         }
       }).catch(()=>[]);
       if(!click[0]?.result)continue;
       // Never trust a visual click alone; read the authenticated server state.
       for(let check=0;check<8;check++){
         await new Promise(done=>setTimeout(done,800));
         const remote=await getMovieRating(movie).catch(()=>null);
         if(remote?.authorized===true && remote.planned===desired){
           confirmed=true;break;
         }
       }
       break;
     }
     if(!confirmed)return {ok:false,manual:true,url:filmUrl,
       error:'Изменение не подтверждено. Нажмите кнопку на открытой вкладке Кинопоиска.'};
     const currentAuth=await self.KinoStatsAccount.detect();
     if(currentAuth.status!=='logged-in'||currentAuth.id!==login.id)
       return {ok:false,error:'Профиль изменился. Данные не сохранены.'};
     const raw=(await chrome.storage.local.get(STORE))[STORE];
     const all={...obj(raw)}, profile={...obj(all[login.id])};
     if(desired)profile[key]={...movie,id:String(movie.id),
       source:'kinopoisk',addedAt:Date.now()};
     else delete profile[key];
     all[login.id]=profile;
     await chrome.storage.local.set({[STORE]:all});
     if(tab)await chrome.tabs.remove(tab.id).catch(()=>{});
     // Server list remains authoritative and is read on the next scheduled scan.
     return {ok:true,profileId:login.id,planned:desired};
   }catch(err){
     return {ok:false,manual:true,url:filmUrl,
       error:String(err?.message||err)};
   }
 }
 chrome.alarms.onAlarm.addListener(alarm=>{
   if(alarm.name===ALARM)void scan().catch(err=>console.warn('[KinoHelper] Planned:',err));
 });
 chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
   if(!['kinoWatchlistEnsure','kinoWatchlistRefresh','kinoWatchlistSet'].includes(msg?.action))
     return false;
   if(sender.id!==chrome.runtime.id||sender.tab||
      !String(sender.url||'').startsWith(chrome.runtime.getURL(''))){
     respond({ok:false,error:'Недоверенный запрос'});return false;
   }
   const task=msg.action==='kinoWatchlistEnsure'?ensure(msg.profileId)
     :msg.action==='kinoWatchlistRefresh'?refresh(msg.profileId)
     :mutate(msg.payload||{});
   task.then(respond).catch(err=>respond({ok:false,error:String(err?.message||err)}));
   return true;
 });
 const wake=async()=>{const auth=await self.KinoStatsAccount.detect();
   if(auth.status==='logged-in')await ensure(auth.id);};
 chrome.runtime.onStartup.addListener(()=>{void wake();});
 chrome.runtime.onInstalled.addListener(()=>{void wake();});
})();