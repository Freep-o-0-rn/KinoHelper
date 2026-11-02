// Import public Kinopoisk profile reaction listings. No page scripts are executed.
// This module only parses directly associated Movie and Vote records; scores
// from Kinopoisk's public movie rating are never treated as a personal vote.
(function(root,factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  if (root) root.KinoProfileVotes=api;
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';
  const TYPES = new Set(['TvSeries','MiniSeries','TvShow','Film']);
  const userId = input => {
    const m=String(input||'').match(/^[1-9]\d{0,12}$/);
    return m ? m[0] : '';
  };
  function extractJSONObject(src, from) {
    const begin=src.indexOf('{',from);
    if (begin<0) return null;
    let depth=0, escaped=false, quoted=false;
    for(let i=begin;i<src.length;i++){
      const c=src[i];
      if (quoted) {
        if(escaped) escaped=false;
        else if(c==='\\')escaped=true;
        else if(c==='"')quoted=false;
      } else if(c==='"')quoted=true;
      else if(c==='{')depth++;
      else if(c==='}' && --depth===0) {
        try{return JSON.parse(src.slice(begin,i+1));}catch{return null;}
      }
    }
    return null;
  }
  function profileSSR(html) {
    if(typeof html!=='string' || html.length>9e6)return null;
    // Extract only the JSON assigned to a known SSR bootstrap key. Never eval.
    const match=/window\.Ya\.__ssr_initial_data\s*=\s*/.exec(html);
    return match ? extractJSONObject(html,match.index+match[0].length):null;
  }
  const ref=(state,value)=>value?.__ref ? state[value.__ref] : value;
  function reactionLists(state){
    const found=[],visited=new Set();
    function walk(obj,depth) {
      if(!obj || typeof obj!=='object'||visited.has(obj)||depth>6)return;
      visited.add(obj);
      if(Array.isArray(obj)){
        if(obj.length && obj.some(x=>ref(state,x)?.__typename==='UserMovieReactions'))
          found.push(obj);
        else if(depth<4) for(const v of obj.slice(0,60))walk(v,depth+1);
        return;
      }
      for(const [key,val] of Object.entries(obj)){
        if(!val || typeof val!=='object')continue;
        const resolved=ref(state,val);
        if(key.includes('movieReactions') && Array.isArray(resolved?.items))
          found.push(resolved.items);
        else if(depth<4 && !key.startsWith('Movie:'))walk(resolved,depth+1);
      }
    }
    for(const [k,v] of Object.entries(state || {})) {
      if(k.startsWith('ROOT_'))walk(v,0);
    }
    return found;
  }
  function recognizedSSRRows(ssr) {
    const state=ssr?.apolloState || ssr?.props?.pageProps?.apolloState;
    if(!state || typeof state!=='object')return 0;
    const ids=new Set();
    for(const entries of reactionLists(state)) {
      for(const raw of entries) {
        const row=ref(state,raw);
        const movie=ref(state,row?.movie);
        if(row?.__typename==='UserMovieReactions' &&
            userId(String(movie?.id||'')) && TYPES.has(movie?.__typename))
          ids.add(String(movie.id));
      }
    }
    return ids.size;
  }
  // Only an explicit Watched reaction proves the profile's watched mark.
  // A Vote never substitutes for Watched here (including rated TV shows).
  function readSSRAll(ssr) {
    const state=ssr?.apolloState || ssr?.props?.pageProps?.apolloState;
    if(!state || typeof state!=='object')return [];
    const results=new Map();
    for(const items of reactionLists(state)) {
      for(const raw of items) {
        const item=ref(state,raw);
        if(item?.__typename!=='UserMovieReactions')continue;
        const movie=ref(state,item.movie);
        const id=String(movie?.id||'');
        const movieType=movie?.__typename;
        if(!userId(id)||!TYPES.has(movieType))continue;
        let rating=null,watched=false;
        for(const [key,reactions] of Object.entries(item)) {
          if(!key.startsWith('reactions')||!Array.isArray(reactions))continue;
          for(const rawReaction of reactions) {
            const reaction=ref(state,rawReaction);
            if(reaction?.__typename==='Watched')watched=true;
            if(reaction?.__typename==='Vote') {
              const value=Number(reaction.value);
              if(Number.isInteger(value)&&value>=1&&value<=10)rating=value;
            }
          }
        }
        const type=movieType==='Film'?'film':'series';
        const genres=Array.isArray(movie.genres)
          ? [...new Set(movie.genres.map(g=>ref(state,g)?.name)
              .filter(g=>typeof g==='string'&&g.trim().length>=3)
              .map(g=>g.trim().toLocaleLowerCase('ru')))].slice(0,12)
          : [];
        const record={type,id,rating,watched,genres};
        const identity=type+':'+id;
        const old=results.get(identity);
        if(old) {
          record.rating=record.rating??old.rating;
          record.watched=record.watched||old.watched;
          if(!record.genres.length)record.genres=old.genres;
        }
        results.set(identity,record);
      }
    }
    return [...results.values()];
  }
  function readSSRRecords(ssr) {
    return readSSRAll(ssr)
      .filter(record=>record.rating!==null)
      .map(({type,id,rating})=>({type,id,rating}));
  }
  function readHTMLCards(doc) {
    if(!doc?.querySelectorAll)return [];
    const votes=new Map();
    for(const card of doc.querySelectorAll('[class*="styles_item"],[data-test-id*="reaction"]')){
      const link=card.querySelector('a[href*="/film/"],a[href*="/series/"]');
      const match=String(link?.getAttribute('href')||'')
        .match(/\/(film|series)\/([1-9]\d{0,12})(?:\/|[?#]|$)/);
      if(!match)continue;
      // Only the personal rating label in the *same* reaction card.
      const score=card.querySelector('[class*="styles_value"]');
      const raw=String(score?.textContent||'').trim();
      if(!/^(10|[1-9])$/.test(raw))continue;
      const type=match[1],id=match[2];
      votes.set(type+':'+id,{type,id,rating:Number(raw)});
    }
    return [...votes.values()];
  }
  function pagination(doc,html,now) {
    const seen=[];
    if(doc?.querySelectorAll){
      for(const anchor of doc.querySelectorAll('a[href*="page="]')){
        const href=String(anchor.getAttribute('href')||'');
        const m=href.match(/[?&]page=(\d+)/);
        if(m){const page=Number(m[1]);if(page>0 && page<=20000)seen.push(page);}
      }
    }else{
      // Useful for DOM-less tests only.
      for(const m of html.matchAll(/[?&]page=(\d+)/g)){
        const page=Number(m[1]);if(page>0&&page<=500)seen.push(page);
      }
    }
    const lastPage=seen.length?Math.max(now,...seen):null;
    return {lastPage};
  }
  function parsePage(html,page=1){
    if(typeof html!=='string'||html.length>9e6)throw Error('Размер страницы слишком большой');
    if(/captcha|smartcaptcha/i.test(html.slice(0,180000)) &&
        !html.includes('UserMovieReactions'))throw Error('Кинопоиск запросил проверку браузера');
    const ssr=profileSSR(html);
    const ssrAll=readSSRAll(ssr);
    // Keep the genres attached to each actual personal vote. Otherwise
    // the full rating import contains only scores and cannot inform discovery.
    const ssrVotes=ssrAll.filter(row=>row.rating!==null)
      .map(({type,id,rating,genres})=>({type,id,rating,genres}));
    const watched=ssrAll.filter(row=>row.watched)
      .map(({type,id,genres})=>({type,id,genres}));
    const recognized=recognizedSSRRows(ssr);
    let doc=null;
    if(typeof DOMParser!=='undefined')
      doc=new DOMParser().parseFromString(html,'text/html');
    const votes=ssrAll.length?ssrVotes:readHTMLCards(doc);
    const {lastPage}=pagination(doc,html,page);
    const domRecognized=doc?.querySelectorAll
      ? [...doc.querySelectorAll('[class*="styles_item"],[data-test-id*="reaction"]')]
        .filter(card=>card.querySelector('a[href*="/film/"],a[href*="/series/"]')).length
      : 0;
    return {votes,watched,lastPage,recognized:Math.max(recognized,domRecognized),
      source:ssrAll.length?'ssr':votes.length?'html':recognized?'watched-only':'empty'};

  }
  return {userId,profileSSR,readSSRAll,readSSRRecords,parsePage,readHTMLCards,pagination};
});
