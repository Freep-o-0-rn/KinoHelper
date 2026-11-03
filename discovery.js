// KinoHelper discovery carousel: read-only catalog + account-scoped ranking.
// It never submits ratings, touches playback progress, or modifies watchlists.
(() => {
  'use strict';
  const core=window.KinoDiscoveryCore;
  const box=document.getElementById('kinoDiscovery');
  if(!core||!box)return;
  const CACHE='kinoDiscoveryCatalogV1',FACT_CACHE='kinoDiscoveryFactsV1',
    POSTER_CACHE='kinoDiscoveryPostersV2',FEED_CACHE='kinoDiscoveryFeedV1',
    HIDDEN_CACHE='kinoDiscoveryHiddenV1';
  // One 90-minute refresh cycle for the catalog and the ranked selection.
  const TTL=90*60*1000,STALE_TTL=14*24*60*60*1000;
  // A new selection revision requires candidate-genre verification before
  // the 90-minute feed is considered complete.
  const PERSONALIZATION_SCHEMA=2;
  const FEED_MIX_SCHEMA=3;
  const RETRY_TTL=20*60*1000,FACT_TTL=7*24*60*60*1000,INTERVAL=5000;
  const $=id=>document.getElementById(id);
  const title=$('discoveryTitle'),kind=$('discoveryKind');
  const year=$('discoveryYear'),genre=$('discoveryGenres');
  const description=$('discoveryDescription'),rating=$('discoveryRating');
  const poster=$('discoveryPoster'),backdrop=$('discoveryBackdrop');
  const empty=$('discoveryPosterEmpty'),counter=$('discoveryCounter');
  const dots=$('discoveryDots'),link=$('discoveryOpen');
  const hideButton=$('discoveryHide');
  let activeScope='__local__',activeCatalog=null,hiddenEntries={};
  let feedsByScope={},lastFeedAt=0,loadContext=null;
  const copy=x=>String(x||'').replace(/\s+/g,' ').trim();
  let items=[],index=0,nextAt=Date.now()+INTERVAL,hovered=false;
  const imageCache=new Map(),detailsCache=new Map(),inFlight=new Set();
  const failedFacts=new Map(),failedPosters=new Map();
  const metadataPending=new Map(),metadataFailures=new Map();
  const posterJobs=[];
  let activePosterJobs=0;
  const limitPosterJobs=4;
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
    // Kinopoisk sometimes stores poster in <picture><source srcset>,
    // sibling elements or a background-image rather than the first img.
    const nodes=[el,...(el.querySelectorAll?.('img, picture source, [style]')||[])];
    for(const node of nodes.slice(0,16)){
      for(const name of ['data-original','data-lazy-src','src',
        'data-src','data-srcset','srcset']){
        const value=node.getAttribute?.(name)||'';
        if(name.endsWith('srcset')){
          for(const part of value.split(','))add(part.trim().split(/\s+/)[0]);
        }else add(value);
      }
      const background=node.getAttribute?.('style')||'';
      const match=background.match(/url\(\s*["']?(https?:\/\/[^"')\s]+)["']?\s*\)/i);
      if(match)add(match[1]);
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
      const imageUrls=[...new Set([
        ...posterAttributes(img),
        ...posterAttributes(card)
      ])];
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
    const existingFacts=detailsCache.get(id);
    if(existingFacts?.factsChecked&&
       (existingFacts.factsSchema===2||Number(item.rating)>0||
        Number(existingFacts.rating)>0))return existingFacts;
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
      const record={title:'',genres:[],description:'',rating:null,
        posterUrl:'',posterFallback:'',releaseDate:premiereFromFilm(doc)};
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
            const rawRating=Number(String(node.aggregateRating?.ratingValue||'').replace(',','.'));
            if(Number.isFinite(rawRating)&&rawRating>0&&rawRating<=10)
              record.rating=rawRating;
            const imgs=[node.image,node.thumbnailUrl].flat().map(x=>
              typeof x==='string'?x:(x?.url||x?.contentUrl||''));
            record.posterUrl=imgs.map(core.poster).find(Boolean)||'';
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
      if(!record.posterUrl){
        for(const selector of [
          'meta[property="og:image"]','meta[name="twitter:image"]',
          'meta[property="twitter:image"]'
        ]){
          const raw=doc.querySelector(selector)?.getAttribute?.('content')||
            doc.querySelector(selector)?.content;
          const url=core.poster(raw);
          if(url){record.posterUrl=url;break;}
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
      const previous=detailsCache.get(id)||{};
      const merged={...previous,...record,factsChecked:true,factsSchema:2,
        rating:record.rating||previous.rating||null,
        posterUrl:record.posterUrl||previous.posterUrl||'',
        posterFallback:record.posterFallback||previous.posterFallback||''};
      detailsCache.set(id,merged);
      persistedFacts[id]={...merged,cachedAt:Date.now()};
      try{await chrome.storage.local.set({[FACT_CACHE]:persistedFacts});}catch{}
      return merged;
    })().catch(error=>{
      failedFacts.set(id,Date.now()+RETRY_TTL);
      throw error;
    }).finally(()=>factsPending.delete(id));
    factsPending.set(id,task);
    return task;
  }
  async function enrichCatalog(candidates,type){
    const result=candidates.map(x=>({...x}));
    // Reuse only known facts from an official film page. These were fetched
    // for images/descriptions during earlier viewing and survive openings.
    for(let i=0;i<result.length;i++){
      const fact=detailsCache.get(core.keyOf(result[i]));
      if(fact?.genres?.length){
        result[i]={...result[i],
          genres:core.genres(fact.genres),
          rating:fact.rating||result[i].rating||null,
          description:fact.description||result[i].description||''};
      }
    }
    // Bound detail requests per refresh. Popular titles lacking verified
    // genres are needed to distinguish "For you" from generic "Popular".
    let cursor=0;
    const cap=type==='new'?16:24;
    const jobs=result.map((movie,i)=>({movie,i}))
      .filter(({movie})=>type==='new'||!movie.genres?.length)
      .slice(0,cap);
    let failures=0;
    const work=async()=>{
      while(cursor<jobs.length&&failures<4){
        const {movie,i}=jobs[cursor++];
        try{
          const fact=await filmFacts(movie);
          result[i]={...movie,
            title:fact.title||movie.title,
            genres:fact.genres.length?fact.genres:movie.genres,
            description:fact.description||movie.description||'',
            rating:fact.rating||movie.rating||null,
            releaseDate:fact.releaseDate||movie.releaseDate||'',
            posterUrl:fact.posterUrl||movie.posterUrl||'',
            posterFallback:fact.posterFallback||movie.posterFallback||''};
        }catch{
          // Avoid dozens of repeated timeouts if the provider is offline.
          failures++;
        }
      }
    };
    await Promise.all([work(),work(),work(),work()]);
    return result;
  }

  function safeObject(value){
    return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  }
  async function preferences(){
    const raw=await chrome.storage.local.get([
      'kinoStatsRatingsV1','kinoStatsWatchedV1','kinoStatsGenresV1'
    ]);
    let accountId='';
    try{
      const current=await window.KinoStatsAccount?.detect();
      if(current?.status==='logged-in'&&/^[1-9]\d{0,12}$/.test(current.id))
        accountId=current.id;
    }catch{}
    const scope=accountId||'__local__';
    let history=[];
    try{history=JSON.parse(localStorage.getItem('kinopoiskHistory')||'[]');}
    catch{}
    return {scope,history,
      ratings:safeObject(raw.kinoStatsRatingsV1?.[scope]),
      watched:safeObject(raw.kinoStatsWatchedV1?.[scope]),
      genres:safeObject(raw.kinoStatsGenresV1)};
  }
  function withVerifiedGenres(catalog){
    const enhance=list=>(Array.isArray(list)?list:[]).map(movie=>{
      const fact=detailsCache.get(core.keyOf(movie));
      return fact?.genres?.length?{...movie,
        genres:core.genres(fact.genres),
        rating:fact.rating||movie.rating,
        description:fact.description||movie.description}:movie;
    });
    return {...catalog,popular:enhance(catalog.popular),new:enhance(catalog.new)};
  }
  function selectedCandidates(catalog,context){
    const verified=withVerifiedGenres(catalog);
    return core.select({recommended:verified.popular,newReleases:verified.new,
      ratings:context.ratings,watched:context.watched,
      genreRecords:context.genres,history:context.history,
      hidden:hiddenEntries});
  }
  function isVisible(item){
    const key=core.keyOf(item);
    return Boolean(key&&!hiddenEntries[key]);
  }
  function filterSelection(saved){
    const seen=new Set();
    return (Array.isArray(saved)?saved:[]).filter(item=>{
      const key=core.keyOf(item);
      if(!key||!isVisible(item)||seen.has(key))return false;
      seen.add(key);return true;
    }).slice(0,10);
  }
  // A saved selection belongs to the verified Kinopoisk profile, not to
  // whichever profile happens to log in after the popup is closed.
  async function persistFeed(next,updatedAt=Date.now()){
    lastFeedAt=updatedAt;
    feedsByScope={...feedsByScope,[activeScope]:{
      at:updatedAt,items:next,catalogAt:Number(activeCatalog?.savedAt||0),
      mixSchema:FEED_MIX_SCHEMA,
      personalizationSchema:
        activeCatalog?.personalizationSchema===PERSONALIZATION_SCHEMA
          ?PERSONALIZATION_SCHEMA:0
    }};
    await chrome.storage.local.set({[FEED_CACHE]:feedsByScope});
  }
  function showEmpty(message){
    items=[];index=0;
    title.textContent='Подборка временно недоступна';
    kind.textContent='Что посмотреть';
    counter.textContent='0 / 0';
    description.textContent=message;
    description.hidden=false;
    if(hideButton)hideButton.hidden=true;
    link.removeAttribute('href');
    dots.replaceChildren();
  }
  function replacementCandidates(catalog,context,current){
    const used=new Set(current.map(core.keyOf));
    return selectedCandidates(catalog,context).filter(movie=>
      isVisible(movie)&&!used.has(core.keyOf(movie)));
  }
  async function hideCurrent(){
    const original=items[index],key=core.keyOf(original);
    if(!key||!activeCatalog)return;
    if(hideButton)hideButton.disabled=true;
    try{
      // Merge first, so a second open popup or sidepanel does not have its
      // hidden choices overwritten by this one.
      const raw=(await chrome.storage.local.get(HIDDEN_CACHE))[HIDDEN_CACHE];
      const all={...safeObject(raw)};
      const scope={...safeObject(all[activeScope]),[key]:true};
      all[activeScope]=scope;
      hiddenEntries=scope;
      await chrome.storage.local.set({[HIDDEN_CACHE]:all});
      const kept=items.filter(movie=>core.keyOf(movie)!==key&&isVisible(movie));
      const context=loadContext||await preferences();
      const next=replacementCandidates(activeCatalog,context,kept)[0];
      // Append the replacement as the last slide. Existing titles keep
      // their order, leaving several autoplay intervals for its poster.
      if(next){
        kept.push(next);
        preparePoster(next,true);
      }
      // The same age is retained: hiding does not reset the 90-minute cycle.
      const originalAt=lastFeedAt||Date.now();
      await persistFeed(kept,originalAt);
      if(kept.length){
        // From the last slide wrap to the first existing title instead
        // of immediately exposing the unready poster at the new last slot.
        const nextIndex=index>=items.length-1?0:Math.min(index,kept.length-1);
        display(kept,{index:nextIndex});
      }else showEmpty('Все доступные фильмы скрыты. Новые появятся после обновления каталога.');
    }catch(error){
      console.warn('[KinoHelper] Не удалось скрыть фильм:',String(error?.message||error));
    }finally{
      if(hideButton)hideButton.disabled=false;
    }
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
    if(hideButton)hideButton.hidden=false;
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
    const kpRating=Number(cached?.rating||item.rating);
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
    preparePoster(item);
    if(items.length>1)preparePoster(items[(index+1)%items.length]);
  }
  function go(i){
    if(!items.length)return;
    index=(i+items.length)%items.length;
    nextAt=Date.now()+INTERVAL;
    show();
  }
  function display(list,options={}){
    if(!list.length)return;
    const previous=core.keyOf(items[index]);
    items=list.slice(0,10);
    const current=items.findIndex(x=>core.keyOf(x)===previous);
    index=Number.isInteger(options.index)
      ?Math.max(0,Math.min(items.length-1,options.index))
      :current>=0?current:0;
    box.hidden=false;
    show();
    // Download the visible slide first, then fill remaining posters in the
    // background. The queue deduplicates movie IDs across rapid navigation.
    for(const movie of items)preparePoster(movie);
  }
  function preparePoster(item,priority=false){
    if(!item)return;
    const id=core.keyOf(item);
    if(!id||imageCache.has(id)||inFlight.has(id)||
       (failedPosters.get(id)||0)>Date.now())return;
    inFlight.add(id);
    // The newly appended title is a high priority preload; it does not
    // jump to the visible position, and remains the final carousel slide.
    if(priority)posterJobs.unshift({item,id});
    else posterJobs.push({item,id});
    pumpPosterJobs();
  }
  function pumpPosterJobs(){
    while(activePosterJobs<limitPosterJobs&&posterJobs.length){
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
  async function rememberPoster(id,url){
    imageCache.set(id,url);
    if(items[index]&&core.keyOf(items[index])===id)showImage(url);
    // A remote URL is tiny and uses Chrome's HTTP cache; decoded image data
    // must remain bounded and stay outside the export/backup.
    const data=typeof url==='string'&&url.startsWith('data:');
    if(chrome.storage.session&&(!data||url.length<=600000)){
      // Only shape-verified covers can enter the new V2 poster cache.
      persistedPosters[id]=data
        ?{dataUrl:url,cachedAt:Date.now(),verifiedPortrait:true}
        :{posterUrl:core.poster(url),cachedAt:Date.now(),verifiedPortrait:true};
      persistedPosters=Object.fromEntries(
        Object.entries(persistedPosters)
          .sort((a,b)=>b[1].cachedAt-a[1].cachedAt).slice(0,10));
      try{await chrome.storage.session.set({[POSTER_CACHE]:persistedPosters});}
      catch{/* Poster remains visible in the current window. */}
    }
  }
  async function loadPoster(item){
    const id=core.keyOf(item),errors=[],attempted=new Set();
    const stats={id,title:item.title,catalog:0,facts:0,metadata:0,
      html:0,browser:0,worker:0,results:[]};
    const candidates=(raw)=>[...new Set((raw||[])
      .map(core.poster).filter(Boolean))];
    // A regular <img> does not need CORS. It can load when JS fetch of
    // the same resource is rejected by CORS/network middleware. Preload
    // bounded candidates concurrently instead of waiting 6.5s per URL.
    const browserImage=src=>new Promise((resolve,reject)=>{
      if(typeof Image!=='function')return reject(Error('Image API unavailable'));
      const img=new Image();
      let done=false;
      const finish=(error)=>{
        if(done)return;
        done=true;
        clearTimeout(timeout);
        img.onload=null;img.onerror=null;
        if(error)reject(error);else resolve(src);
      };
      const timeout=setTimeout(()=>finish(Error('Image timeout')),2700);
      img.onload=()=>finish(core.isPosterShape(img.naturalWidth,img.naturalHeight)
        ?null:Error('Not a portrait poster ('+img.naturalWidth+
          'x'+img.naturalHeight+')'));
      img.onerror=()=>finish(Error('Image blocked or not found'));
      img.src=src;
    });
    const trySources=async(raw,stage)=>{
      const sources=candidates(raw);
      stats[stage]=sources.length;
      if(!sources.length)return false;
      if(typeof Image==='function'){
        stats.browser+=Math.min(4,sources.length);
        try{
          const loaded=await Promise.any(sources.slice(0,4)
            .map(source=>browserImage(source)));
          await rememberPoster(id,loaded);
          console.debug('[KinoHelper] Постер загружен напрямую',id,stage);
          return true;
        }catch(e){errors.push(stage+': browser image unavailable');}
      }
      // Browser preload failed: try the existing background conversion
      // without re-requesting every non-working size sequentially.
      for(const source of sources.slice(0,2)){
        if(attempted.has(source))continue;
        attempted.add(source);
        stats.worker++;
        try{
          const response=await chrome.runtime.sendMessage({
            action:'loadSearchPoster',payload:{url:source,timeoutMs:3500}
          });
          if(response?.ok&&typeof response.dataUrl==='string'&&
             /^data:image\/(?:png|jpe?g|webp);base64,/i.test(response.dataUrl)){
            // MIME and HTTP success do not prove the result is a poster.
            // Decode the returned image before using/caching it.
            if(typeof Image==='function'){
              try{await browserImage(response.dataUrl);}
              catch(error){
                errors.push(stage+': '+String(error?.message||error));
                continue;
              }
            }
            await rememberPoster(id,response.dataUrl);
            console.debug('[KinoHelper] Постер загружен через worker',id,stage);
            return true;
          }
          errors.push(stage+': '+(response?.error||'image response unavailable'));
        }catch(e){errors.push(stage+': '+String(e?.message||e));}
      }
      return false;
    };
    // Use the catalog's image immediately if it works. Prefer this fast
    // path, but independently fetch verified metadata to fill in КП ratings.
    const official=ensureMetadata(item);
    const sourceCatalog=core.posterSources({...item,id:''});
    if(await trySources(sourceCatalog,'catalog'))return;
    // Film facts and metadata can contain original poster links absent
    // from list cards. Movie facts are shared with description rendering.
    const facts=detailsCache.get(id);
    if(await trySources(core.posterSources({
      posterUrl:facts?.posterUrl,posterFallback:facts?.posterFallback,id:''
    }),'facts'))return;
    try{
      const record=await official;
      if(record&&await trySources(core.posterSources({
        posterUrl:record.posterUrl,posterFallback:record.posterFallback,id:''
      }),'metadata'))return;
    }catch(e){errors.push('metadata: '+String(e?.message||e));}
    try{
      const response=await chrome.runtime.sendMessage({
        action:'findPosterOnMoviePage',payload:{type:item.type,id:item.id}
      });
      if(response?.ok&&response.poster&&await trySources(core.posterSources({
        posterUrl:response.poster,id:''
      }),'html'))return;
      if(!response?.ok)errors.push('html: '+(response?.error||'unavailable'));
    }catch(e){errors.push('html: '+String(e?.message||e));}
    if(await trySources(core.posterSources({id:item.id}),'legacy'))return;
    stats.results=[...new Set(errors)].slice(0,8);
    console.warn('[KinoHelper] Диагностика постера:',stats);
    throw Error('Нет доступных изображений: '+stats.results.join('; ').slice(0,160));
  }
  // One verification per title and popup view. Do not wait for the poster
  // failure before requesting its official score: these are independent.
  async function ensureMetadata(item){
    const id=core.keyOf(item);
    const cached=detailsCache.get(id);
    if(cached?.metadataChecked)return cached;
    if((metadataFailures.get(id)||0)>Date.now())return cached||null;
    if(metadataPending.has(id))return metadataPending.get(id);
    const work=(async()=>{
      const response=await chrome.runtime.sendMessage({
        action:'getSearchMovieMetadata',
        payload:{id:item.id,type:item.type,discovery:true}
      });
      if(!response?.ok||!response.metadata)
        throw Error(response?.error||'Метаданные Кинопоиска недоступны');
      const value=response.metadata;
      const previous=detailsCache.get(id)||{};
      const score=Number(value.rating);
      const record={...previous,
        rating:Number.isFinite(score)&&score>0&&score<=10
          ?score:(previous.rating||null),
        posterUrl:core.poster(value.poster)||previous.posterUrl||'',
        posterFallback:core.poster(value.posterFallback)||previous.posterFallback||'',
        metadataChecked:true};
      detailsCache.set(id,record);
      persistedFacts[id]={...record,cachedAt:Date.now()};
      try{await chrome.storage.local.set({[FACT_CACHE]:persistedFacts});}catch{}
      if(items[index]&&core.keyOf(items[index])===id) {
        const n=Number(record.rating||item.rating);
        rating.textContent=Number.isFinite(n)&&n>0
          ?'★ КП '+n.toFixed(1).replace('.',','):'';
        rating.hidden=!rating.textContent;
      }
      return record;
    })().catch(error=>{
      metadataFailures.set(id,Date.now()+5*60*1000);
      console.debug('[KinoHelper] Рейтинг/метаданные '+id+': '+String(error?.message||error));
      return detailsCache.get(id)||null;
    }).finally(()=>metadataPending.delete(id));
    metadataPending.set(id,work);
    return work;
  }
  function showImage(url){
    poster.src=url;backdrop.src=url;
    poster.hidden=false;backdrop.hidden=false;empty.hidden=true;
  }
  async function enrich(item){
    // Metadata and HTML can load in parallel; either can supply the КП score.
    const verified=ensureMetadata(item);
    try{
      const record=await filmFacts(item);
      if(core.keyOf(items[index])===core.keyOf(item)){
        if(record.posterUrl&&!imageCache.has(core.keyOf(item))&&
          !inFlight.has(core.keyOf(item)))preparePoster({...item,
            posterUrl:record.posterUrl,posterFallback:record.posterFallback});
        // Never rebuild the catalog here: update only visible film details.
        genre.textContent=(record.genres.length?record.genres:item.genres)
          .slice(0,3).join(', ');
        genre.hidden=!genre.textContent;
        const desc=record.description||item.description||'';
        description.textContent=desc;description.hidden=!desc;
        const value=Number(record.rating||item.rating);
        if(value>0&&value<=10){
          rating.textContent='★ КП '+value.toFixed(1).replace('.',',');
          rating.hidden=false;
        }
      }
    }catch{/* Missing metadata is not invented. */}
    await verified;
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
    showEmpty(message);
  }
  async function showFrom(catalog,context,at=Date.now()){
    activeCatalog=catalog;
    loadContext=context;
    const chosen=selectedCandidates(catalog,context);
    const ratings=Object.values(context.ratings||{});
    const withRatedGenres=ratings.filter(x=>
      Number(x?.rating)>=1&&Array.isArray(x?.genres)&&x.genres.length).length;
    const genreCandidates=(catalog.popular||[]).filter(x=>
      (detailsCache.get(core.keyOf(x))?.genres?.length||x.genres?.length)>0).length;
    console.debug('[KinoHelper] Персонализация:',{
      rated:ratings.filter(x=>Number(x?.rating)>=1).length,
      ratedWithGenres:withRatedGenres,
      candidatesWithGenres:genreCandidates,
      personalSlides:chosen.filter(x=>x.kind==='for-you').length
    });
    if(chosen.length){
      await persistFeed(chosen,at);
      display(chosen);
    }else unavailable('Не удалось подобрать фильмы и сериалы из доступных каталогов.');
  }
  async function enrichAndSave(catalog,context,feedAt){
    // Candidate metadata must precede the FINAL ranking. The previous
    // implementation enriched only premieres and skipped popular films.
    const today=new Date().getFullYear();
    const news=dedupe((catalog.new||[])
      .filter(x=>x.year>=today-1&&x.year<=today));
    // Verified old details are free. Missing popular genres require at most
    // 24 bounded HTML requests per 90-minute refresh, not on every open.
    const [popularEnriched,newEnriched]=await Promise.all([
      enrichCatalog(catalog.popular||[],'popular'),
      enrichCatalog(news,'new')
    ]);
    const replacement=new Map(newEnriched.map(x=>[core.keyOf(x),x]));
    const patched={...catalog,popular:popularEnriched,
      new:(catalog.new||[]).map(x=>replacement.get(core.keyOf(x))||x),
      enrichedAt:Date.now(),personalizationSchema:PERSONALIZATION_SCHEMA};
    const latest=(await chrome.storage.local.get(CACHE))[CACHE];
    if(latest?.savedAt!==catalog.savedAt)return;
    await chrome.storage.local.set({[CACHE]:patched});
    activeCatalog=patched;
    // Save one completed selection for the remaining portion of the
    // original cycle, without pushing its expiration 90 minutes forward.
    if(context&&activeScope===context.scope)
      await showFrom(patched,context,feedAt||Number(catalog.savedAt)||Date.now());
  }
  async function start(){
    box.hidden=false;
    if(!items.length)title.textContent='Подбираем фильмы и сериалы…';
    const raw=await chrome.storage.local.get([
      CACHE,FACT_CACHE,FEED_CACHE,HIDDEN_CACHE
    ]);
    if(chrome.storage.session){
      try{
        const saved=(await chrome.storage.session.get(POSTER_CACHE))[POSTER_CACHE];
        if(saved&&typeof saved==='object'&&!Array.isArray(saved)){
          for(const [id,item] of Object.entries(saved)){
            if(!new RegExp('^(?:film|series):[1-9][0-9]{0,12}$').test(id)||
              !item||item.verifiedPortrait!==true||
              Date.now()-Number(item.cachedAt||0)>STALE_TTL)continue;
            const url=typeof item.posterUrl==='string'
              ?core.poster(item.posterUrl)
              :typeof item.dataUrl==='string'&&item.dataUrl.length<=600000&&
                /^data:image\/(?:png|jpe?g|webp);base64,/i.test(item.dataUrl)
                ?item.dataUrl:'';
            if(!url)continue;
            persistedPosters[id]=item;
            imageCache.set(id,url);
          }
        }
      }catch{}
    }
    const stored=raw[CACHE],cached=stored&&typeof stored==='object'?stored:null;
    persistedFacts=safeObject(raw[FACT_CACHE]);
    for(const [key,record] of Object.entries(persistedFacts)){
      const at=Number(record?.cachedAt||0);
      if(at>0&&Date.now()-at<FACT_TTL&&record&&typeof record==='object'&&
        /^(?:film|series):[1-9]\d{0,12}$/.test(key)){
        detailsCache.set(key,{
          ...record,
          factsChecked:record.factsChecked===true||
            Boolean(record.releaseDate||record.description||
              (Array.isArray(record.genres)&&record.genres.length))
        });
      }else delete persistedFacts[key];
    }
    const context=await preferences();
    activeScope=context.scope;
    loadContext=context;
    hiddenEntries={...safeObject(safeObject(raw[HIDDEN_CACHE])[activeScope])};
    feedsByScope={...safeObject(raw[FEED_CACHE])};
    const record=safeObject(feedsByScope[activeScope]);
    lastFeedAt=Number(record.at)||0;
    const age=Date.now()-Number(cached?.savedAt||0);
    const usable=age>=0&&age<STALE_TTL&&
      Array.isArray(cached?.popular)&&Array.isArray(cached?.new);
    activeCatalog=usable?cached:null;
    const saved=filterSelection(record.items);
    if(saved.length){
      display(saved);
      // If another view hid a title since this feed was saved, repair the
      // selection using cached candidates without a network request.
      if(saved.length!==record.items.length&&usable){
        const candidates=replacementCandidates(cached,context,saved);
        const filled=[...saved,...candidates.slice(0,10-saved.length)];
        await persistFeed(filled,lastFeedAt||Date.now());
        display(filled);
      }
    }
    const feedFresh=saved.length&&lastFeedAt>0&&
      Date.now()-lastFeedAt>=0&&Date.now()-lastFeedAt<TTL;
    const catalogFresh=usable&&cached.schema===2&&age<TTL;
    const completed=cached?.personalizationSchema===PERSONALIZATION_SCHEMA;
    const feedCompleted=record.personalizationSchema===PERSONALIZATION_SCHEMA;
    const mixed=record.mixSchema===FEED_MIX_SCHEMA;
    // Within 90 minutes, keep precisely the same saved slide sequence.
    if(feedFresh&&catalogFresh&&completed&&feedCompleted&&mixed)return;
    // One-time migration of the previous "popular only" cache, entirely
    // without catalog refetch. Old slides remain visible while it completes.
    if(catalogFresh&&!completed){
      await enrichAndSave(cached,context,lastFeedAt||Number(cached.savedAt));
      return;
    }
    if(catalogFresh&&completed&&saved.length&&(!feedCompleted||!mixed)){
      // Existing For-You-only feeds need one local reshuffle. No catalog
      // network calls, no new 90-minute timestamp, and no lost opt-outs.
      await showFrom(cached,context,lastFeedAt||Number(cached.savedAt));
      return;
    }
    // If a verified catalog already exists, calculate only the new
    // account's personal selection. Do not fetch network catalogs.
    if(!saved.length&&catalogFresh){
      await showFrom(cached,context,Number(cached.savedAt));
      return;
    }
    if(Date.now()<Number(cached?.retryAt||0)){
      if(!saved.length&&usable)await showFrom(cached,context);
      else if(!saved.length)unavailable('Кинопоиск не ответил. Повторная попытка позже.');
      return;
    }
    const attemptedAt=Date.now();
    await chrome.storage.local.set({[CACHE]:{
      ...(cached||{}),retryAt:attemptedAt+RETRY_TTL
    }});
    const names=['filmsPopular','seriesPopular','filmsNew','seriesNew'];
    const responses=await Promise.allSettled(names.map(name=>fetchCatalog(name)));
    const sources={...(cached?.sources||{})};
    let successes=0;
    const retrySources=[];
    for(let i=0;i<names.length;i++){
      if(responses[i].status==='fulfilled'){
        sources[names[i]]=responses[i].value;successes++;
      }else retrySources.push(names[i]);
    }
    if(!successes){
      if(!saved.length&&usable)await showFrom(cached,context);
      else if(!saved.length)unavailable('Списки Кинопоиска сейчас недоступны.');
      return;
    }
    const combined=compose(sources,cached);
    const fresh={schema:2,sources,...combined,savedAt:attemptedAt,
      retrySources,retryAt:attemptedAt+(retrySources.length?RETRY_TTL:TTL),
      enrichedAt:0};
    await chrome.storage.local.set({[CACHE]:fresh});
    // Show real source-ranked provisional films immediately. Verified
    // personalized labels replace them once official genres are available.
    await showFrom(fresh,context,attemptedAt);
    await enrichAndSave(fresh,context,attemptedAt);
  }
  // Cached remote URLs can expire between popup openings. If Chrome
  // cannot render one, clear only that picture and retry safe sources.
  poster.addEventListener('error',()=>{
    const item=items[index],id=core.keyOf(item);
    if(!id||!imageCache.has(id)||imageCache.get(id)!==poster.src)return;
    imageCache.delete(id);
    delete persistedPosters[id];
    poster.hidden=true;
    backdrop.hidden=true;
    empty.hidden=false;
    failedPosters.delete(id);
    if(chrome.storage.session)
      void chrome.storage.session.set({[POSTER_CACHE]:persistedPosters}).catch(()=>{});
    preparePoster(item);
  });
  hideButton?.addEventListener('click',()=>void hideCurrent());
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
  // Read cached selection on opening, then refresh only after the same
  // 90-minute cycle expires. Keep an open sidepanel current as well.
  let refreshing=false;
  setInterval(async()=>{
    const now=Date.now();
    if(refreshing)return;
    const catalogAge=now-Number(activeCatalog?.savedAt||0);
    const feedAge=now-lastFeedAt;
    if(catalogAge<TTL&&feedAge<TTL)return;
    refreshing=true;
    try{
      const previous=(await chrome.storage.local.get(CACHE))[CACHE];
      if(now>=Number(previous?.retryAt||0))await start();
    }catch(error){
      console.warn('[KinoHelper] Discovery refresh:',String(error?.message||error));
    }finally{refreshing=false;}
  },60000);
  void start().catch(error=>{
    if(!items.length){
      title.textContent='Подборка временно недоступна';
      description.textContent='Не удалось загрузить фильмы.';
      description.hidden=false;
    }
    console.warn('[KinoHelper] Discovery:',String(error?.message||error));
  });
})();