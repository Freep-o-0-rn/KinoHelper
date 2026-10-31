// KinoHelper 1.561: durable rate-limited page-by-page ratings importer.
// Runs from the MV3 service worker. Chrome alarms resume work even after the
// popup or side panel is closed. No open tab, user-entered ID, or polling loop.
(() => {
  'use strict';
  const ALARM='kinoStatsFullImportV1';
  const JOB='kinoStatsImportJobV2';
  const RATINGS='kinoStatsRatingsV1';
  const LEGACY='kinoStatsProfileImportV1';
  const PAGE_DELAY=60 * 1000;
  const REFRESH_DELAY=24 * 60 * 60 * 1000;
  const MAX_PAGE=20000; // Security ceiling, not a per-session batch limit.
  const PROFILE=/^[1-9]\d{0,12}$/;
  const safeObj=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
  let work=null, offscreenOpening=null;

  async function readJob() {
    return (await chrome.storage.local.get(JOB))[JOB] || null;
  }
  async function saveJob(job) {
    const value={...job,updatedAt:Date.now()};
    await chrome.storage.local.set({[JOB]:value});
    return value;
  }
  async function schedule(when) {
    await chrome.alarms.create(ALARM,{when:Math.max(Date.now()+30000,when)});
  }
  async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    if (!offscreenOpening) {
      offscreenOpening=chrome.offscreen.createDocument({
        url:'stats-offscreen.html',
        reasons:['DOM_PARSER'],
        justification:'Parse Kinopoisk profile ratings safely while background import runs'
      }).catch(async error=>{
        if (!(await chrome.offscreen.hasDocument())) throw error;
      }).finally(()=>{offscreenOpening=null;});
    }
    await offscreenOpening;
  }
  async function parse(html,page) {
    await ensureOffscreen();
    const response=await chrome.runtime.sendMessage({
      action:'kinoStatsParseProfilePage',html,page
    });
    if (!response?.ok) throw Error(response?.error||'Parser not available');
    return response.result;
  }
  function makeJob(id,legacy) {
    const old=safeObj(legacy);
    const next=Number.isSafeInteger(old.nextPage)&&old.nextPage>=1
      ? old.nextPage : 1;
    const total=Number.isSafeInteger(old.lastPage)&&old.lastPage>=1
      ? old.lastPage : null;
    const done=Array.isArray(old.visitedPages)
      ? old.visitedPages.filter(Number.isSafeInteger).length
      : Number(old.pages)||0;
    const completed=Boolean(total&&next>total);
    return {
      profileId:id, state:completed?'completed':'loading',
      nextPage:next, pagesDone:done, totalPages:total,
      importedVotes:Number(old.votes)||0, failures:0,
      nextAt:Date.now()+(completed?REFRESH_DELAY:1000),
      message:completed?'Все обнаруженные страницы загружены':'Импорт продолжается',
      previousFingerprint:''
    };
  }
  async function start(id) {
    if (!PROFILE.test(String(id)))return {ok:false,error:'invalid account ID'};
    const existing=await readJob();
    if (existing?.profileId===id) {
      // Don't replace an in-progress position when popup reopens.
      if (!['completed','loading','retry','paused'].includes(existing.state)) {
        const restarted=await saveJob({...existing,state:'loading',nextAt:Date.now()+1000});
        await schedule(restarted.nextAt);
      } else {
        await schedule(existing.nextAt || Date.now()+1000);
      }
      return {ok:true,job:existing};
    }
    const data=await chrome.storage.local.get(LEGACY);
    const job=await saveJob(makeJob(id,safeObj(data[LEGACY])[id]));
    await schedule(job.nextAt);
    return {ok:true,job};
  }

  async function fetchProfilePage(job) {
    const page=job.nextPage;
    const url='https://www.kinopoisk.ru/user/'+job.profileId+
      '/movies/voted-watched/?page='+page;
    const response=await fetch(url,{
      credentials:'include',cache:'no-store',
      signal:AbortSignal.timeout(20000)
    });
    if(!response.ok) {
      const problem=Error('HTTP '+response.status);
      problem.code=response.status;
      throw problem;
    }
    let actual;
    try {actual=new URL(response.url);}catch{throw Error('Недопустимый URL ответа');}
    if(actual.protocol!=='https:' ||
       !['www.kinopoisk.ru','kinopoisk.ru'].includes(actual.hostname) ||
       !new RegExp('^/user/'+job.profileId+'/movies/voted-watched/?$')
         .test(actual.pathname)) {
      throw Error('Кинопоиск перенаправил на другую страницу');
    }
    const html=await response.text();
    if(html.length>9e6)throw Error('Слишком большой ответ Кинопоиска');
    return parse(html,page);
  }

  async function handleFailure(job,error) {
    const message=String(error?.message||error).slice(0,210);
    const blocked=/captcha|проверку браузера|HTTP 401|HTTP 403|HTTP 429|HTTP 503|redirect|перенаправил/i.test(message);
    const fail=Math.min(100,(job.failures||0)+1);
    // No attempts to bypass access checks; retry slowly when user can
    // complete the challenge in their normal browser session.
    const delay=blocked ? Math.min(6*60*60*1000,60*60*1000*2**Math.min(fail-1,3))
      : Math.min(60*60*1000,[120000,300000,900000,1800000,3600000][Math.min(fail-1,4)]);
    const nextAt=Date.now()+delay;
    const newer=await saveJob({...job,failures:fail,
      state:blocked?'paused':'retry',nextAt,
      message:blocked ? 'Доступ ограничен: '+message :
        'Ошибка загрузки: '+message});
    await schedule(nextAt);
    return newer;
  }
  async function onePage() {
    if(work)return work;
    work=(async()=>{
      let job=await readJob();
      if (!job?.profileId || !PROFILE.test(job.profileId)) return null;
      // A completed import automatically refreshes tomorrow, with no user action.
      if(job.state==='completed') {
        job=await saveJob({...job,state:'loading',nextPage:1,
          pagesDone:0,totalPages:null,previousFingerprint:'',
          failures:0,message:'Проверяем обновления оценок'});
      }
      try {
        const identity=await self.KinoStatsAccount.detect();
        if(identity.status!=='logged-in' || identity.id!==job.profileId) {
          const reason=identity.status==='logged-in'
            ? 'Выполнен вход в другой профиль'
            : identity.status==='logged-out' ? 'Вход в Кинопоиск не выполнен'
              : 'Невозможно проверить текущий профиль';
          return handleFailure(job,Error(reason));
        }
        if(job.nextPage>MAX_PAGE) {
          return handleFailure(job,Error('Необычно большое количество страниц. Нужна проверка формата'));
        }
        job=await saveJob({...job,state:'loading',
          message:'Загружаем страницу '+job.nextPage+
            (job.totalPages?' из '+job.totalPages:'')});
        const parsed=await fetchProfilePage(job);
        if(!Array.isArray(parsed?.votes) || !parsed.votes.length &&
            !parsed.recognized) {
          throw Error('Страница не содержит распознанных записей профиля');
        }
        const fingerprint=parsed.votes.map(v=>v.type+':'+v.id+':'+v.rating).join('|');
        if(fingerprint && fingerprint===job.previousFingerprint) {
          throw Error('Кинопоиск повторил ту же страницу. Импорт приостановлен');
        }
        const snapshot=await chrome.storage.local.get([RATINGS,LEGACY]);
        const all={...safeObj(snapshot[RATINGS])};
        const account={...safeObj(all[job.profileId])};
        let received=0;
        for(const item of parsed.votes) {
          if(!['film','series'].includes(item?.type) ||
             !PROFILE.test(String(item.id)) ||
             !Number.isInteger(item.rating) ||
             item.rating<1 || item.rating>10) continue;
          account[item.type+':'+item.id]={
            rating:item.rating,source:'kinopoisk-profile',updatedAt:Date.now()
          };
          received++;
        }
        all[job.profileId]=account;
        const legacy={...safeObj(snapshot[LEGACY])};
        const previous=safeObj(legacy[job.profileId]);
        const visited=[...new Set([
          ...(Array.isArray(previous.visitedPages)?previous.visitedPages:[]),
          job.nextPage
        ])].filter(n=>Number.isSafeInteger(n)&&n>=1&&n<=MAX_PAGE)
          .sort((a,b)=>a-b);
        const known=Number.isInteger(parsed.lastPage)&&parsed.lastPage>=job.nextPage
          ? parsed.lastPage : null;
        const total=Math.max(job.totalPages||0,known||0)||null;
        const page=job.nextPage;
        const votes=Object.values(account)
          .filter(v=>Number.isInteger(v?.rating)&&v.rating>=1&&v.rating<=10).length;
        legacy[job.profileId]={
          ...previous,visitedPages:visited,pages:visited.length,
          nextPage:page+1,lastPage:total,votes,updatedAt:Date.now()
        };
        const completed=Boolean(total && page>=total);
        const nextAt=Date.now()+(completed?REFRESH_DELAY:PAGE_DELAY);
        const nextJob={
          ...job,state:completed?'completed':'loading',
          nextPage:page+1,pagesDone:job.pagesDone+1,
          totalPages:total,importedVotes:votes,
          failures:0,nextAt,previousFingerprint:fingerprint,
          message:completed?
            'Все доступные страницы загружены. Обновления проверяются автоматически.'
            :'Страница '+page+' загружена ('+received+' оценок); продолжаем'
        };
        // Ratings, cursor and status must commit together; an alarm after
        // a service worker restart will never skip a page that was not saved.
        await chrome.storage.local.set({
          [RATINGS]:all,[LEGACY]:legacy,
          [JOB]:{...nextJob,updatedAt:Date.now()}
        });
        await schedule(nextAt);
        return nextJob;
      } catch(error) {
        return handleFailure(job,error);
      }
    })().finally(()=>{work=null;});
    return work;
  }
  async function wake() {
    const job=await readJob();
    if(!job) return;
    await schedule(job.nextAt || Date.now()+30000);
  }

  chrome.alarms.onAlarm.addListener(alarm=>{
    if(alarm.name===ALARM)void onePage().catch(error=>{
      console.warn('[KinoHelper] Background profile import:',error);
      void schedule(Date.now()+5*60*1000);
    });
  });
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(message?.action!=='statsImportEnsure'&&message?.action!=='statsImportStatus')return;
    if(sender.id!==chrome.runtime.id || sender.tab ||
       !String(sender.url||'').startsWith(chrome.runtime.getURL(''))) {
      respond({ok:false,error:'untrusted extension context'});
      return false;
    }
    const task=message.action==='statsImportEnsure'
      ? start(String(message.profileId||'')) : readJob().then(job=>({ok:true,job}));
    task.then(respond).catch(error=>respond({ok:false,error:String(error?.message||error)}));
    return true;
  });
  chrome.runtime.onStartup.addListener(()=>{void wake();});
  chrome.runtime.onInstalled.addListener(()=>{void wake();});
})();
