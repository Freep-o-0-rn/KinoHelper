// Determine the *currently authenticated* Kinopoisk profile. No cookie API,
// password access, token extraction or manual profile ID required.
(function(root, factory) {
  const api=factory();
  if(typeof module!=='undefined' && module.exports)module.exports=api;
  if(root)root.KinoStatsAccount=api;
})(typeof window!=='undefined'?window:null, () => {
  'use strict';
  const ROOT='https://www.kinopoisk.ru';
  const HOSTS=new Set(['www.kinopoisk.ru','kinopoisk.ru']);
  const ID=/^[1-9]\d{0,12}$/;
  function knownURL(input) {
    try {
      const u=new URL(input);
      return u.protocol==='https:' && HOSTS.has(u.hostname) ? u : null;
    } catch {return null;}
  }
  function identityFromResponse(requested, responseUrl, html) {
    const u=knownURL(responseUrl);
    if(!u)return '';
    // /mykp/ may redirect to the owner's personal /user/<id>/ page.
    const user=u.pathname.match(/^\/user\/([1-9]\d{0,12})\/?$/);
    if(user && requested==='/mykp/')return user[1];
    // Only trust the logged-in account bootstrap on self-only /mykp pages.
    if(!u.pathname.startsWith('/mykp/'))return '';
    const match=String(html||'').match(
      /\bgetUserId\s*=\s*function\s*\(\s*\)\s*\{\s*return\s+([1-9]\d{0,12})\b/
    );
    return match && ID.test(match[1]) ? match[1] : '';
  }
  function authStatus(responseUrl, status, html) {
    const u=knownURL(responseUrl);
    if(status===401||status===403)return 'logged-out';
    if(!u)return 'unavailable';
    if(/captcha|showcaptcha/i.test(u.pathname))return 'unavailable';
    const preview=String(html||'').slice(0,120000);
    if(/smartcaptcha|showcaptcha/i.test(preview))return 'unavailable';
    if(/(?:\bвойти\b|\blogin\b|sign[\s-]*in)/i.test(preview) &&
        /(?:passport\.yandex|id\.yandex|auth\/)/i.test(preview))
      return 'logged-out';
    return 'unknown';
  }
  async function detect(fetcher=fetch) {
    let lastReason='Невозможно подтвердить профиль по личной странице.';
    let outcome='unknown';
    for(const route of ['/mykp/','/mykp/folders/1/']) {
      try {
        const reply=await fetcher(ROOT+route,{
          credentials:'include',
          cache:'no-store',
          redirect:'follow',
          signal:AbortSignal.timeout(12000)
        });
        if(!reply || typeof reply.url!=='string')continue;
        const url=knownURL(reply.url);
        if(!url) {
          lastReason='Кинопоиск перенаправил на страницу входа или другой домен.';
          outcome='logged-out';
          continue;
        }
        if(!reply.ok){
          lastReason='Ответ Кинопоиска: HTTP '+reply.status;
          if(reply.status===401||reply.status===403)outcome='logged-out';
          continue;
        }
        const html=await reply.text();
        if(html.length>6e6)throw Error('Слишком большой ответ профиля');
        const id=identityFromResponse(route,reply.url,html);
        if(id)return {status:'logged-in',id,verifiedAt:Date.now()};
        const state=authStatus(reply.url,reply.status,html);
        if(state==='logged-out')outcome='logged-out';
        lastReason=state==='unavailable'
          ? 'Кинопоиск запросил проверку браузера.'
          : 'В ответе нет подтверждённого ID аккаунта.';
      }catch(error){
        lastReason=String(error?.message||error).slice(0,160);
      }
    }
    return {status:outcome==='logged-out'?'logged-out':'unavailable',id:'',
      reason:lastReason};
  }
  return {detect,identityFromResponse,authStatus};
});
