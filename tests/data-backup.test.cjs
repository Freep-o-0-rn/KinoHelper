const test = require('node:test');
const assert = require('node:assert/strict');
const backup = require('../data-backup.js');

test('history merges by URL, keeping the latest and sorting newest first', () => {
  const merged = backup.mergeHistory(
    [{url:'https://www.kinokino.vip/film/12/',title:'Old',timestamp:100},
      {url:'https://www.kinokino.vip/film/13/',timestamp:300}],
    [{url:'https://www.kinokino.vip/film/12/',title:'New',timestamp:200},
      {url:'javascript:alert(1)',timestamp:900}]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].url, 'https://www.kinokino.vip/film/13/');
  assert.equal(merged[1].title, 'New');
});

test('watchlist merges duplicates by Kinopoisk ID', () => {
  const actual = backup.mergeWatchlist(
    [{type:'film',id:'50',title:'Old',addedAt:5}],
    [{type:'film',id:'50',title:'New',addedAt:9},
      {type:'series',id:'50',title:'Series',addedAt:3}]
  );
  assert.equal(actual.length, 2);
  assert.equal(actual[0].title, 'New');
});

test('scoped ratings never lose unrelated profiles and favor newer revisions', () => {
  const existing = {'123': {'film:11': {rating:8,updatedAt:50}},
    '__local__': {'series:7': {rating:6,updatedAt:2}}};
  const imported = {'123': {
    'film:11': {rating:10,updatedAt:20},
    'film:12': {rating:4,updatedAt:60}
  }, '456': {'film:1': {rating:2,updatedAt:5}}};
  const actual = backup.mergeRatings(existing, imported);
  assert.equal(actual['123']['film:11'].rating, 8);
  assert.equal(actual['123']['film:12'].rating, 4);
  assert.equal(actual['456']['film:1'].rating, 2);
  assert.equal(actual.__local__['series:7'].rating, 6);
});

test('lifetime watched status remains completed and time never doubles', () => {
  const before = { 'film:10': {completed:true,updatedAt:1} };
  const after = { 'film:10': {completed:false,updatedAt:9} };
  const library = backup.mergeStorageValue('kinoStatsLibraryV1',before,after);
  assert.equal(library['film:10'].completed,true);

  const time = backup.mergeStorageValue('kinoStatsWatchTimeV1',
    {'film:10':{seconds:300,updatedAt:1}},
    {'film:10':{seconds:250,updatedAt:9}});
  assert.equal(time['film:10'].seconds,300);
});

test('importing extended history prevents automatic truncation', () => {
  const history = Array.from({length:25},(_,i)=>({
    url:'https://www.kinokino.vip/film/'+(i+1)+'/',
    timestamp: Date.now() - i * 1000
  }));
  const current = {
    local:{
      kinoHelperSettings:JSON.stringify({
        historyRulesActivated:true,historyMaxItems:20,historyMaxAgeDays:30
      })
    },storage:{}
  };
  const imported = {local:{kinopoiskHistory:JSON.stringify(history)},storage:{}};
  const merged = backup.combineData(current, imported);
  assert.equal(JSON.parse(merged.local.kinopoiskHistory).length,25);
  const settings=JSON.parse(merged.local.kinoHelperSettings);
  assert.equal(settings.historyMaxItems,null);
  assert.equal(settings.historyMaxAgeDays,30);
});

test('backup rejects unexpected format and malformed data', () => {
  assert.throws(()=>backup.validateBackup({}),/Неподдерживаемый/);
  const base={format:'KinoHelperDataBackup',formatVersion:1,local:{},
    storage:{kinoStatsRatingsV1:{'123':{'film:1':{rating:10}}}}};
  assert.doesNotThrow(()=>backup.validateBackup(base));
  assert.throws(()=>backup.validateBackup({...base,
    local:{kinopoiskHistory:'{}'}}),/Повреждён список/);
});


test('profile watched marks round-trip without mixing Kinopoisk accounts',()=>{
  const before={'123':{'film:99':{watched:true,updatedAt:1}}};
  const incoming={'123':{'series:88':{watched:true,updatedAt:2}},
    '456':{'film:99':{watched:true,updatedAt:2}}};
  const result=backup.mergeStorageValue('kinoStatsWatchedV1',before,incoming);
  assert.equal(Object.keys(result['123']).length,2);
  assert.equal(Object.keys(result['456']).length,1);
  assert.equal(result['123']['film:99'].watched,true);
});


test('watchlist accounts remain isolated when backup is merged',()=>{
 const a={'111':{'film:1':{id:'1',type:'film',updatedAt:1}}};
 const b={'222':{'film:2':{id:'2',type:'film',updatedAt:2}}};
 const merged=backup.mergeStorageValue('kinoWatchlistProfilesV1',a,b);
 assert.equal(Object.keys(merged).length,2);
 assert.ok(merged['111']['film:1']);
 assert.ok(merged['222']['film:2']);
});
