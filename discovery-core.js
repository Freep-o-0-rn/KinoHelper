// KinoHelper discovery feed: pure selection and personalization, no network or writes.
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined' && module.exports)module.exports=api;
  if(root)root.KinoDiscoveryCore=api;
})(typeof window!=='undefined'?window:null,()=>{
  'use strict';
  const FILM_ID=/^[1-9]\d{0,12}$/;
  const safe=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
  const clean=x=>String(x||'').replace(/\s+/g,' ').trim();
  const keyOf=m=>m&&['film','series'].includes(m.type)&&FILM_ID.test(String(m.id))
    ?m.type+':'+m.id:'';
  function poster(raw){
    try{
      let value=String(raw||'').trim().replace(/&amp;/gi,'&')
        .replace(/\\u002[fF]/g,'/').replace(/\\\//g,'/');
      if(value.startsWith('//'))value='https:'+value;
      const url=new URL(value);
      return url.protocol==='https:'&&
        ['avatars.mds.yandex.net','st.kp.yandex.net'].includes(url.hostname)
        ?url.href:'';
    }catch{return '';}
  }
  // Official Kinopoisk poster URLs may be returned without a size suffix.
  // Try light thumbnails first, then the original and legacy static sources.
  function posterSources(item={}){
    const candidates=[],seen=new Set();
    const add=raw=>{
      const url=poster(raw);
      if(!url||seen.has(url))return;
      seen.add(url);candidates.push(url);
    };
    const expand=raw=>{
      const source=poster(raw);
      if(!source)return;
      const url=new URL(source),pathname=url.pathname.replace(/\/+$/,'');
      const avatar=url.hostname==='avatars.mds.yandex.net'&&
        /^\/get-kinopoisk-image\/[^/]+\/[^/]+/.test(pathname);
      if(avatar){
        const base=pathname.replace(/\/(?:orig|\d+x\d+)$/i,'');
        for(const suffix of ['280x420','300x450','orig'])
          add(url.origin+base+'/'+suffix);
      }
      add(source);
    };
    expand(item.posterUrl||item.poster);
    expand(item.posterFallback);
    const id=String(item.id||'');
    if(/^[1-9]\d{0,12}$/.test(id)){
      add('https://st.kp.yandex.net/images/film_iphone/iphone360_'+id+'.jpg');
      add('https://st.kp.yandex.net/images/film_big/'+id+'.jpg');
    }
    return candidates;
  }
  function genres(input){
    return [...new Set((Array.isArray(input)?input:[]).map(x=>clean(x).toLocaleLowerCase('ru'))
      .filter(x=>x.length>=3&&x.length<=32&&/^[\p{L}][\p{L} -]*$/u.test(x)))].slice(0,8);
  }
  function premiereDate(value){
    const months=['января','февраля','марта','апреля','мая','июня',
      'июля','августа','сентября','октября','ноября','декабря'];
    const pattern=/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(20\d{2})/u;
    const m=clean(value).toLocaleLowerCase('ru').match(pattern);
    if(!m)return '';
    const day=Number(m[1]),month=months.indexOf(m[2]),y=Number(m[3]);
    const d=new Date(Date.UTC(y,month,day));
    if(d.getUTCDate()!==day||d.getUTCMonth()!==month||
      d.getUTCFullYear()!==y)return '';
    return d.toISOString().slice(0,10);
  }
  function movie(x,kind){
    if(!x||!['film','series'].includes(x.type)||!FILM_ID.test(String(x.id)))return null;
    const title=clean(x.title).slice(0,120);
    if(title.length<2)return null;
    const yr=Number(x.year),r=Number(x.rating);
    return {
      type:x.type,id:String(x.id),title,
      kind:kind==='new'?'new':kind==='popular'?'popular':'for-you',
      year:Number.isInteger(yr)&&yr>=1888&&yr<=2200?yr:null,
      rating:Number.isFinite(r)&&r>0&&r<=10?r:null,
      genres:genres(x.genres),description:clean(x.description).slice(0,280),
      posterUrl:poster(x.posterUrl||x.poster),
      posterFallback:poster(x.posterFallback),
      // A production year is not proof of a release. Only use a date
      // that the source explicitly associates with the film's premiere.
      releaseDate:/^\d{4}-\d{2}-\d{2}$/.test(String(x.releaseDate||''))
        ?x.releaseDate:''
    };
  }
  function viewed(history,watched){
    const ids=new Set();
    for(const entry of Array.isArray(history)?history:[]){
      const match=String(entry?.url||'').match(/\/(film|series)\/([1-9]\d{0,12})(?:\/|$)/);
      if(match){ids.add('film:'+match[2]);ids.add('series:'+match[2]);}
    }
    for(const [k,x] of Object.entries(safe(watched)))if(x?.watched){
      ids.add(k);
      const n=k.match(/^(?:film|series):([1-9]\d{0,12})$/)?.[1];
      if(n){ids.add('film:'+n);ids.add('series:'+n);}
    }
    return ids;
  }
  function interests(genreRecords,ratings,watched){
    const weight=new Map();
    const watch=safe(watched),scores=safe(ratings);
    const sources={...watch,...safe(genreRecords)};
    for(const [id,item] of Object.entries(sources)){
      const gs=genres(item?.genres);
      if(!gs.length)continue;
      const vote=Number(scores[id]?.rating);
      let w=watch[id]?.watched?0.35:0;
      if(vote>=8&&vote<=10)w+=3+(vote-8);
      else if(vote>=5&&vote<8)w+=0.4;
      else if(vote>=1&&vote<5)w-=2.5;
      if(w===0)continue;
      for(const g of gs)weight.set(g,(weight.get(g)||0)+w);
    }
    return weight;
  }
  // Candidate lists contain actual Kinopoisk catalog entries. "For you" is
  // reserved for matches with local genre evidence; the fallback is explicitly
  // labeled "Popular" rather than pretending to be personalized.
  function select({recommended=[],newReleases=[],history=[],watched={},
    ratings={},genreRecords={},count=10,year=new Date().getFullYear()}={}){
    const seen=viewed(history,watched);
    for(const [key,x] of Object.entries(safe(ratings))){
      if(Number(x?.rating)>=1){
        seen.add(key);
        const id=key.match(/^(?:film|series):([1-9]\d{0,12})$/)?.[1];
        if(id){seen.add('film:'+id);seen.add('series:'+id);}
      }
    }
    const interest=interests(genreRecords,ratings,watched);
    const normalize=(input,kind)=>(Array.isArray(input)?input:[])
      .map(x=>movie(x,kind)).filter(m=>{
        const k=keyOf(m);
        return k&&!seen.has(k)&&!seen.has('film:'+m.id)&&
          !seen.has('series:'+m.id);
      });
    const now=new Date(),today=now.toISOString().slice(0,10);
    const minDate=new Date(Date.UTC(now.getUTCFullYear(),
      now.getUTCMonth()-5,now.getUTCDate())).toISOString().slice(0,10);
    const max=Math.min(10,Math.max(1,Number(count)||10));
    const accepted=new Set();
    const unique=arr=>arr.filter(m=>{
      // Film and series identities can vary between legacy catalog URLs.
      if(accepted.has(m.id))return false;
      accepted.add(m.id);return true;
    });
    const news=unique(normalize(newReleases,'new')
      .filter(m=>m.year&&m.year>=year-1&&m.year<=year&&
        m.releaseDate&&m.releaseDate>=minDate&&m.releaseDate<=today)
      .sort((a,b)=>b.releaseDate.localeCompare(a.releaseDate)));
    const raw=unique(normalize(recommended,'for-you'));
    const scored=raw.map((m,i)=>{
      const affinity=m.genres.reduce((n,g)=>n+(interest.get(g)||0),0);
      return {m,affinity,score:affinity*3+(m.rating||0)*.12-i*.015};
    });
    const personal=scored.filter(x=>x.affinity>=.35)
      .sort((a,b)=>b.score-a.score).map(x=>x.m);
    const popular=scored.filter(x=>x.affinity<.35)
      .map(x=>({...x.m,kind:'popular'}));
    const out=[],chosen=new Set();
    const append=m=>{
      if(!m||chosen.has(m.id)||out.length>=max)return;
      chosen.add(m.id);out.push(m);
    };
    // Mix genuine personal matches with verified premieres, then fill any
    // remaining slots with catalog-ranked popular titles (not random picks).
    while(out.length<max&&(personal.length||news.length)){
      append(personal.shift());
      append(news.shift());
    }
    for(const m of popular)append(m);
    return out;
  }
  return {movie,poster,posterSources,genres,premiereDate,keyOf,interests,viewed,select};
});
