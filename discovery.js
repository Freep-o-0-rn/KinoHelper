// KinoHelper discovery carousel: read-only catalog + account-scoped ranking.
// It never submits ratings, touches playback progress, or modifies watchlists.
(() => {
  'use strict';
  const core=window.KinoDiscoveryCore;
  const box=document.getElementById('kinoDiscovery');
  if(!core||!box)return;
  const CACHE='kinoDiscoveryCatalogV1';
  const TTL=6*60*60*1000,STALE_TTL=7*24*60*60*1000,INTERVAL=5000;
  const $=id=>document.getElementById(id);
  const title=$('discoveryTitle'),kind=$('discoveryKind');
  const year=$('discoveryYear'),genre=$('discoveryGenres');
  const description=$('discoveryDescription'),rating=$('discoveryRating');
  const poster=$('discoveryPoster'),backdrop=$('discoveryBackdrop');
  const empty=$('discoveryPosterEmpty'),counter=$('discoveryCounter');
  const dots=$('discoveryDots'),link=$('discoveryOpen');
  const copy=x=>String(x||'').replace(/\s+/g,' ').trim();
  let items=[],index=0,nextAt=Date.now()+INTERVAL,hovered=false;
  let progress=0;
  const imageCache=new Map(),detailsCache=new Map(),inFlight=new Set();

  function validListResponse(response){
    try{
      const u=new URL(response.url);
      return response.ok&&u.protocol==='https:'&&
        ['www.kinopoisk.ru','kinopoisk.ru'].includes(u.hostname)&&
        u.pathname.startsWith('/lists/movies/');
    }catch{return false;}
  }
  function catalogUrl(type){
    const y=new Date().getFullYear();
    return type==='new'
      ?'https://www.kinopoisk.ru/lists/movies/year--'+y+'/?b=films&b=released'
      :'https://www.kinopoisk.ru/lists/movies/popular-films/?b=films&b=high_rated';
  }
  function urlPoster(el) {
    if(!el)return '';
    const raw=el.getAttribute('data-src')||el.getAttribute('src')||
      el.getAttribute('data-original')||'';
    const candidate=core.poster(raw);
    if(candidate)return candidate;
    const source=el.getAttribute('srcset')||el.getAttribute('data-srcset')||'';
    for(const item of source.split(',')){
      const url=core.poster(item.trim().split(/\s+/)[0]);
      if(url)return url;
    }
    return '';
  }
  function extractYear(text){
    const match=copy(text).match(/(?:18|19|20)\d{2}/);
    return match?Number(match[0]):null;
  }
  function parseCatalog(html){
    const doc=new DOMParser().parseFromString(html,'text/html');
    const body=doc.querySelector('main')||doc.body;
    if(!body)return [];
    const results=new Map();
    for(const anchor of body.querySelectorAll('a[href]')){
      const href=anchor.getAttribute('href')||'';
      // Only canonical movie links; ignore clips, actor pages, reviews.
      const m=href.match(/^\/film\/([1-9]\d{0,12})\/?(?:\?.*)?$/);
      if(!m)continue;
      const card=anchor.closest('[data-test-id*="movie-list"], [data-tid*="movie-list"], .styles_root__ti07r, article, li')||
        anchor.parentElement?.parentElement||anchor;
      const heading=card.querySelector('h3, h2, [data-test-id*="title"]');
      const img=anchor.querySelector('img')||card.querySelector('img');
      const rawTitle=copy(heading?.textContent)||copy(img?.alt)||
        copy(anchor.textContent);
      const filmTitle=rawTitle.replace(/^Смотреть\s+/i,'').slice(0,120);
      if(filmTitle.length<2||filmTitle.length>110)continue;
      const text=copy(card.textContent).slice(0,700);
      const year=extractYear(text);
      const ratingElement=card.querySelector('[data-test-id*="rating"], [class*="ratingValue"], [class*="ratingPositive"], [class*="ratingNeutral"]');
      const ratingMatch=copy(ratingElement?.textContent).match(/(?:^|\s)(\d(?:[.,]\d)?)(?:\s|$)/);
      const parsedRating=ratingMatch?Number(ratingMatch[1].replace(',','.')):null;
      // The list often has one genre after the country separator.
      const genreMatch=text.match(/(?:Россия|США|Франция|Великобритания|Германия|Канада|Япония|Индия|Корея|Австралия)\s*[•·]\s*([\p{L} -]{3,32})/u);
      const genres=genreMatch?core.genres([genreMatch[1]]):[];
      const possible=core.movie({type:'film',id:m[1],title:filmTitle,year,
        rating:parsedRating,genres,posterUrl:urlPoster(img)},'for-you');
      if(!possible)continue;
      const old=results.get(m[1]);
      if(!old||(!old.posterUrl&&possible.posterUrl))
        results.set(m[1],possible);
      if(results.size>=45)break;
    }
    return [...results.values()];
  }
  async function fetchCatalog(type){
    const url=catalogUrl(type);
    const res=await fetch(url,{credentials:'include',cache:'no-store',
      signal:AbortSignal.timeout(14000)});
    if(!validListResponse(res))throw Error('Каталог перенаправлен или недоступен');
    const html=await res.text();
    if(html.length>10e6)throw Error('Ответ каталога слишком большой');
    const parsed=parseCatalog(html);
    if(!parsed.length)throw Error('Кинопоиск не вернул распознанных фильмов');
    return parsed;
  }
  async function pick(input){
    const raw=await chrome.storage.local.get([
      'kinoStatsRatingsV1','kinoStatsWatchedV1','kinoStatsGenresV1'
    ]);
    let accountId='';
    try{
      const current=await window.KinoStatsAccount?.detect();
      if(current?.status==='logged-in'&&/^[1-9]\d{0,12}$/.test(current.id))
        accountId=current.id;
    }catch{ /* No confirmed login: use only generic catalog selection. */ }
    const ratings=accountId?raw.kinoStatsRatingsV1?.[accountId]:{};
    const watched=accountId?raw.kinoStatsWatchedV1?.[accountId]:{};
    let history=[];
    try{history=JSON.parse(localStorage.getItem('kinopoiskHistory')||'[]');}
    catch{history=[];}
    return core.select({recommended:input.popular,newReleases:input.new,
      ratings,watched,genreRecords:raw.kinoStatsGenresV1||{},history});
  }
  function drawDots(){
    dots.replaceChildren();
    items.forEach((_,i)=>{
      const dot=document.createElement('button');
      dot.type='button';
      dot.className='discovery-dot'+(i===index?' selected':'');
      dot.setAttribute('aria-label','Слайд '+(i+1)+' из '+items.length);
      dot.setAttribute('aria-current',String(i===index));
      dot.addEventListener('click',()=>go(i));
      dots.appendChild(dot);
    });
  }
  function show(){
    if(!items.length)return;
    const item=items[index],id=core.keyOf(item),cached=detailsCache.get(id);
    title.textContent=item.title;
    kind.textContent=item.kind==='new'?'✦ Новинки':'✦ Для вас';
    kind.classList.toggle('is-new',item.kind==='new');
    year.textContent=item.year?String(item.year):'';
    year.hidden=!item.year;
    const displayGenres=cached?.genres?.length?cached.genres:item.genres;
    genre.textContent=displayGenres.slice(0,3).join(', ');
    genre.hidden=!genre.textContent;
    if(year.hidden||genre.hidden)genre.classList.remove('with-dot');
    else genre.classList.add('with-dot');
    const desc=cached?.description||item.description||'';
    description.textContent=desc;
    description.hidden=!desc;
    const kpRating=Number(item.rating);
    rating.textContent=Number.isFinite(kpRating)&&kpRating>0
      ?'★ КП '+kpRating.toFixed(1).replace('.',','):'';
    rating.hidden=!rating.textContent;
    counter.textContent=(index+1)+' / '+items.length;
    const src=imageCache.get(id);
    poster.hidden=!src;backdrop.hidden=!src;empty.hidden=Boolean(src);
    if(src){poster.src=src;backdrop.src=src;}
    link.href='https://www.kinopoisk.ru/film/'+item.id+'/';
    link.setAttribute('aria-label','Открыть «'+item.title+'» на Кинопоиске');
    drawDots();
    void enrich(item);
    void preparePoster(item);
    if(items.length>1)void preparePoster(items[(index+1)%items.length]);
  }
  function go(i){
    if(!items.length)return;
    index=(i+items.length)%items.length;
    nextAt=Date.now()+INTERVAL;
    show();
  }
  function display(list){
    if(!list.length)return;
    items=list.slice(0,10);index=0;
    box.hidden=false;
    show();
  }
  async function preparePoster(item){
    if(!item)return;
    const id=core.keyOf(item);
    if(imageCache.has(id)||inFlight.has(id))return;
    inFlight.add(id);
    try{
      let imageUrl=core.poster(item.posterUrl);
      if(!imageUrl){
        const result=await chrome.runtime.sendMessage({
          action:'findPosterOnMoviePage',payload:{type:item.type,id:item.id}
        });
        if(result?.ok)imageUrl=core.poster(result.poster);
      }
      if(!imageUrl)return;
      const result=await chrome.runtime.sendMessage({
        action:'loadSearchPoster',payload:{url:imageUrl}
      });
      if(result?.ok&&typeof result.dataUrl==='string'&&
         /^data:image\/(?:png|jpe?g|webp);base64,/i.test(result.dataUrl)){
        imageCache.set(id,result.dataUrl);
        if(core.keyOf(items[index])===id)showImage(result.dataUrl);
      }
    }catch{/* A missing poster is a visual-only failure. */}
    finally{inFlight.delete(id);}
  }
  function showImage(url){
    poster.src=url;backdrop.src=url;
    poster.hidden=false;backdrop.hidden=false;empty.hidden=true;
  }
  async function enrich(item){
    const id=core.keyOf(item);
    if(detailsCache.has(id))return;
    detailsCache.set(id,{genres:[],description:''});
    try{
      // Read-only: unlike the general details helper, this never writes
      // recommendation genres into watched-title statistics.
      const url='https://www.kinopoisk.ru/film/'+item.id+'/';
      const response=await fetch(url,{credentials:'include',
        signal:AbortSignal.timeout(9500)});
      const resolved=new URL(response.url);
      if(!response.ok||!['www.kinopoisk.ru','kinopoisk.ru'].includes(resolved.hostname)||
         resolved.pathname!=='/film/'+item.id+'/')return;
      const html=await response.text();
      if(html.length>6e6)return;
      const doc=new DOMParser().parseFromString(html,'text/html');
      let record={genres:[],description:''};
      for(const script of doc.querySelectorAll('script[type="application/ld+json"]')){
        try{
          const json=JSON.parse(script.textContent);
          const nodes=Array.isArray(json)?json:[json];
          for(const node of nodes.flatMap(x=>Array.isArray(x?.['@graph'])?x['@graph']:[x])){
            if(![].concat(node?.['@type']||[]).includes('Movie'))continue;
            record.genres=core.genres(typeof node.genre==='string'?
              node.genre.split(','):node.genre);
            record.description=copy(node.description).slice(0,230);
            break;
          }
        }catch{}
        if(record.description)break;
      }
      if(!record.description){
        const alt=doc.querySelector('[data-test-id="film-description"], [class*="filmDescription"]');
        record.description=copy(alt?.textContent).slice(0,230);
      }
      if(!record.description){
        const meta=doc.querySelector('meta[property="og:description"]');
        const desc=copy(meta?.content);
        if(desc.length>=35&&!/смотреть онлайн/i.test(desc))
          record.description=desc.slice(0,230);
      }
      detailsCache.set(id,record);
      if(core.keyOf(items[index])===id)show();
    }catch{/* Keep known official title and year when description unavailable. */}
  }
  async function start(){
    box.hidden=false;
    title.textContent='Подбираем фильмы…';
    const cached=(await chrome.storage.local.get(CACHE))[CACHE];
    const saved=cached&&typeof cached==='object'?cached:null;
    const age=Date.now()-Number(saved?.savedAt||0);
    const usable=age>=0&&age<STALE_TTL &&
      Array.isArray(saved?.popular)&&Array.isArray(saved?.new);
    if(usable){
      const feed=await pick(saved);
      if(feed.length)display(feed);
    }
    if(usable&&age<TTL)return;
    const fetched=await Promise.allSettled([fetchCatalog('popular'),fetchCatalog('new')]);
    const fresh={
      popular:fetched[0].status==='fulfilled'?fetched[0].value:(saved?.popular||[]),
      new:fetched[1].status==='fulfilled'?fetched[1].value:(saved?.new||[])
    };
    if(!fresh.popular.length&&!fresh.new.length){
      if(!items.length){
        title.textContent='Подборка недоступна';
        kind.textContent='Что посмотреть';
        description.textContent='Не удалось получить фильмы с Кинопоиска.';
        description.hidden=false;
        link.removeAttribute('href');
        dots.replaceChildren();
      }
      return;
    }
    // Cache public catalog only; personal ratings/history never enter it.
    if(fetched.some(x=>x.status==='fulfilled')){
      await chrome.storage.local.set({[CACHE]:{...fresh,savedAt:Date.now()}});
    }
    const feed=await pick(fresh);
    if(feed.length)display(feed);
  }
  $('discoveryPrevious').addEventListener('click',()=>go(index-1));
  $('discoveryNext').addEventListener('click',()=>go(index+1));
  box.addEventListener('mouseenter',()=>{hovered=true;});
  box.addEventListener('mouseleave',()=>{hovered=false;nextAt=Date.now()+INTERVAL;});
  box.addEventListener('focusin',()=>{hovered=true;});
  box.addEventListener('focusout',e=>{
    if(!box.contains(e.relatedTarget)){hovered=false;nextAt=Date.now()+INTERVAL;}
  });
  setInterval(()=>{
    if(items.length<2||hovered||document.hidden||
       document.body.classList.contains('settings-open')||
       document.body.classList.contains('stats-open')||
       window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)return;
    if(Date.now()>=nextAt)go(index+1);
  },1000);
  // One background catalog load per popup view. No repeated calls per slide.
  void start().catch(error=>{
    if(!items.length){
      title.textContent='Подборка временно недоступна';
      description.textContent='Не удалось загрузить фильмы.';
      description.hidden=false;
    }
    console.warn('[KinoHelper] Discovery:',String(error?.message||error));
  });
})();
