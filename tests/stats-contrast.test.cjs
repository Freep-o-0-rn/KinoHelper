'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const core = require('../stats-core.js');
const statsSource = readFileSync(path.join(__dirname, '..', 'stats.js'), 'utf8');

function rgb(hex) {
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
}
function distance(a, b) {
  const x = rgb(a), y = rgb(b);
  return Math.hypot(...x.map((v, i) => v - y[i]));
}
function sample(values) {
  return Object.fromEntries(values.map((rating,i) => [
    'film:' + (i + 1), {rating}
  ]));
}

test('ten rating accents are saturated, distinct and each neighbor contrasts', () => {
  const buckets = core.summarize({ratings:sample([1,2,3,4,5,6,7,8,9,10])}).buckets;
  const colors = buckets.map(b => b.color);
  assert.equal(colors.length,10);
  assert.equal(new Set(colors).size,10);
  for (const hex of colors) assert.match(hex,/^#[0-9A-F]{6}$/);
  for (let i=1; i<colors.length; i++) {
    assert.ok(distance(colors[i-1], colors[i]) > 90,
      'neighboring grades '+i+' and '+(i+1)+' must remain distinguishable');
  }
});

test('vivid palette changes no individual counts or mean', () => {
  const ratings=[1,1,7,8,8,8,9,10,10];
  const result=core.summarize({ratings:sample(ratings)});
  assert.deepEqual(result.buckets.map(x=>x.count), [2,0,0,0,0,0,1,3,1,2]);
  assert.equal(result.ratingsCount,ratings.length);
  assert.equal(result.buckets.reduce((acc,x)=>acc+x.count,0),ratings.length);
  assert.equal(result.meanRating,ratings.reduce((a,b)=>a+b,0)/ratings.length);
});

class MockElement {
  constructor(){
    this.attrs={}; this.children=[]; this.events={}; this.dataset={};
    this.className=''; this.textContent=''; this.style={}; this.hidden=false;
    this.classList={add(){},remove(){},toggle(){}};
  }
  addEventListener(type,cb){this.events[type]=cb;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  removeAttribute(name){delete this.attrs[name];}
  append(...children){this.children.push(...children);}
  appendChild(child){this.children.push(child);}
  replaceChildren(...children){this.children=children;}
}
async function makeUI(ratings, films = {}) {
  const nodes={};
  const doc={
    body:new MockElement(),activeElement:null,
    getElementById(id){return nodes[id] ||= new MockElement();},
    createElement(){return new MockElement();},
    createElementNS(){return new MockElement();}
  };
  const current='111222';
  const values={kinoStatsRatingsV1:{[current]:sample(ratings)},
    kinoPlaybackProgressV1:films};
  const chrome={
    storage:{
      local:{
        async get(keys){
          return Object.fromEntries((Array.isArray(keys)?keys:[keys])
            .map(key=>[key,values[key]]));
        },
        async set(obj){Object.assign(values,obj);}
      },
      onChanged:{addListener(){}}
    },
    runtime:{
      getManifest(){return {version:'1.563'};},
      async sendMessage(){return {ok:true};}
    }
  };
  const win={
    KinoStatsCore:core,
    KinoStatsAccount:{async detect(){return {status:'logged-in',id:current};}},
    addEventListener(){}
  };
  new Function('window','document','chrome',statsSource)(win,doc,chrome);
  nodes.statsButton.events.click();
  for(let i=0;i<50;i++) await new Promise(r=>setImmediate(r));
  const slices = id => {
    const wrap=nodes[id].children[0];
    return wrap.children[0].children.slice(1); // after background ring
  };
  return {nodes,slices};
}
const visibleLength = element => Number(element.attrs['stroke-dasharray'].split(' ')[0]);
const CIRCUMFERENCE=2*Math.PI*39;

test('rating sectors have subtle background gaps without changing tooltip values', async () => {
  const ui=await makeUI([8,8,9],
    {'film:100':{type:'film',id:'100',duration:600,position:100,completed:true},
     'film:200':{type:'film',id:'200',duration:600,position:200,completed:false}});
  const rating=ui.slices('statsRatingsChart');
  assert.equal(rating.length,2);
  const grade8=rating.find(c=>c.attrs['aria-label'].startsWith('8:'));
  const grade9=rating.find(c=>c.attrs['aria-label'].startsWith('9:'));
  assert.ok(grade8 && grade9);
  assert.ok(visibleLength(grade8) < CIRCUMFERENCE*2/3);
  assert.ok(visibleLength(grade9) < CIRCUMFERENCE/3);
  assert.equal(grade8.attrs['aria-label'],'8: 2 (67%)');
  assert.equal(grade9.attrs['aria-label'],'9: 1 (33%)');
  // Separators are opt-in for personal ratings; film charts remain unchanged.
  const films=ui.slices('statsFilmChart');
  assert.equal(films.length,2);
  assert.ok(Math.abs(visibleLength(films[0])-CIRCUMFERENCE/2)<1e-6);
  assert.ok(Math.abs(visibleLength(films[1])-CIRCUMFERENCE/2)<1e-6);
});

test('single rating uses full unbroken circle, rare grades stay visible', async()=>{
  const single=await makeUI([10]);
  const circles=single.slices('statsRatingsChart');
  assert.equal(circles.length,1);
  assert.ok(Math.abs(visibleLength(circles[0])-CIRCUMFERENCE)<1e-6);
  const mix=await makeUI([...Array(99).fill(8),1]);
  const sparse=mix.slices('statsRatingsChart');
  assert.equal(sparse.length,2);
  assert.ok(sparse.every(s=>visibleLength(s)>0));
});
