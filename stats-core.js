// Pure KinoHelper statistics calculations. Unknown values are not estimated.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinoStatsCore = api;
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';
  const identity = item => {
    const match = String(item || '').match(/^(film|series):([1-9]\d{0,12})$/);
    return match ? match[1] + ':' + match[2] : null;
  };
  const valid = value => value && typeof value === 'object' && !Array.isArray(value);
  const num = value => Number.isFinite(value) && value >= 0 ? value : 0;
  function summarize({ films = {}, episodes = {}, library = {}, watchTime = {}, genres = {},
    ratings = {}, profileId = '' } = {}) {
    const filmMap = new Map(), seriesMap = new Map();
    let finishedFilms = 0, unfinishedFilms = 0, finishedEpisodes = 0;
    for (const [key, entry] of Object.entries(valid(films) ? films : {})) {
      if (identity(key) !== key || !key.startsWith('film:') ||
          !entry || entry.type !== 'film' || String(entry.id) !== key.slice(5) ||
          !Number.isFinite(entry.duration) || entry.duration < 60 ||
          !Number.isFinite(entry.position) || entry.position < 0) continue;
      filmMap.set(key, entry);
      if (entry.completed) finishedFilms++; else unfinishedFilms++;
    }
    const seenEpisodes = new Set();
    const completedEpisodeKeys = new Set();
    for (const [key, entry] of Object.entries(valid(episodes) ? episodes : {})) {
      if (!/^series:[1-9]\d{0,12}:\d{1,3}:\d{1,3}$/.test(key) ||
          !entry || entry.type !== 'series' ||
          key !== 'series:' + entry.id + ':' + entry.season + ':' + entry.episode ||
          !Number.isFinite(entry.duration) || entry.duration < 60 ||
          !Number.isFinite(entry.position) || entry.position < 0) continue;
      seriesMap.set('series:' + entry.id, true);
      seenEpisodes.add(key);
      if (entry.completed) completedEpisodeKeys.add(key);
    }
    // Merge permanent verified catalog with bounded legacy checkpoints.
    for (const [key, record] of Object.entries(valid(library) ? library : {})) {
      if (!record || typeof record !== 'object') continue;
      if (/^film:[1-9]\d{0,12}$/.test(key)) {
        const earlier = filmMap.get(key);
        if (!earlier) filmMap.set(key, {
          type:'film', id:key.slice(5), completed:Boolean(record.completed)
        });
        else if (record.completed) filmMap.set(key, { ...earlier, completed: true });
      } else {
        const match = /^series:([1-9]\d{0,12}):(\d{1,3}):(\d{1,3})$/.exec(key);
        if (!match || Number(match[2]) < 1 || Number(match[3]) < 1) continue;
        seriesMap.set('series:' + match[1], true);
        seenEpisodes.add(key);
        if (record.completed) completedEpisodeKeys.add(key);
      }
    }
    // A provider may expose a verified series under /film/<id>. If both
    // identities exist for the same Kinopoisk ID, series evidence wins.
    for (const seriesKey of seriesMap.keys()) {
      filmMap.delete('film:' + seriesKey.slice(7));
    }
    finishedFilms = [...filmMap.values()].filter(e=>e.completed).length;
    unfinishedFilms = filmMap.size - finishedFilms;
    finishedEpisodes = completedEpisodeKeys.size;
    let filmSeconds = 0, seriesSeconds = 0;
    for (const [key, entry] of Object.entries(valid(watchTime) ? watchTime : {})) {
      if (!identity(key)) continue;
      const seconds = Math.min(num(entry?.seconds), 1e10);
      if (key.startsWith('series:') ||
          (key.startsWith('film:') && seriesMap.has('series:' + key.slice(5))))
        seriesSeconds += seconds;
      else filmSeconds += seconds;
    }
    const rated = Object.values(valid(ratings) ? ratings : {})
      .map(item => Number(item?.rating))
      .filter(x => Number.isInteger(x) && x >= 1 && x <= 10);
    // Ten deliberately contrasting categorical accents. Neighboring grades
    // alternate warm / cool hues instead of merging into a soft gradient.
    // Grade 1 remains red, grade 10 green; color never replaces the grade label.
    const ratingColors = [
      '#D83A52', // 1 — red
      '#4B5ED7', // 2 — royal indigo
      '#E88622', // 3 — orange
      '#9952C8', // 4 — violet
      '#D2A62F', // 5 — gold
      '#069FB5', // 6 — cyan
      '#C84391', // 7 — magenta
      '#6C9E3D', // 8 — green
      '#3176D6', // 9 — blue
      '#078F70'  // 10 — emerald
    ];
    const ratingCounts = Array(10).fill(0);
    for (const rating of rated) ratingCounts[rating - 1]++;
    const buckets = ratingCounts.map((count, index) => ({
      name: String(index + 1), count, color: ratingColors[index]
    }));
    const genreCounts = new Map();
    let taggedTitles = 0;
    const eligible = new Set([...filmMap.keys(), ...seriesMap.keys()]);
    const genreTitles = new Set();
    for (const [key, entry] of Object.entries(valid(genres) ? genres : {})) {
      // Some providers present series on /film/<id>; reuse the same
      // Kinopoisk ID's genre metadata without counting a title twice.
      const alias = /^film:([1-9]\d{0,12})$/.exec(key);
      const watched = eligible.has(key) ||
        Boolean(alias && eligible.has('series:' + alias[1]));
      if (!watched || !Array.isArray(entry?.genres) || !entry.genres.length) continue;
      const identityKey = eligible.has(key) ? key : 'series:' + alias[1];
      if (genreTitles.has(identityKey)) continue;
      const names = [...new Set(entry.genres.map(g =>
        String(g).trim().toLocaleLowerCase('ru')).filter(g =>
          g.length >= 3 && g.length <= 32))];
      if (names.length) {
        genreTitles.add(identityKey);
        taggedTitles++;
      }
      for (const name of names) genreCounts.set(name, (genreCounts.get(name) || 0) + 1);
    }
    const palette = ['#f36a35','#8a6aea','#28a8a0','#edb348','#da6ba2'];
    const genreRows = [...genreCounts.entries()]
      .sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0], 'ru'))
      .map(([name,count],i) => ({name,count,color:palette[i % palette.length]}));
    if (genreRows.length > 5) {
      const others = genreRows.slice(4).reduce((n,g)=>n+g.count,0);
      genreRows.splice(4,Infinity,{name:'Другие',count:others,color:'#a0a7b4'});
    }
    return {
      finishedFilms, unfinishedFilms,
      startedSeries: seriesMap.size, finishedEpisodes,
      startedEpisodes: seenEpisodes.size,
      // Without verified full episode totals, "fully watched series" is unknown.
      completedSeries: null,
      filmSeconds, seriesSeconds,
      totalSeconds: filmSeconds + seriesSeconds,
      ratingsCount: rated.length,
      meanRating: rated.length ? rated.reduce((a,b)=>a+b,0)/rated.length : null,
      buckets, genreRows, taggedTitles,
      profileId: /^\d{1,13}$/.test(String(profileId)) ? String(profileId) : ''
    };
  }
  function validateProfile(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(?:https:\/\/(?:www\.)?kinopoisk\.ru\/user\/)?([1-9]\d{0,12})(?:\/(?:movies\/voted-watched\/?)?)?(?:\?.*)?$/i);
    return match ? match[1] : '';
  }
  return { summarize, validateProfile };
});
