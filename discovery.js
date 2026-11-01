// KinoHelper discovery carousel: read-only catalog + account-scoped ranking.
// It never submits ratings, touches playback progress, or modifies watchlists.
(() => {
  'use strict';
  const core=window.KinoDiscoveryCore;
  const box=document.getElementById('kinoDiscovery');
  if(!core||!box)return;
  const CACHE='kinoDiscoveryCatalogV1',FACT_CACHE='kinoDiscoveryFactsV1',
    POSTER_CACHE='kinoDiscoveryPostersV1';
  const TTL=24*60*60*1000,STALE_TTL=14*24*60*60*1000;
  const RETRY_TTL=20*60*1000,FACT_TTL=7*24*60*60*1000,INTERVAL=5000;
  const $=id=>document.getElementById(id);
  const title=$('discoveryTitle'),kind=$('discoveryKind');
  const year=$('discoveryYear'),genre=$('discoveryGenres');
  const description=$('discoveryDescription'),rating=$('discoveryRating');
  const poster=$('discoveryPoster'),backdrop=$('discoveryBackdrop');
  const empty=$('discoveryPosterEmpty'),counter=$('discoveryCounter');
  const dots=$('discoveryDots'),link=$('discoveryOpen');
  const copy=x=>String(x||'').replace(/\s+/g,' ').trim();
  let items=[],index=0,nextAt=Date.now()+INTERVAL,hovered=false;
  const imageCache=new Map(),detailsCache=new Map(),inFlight=new Set();
  const failedFacts=new Map(),failedPosters=new Map();
  const posterJobs=[];
  let activePosterJobs=0;
  let persistedFacts={},persistedPosters={};
  const factsPending=new Map();

  function validListResponse(response){
    try{
      const u=new URL(response.url);
      return response.ok&&u.protocol==='https:'&&
        ['www.kinopoisk.ru','kinopoisk.ru'].includes(u.hostname)&&
        u.pathname.startsWith('/lists/movies/');
    }catch{return false;}
  }
  function catalogUrl(source){
    const y=new Date().getFullYear();
    const paths={
      filmsPopular:'/lists/movies/popular/',
      seriesPopular:'/lists/movies/popular-series/',
      filmsNew:'/lists/movies/popular/year--'+y+'/',
      seriesNew:'/lists/movies/popular-series/year--'+y+'/'
    };
    return paths[source]?'https://www.kinopoisk.ru'+paths[source]:'';
  }
  function posterAttributes(el) {
    if(!el)return [];
    const result=[],add=raw=>{
      const url=core.poster(raw);
      if(url&&!result.includes(url))result.push(url);
    };
    // Some Kinopoisk templates use a placeholder in data-src and the
    // actual poster in src, data-original, data-lazy-src or srcset.
    for(const name of ['data-original','data-lazy-src','src',
      'data-src','data-srcset','srcset']){
      const value=el.getAttribute(name)||'';
      if(name.endsWith('srcset')){
        for(const part of value.split(','))add(part.trim().split(/\s+/)[0]);
      }else add(value);
    }
    return result;
  }
  function extractYear(text){
    const match=copy(text).match(/(?:18|19|20)\d{2}/);
    return match?Number(match[0]):null;
  }
  function parseCatalog(html,source){
    const doc=new DOMParser().parseFromString(html,'text/html');
    const body=doc.querySelector('main')||doc.body;
    if(!body)return [];
    const results=new Map();
    for(const anchor of body.querySelectorAll('a[href]')){
      const href=anchor.getAttribute('href')||'';
      // Only canonical movie links; ignore clips, actor pages, reviews.
      const m=href.match(/^\/(film|series)\/([1-9]\d{0,12})\/?(?:\?.*)?$/);
      if(!m)continue;
      const id=m[2],mediaType=source.startsWith('series')?'series':m[1];
      const card=anchor.closest('.styles_root__ti07r, [data-test-id*="movie-card"], [class*="styles_root"], article, li')||
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
      const genreMatch=text.match(/[\p{L} ,]{2,35}\s*[•·]\s*([\p{L}-]{3,24})/u);
      const genres=genreMatch?core.genres([genreMatch[1]]):[];
      const imageUrls=posterAttributes(img);
      const possible=core.movie({type:mediaType,id,title:filmTitle,year,
        rating:parsedRating,genres,posterUrl:imageUrls[0]||'',
        posterFallback:imageUrls[1]||''},'for-you');
      if(!possible)continue;
      const old=results.get(id);
      if(!old||(!old.posterUrl&&possible.posterUrl))
        results.set(id,possible);
      if(results.size>=45)break;
    }
    return [...results.values()];
  }
  async function fetchCatalog(source){
    const url=catalogUrl(source);
    if(!url)throw Error('Неизвестный каталог');
    const res=await fetch(url,{credentials:'include',cache:'no-store',
      signal:AbortSignal.timeout(14000)});
    if(!validListResponse(res))throw Error('Каталог перенаправлен или недоступен');
    const html=await res.text();
    if(html.length>10e6)throw Error('Ответ каталога слишком большой');
    const parsed=parseCatalog(html,source);
    if(!parsed.length)throw Error('Кинопоиск не вернул распознанных фильмов');
    return parsed;
  }
  function premiereFromFilm(doc){
    // Do not equate production year with the film's release date. Require
    // an actual Kinopoisk detail row headed "Премьера в России/мире".
    for(const el of doc.querySelectorAll('dt, th, span, div')){
      const title=copy(el.textContent);
      if(title!=='Премьера в России'&&title!=='Премьера в мире')continue;
      if(el.children.length>1)continue;
      const row=el.closest('tr, [class*="row"], [class*="Row"]')||
        el.parentElement;
      if(!row)continue;
      const date=core.premiereDate(copy(row.textContent).slice(0,210));
      if(date)return date;
    }
    return '';
  }
  async function filmFacts(item){
    const id=core.keyOf(item);
    if(detailsCache.has(id))return detailsCache.get(id);
    if((failedFacts.get(id)||0)>Date.now())throw Error('Повтор запроса позже');
    if(factsPending.has(id))return factsPending.get(id);
    const task=(async()=>{
      const url='https://www.kinopoisk.ru/'+item.type+'/'+item.id+'/';
      const response=await fetch(url,{credentials:'include',
        signal:AbortSignal.timeout(9500)});
      const resolved=new URL(response.url);
      if(!response.ok||!['www.kinopoisk.ru','kinopoisk.ru'].includes(resolved.hostname)||
         !new RegExp('^/(?:film|series)/'+item.id+'/?$').test(resolved.pathname))
        throw Error('Карточка недоступна');
      const html=await response.text();
      if(html.length>6e6)throw Error('Карточка слишком большая');
      const doc=new DOMParser().parseFromString(html,'text/html');
      const record={title:'',genres:[],description:'',releaseDate:premiereFromFilm(doc)};
      for(const script of doc.querySelectorAll('script[type="application/ld+json"]')){
        try{
          const json=JSON.parse(script.textContent);
          const nodes=Array.isArray(json)?json:[json];
          for(const node of nodes.flatMap(x=>Array.isArray(x?.['@graph'])?x['@graph']:[x])){
            if(![].concat(node?.['@type']||[]).some(t=>
              ['Movie','TVSeries','TVMiniSeries','TVShow','CreativeWorkSeries'].includes(t)))continue;
            record.title=copy(node.name).slice(0,120);
            record.genres=core.genres(typeof node.genre==='string'?
              node.genre.split(','):node.genre);
            record.description=copy(node.description).slice(0,230);
            break;
          }
        }catch{}
        if(record.description&&record.genres.length)break;
      }
      if(!record.genres.length){
        for(const el of doc.querySelectorAll('dt, th, span, div')){
          if(el.children.length>1||copy(el.textContent)!=='Жанр')continue;
          const row=el.closest('tr, [class*="row"], [class*="Row"]')||
            el.parentElement;
          if(row){
            const values=[...row.querySelectorAll('a')].map(x=>copy(x.textContent));
            record.genres=core.genres(values.length?values:
              copy(row.textContent).replace(/^Жанр\s*/,'').split(','));
          }
          if(record.genres.length)break;
        }
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
      persistedFacts[id]={...record,cachedAt:Date.now()};
      // Persist metadata, but never account data or full HTML pages.
      try{await chrome.storage.local.set({[FACT_CACHE]:persistedFacts});}catch{}
      return record;
    })().catch(error=>{
      failedFacts.set(id,Date.now()+RETRY_TTL);
      throw error;
    }).finally(()=>factsPending.delete(id));
    factsPending.set(id,task);
    return task;
  }
  async function enrichCatalog(candidates,type){
    const result=candidates.map(x=>({...x}));
    // Limit the read-only detail requests; concurrency <= 2. Explicit
    // release dates are required for new releases, while popular movies
    // with known genres do not need extra candidate-detail requests.
    let cursor=0;
    const cap=type==='new'?16:6;
    const jobs=result.map((movie,i)=>({movie,i}))
      .filter(({movie})=>type==='new'||!movie.genres?.length)
      .slice(0,cap);
    const work=async()=>{
      while(cursor<jobs.length){
        const {movie,i}=jobs[cursor++];
        try{
          const fact=await filmFacts(movie);
          result[i]={...movie,
            title:fact.title||movie.title,
            genres:fact.genres.length?fact.genres:movie.genres,
            description:fact.description||movie.description||'',
            releaseDate:fact.releaseDate||movie.releaseDate||''};
        }catch{/* No verified detail => no "new" classification. */}
      }
    };
    await Promise.all([work(),work()]);
    return result;
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
    const scope=accountId||'__local__';
    const ratings=raw.kinoStatsRatingsV1?.[scope]||{};
    const watched=raw.kinoStatsWatchedV1?.[scope]||{};
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
    kind.textContent=item.kind==='new'?'✦ Новинки':
      item.kind==='for-you'?'✦ Для вас':'✦ Популярное';
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
    link.href='https://www.kinopoisk.ru/'+item.type+'/'+item.id+'/';
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
    const previous=items[index]?.id;
    items=list.slice(0,10);
    const current=items.findIndex(x=>x.id===previous);
    index=current>=0?current:0;
    box.hidden=false;
    show();
  }
  function preparePoster(item){
    if(!item)return;
    const id=core.keyOf(item);
    if(!id||imageCache.has(id)||inFlight.has(id)||
       (failedPosters.get(id)||0)>Date.now())return;
    inFlight.add(id);
    posterJobs.push({item,id});
    pumpPosterJobs();
  }
  function pumpPosterJobs(){
    while(activePosterJobs<2&&posterJobs.length){
      const {item,id}=posterJobs.shift();
      activePosterJobs++;
      Promise.resolve().then(()=>loadPoster(item)).catch(error=>{
        failedPosters.set(id,Date.now()+2*60*1000);
        console.warn('[KinoHelper] Постер '+id+': '+String(error?.message||error));
      }).finally(()=>{
        inFlight.delete(id);
        activePosterJobs--;
        pumpPosterJobs();
      });
    }
  }
  async function loadPoster(item){
    const id=core.keyOf(item),attempted=new Set(),errors=[];
    const trySources=async sources=>{
      for(const url of sources){
        if(attempted.size>=12)break;
        const source=core.poster(url);
        if(!source||attempted.has(source))continue;
        attempted.add(source);
        try{
          const response=await chrome.runtime.sendMessage({
            action:'loadSearchPoster',payload:{url:source}
          });
          if(!response?.ok||typeof response.dataUrl!=='string'||
             !/^data:image\/(?:png|jpe?g|webp);base64,/i.test(response.dataUrl)){
            errors.push(response?.error||'Недействительный ответ изображения');
            continue;
          }
          imageCache.set(id,response.dataUrl);
          if(items[index]&&core.keyOf(items[index])===id)
            showImage(response.dataUrl);
          // Image data is account-independent, but too large for persistent
          // backup. Keep a bounded session cache instead.
          if(chrome.storage.session&&response.dataUrl.length<=600000){
            persistedPosters[id]={dataUrl:response.dataUrl,cachedAt:Date.now()};
            persistedPosters=Object.fromEntries(
              Object.entries(persistedPosters)
                .sort((a,b)=>b[1].cachedAt-a[1].cachedAt).slice(0,10)
            );
            try{await chrome.storage.session.set({[POSTER_CACHE]:persistedPosters});}
            catch{/* Image remains available in memory. */}
          }
          return true;
        }catch(error){errors.push(String(error?.message||error));}
      }
      return false;
    };
    // 1. Try real poster URLs present in the ranking card, including CDN sizes.
    const catalogSources=core.posterSources({...item,id:''});
    if(await trySources(catalogSources))return;
    // 2. Reuse verified facts if already loaded by the new-release parser.
    const facts=detailsCache.get(id);
    if(facts?.posterUrl&&await trySources(core.posterSources({
      posterUrl:facts.posterUrl,posterFallback:facts.posterFallback,id:''
    })))return;
    // 3. Search metadata uses the existing KinoHelper GraphQL integration.
    try{
      const response=await chrome.runtime.sendMessage({
        action:'getSearchMovieMetadata',payload:{type:item.type,id:item.id}
      });
      if(response?.ok&&response.metadata&&await trySources(core.posterSources({
        posterUrl:response.metadata.poster,
        posterFallback:response.metadata.posterFallback,id:''
      })))return;
      if(!response?.ok)errors.push(response?.error||'GraphQL недоступен');
    }catch(error){errors.push(String(error?.message||error));}
    // 4. Finally inspect Kinopoisk's HTML/SSR, as title search already does.
    try{
      const response=await chrome.runtime.sendMessage({
        action:'findPosterOnMoviePage',payload:{type:item.type,id:item.id}
      });
      if(response?.ok&&response.poster&&await trySources(core.posterSources({
        posterUrl:response.poster,id:''
      })))return;
      if(!response?.ok)errors.push(response?.error||'Страница фильма недоступна');
    }catch(error){errors.push(String(error?.message||error));}
    // 5. Official static image URLs are fallback only, not fabricated posters.
    if(await trySources(core.posterSources({id:item.id})))return;
    throw Error('Нет доступных изображений ('+
      [...new Set(errors)].slice(0,3).join('; ').slice(0,180)+')');
  }
  function showImage(url){
    poster.src=url;backdrop.src=url;
    poster.hidden=false;backdrop.hidden=false;empty.hidden=true;
  }
  async function enrich(item){
    try{
      const record=await filmFacts(item);
      if(core.keyOf(items[index])===core.keyOf(item)){
        // Never rebuild the catalog here: update only visible film details.
        genre.textContent=(record.genres.length?record.genres:item.genres)
          .slice(0,3).join(', ');
        genre.hidden=!genre.textContent;
        const desc=record.description||item.description||'';
        description.textContent=desc;description.hidden=!desc;
      }
    }catch{/* Missing metadata is not invented. */}
  }
  function dedupe(list){
    const seen=new Set();
    return list.filter(item=>{
      const key=core.keyOf(item);
      if(!key||seen.has(item.id))return false;
      seen.add(item.id);return true;
    });
  }
  function alternate(films,series){
    const a=Array.isArray(films)?films:[],b=Array.isArray(series)?series:[];
    const result=[];
    for(let i=0;i<Math.max(a.length,b.length);i++){
      if(i<a.length)result.push(a[i]);
      if(i<b.length)result.push(b[i]);
    }
    return result;
  }
  function compose(sources,fallback){
    const has=key=>Array.isArray(sources?.[key]);
    const freshPopular=dedupe(alternate(
      sources?.filmsPopular,sources?.seriesPopular));
    const currentYear=new Date().getFullYear();
    // Add current-year titles seen in popular lists: a filtered yearly page
    // may be unavailable, but the premiere still has to be verified later.
    const recent=items=>(items||[]).filter(x=>
      x.year>=currentYear-1&&x.year<=currentYear);
    const freshNew=dedupe(alternate(
      [...(sources?.filmsNew||[]),...recent(sources?.filmsPopular)],
      [...(sources?.seriesNew||[]),...recent(sources?.seriesPopular)]));
    // If the main ranking is unavailable but year-filtered lists work,
    // keep those source-ranked titles as *popular*, never fabricate news.
    const popular=freshPopular.length?freshPopular:
      freshNew.length?freshNew:Array.isArray(fallback?.popular)?fallback.popular:[];
    const news=freshNew.length?freshNew:
      Array.isArray(fallback?.new)?fallback.new:[];
    const verified=new Map((fallback?.new||[])
      .filter(x=>x?.releaseDate).map(x=>[core.keyOf(x),x]));
    const restored=news.map(x=>{
      const previous=verified.get(core.keyOf(x));
      return previous?{...x,releaseDate:previous.releaseDate,
        description:previous.description||x.description,
        genres:previous.genres?.length?previous.genres:x.genres}:x;
    });
    return {popular,new:restored};
  }
  function unavailable(message){
    if(items.length)return;
    title.textContent='Подборка временно недоступна';
    kind.textContent='Что посмотреть';
    counter.textContent='0 / 0';
    description.textContent=message;
    description.hidden=false;
    link.removeAttribute('href');
    dots.replaceChildren();
  }
  async function showFrom(catalog){
    const feed=await pick(catalog);
    if(feed.length)display(feed);
    else unavailable('Не удалось подобрать фильмы и сериалы из доступных каталогов.');
  }
  async function enrichAndSave(catalog){
    // Catalog data is already persisted before slow metadata requests start.
    // If the popup is closed during enrichment, the next opening reuses
    // that raw catalog instead of downloading all list pages again.
    const y=new Date().getFullYear();
    const candidates=dedupe((catalog.new||[])
      .filter(x=>x.year>=y-1&&x.year<=y));
    const enriched=await enrichCatalog(candidates,'new');
    const replacements=new Map(enriched.map(x=>[core.keyOf(x),x]));
    const patched={
      ...catalog,
      new:(catalog.new||[]).map(x=>replacements.get(core.keyOf(x))||x),
      enrichedAt:Date.now()
    };
    const previous=(await chrome.storage.local.get(CACHE))[CACHE];
    if(previous?.savedAt!==catalog.savedAt)return;
    await chrome.storage.local.set({[CACHE]:patched});
    await showFrom(patched);
  }
  async function start(){
    box.hidden=false;
    title.textContent='Подбираем фильмы и сериалы…';
    const raw=await chrome.storage.local.get([CACHE,FACT_CACHE]);
    if(chrome.storage.session){
      try{
        const saved=(await chrome.storage.session.get(POSTER_CACHE))[POSTER_CACHE];
        if(saved&&typeof saved==='object'&&!Array.isArray(saved)){
          for(const [id,item] of Object.entries(saved)){
            if(!new RegExp('^(?:film|series):[1-9][0-9]{0,12}$').test(id)||
              !item||Date.now()-Number(item.cachedAt||0)>STALE_TTL||
              typeof item.dataUrl!=='string'||item.dataUrl.length>600000||
              !new RegExp('^data:image/(?:png|jpe?g|webp);base64,','i').test(item.dataUrl))continue;
            persistedPosters[id]=item;
            imageCache.set(id,item.dataUrl);
          }
        }
      }catch{}
    }
    const stored=raw[CACHE],cached=stored&&typeof stored==='object'?stored:null;
    persistedFacts=raw[FACT_CACHE]&&typeof raw[FACT_CACHE]==='object'
      &&!Array.isArray(raw[FACT_CACHE])?raw[FACT_CACHE]:{};
    // Cached factual metadata survives popup and side-panel restarts.
    for(const [key,record] of Object.entries(persistedFacts)){
      const at=Number(record?.cachedAt||0);
      if(at>0&&Date.now()-at<FACT_TTL&&record&&typeof record==='object'&&
        /^(?:film|series):[1-9]\d{0,12}$/.test(key)){
        detailsCache.set(key,record);
      }else delete persistedFacts[key];
    }
    const age=Date.now()-Number(cached?.savedAt||0);
    const usable=age>=0&&age<STALE_TTL&&
      Array.isArray(cached?.popular)&&Array.isArray(cached?.new);
    if(usable)await showFrom(cached);
    if(usable&&cached.schema===2&&age<TTL&&
      (!cached.retrySources?.length||Date.now()<Number(cached.retryAt||0))){
      if(!cached.enrichedAt)await enrichAndSave(cached);
      return;
    }
    // Back off across window restarts and network errors, including when
    // Kinopoisk denies access. No retry on every popup opening.
    if(Date.now()<Number(cached?.retryAt||0)){
      if(!usable)unavailable('Кинопоиск не ответил. Повторная попытка позже.');
      return;
    }
    const attemptedAt=Date.now();
    await chrome.storage.local.set({[CACHE]:{
      ...(cached||{}),retryAt:attemptedAt+RETRY_TTL
    }});
    const allNames=['filmsPopular','seriesPopular','filmsNew','seriesNew'];
    const names=usable&&cached.schema===2&&age<TTL&&
      Array.isArray(cached.retrySources)&&cached.retrySources.length
      ?cached.retrySources:allNames;
    const responses=await Promise.allSettled(names.map(name=>fetchCatalog(name)));
    const sources={...(cached?.sources||{})};
    let successes=0;
    const retrySources=[];
    for(let i=0;i<names.length;i++){
      if(responses[i].status==='fulfilled'){
        sources[names[i]]=responses[i].value;
        successes++;
      }else retrySources.push(names[i]);
    }
    if(!successes){
      if(!usable)unavailable('Списки Кинопоиска сейчас недоступны. Повторим запрос позже.');
      return;
    }
    const combined=compose(sources,cached);
    const fresh={schema:2,sources,...combined,savedAt:attemptedAt,
      retrySources,retryAt:attemptedAt+(retrySources.length?RETRY_TTL:TTL),
      enrichedAt:0};
    // Save BEFORE slow detail lookups; data remains after the popup closes.
    await chrome.storage.local.set({[CACHE]:fresh});
    await showFrom(fresh);
    await enrichAndSave(fresh);
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
       !box.getClientRects().length||
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