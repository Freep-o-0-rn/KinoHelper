// KinoHelper discovery carousel: read-only catalog + account-scoped ranking.
// It never submits ratings, touches playback progress, or modifies watchlists.
(() => {
  'use strict';
  const core=window.KinoDiscoveryCore;
  const box=document.getElementById('kinoDiscovery');
  if(!core||!box)return;
  const CACHE='kinoDiscoveryCatalogV1',FACT_CACHE='kinoDiscoveryFactsV1';
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
  const failedFacts=new Map();
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
      const possible=core.movie({type:mediaType,id,title:filmTitle,year,
        rating:parsedRating,genres,posterUrl:urlPoster(img)},'for-you');
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
    if(factsPending.has(id))return factsPending.get(id);
    const task=(async()=>{
      const url='https://www.kinopoisk.ru/'+item.type+'/'+item.id+'/';
      const response=await fetch(url,{credentials:'include',
        signal:AbortSignal.timeout(9500)});
      const resolved=new URL(response.url);
      if(!response.ok||!['www.kinopoisk.ru','kinopoisk.ru'].includes(resolved.hostname)||
         !new RegExp('^/(?:film|series)/'+item.id+'/?
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
      return record;
    })().finally(()=>factsPending.delete(id));
    factsPending.set(id,task);
    return task;
  }
  async function enrichCatalog(candidates,type){
    const result=candidates.map(x=>({...x}));
    // Limit the read-only detail requests; concurrency <= 2. Explicit
    // release dates are required for new releases, while popular movies
    // with known genres do not need extra candidate-detail requests.
    let cursor=0;
    const cap=type==='new'?24:16;
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
    const rawPopular=fetched[0].status==='fulfilled'?fetched[0].value:(saved?.popular||[]);
    const rawNew=fetched[1].status==='fulfilled'?fetched[1].value:(saved?.new||[]);
    // Check up-to-date popular films too, not just the editorial yearly
    // list: a recent October premiere may not be among its first entries.
    const currentYear=new Date().getFullYear();
    const candidates=[],candidateIds=new Set();
    for(const film of [
      ...rawPopular.filter(x=>x.year>=currentYear-1).slice(0,12),
      ...rawNew
    ]){
      if(candidateIds.has(film.id))continue;
      candidateIds.add(film.id);candidates.push(film);
    }
    const [popular,news]=await Promise.all([
      fetched[0].status==='fulfilled'?enrichCatalog(rawPopular,'popular'):rawPopular,
      (fetched[0].status==='fulfilled'||fetched[1].status==='fulfilled')
        ?enrichCatalog(candidates,'new')
        :(saved?.new||[])
    ]);
    const fresh={popular,new:news};
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
    else if(!items.length){
      title.textContent='Подборка пока недоступна';
      kind.textContent='Что посмотреть';
      description.textContent='Недостаточно данных для персонального подбора или нет подтверждённых новинок.';
      description.hidden=false;counter.textContent='0 / 0';
      link.removeAttribute('href');
    }
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
).test(resolved.pathname))
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
            if(![].concat(node?.['@type']||[]).includes('Movie'))continue;
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
      return record;
    })().finally(()=>factsPending.delete(id));
    factsPending.set(id,task);
    return task;
  }
  async function enrichCatalog(candidates,type){
    const result=candidates.map(x=>({...x}));
    // Limit the read-only detail requests; concurrency <= 2. Explicit
    // release dates are required for new releases, while popular movies
    // with known genres do not need extra candidate-detail requests.
    let cursor=0;
    const cap=type==='new'?24:16;
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
    const rawPopular=fetched[0].status==='fulfilled'?fetched[0].value:(saved?.popular||[]);
    const rawNew=fetched[1].status==='fulfilled'?fetched[1].value:(saved?.new||[]);
    // Check up-to-date popular films too, not just the editorial yearly
    // list: a recent October premiere may not be among its first entries.
    const currentYear=new Date().getFullYear();
    const candidates=[],candidateIds=new Set();
    for(const film of [
      ...rawPopular.filter(x=>x.year>=currentYear-1).slice(0,12),
      ...rawNew
    ]){
      if(candidateIds.has(film.id))continue;
      candidateIds.add(film.id);candidates.push(film);
    }
    const [popular,news]=await Promise.all([
      fetched[0].status==='fulfilled'?enrichCatalog(rawPopular,'popular'):rawPopular,
      (fetched[0].status==='fulfilled'||fetched[1].status==='fulfilled')
        ?enrichCatalog(candidates,'new')
        :(saved?.new||[])
    ]);
    const fresh={popular,new:news};
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
    else if(!items.length){
      title.textContent='Подборка пока недоступна';
      kind.textContent='Что посмотреть';
      description.textContent='Недостаточно данных для персонального подбора или нет подтверждённых новинок.';
      description.hidden=false;counter.textContent='0 / 0';
      link.removeAttribute('href');
    }
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
