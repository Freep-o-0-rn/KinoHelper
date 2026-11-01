// KinoHelper 1.573: lightweight one-minute profile synchronization.
// The initial full imports remain durable, paginated and independently
// scheduled. This heartbeat reads recent first pages without restarting them.
(() => {
  'use strict';
  const ALARM='kinoProfileMinuteSyncV1';
  const STATUS='kinoProfileMinuteSyncStatusV1';
  const PERIOD_MINUTES=1;
  const RETRY_DELAY=5*60*1000;
  const MAX_RETRY=60*60*1000;
  let running=null;
  const obj=v=>v && typeof v==='object'&&!Array.isArray(v)?v:{};
  const profileId=id=>/^[1-9]\d{0,12}$/.test(String(id||''));
  async function ensureAlarm(){
    const exists=typeof chrome.alarms.get==='function'
      ? await chrome.alarms.get(ALARM):null;
    if(!exists)await chrome.alarms.create(ALARM,{
      periodInMinutes:PERIOD_MINUTES,delayInMinutes:PERIOD_MINUTES
    });
  }
  function nextFailure(attempts){
    const count=Math.min(8,(Number(attempts)||0)+1);
    return {attempts:count,nextAt:Date.now()+Math.min(
      MAX_RETRY,RETRY_DELAY*2**Math.min(count-1,4))};
  }
  async function synchronize(){
    if(running)return running;
    running=(async()=>{
      const now=Date.now();
      const saved=obj((await chrome.storage.local.get(STATUS))[STATUS]);
      if(saved.authRetryAt>now)return {ok:false,skipped:'authentication-backoff'};
      let identity;
      // One fresh account check per minute is shared by both importers.
      // UI opens/reopens reuse this result from chrome.storage.session.
      try{identity=await self.KinoStatsAccount.detect(
        undefined,{force:true});}
      catch(error){
        const failure=nextFailure(saved.authFailures);
        await chrome.storage.local.set({[STATUS]:{
          ...saved,authFailures:failure.attempts,
          authRetryAt:failure.nextAt,authError:String(error?.message||error)
        }});
        return {ok:false,reason:'authentication-error'};
      }
      if(identity?.status!=='logged-in'||!profileId(identity.id)){
        const failure=nextFailure(saved.authFailures);
        await chrome.storage.local.set({[STATUS]:{
          ...saved,authFailures:failure.attempts,
          authRetryAt:failure.nextAt,
          authError:String(identity?.reason||'Аккаунт не подтверждён')
        }});
        return {ok:false,reason:'not-authenticated'};
      }
      const id=String(identity.id);
      const previous=saved.profileId===id?saved:{};
      const tasks=[
        ['ratings',self.KinoStatsMinuteSync],
        ['planned',self.KinoWatchlistMinuteSync]
      ];
      const results={};
      const after={...previous,profileId:id,lastCheckAt:now,
        authFailures:0,authRetryAt:0,authError:''};
      await Promise.all(tasks.map(async ([name,service])=>{
        const old=obj(previous[name]);
        if(Number(old.nextAt)>now){
          results[name]={ok:true,skipped:'rate-limit-backoff'};
          after[name]=old;return;
        }
        try{
          if(typeof service?.run!=='function')throw Error('Сервис синхронизации не загружен');
          const outcome=await service.run(identity);
          const success=outcome?.ok!==false;
          const error=String(outcome?.error||'').slice(0,180);
          const failure=success?null:nextFailure(old.failures);
          after[name]={
            checkedAt:success?Date.now():Number(old.checkedAt)||0,
            changed:success?Number(outcome.changed)||0:Number(old.changed)||0,
            skipped:String(outcome?.skipped||''),
            error,
            failures:failure?.attempts||0,
            nextAt:failure?.nextAt||0
          };
          results[name]=outcome;
        }catch(error){
          const failure=nextFailure(old.failures);
          after[name]={...old,failures:failure.attempts,
            nextAt:failure.nextAt,error:String(error?.message||error).slice(0,180)};
          results[name]={ok:false,error:after[name].error};
        }
      }));
      await chrome.storage.local.set({[STATUS]:after});
      return {ok:true,profileId:id,results};
    })().finally(()=>{running=null});
    return running;
  }
  chrome.alarms.onAlarm.addListener(alarm=>{
    if(alarm.name===ALARM)void synchronize().catch(error=>
      console.warn('[KinoHelper] Minute sync:',error));
  });
  chrome.runtime.onInstalled.addListener(()=>{
    void ensureAlarm().catch(error=>
      console.warn('[KinoHelper] Cannot schedule minute sync:',error));
  });
  chrome.runtime.onStartup.addListener(()=>{
    void ensureAlarm().catch(error=>
      console.warn('[KinoHelper] Cannot restore minute sync:',error));
  });
  // Service-worker restarts do not guarantee persistence of periodic alarms.
  void ensureAlarm().catch(error=>
    console.warn('[KinoHelper] Minute sync schedule:',error));
  self.KinoProfileMinuteSync={synchronize,ensureAlarm};
})();