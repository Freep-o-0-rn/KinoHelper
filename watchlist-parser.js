// Parse Kinopoisk's profile "planned-to-watch" listing without executing page JS.
// Only movie reactions inside the dedicated listing are used as record sources.
(function(root,factory){
 const api=factory();
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 if(root)root.KinoPlannedParser=api;
})(typeof window!=='undefined'?window:null,()=>{
 'use strict';
 const ID=/^[1-9]\d{0,12}$/;
 const TYPES=new Set(['Film','TvSeries','MiniSeries','TvShow']);
 const isObj=x=>x&&typeof x==='object'&&!Array.isArray(x);
 function extract(src,at){
   const begin=src.indexOf('{',at);if(begin<0)return null;
   let depth=0,str=false,esc=false;
   for(let i=begin;i<src.length;i++){
     const c=src[i];
     if(str){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')str=false;}
     else if(c==='"')str=true;
     else if(c==='{')depth++;
     else if(c==='}'&&!--depth){try{return JSON.parse(src.slice(begin,i+1));}catch{return null;}}
   }
   return null;
 }
 function ssr(html){
   const m=/window\.Ya\.__ssr_initial_data\s*=\s*/.exec(html);
   return m?extract(html,m.index+m[0].length):null;
 }
 const deref=(state,v)=>v?.__ref?state[v.__ref]:v;
 const clean=(x,n=150)=>typeof x==='string'?x.replace(/\s+/g,' ').trim().slice(0,n):'';
 function normalize(movie,state){
   const id=String(movie?.id||'');
   if(!ID.test(id)||!TYPES.has(movie?.__typename))return null;
   const type=movie.__typename==='Film'?'film':'series';
   const year=Number(movie.productionYear||movie.releaseYears?.start);
   const title=clean(movie.title?.russian||movie.title?.original||movie.name||'',200)||
     (type==='film'?'Фильм №':'Сериал №')+id;
   const genres=Array.isArray(movie.genres)
     ? movie.genres.map(g=>clean(deref(state,g)?.name,32)).filter(Boolean).slice(0,8):[];
   const poster=movie.poster||movie.gallery?.posters?.kpVertical;
   const posterUrl=clean(poster?.avatarsUrl||poster?.fallbackUrl||'',700);
   return {id,type,title,year:Number.isInteger(year)&&year>=1888&&year<=2200?year:null,
     genres,posterUrl:/^https:\/\/(?:avatars\.mds\.yandex\.net|st\.kp\.yandex\.net)\//.test(posterUrl)?posterUrl:''};
 }
 function parsePage(html,page=1){
   if(typeof html!=='string'||html.length>9e6)throw Error('Недопустимый документ');
   if(/captcha|smartcaptcha/i.test(html.slice(0,150000)) &&
      !html.includes('UserMovieReactions'))throw Error('Кинопоиск запросил проверку браузера');
   const data=ssr(html);
   const state=data?.apolloState||data?.props?.pageProps?.apolloState;
   const entries=new Map();let recognized=0,verifiedEmpty=false;
   if(isObj(state)){
     // The new profile can expose UserMovieReactions, bare Movie entities,
     // or connection edges. Only scan the list rooted in this dedicated
     // planned-to-watch page, not unrelated recommendations.
     const lists=[],genericLists=[],visited=new Set();
     const resolve=x=>deref(state,x);
     function asList(container) {
       const value=resolve(container);
       if(Array.isArray(value))return value;
       if(!isObj(value))return null;
       for(const field of ['items','nodes','edges','movies','results']) {
         const children=resolve(value[field]);
         if(Array.isArray(children))return children;
       }
       return null;
     }
     function walk(src,depth,fromListing=false){
       const item=resolve(src);
       if(!item||typeof item!=='object'||visited.has(item)||depth>10)return;
       visited.add(item);
       if(Array.isArray(item)){
         if(fromListing){ lists.push(item);return; }
         for(const value of item.slice(0,100))walk(value,depth+1,false);
         return;
       }
       for(const [key,value] of Object.entries(item)){
         if(!value||typeof value!=='object')continue;
         const explicit=/movieReactions|planned|willWatch|watchlist/i.test(key);
         const generic=/movieList|movies\(/i.test(key);
         const list=asList(value);
         if(explicit&&list){
           lists.push(list);
           if(!list.length)verifiedEmpty=true;
         } else if(generic&&list&&depth<=1){
           // Generic movie arrays may include recommendations elsewhere.
           genericLists.push(list);
         } else if(depth<7)walk(value,depth+1,false);
       }
     }
     for(const [key,value] of Object.entries(state)) {
       if(key.startsWith('ROOT_'))walk(value,0);
     }
     function movieFor(raw) {
       const entry=resolve(raw);
       if(!isObj(entry))return null;
       if(entry.__typename==='UserMovieReactions')
         return resolve(entry.movie);
       const edge=resolve(entry.node||entry.item);
       if(edge&&edge!==entry)return movieFor(edge);
       const container=resolve(entry.movie);
       if(container?.id&&TYPES.has(container.__typename))return container;
       if(TYPES.has(entry.__typename)&&entry.id)return entry;
       return null;
     }
     for(const list of (lists.length?lists:genericLists))for(const raw of list){
       const movie=movieFor(raw),item=normalize(movie,state);
       if(!item)continue;
       recognized++;
       entries.set(item.type+':'+item.id,item);
     }
   }
   let doc=null;
   if(typeof DOMParser!=='undefined')doc=new DOMParser().parseFromString(html,'text/html');
   if(!recognized && doc){
     // HTML fallback is restricted to cards within the user movie listing.
     for(const card of doc.querySelectorAll(
       '[class*="styles_item"],[class*="styles_movie"],[data-test-id*="reaction"]')){
       const link=card.querySelector('a[href*="/film/"],a[href*="/series/"]');
       const match=String(link?.getAttribute('href')||'').match(
         /\/(film|series)\/([1-9]\d{0,12})(?:\/|[?#]|$)/);
       if(!match)continue;
       const title=clean(card.querySelector('[class*="styles_title"] span')?.textContent||
         card.querySelector('[class*="styles_title"]')?.textContent||
         link?.textContent||card.querySelector('img')?.alt||'',200)||
         (match[1]==='film'?'Фильм №':'Сериал №')+match[2];
       const image=card.querySelector('img');
       const url=clean(image?.getAttribute('src')||'',700);
       const meta=card.querySelector('[class*="styles_subtitle"]')?.textContent||'';
       const year=Number(meta.match(/\b(?:19|20)\d{2}\b/)?.[0]);
       entries.set(match[1]+':'+match[2],{type:match[1],id:match[2],title,
         year:year>=1888&&year<=2200?year:null,genres:[],
         posterUrl:/^https:\/\/(?:avatars\.mds\.yandex\.net|st\.kp\.yandex\.net)\//.test(url)?url:''});
       recognized++;
     }
   }
   const pages=[];
   if(doc)for(const a of doc.querySelectorAll('a[href*="page="]')){
     const n=Number(String(a.getAttribute('href')||'').match(/[?&]page=(\d+)/)?.[1]);
     if(Number.isInteger(n)&&n>=1&&n<=20000)pages.push(n);
   }else for(const m of html.matchAll(/[?&]page=(\d+)/g)){
     const n=Number(m[1]);if(n>=1&&n<=20000)pages.push(n);
   }
   return {items:[...entries.values()],recognized,
     verifiedEmpty:verifiedEmpty && recognized===0,
     lastPage:pages.length?Math.max(page,...pages):null,
     source:recognized?'listing':verifiedEmpty?'verified-empty':'empty'};
 }
 return {parsePage};
});