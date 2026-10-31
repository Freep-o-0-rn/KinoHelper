'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../stats-core.js');
const film = (id, completed) => ({
  type:'film',id:String(id),position:100,duration:200,completed
});
const ep = (id,s,e,completed) => ({
  type:'series',id:String(id),season:s,episode:e,
  position:100,duration:200,completed
});

test('movies and series episodes remain separate and unique', () => {
  const data = core.summarize({
    films:{'film:101':film(101,true),'film:202':film(202,false)},
    episodes:{'series:55:1:1':ep(55,1,1,true),
      'series:55:1:2':ep(55,1,2,false)},
  });
  assert.equal(data.finishedFilms,1);
  assert.equal(data.unfinishedFilms,1);
  assert.equal(data.startedSeries,1);
  assert.equal(data.startedEpisodes,2);
  assert.equal(data.finishedEpisodes,1);
  assert.equal(data.completedSeries,null,'unknown total episodes must not imply series complete');
});

test('historical catalog retains completion after checkpoint eviction or rewatch', () => {
  const data = core.summarize({
    films:{'film:101':film(101,false)},
    episodes:{},
    library:{'film:101':{completed:true},
      'film:202':{completed:true},
      'series:55:1:1':{completed:true},
      'series:55:1:2':{completed:false}}
  });
  assert.equal(data.finishedFilms,2);
  assert.equal(data.unfinishedFilms,0);
  assert.equal(data.startedSeries,1);
  assert.equal(data.finishedEpisodes,1);
  assert.equal(data.startedEpisodes,2);
});

test('only confirmed personal ratings contribute to mean', () => {
  const data = core.summarize({
    ratings:{
      'film:101':{rating:9},
      'film:202':{rating:7},
      'film:303':{rating:0},
      'film:404':{rating:10.5},
      'film:505':{rating:'not a vote'}
    }
  });
  assert.equal(data.ratingsCount,2);
  assert.equal(data.meanRating,8);
  assert.equal(data.buckets[0].count,1);
  assert.equal(data.buckets[1].count,1);
});

test('genre membership works with multiple genres and watched-only ID', () => {
  const data = core.summarize({
    films:{'film:101':film(101,true)},
    episodes:{'series:55:1:1':ep(55,1,1,true)},
    genres:{
      'film:101':{genres:['драма','триллер']},
      'series:55':{genres:['драма']},
      'film:999':{genres:['фантастика']}
    }
  });
  assert.equal(data.taggedTitles,2);
  assert.equal(data.genreRows[0].name,'драма');
  assert.equal(data.genreRows[0].count,2);
  assert.equal(data.genreRows.length,2);
});

test('actual playback time never derived from checkpoint position', () => {
  const data = core.summarize({
    films:{'film:101':film(101,false)}, watchTime:{}
  });
  assert.equal(data.totalSeconds,0);
  const later = core.summarize({
    watchTime:{'film:101':{seconds:35},'series:55':{seconds:80}}
  });
  assert.equal(later.filmSeconds,35);
  assert.equal(later.seriesSeconds,80);
  assert.equal(later.totalSeconds,115);
});

test('profile link validation accepts personal ID but rejects foreign host', () => {
  assert.equal(core.validateProfile(
    'https://www.kinopoisk.ru/user/7143359/movies/voted-watched/'),'7143359');
  assert.equal(core.validateProfile('7143359'),'7143359');
  assert.equal(core.validateProfile('https://evil.test/user/7143359/'),'');
});

// Verify actual background aggregation code (not a copied algorithm).
function runtime() {
  const source = fs.readFileSync(path.join(__dirname,'..','background.js'),'utf8');
  const start = source.indexOf('// KinoHelper 1.558: wall-clock');
  assert.ok(start >= 0);
  const data = {local:{},session:{}};
  const area = kind => ({
    get:async key=>({[key]:data[kind][key]}),
    set:async obj=>Object.assign(data[kind],obj)
  });
  const chrome = {storage:{local:area('local'),session:area('session')}};
  const functions = new Function('chrome',source.slice(start) +
    ';return {statsRecordVerifiedTime,statsRememberCompletion};')(chrome);
  return {...functions,data};
}

test('watch time is deduplicated, capped and movie-isolated', async () => {
  const api = runtime();
  const token = 'A'.repeat(32);
  const payload = sec=>({playedSeconds:sec,statsTrackingId:token});
  await api.statsRecordVerifiedTime('film:101',payload(5));
  await api.statsRecordVerifiedTime('film:101',payload(5));
  await api.statsRecordVerifiedTime('film:101',payload(12));
  assert.equal(api.data.local.kinoStatsWatchTimeV1['film:101'].seconds,12);
  await api.statsRecordVerifiedTime('film:101',payload(200));
  assert.equal(api.data.local.kinoStatsWatchTimeV1['film:101'].seconds,27);
  await api.statsRecordVerifiedTime('series:101',payload(300));
  assert.equal(api.data.local.kinoStatsWatchTimeV1['series:101'],undefined);
});

test('completed content cannot be undone by a later checkpoint', async () => {
  const api = runtime();
  await api.statsRememberCompletion('film:101',true);
  await api.statsRememberCompletion('film:101',false);
  await api.statsRememberCompletion('series:101:1:1',true);
  await api.statsRememberCompletion('series:101:1:1',false);
  const records=api.data.local.kinoStatsLibraryV1;
  assert.equal(records['film:101'].completed,true);
  assert.equal(records['series:101:1:1'].completed,true);
  assert.equal(Object.keys(records).length,2);
});


test('a series served on /film/ does not inflate film counts or lose its time', () => {
  const data = core.summarize({
    films:{'film:404900':film(404900,false)},
    episodes:{'series:404900:1:4':ep(404900,1,4,true)},
    watchTime:{'film:404900':{seconds:30},'series:404900':{seconds:120}},
    genres:{'film:404900':{genres:['драма']}}
  });
  assert.equal(data.finishedFilms,0);
  assert.equal(data.unfinishedFilms,0);
  assert.equal(data.startedSeries,1);
  assert.equal(data.finishedEpisodes,1);
  assert.equal(data.seriesSeconds,150);
  assert.equal(data.filmSeconds,0);
  assert.equal(data.taggedTitles,1);
});
