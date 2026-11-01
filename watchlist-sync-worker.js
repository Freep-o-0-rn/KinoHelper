// Per-account Kinopoisk watchlist sync. No guessed GraphQL mutation.
(() => {
 'use strict';
 const STORE='kinoWatchlistProfilesV1', JOB='kinoWatchlistImportJobV1';
 const ALARM='kinoWatchlistImportV1', STEP=30000, DAY=86400000;
 let mutationRevision=0,pendingMutations=0;
 const MIN_PAGE_SIZE=20; // Full pages without navigation must be checked further.
 const MAX_PAGE=2000;
 // Stable, sorted signature of the latest parsed list page.
 const itemSignature=item=>[keyOf(item)||'',item?.title||'',
   item?.year||'',Array.isArray(item?.genres)?item.genres.join(','):'',
   item?.posterUrl||''].join('|');
 const fingerprintOf=items=>items.map(itemSignature).sort().join('\n');
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
   // Completed imports are refreshed by the minute heartbeat. A full
   // re-scan remains scheduled for the existing daily nextAt.
   await schedule(job.nextAt);
   // Start the first page immediately, rather than waiting for the 30s alarm.
   // The alarm remains the durable fallback when the panel closes.
   if(job.state==='loading' && job.page===1 && !current)
     void scan().catch(error=>console.warn('[KinoHelper] Watchlist:',error));
   return {ok:true,job};
 }
 // A rendered browser page may contain the listing even when the worker's
 // fetch received a shell/anti-bot response. Use a normal Chrome tab as a
 // read-only fallback; it shares the user's own session, with no cookie access.
 async function readRenderedPage(profileId,page){
   const targetUrl=path(profileId)+'?page='+page;
   const tab=await chrome.tabs.create({url:targetUrl,active:false});
   try {
     let last='Страница ещё загружается';
     for(let attempt=0;attempt<36;attempt++){
       if(attempt)await new Promise(done=>setTimeout(done,350));
       const live=await chrome.tabs.get(tab.id).catch(()=>null);
       if(!live)throw Error('Вкладка списка закрыта');
       const actual=new URL(live.url||targetUrl);
       if(!['www.kinopoisk.ru','kinopoisk.ru'].includes(actual.hostname) ||
          actual.pathname.replace(/\/+$/,'')!==
            new URL(path(profileId)).pathname.replace(/\/+$/,''))
         throw Error('Кинопоиск потребовал вход или подтверждение');
       if(live.status!=='complete')continue;
       const script=await chrome.scripting.executeScript({
         target:{tabId:tab.id},func:()=>document.documentElement.outerHTML
       }).catch(()=>[]);
       const html=script?.[0]?.result;
       if(typeof html!=='string'||html.length>9e6)continue;
       const result=await parse(html,page);
       if(result?.recognized || result?.verifiedEmpty)return result;
       last='Список не появился в открытой странице';
     }
     throw Error(last);
   }finally{
     await chrome.tabs.remove(tab.id).catch(()=>{});
   }
 }
 async function loadPage(profileId,page,allowBrowserFallback=true) {
   let firstError=null;
   try {
     const response=await fetch(path(profileId)+'?page='+page,{
       credentials:'include',cache:'no-store',signal:AbortSignal.timeout(20000)});
     if(!response.ok)throw Error('HTTP '+response.status);
     const target=new URL(response.url);
     if(target.protocol!=='https:'||
        !['kinopoisk.ru','www.kinopoisk.ru'].includes(target.hostname)||
        target.pathname.replace(/\/+$/,'')!==
          new URL(path(profileId)).pathname.replace(/\/+$/,''))
       throw Error('Кинопоиск перенаправил запрос');
     const html=await response.text();
     if(html.length>9e6)throw Error('Слишком большой ответ');
     const result=await parse(html,page);
     if(result?.recognized||result?.verifiedEmpty)return result;
     firstError=Error('В фоновом ответе нет списка');
   }catch(error){firstError=error;}
   // Automated minute checks never open browser tabs. Keep the rendered
   // fallback only for the initial/full import and explicit refresh.
   if(!allowBrowserFallback)throw firstError ||
     Error('Профиль не удалось прочитать');
   // One fallback per page, not a retry loop that could leave tabs behind.
   try{return await readRenderedPage(profileId,page);}
   catch(error){
     throw Error('Не удалось прочитать список: '+String(firstError?.message||'')+
       '; '+String(error?.message||error));
   }
 }

 async function scan(){
   if(current)return current;
   current=(async()=>{
     // A user-driven remote bookmark operation takes precedence over an
     // ongoing importer. A delayed page must not restore a deleted title.
     if(minuteWork)await minuteWork;
     let job=await getJob();
     if(pendingMutations){
       await schedule(Date.now()+30000);
       return job;
     }
     if(!validId(job?.profileId))return null;
     const auth=await self.KinoStatsAccount.detect();
     if(auth.status==='logged-in'&&auth.id!==job.profileId)
       return ensure(auth.id);
     if(auth.status!=='logged-in'){
       job=await putJob({...job,state:'paused',nextAt:Date.now()+3600000,
         message:'Авторизация не подтверждена'});
       await schedule(job.nextAt);return job;
     }
     if(job.state==='completed'||job.state==='partial'){
       job=await putJob({profileId:job.profileId,page:1,done:0,
         staged:{},total:null,state:'loading',count:0,failures:0,
         nextAt:Date.now(),message:'Проверяем изменения'});
     }
     try{
       if(job.page>MAX_PAGE)throw Error('Превышено число страниц');
       const result=await loadPage(job.profileId,job.page);
       // Verify identity immediately before importing data into its scope.
       const fresh=await self.KinoStatsAccount.detect(undefined,{force:true});
       if(fresh.status!=='logged-in'||fresh.id!==job.profileId)
         throw Error('Аккаунт изменился во время импорта');
       if(!Array.isArray(result?.items)||
          (!result.recognized && !result.verifiedEmpty)){
         throw Error('Список не распознан на странице '+job.page+
           ' — откройте список на Кинопоиске и попробуйте обновить');
       }
       const actual=await getJob();
       if(actual?.profileId!==job.profileId||actual.page!==job.page)return actual;
       const staged={...obj(job.staged)};
       const previousFingerprint=job.fingerprint||'';
       const fingerprint=result.items.map(item=>keyOf(item)).filter(Boolean)
         .sort().join('|');
       // If the server returns the same first page for ?page=2, avoid
       // an infinite scan and avoid showing duplicate entries.
       const repeated=job.page>1 && fingerprint &&
         fingerprint===previousFingerprint;
       if(!repeated)for(const item of result.items){
         const key=keyOf(item);
         if(key)staged[key]={...item,source:'kinopoisk'};
       }
       const explicitTotal=(Number(result.lastPage)>1
         ? Number(result.lastPage):null)||Number(job.total)||null;
       const complete=Boolean(
         result.verifiedEmpty || repeated ||
         (explicitTotal && job.page>=explicitTotal) ||
         (!explicitTotal && result.items.length<MIN_PAGE_SIZE)
       );
       // A successful individual page can be displayed immediately. Never
       // delete previous items before the complete verified scan.
       const stored=(await chrome.storage.local.get(STORE))[STORE];
       const profiles={...obj(stored)};
       const previous=obj(profiles[job.profileId]);
       const intermediate={...previous};
       for(const [key,value] of Object.entries(staged)){
         const old=previous[key];
         intermediate[key]={...value,addedAt:old?.addedAt||Date.now()};
       }
       const finalScope=Object.fromEntries(Object.entries(staged)
         .map(([key,value])=>[key,intermediate[key]]));
       // Empty first-page listing is authoritative only if SSR explicitly
       // exposes an empty planned collection; otherwise preserve old data.
       if(complete){
         const verified=await self.KinoStatsAccount.detect();
         if(verified.status!=='logged-in'||verified.id!==job.profileId)
           throw Error('Аккаунт изменился во время загрузки');
       }
       const merged=complete&&!repeated?finalScope:intermediate;
       profiles[job.profileId]=merged;
       const nextJob={...job,page:job.page+1,done:job.page,
         total:explicitTotal,staged:complete?{}:staged,
         fingerprint,count:Object.keys(staged).length,
         state:repeated?'partial':complete?'completed':'loading',failures:0,
         nextAt:Date.now()+(complete?DAY:STEP),
         message:repeated
           ? 'Сайт повторил страницу; загружено '+Object.keys(staged).length+
             '. Проверьте список на Кинопоиске.'
           :complete?'Загружено: '+Object.keys(staged).length:
             'Загружено '+Object.keys(staged).length+
             ' · страница '+job.page+(explicitTotal?'/'+explicitTotal:''),
         updatedAt:Date.now()};
       const changes={[JOB]:nextJob};
       // No need to notify all open popup/sidepanel views when the profile
       // contents did not change, e.g. a periodic full verification.
       if(JSON.stringify(previous)!==JSON.stringify(merged))
         changes[STORE]=profiles;
       if(complete&&!repeated){
         const rawQueue=(await chrome.storage.local.get('kinoWatchlistAutoRemoveV1'))
           .kinoWatchlistAutoRemoveV1;
         const queued={...obj(rawQueue)},pending={...obj(queued[job.profileId])};
         let queueChanged=false;
         for(const key of Object.keys(pending)){
           if(!finalScope[key]){delete pending[key];queueChanged=true;}
         }
         if(queueChanged){
           queued[job.profileId]=pending;
           changes.kinoWatchlistAutoRemoveV1=queued;
         }
       }
       // Atomically persist cursor and list. A service-worker restart
       // cannot leave the cursor ahead of the committed entries.
       await chrome.storage.local.set(changes);
       job=nextJob;
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
   id=String(id||'');
   const auth=await self.KinoStatsAccount.detect();
   if(!validId(id)||auth.status!=='logged-in'||auth.id!==id)
     return {ok:false,error:'Профиль Кинопоиска не подтверждён'};
   if(current)await current;
   const job=await putJob({profileId:id,page:1,done:0,total:null,
     staged:{},state:'loading',count:0,failures:0,nextAt:Date.now()});
   await schedule(job.nextAt);
   return {ok:true,job:await scan()};
 }

 // Direct GraphQL mutations share the authenticated request transport
 // with rating changes. No page navigation, tabs or synthetic DOM clicks.
 async function mutate({movie,desired,profileId,auto=false}) {
   const key=keyOf(movie);
   if(!key||typeof desired!=='boolean')
     return {ok:false,error:'Неверный фильм или действие'};
   pendingMutations++;
   mutationRevision++;
   try {
     if(current)await current;
     if(minuteWork)await minuteWork;
     // Never authorize writes solely from an expired/cached profile.
     const login=await self.KinoStatsAccount.detect(undefined,{force:true});
     if(login.status!=='logged-in'||String(profileId||'')!==login.id)
       return {ok:false,error:'Аккаунт Кинопоиска не подтверждён или изменился'};

     // Set/remove are separate idempotent mutations. Don't pre-fetch the
     // existing state: it costs an extra network request for every click.
     let changed;
     try {
       changed=await setMoviePlanned(movie,desired);
     }catch(error){
       return {ok:false,error:String(error?.message||error)};
     }
     if(!changed?.ok)return {ok:false,
       error:changed?.error||'Кинопоиск не подтвердил операцию',
       authRequired:Boolean(changed?.authRequired)};

     // Mutation SUCCESS is necessary, but read after write also confirms
     // the profile state. Bounded retry covers propagation lag.
     let verified=false;
     for(let attempt=0;attempt<4;attempt++){
       if(attempt)await new Promise(done=>setTimeout(done,attempt*250));
       const actual=await getMovieRating(movie).catch(()=>null);
       if(actual?.authorized===true && actual.planned===desired){
         verified=true;break;
       }
     }
     if(!verified)return {ok:false,
       error:'Кинопоиск принял запрос, но не удалось подтвердить состояние. '+
         'Обновите список через ↻.'};

     const auth=await self.KinoStatsAccount.detect(undefined,{force:true});
     if(auth.status!=='logged-in'||auth.id!==login.id)
       return {ok:false,error:'Аккаунт сменился. Локальные данные не изменены'};
     const old=(await chrome.storage.local.get(STORE))[STORE];
     const all={...obj(old)},scope={...obj(all[login.id])};
     if(desired)scope[key]={...movie,id:String(movie.id),
       source:'kinopoisk',addedAt:scope[key]?.addedAt||Date.now()};
     else delete scope[key];
     all[login.id]=scope;
     await chrome.storage.local.set({[STORE]:all});
     const job=await getJob();
     if(job?.profileId===login.id&&job.state==='loading'){
       const staged={...obj(job.staged)};
       if(desired)staged[key]=scope[key];
       else delete staged[key];
       await putJob({...job,staged});
     }
     if(!auto){
       const queuedRaw=(await chrome.storage.local.get(AUTO_KEY))[AUTO_KEY];
       const queue={...obj(queuedRaw)},pending={...obj(queue[login.id])};
       if(pending[key]){
         delete pending[key];queue[login.id]=pending;
         await chrome.storage.local.set({[AUTO_KEY]:queue});
       }
     }
     return {ok:true,profileId:login.id,planned:desired};
   }finally{
     pendingMutations--;
     mutationRevision++;
   }
 }

 // Serialize changes to the same title from popup, side panel and
 // automatic completion so that concurrent clicks cannot undo each other.
 const bookmarkQueue=new Map();
 function queuedMutate(payload){
   const key=String(payload?.profileId||'')+':'+String(keyOf(payload?.movie)||'');
   const before=bookmarkQueue.get(key)||Promise.resolve();
   const next=before.catch(()=>{}).then(()=>mutate(payload));
   bookmarkQueue.set(key,next);
   void next.finally(()=>{
     if(bookmarkQueue.get(key)===next)bookmarkQueue.delete(key);
   }).catch(()=>{});
   return next;
 }

 // Fast, read-only check of the newest planned-list page every minute.
 // A full multi-page re-scan is deliberately NOT restarted every minute.
 let minuteWork=null;
 async function minuteSync(identity){
   if(minuteWork)return minuteWork;
   minuteWork=(async()=>{
     const id=String(identity?.id||'');
     if(identity?.status!=='logged-in'||!validId(id))
       return {ok:false,skipped:'auth'};
     const job=await getJob();
     if(!job||job.profileId!==id){
       await ensure(id);
       return {ok:true,skipped:'started-import'};
     }
     if(job.state!=='completed')return {
       ok:true,skipped:'full-import-'+job.state
     };
     if(current||pendingMutations||Number(job.nextAt||0)<=Date.now()+60000)
       return {ok:true,skipped:'busy-or-full-due'};
     const revision=mutationRevision;
     // Do not open temporary browser tabs on a one-minute schedule.
     const result=await loadPage(id,1,false);
     if(!Array.isArray(result?.items)||
       (!result.recognized&&!result.verifiedEmpty))
       throw Error('Список Кинопоиска не распознан');
     const latest=await getJob();
     if(latest?.profileId!==id||latest.state!=='completed'||
        pendingMutations||mutationRevision!==revision)
       return {ok:true,skipped:'job-or-user-action-changed'};
     const fingerprint=fingerprintOf(result.items);
     if(latest.minuteFingerprint===fingerprint)
       return {ok:true,changed:0,skipped:'unchanged-page'};
     const now=Date.now();
     const scope=(await chrome.storage.local.get(STORE))[STORE];
     const profiles={...obj(scope)};
     const before=obj(profiles[id]);
     const next={...before};
     let newCount=0;
     for(const item of result.items){
       const key=keyOf(item);
       if(!key)continue;
       if(!next[key]){
         next[key]={...item,source:'kinopoisk',addedAt:now};
         newCount++;
       }else {
         // Metadata may improve, but preserve the original added timestamp.
         next[key]={...next[key],...item,source:'kinopoisk',
           addedAt:next[key].addedAt||now};
       }
     }
     // Replacing the entire list is only safe for an explicitly
     // verified single-page list. Otherwise removals need full re-scan.
     const singlePage=job.done===1 &&
       (result.verifiedEmpty || result.items.length<MIN_PAGE_SIZE ||
         Number(result.lastPage)===1);
     const desired=singlePage ? Object.fromEntries(result.items
       .map(item=>[keyOf(item),next[keyOf(item)]])
       .filter(([key,value])=>key&&value)) : next;
     // Count actual changed titles, not only list-size differences.
     const allKeys=new Set([...Object.keys(before),...Object.keys(desired)]);
     const changes=[...allKeys].filter(key=>
       JSON.stringify(before[key])!==JSON.stringify(desired[key])).length;
     const verified=await self.KinoStatsAccount.detect();
     if(verified.status!=='logged-in'||verified.id!==id)
       return {ok:false,skipped:'account-changed'};
     const still=await getJob();
     if(still?.profileId!==id||still.state!=='completed'||
        pendingMutations||revision!==mutationRevision)
       return {ok:true,skipped:'concurrent-change'};
     const updates={[JOB]:{...still,lastMinuteSyncAt:now,
       lastMinuteSyncChanges:changes,minuteFingerprint:fingerprint}};
     if(JSON.stringify(before)!==JSON.stringify(desired)){
       profiles[id]=desired;updates[STORE]=profiles;
     }
     await chrome.storage.local.set(updates);
     return {ok:true,checkedAt:now,changed:changes,
       partial:!singlePage};
   })().catch(error=>({ok:false,error:String(error?.message||error)}))
      .finally(()=>{minuteWork=null});
   return minuteWork;
 }
 self.KinoWatchlistMinuteSync={run:minuteSync};

 // v1.571: a completed film leaves "Буду смотреть" only after the
 // authenticated Kinopoisk state confirms its removal. The old watchlist
 // remains visible when the website cannot be changed, with a clear error.
 const AUTO_KEY='kinoWatchlistAutoRemoveV1';
 const AUTO_ALARM='kinoWatchlistAutoRemoveAlarmV1';
 let autoRunner=null;
 let autoWrite=Promise.resolve();
 const filmId=key=>/^film:([1-9]\d{0,12})$/.exec(String(key||''))?.[1]||'';
 async function queueCompletedFilm(mediaKey){
   const id=filmId(mediaKey);
   if(!id)return {ok:false,reason:'not a film'};
   const task=async()=>{
     const auth=await self.KinoStatsAccount.detect();
     if(auth.status!=='logged-in'||!validId(auth.id))
       return {ok:false,reason:'no confirmed profile'};
     const scope=await chrome.storage.local.get([STORE,AUTO_KEY]);
     const items=obj(obj(scope[STORE])[auth.id]);
     const key='film:'+id;
     let movie=items[key];
     if(!movie){
       // The full profile import may not have run yet. Confirm directly
       // that this particular title is planned on the active account.
       const remote=await getMovieRating({type:'film',id}).catch(()=>null);
       if(remote?.authorized===true && remote.planned===true){
         movie={type:'film',id,title:'Фильм №'+id};
       }else return {ok:true,queued:false,reason:'not planned on current account'};
     }
     const all={...obj(scope[AUTO_KEY])};
     const pending={...obj(all[auth.id])};
     if(pending[key]){
       return {ok:true,queued:true,reason:'already pending'};
     }
     pending[key]={movie:{...movie,type:'film',id},attempts:0,
       state:'queued',nextAt:Date.now(),updatedAt:Date.now(),error:''};
     all[auth.id]=pending;
     await chrome.storage.local.set({[AUTO_KEY]:all});
     await chrome.alarms.create(AUTO_ALARM,{when:Date.now()+30000});
     void processAutoRemovals().catch(err=>
       console.warn('[KinoHelper] Auto watchlist removal:',err));
     return {ok:true,queued:true};
   };
   const result=autoWrite.then(task,task);
   autoWrite=result.catch(()=>{});
   return result;
 }
 async function processAutoRemovals(){
   if(autoRunner)return autoRunner;
   autoRunner=(async()=>{
     const auth=await self.KinoStatsAccount.detect();
     if(auth.status!=='logged-in'||!validId(auth.id))return;
     const raw=(await chrome.storage.local.get(AUTO_KEY))[AUTO_KEY];
     const profiles={...obj(raw)},pending={...obj(profiles[auth.id])};
     const candidate=Object.entries(pending)
       .filter(([key,entry])=>filmId(key)&&entry?.state!=='failed'&&
         Number(entry?.nextAt||0)<=Date.now())
       .sort((a,b)=>Number(a[1]?.nextAt||0)-Number(b[1]?.nextAt||0))[0];
     if(!candidate)return;
     const [key,entry]=candidate;
     let result;
     try{
       // Prevent an earlier profile page fetch from reinserting the removed
       // item after the site has already confirmed its deletion.
       if(current)await current;
       result=await queuedMutate({
         movie:entry.movie,desired:false,profileId:auth.id,auto:true
       });
     }catch(error){result={ok:false,error:String(error?.message||error)};}
     const after=(await chrome.storage.local.get(AUTO_KEY))[AUTO_KEY];
     const all={...obj(after)},scope={...obj(all[auth.id])};
     // User may have changed profile or removed/replaced this job.
     if(!scope[key]||scope[key].updatedAt!==entry.updatedAt)return;
     if(result?.ok){
       delete scope[key];
       // mutate already removed the verified movie from the profile store.
     }else{
       const attempts=(Number(entry.attempts)||0)+1;
       scope[key]={...entry,attempts,updatedAt:Date.now(),
         // A failed website click keeps a tab open for manual completion:
         // do not create two more unwanted tabs on automatic retries.
         state:result?.manual||attempts>=3?'failed':'retry',
         nextAt:Date.now()+Math.min(3600000,300000*attempts),
         error:String(result?.error||'Не удалось изменить список на Кинопоиске')
           .slice(0,160)};
     }
     all[auth.id]=scope;
     await chrome.storage.local.set({[AUTO_KEY]:all});
     const next=Object.values(scope)
       .filter(v=>v?.state!=='failed')
       .map(v=>Number(v.nextAt)||Date.now()+30000)
       .sort((a,b)=>a-b)[0];
     if(next)await chrome.alarms.create(AUTO_ALARM,{
       when:Math.max(Date.now()+30000,next)});
   })().finally(()=>{autoRunner=null});
   return autoRunner;
 }
 self.KinoWatchlistAutoComplete={onFilmCompleted:queueCompletedFilm};

 chrome.alarms.onAlarm.addListener(alarm=>{
   if(alarm.name===ALARM)void scan().catch(err=>console.warn('[KinoHelper] Planned:',err));
   if(alarm.name===AUTO_ALARM)void processAutoRemovals().catch(err=>
     console.warn('[KinoHelper] Auto watchlist:',err));
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
     :queuedMutate(msg.payload||{});
   task.then(respond).catch(err=>respond({ok:false,error:String(err?.message||err)}));
   return true;
 });
 const wake=async()=>{const auth=await self.KinoStatsAccount.detect();
   if(auth.status==='logged-in')await ensure(auth.id);
   void processAutoRemovals().catch(err=>
     console.warn('[KinoHelper] Restore auto watchlist jobs:',err));};
 chrome.runtime.onStartup.addListener(()=>{void wake();});
 chrome.runtime.onInstalled.addListener(()=>{void wake();});
})();