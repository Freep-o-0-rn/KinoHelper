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
      const url=new URL(String(raw||''));
      return url.protocol==='https:'&&
        ['avatars.mds.yandex.net','st.kp.yandex.net'].includes(url.hostname)
        ?url.href:'';
    }catch{return '';}
  }
  function genres(input){
    return [...new Set((Array.isArray(input)?input:[]).map(x=>clean(x).toLocaleLowerCase('ru'))
      .filter(x=>x.length>=3&&x.length<=32&&/^[\p{L}][\p{L} -]*$/u.test(x)))].slice(0,8);
  }
  function movie(x,kind){
    if(!x||x.type!=='film'||!FILM_ID.test(String(x.id)))return null;
    const title=clean(x.title).slice(0,120);
    if(title.length<2)return null;
    const yr=Number(x.year),r=Number(x.rating);
    return {
      type:'film',id:String(x.id),title,kind:kind==='new'?'new':'for-you',
      year:Number.isInteger(yr)&&yr>=1888&&yr<=2200?yr:null,
      rating:Number.isFinite(r)&&r>0&&r<=10?r:null,
      genres:genres(x.genres),description:clean(x.description).slice(0,280),
      posterUrl:poster(x.posterUrl||x.poster),
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
      if(match)ids.add(match[1]+':'+match[2]);
    }
    for(const [k,x] of Object.entries(safe(watched)))if(x?.watched)ids.add(k);
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
  function select({recommended=[],newReleases=[],history=[],watched={},
    ratings={},genreRecords={},count=10,year=new Date().getFullYear()}={}){
    const seen=viewed(history,watched);
    for(const [id,x] of Object.entries(safe(ratings)))
      if(Number(x?.rating)>=1)seen.add(id);
    const interest=interests(genreRecords,ratings,watched);
    const normalize=(input,kind)=>(
      Array.isArray(input)?input:[]).map(x=>movie(x,kind))
      .filter(m=>m&&!seen.has(keyOf(m)));
    const now=new Date(),today=now.toISOString().slice(0,10);
    const minDate=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-5,
      now.getUTCDate())).toISOString().slice(0,10);
    const newKeys=new Set();
    const news=normalize(newReleases,'new')
      .filter(m=>m.releaseDate&&m.releaseDate>=minDate&&m.releaseDate<=today)
      .sort((a,b)=>b.releaseDate.localeCompare(a.releaseDate))
      .filter(m=>{
        const k=keyOf(m);
        if(newKeys.has(k))return false;
        newKeys.add(k);return true;
      });
    const recKeys=new Set();
    const rec=normalize(recommended,'for-you').filter(m=>{
      const k=keyOf(m);
      if(newKeys.has(k)||recKeys.has(k))return false;
      recKeys.add(k);return true;
    });
    // A popular film is NOT a personal recommendation without evidence
    // of matching genres and positive preferences from verified local data.
    const scored=rec.map((m,i)=>{
      const affinity=m.genres.reduce((n,g)=>n+(interest.get(g)||0),0);
      return {m,score:affinity*3+(m.rating||0)*.12-i*.02,affinity};
    }).filter(x=>x.affinity>=0.35)
      .sort((a,b)=>b.score-a.score).map(x=>x.m);
    // Mix sources but never invent recommendations or double-list the same movie.
    const chosen=[],max=Math.min(10,Math.max(1,Number(count)||10));
    while(chosen.length<max&&(scored.length||news.length)){
      if(scored.length)chosen.push(scored.shift());
      if(chosen.length<max&&news.length)chosen.push(news.shift());
    }
    return chosen;
  }
  return {movie,poster,genres,keyOf,interests,viewed,select};
});
