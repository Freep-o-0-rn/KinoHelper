// KinoHelper 1.558 — compact statistics dashboard, used by popup and side panel.
(() => {
  'use strict';
  const core = window.KinoStatsCore;
  const view = document.getElementById('statisticsScreen');
  const button = document.getElementById('statsButton');
  const back = document.getElementById('statsBack');
  if (!core || !view || !button || !back) return;

  const KEYS = ['kinoPlaybackProgressV1', 'kinoSeriesEpisodeProgressV1',
    'kinoStatsLibraryV1', 'kinoStatsWatchTimeV1', 'kinoStatsGenresV1', 'kinoStatsRatingsV1',
    'kinoStatsProfileId'];
  const palette = { film: '#f36a35', series: '#8a6aea', other: '#a9b0bb' };
  const els = id => document.getElementById(id);
  let currentlyOpen = false;
  let lastData = null;
  let loadingId = 0;

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function displayTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const minutes = Math.floor(seconds / 60);
    if (!minutes) return '<1 мин';
    const hours = Math.floor(minutes / 60);
    return hours ? hours + ' ч ' + (minutes % 60 ? minutes % 60 + ' мин' : '') :
      minutes + ' мин';
  }
  const count = value => Number.isFinite(value) ? String(value) : '—';

  function createSvgChart(host, entries, label, { big = false, center = '', sub = '' } = {}) {
    host.replaceChildren();
    host.setAttribute('aria-label', label);
    const wrap = document.createElement('div');
    wrap.className = 'stats-donut' + (big ? ' stats-donut-large' : '');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox','0 0 100 100');
    svg.setAttribute('role','img');
    svg.setAttribute('aria-label',label);
    const centerNode = document.createElement('div');
    centerNode.className = 'stats-donut-center';
    const strong = document.createElement('strong');
    strong.textContent = center || '—';
    const small = document.createElement('small');
    small.textContent = sub;
    centerNode.append(strong,small);
    const tooltip = document.createElement('div');
    tooltip.className = 'stats-chart-tip';
    tooltip.setAttribute('role', 'status');
    const total = entries.reduce((sum, item) => sum + item.value, 0);
    const circumference = 2 * Math.PI * 39;
    let offset = 0;
    const makeCircle = (color, portion, start, description, interactive) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
      circle.setAttribute('cx','50'); circle.setAttribute('cy','50');
      circle.setAttribute('r','39'); circle.setAttribute('fill','none');
      circle.setAttribute('stroke',color);
      circle.setAttribute('stroke-width','13');
      circle.setAttribute('transform','rotate(-90 50 50)');
      circle.setAttribute('stroke-dasharray',
        (portion * circumference) + ' ' + circumference);
      circle.setAttribute('stroke-dashoffset', String(-start * circumference));
      if (interactive) {
        circle.setAttribute('class','stats-donut-piece');
        circle.setAttribute('tabindex','0');
        circle.setAttribute('aria-label',description);
        const title = document.createElementNS('http://www.w3.org/2000/svg','title');
        title.textContent = description;
        circle.appendChild(title);
        const show = () => {
          tooltip.textContent = description;
          wrap.classList.add('stats-tip-visible');
        };
        circle.addEventListener('mouseenter',show);
        circle.addEventListener('focus',show);
        circle.addEventListener('click',show);
        circle.addEventListener('mouseleave',()=>wrap.classList.remove('stats-tip-visible'));
        circle.addEventListener('blur',()=>wrap.classList.remove('stats-tip-visible'));
      }
      svg.appendChild(circle);
    };
    makeCircle('var(--bg-secondary)',1,0,'',false);
    if (total > 0) {
      for (const row of entries) {
        if (!row.value || !Number.isFinite(row.value)) continue;
        const portion = row.value / total;
        const pct = (portion * 100).toFixed(portion < .01 ? 1 : 0);
        makeCircle(row.color, portion, offset,
          row.name + ': ' + row.valueLabel + ' (' + pct + '%)',true);
        offset += portion;
      }
    }
    wrap.append(svg,centerNode,tooltip);
    host.appendChild(wrap);
  }

  function makeLegend(container, data) {
    container.replaceChildren();
    for (const row of data) {
      if (!row.value) continue;
      const line = document.createElement('div');
      line.className = 'stats-legend-row';
      const dot = document.createElement('span');
      dot.className = 'stats-legend-dot';
      dot.style.background = row.color;
      const text = document.createElement('span');
      text.textContent = row.name;
      text.title = row.name;
      const value = document.createElement('b');
      value.textContent = row.valueLabel;
      line.append(dot,text,value);
      container.appendChild(line);
    }
  }

  function genreRows(model) {
    const total = model.genreRows.reduce((n,r)=>n+r.count,0);
    return model.genreRows.map(row => ({
      value: row.count, name: row.name, color: row.color,
      valueLabel: total ? Math.round(row.count / total * 100) + '%' : '—'
    }));
  }
  function render(model) {
    const films = [
      {name:'Завершено', value:model.finishedFilms,
        valueLabel:count(model.finishedFilms),color:palette.film},
      {name:'В процессе', value:model.unfinishedFilms,
        valueLabel:count(model.unfinishedFilms),color:palette.other}
    ];
    const seriesEpisodes = [
      {name:'Серий завершено', value:model.finishedEpisodes,
        valueLabel:count(model.finishedEpisodes),color:palette.series},
      {name:'Не завершено серий',value:Math.max(0,
        model.startedEpisodes-model.finishedEpisodes),
        valueLabel:count(model.startedEpisodes-model.finishedEpisodes),
        color:palette.other}
    ];
    createSvgChart(els('statsFilmChart'), films, 'Статистика фильмов',
      {center:count(model.finishedFilms),sub:'из '+
        count(model.finishedFilms+model.unfinishedFilms)});
    makeLegend(els('statsFilmLegend'),films);

    // A series is counted as "started" if a verified episode exists.
    // We cannot assert full series completion without verified episode totals.
    createSvgChart(els('statsSeriesChart'), seriesEpisodes,
      'Прогресс серий', {center:count(model.startedSeries),sub:'сериалов'});
    makeLegend(els('statsSeriesLegend'),seriesEpisodes);
    els('statsEpisodesCount').textContent = count(model.finishedEpisodes);

    const times = [
      {name:'Фильмы',value:model.filmSeconds,color:palette.film,
        valueLabel:displayTime(model.filmSeconds)},
      {name:'Сериалы',value:model.seriesSeconds,color:palette.series,
        valueLabel:displayTime(model.seriesSeconds)}
    ];
    createSvgChart(els('statsTimeChart'), times, 'Реальное время просмотра',
      {big:true,center:displayTime(model.totalSeconds),sub:'всего'});
    makeLegend(els('statsTimeLegend'),times);
    els('statsTimeNote').textContent = model.totalSeconds > 0
      ? 'Учтено фактическое воспроизведение с версии 1.558; перемотки исключены.'
      : 'Учёт времени начнётся при следующем просмотре. Старые таймкоды не пересчитываются.';

    const genres = genreRows(model);
    createSvgChart(els('statsGenresChart'), genres,'Любимые жанры',
      {big:true,center:genres[0]?.valueLabel || '—',
        sub:genres[0]?.name || 'Нет данных'});
    makeLegend(els('statsGenresLegend'),genres);
    els('statsGenresNote').textContent = model.taggedTitles
      ? 'По ' + model.taggedTitles + ' произведениям с известными жанрами. Одно произведение может иметь несколько жанров.'
      : 'Жанры появятся по мере загрузки карточек просмотренных фильмов и сериалов.';

    const ratings = model.buckets.map(x=>({
      name:x.name,value:x.count,color:x.color,
      valueLabel:count(x.count)
    }));
    createSvgChart(els('statsRatingsChart'),ratings,'Мои оценки',
      {big:true,center:model.meanRating === null ? '—' :
        model.meanRating.toFixed(1),sub:'средняя'});
    makeLegend(els('statsRatingsLegend'),ratings);
    els('statsRatingsNote').textContent = model.ratingsCount
      ? model.ratingsCount + ' подтверждённых оценок, полученных в KinoHelper. Полный архив профиля пока не загружен.'
      : 'Подтверждённых оценок ещё нет. Полный архив профиля пока не загружен.';

    els('statsProfileLink').hidden = !model.profileId;
    if (model.profileId) {
      els('statsProfileLink').href =
        'https://www.kinopoisk.ru/user/' + model.profileId + '/movies/voted-watched/';
    }
  }

  async function reload() {
    const order = ++loadingId;
    try {
      const values = await chrome.storage.local.get(KEYS);
      if (order !== loadingId) return;
      const profileId = String(values.kinoStatsProfileId || '');
      const scopes = safeObject(values.kinoStatsRatingsV1);
      const ratings = safeObject(scopes[profileId || '__local__']);
      lastData = core.summarize({
        films:values.kinoPlaybackProgressV1,
        episodes:values.kinoSeriesEpisodeProgressV1,
        library:values.kinoStatsLibraryV1,
        watchTime:values.kinoStatsWatchTimeV1,
        genres:values.kinoStatsGenresV1,
        ratings,profileId
      });
      render(lastData);
      const input = els('statsProfileInput');
      if (document.activeElement !== input) input.value =
        profileId ? 'https://www.kinopoisk.ru/user/' + profileId + '/' : '';
    } catch (error) {
      els('statsStatus').textContent = 'Не удалось прочитать данные статистики: '+
        error.message;
    }
  }

  async function recordConfirmedRating({type,id,rating}) {
    const n = Number(rating);
    const media = type + ':' + String(id);
    if (!/^(?:film|series):[1-9]\d{0,12}$/.test(media) ||
        !Number.isInteger(n) || n < 1 || n > 10) return;
    const stored = await chrome.storage.local.get(['kinoStatsRatingsV1','kinoStatsProfileId']);
    const profileId = String(stored.kinoStatsProfileId || '');
    const scope = profileId || '__local__';
    const all = {...safeObject(stored.kinoStatsRatingsV1)};
    all[scope] = {...safeObject(all[scope]),
      [media]: {rating:n,updatedAt:Date.now()}};
    await chrome.storage.local.set({kinoStatsRatingsV1:all});
  }


  // Reuse the existing authorized MoviePreviewCard request. It checks a
  // known movie ID and returns the current Kinopoisk account's actual vote;
  // this is NOT scraping the user's whole public profile.
  let ratingsSyncActive = false;
  async function syncKnownRatings() {
    if (ratingsSyncActive) return;
    ratingsSyncActive = true;
    const button = els('statsRatingsSync');
    const status = els('statsStatus');
    button.disabled = true;
    button.textContent = 'Проверяем оценки…';
    try {
      const keys = ['kinoPlaybackProgressV1','kinoSeriesEpisodeProgressV1',
        'kinoStatsLibraryV1','kinoStatsProfileId','kinoStatsRatingScanV1'];
      const data = await chrome.storage.local.get(keys);
      const media = new Map();
      for (const [key,item] of Object.entries(safeObject(data.kinoPlaybackProgressV1))) {
        if (/^film:[1-9]\d{0,12}$/.test(key))
          media.set(key, Number(item?.updatedAt)||0);
      }
      for (const [key,item] of Object.entries(safeObject(data.kinoSeriesEpisodeProgressV1))) {
        const match = /^series:([1-9]\d{0,12}):\d{1,3}:\d{1,3}$/.exec(key);
        if (!match) continue;
        const id = 'series:' + match[1];
        media.set(id,Math.max(media.get(id)||0,Number(item?.updatedAt)||0));
      }
      for (const [key,item] of Object.entries(safeObject(data.kinoStatsLibraryV1))) {
        const film = /^film:[1-9]\d{0,12}$/.test(key) ? key : '';
        const series = /^series:([1-9]\d{0,12}):\d{1,3}:\d{1,3}$/.exec(key);
        const id = film || (series ? 'series:' + series[1] : '');
        if (id) media.set(id,Math.max(media.get(id)||0,Number(item?.updatedAt)||0));
      }
      const account = String(data.kinoStatsProfileId || '') || '__local__';
      const scans = {...safeObject(data.kinoStatsRatingScanV1)};
      const scanned = {...safeObject(scans[account])};
      const oneDay = 86400000;
      const entries = [...media.entries()].sort((a,b)=>b[1]-a[1])
        .filter(([key])=>!Number.isFinite(scanned[key]) ||
          Date.now()-scanned[key]>oneDay)
        .slice(0,12);
      if (!media.size) {
        status.textContent = 'Сначала посмотри фильм или серию через KinoHelper.';
        return;
      }
      if (!entries.length) {
        status.textContent = 'Все известные оценки недавно проверены. Можно повторить завтра.';
        return;
      }
      let verified = 0, withoutVote = 0, processed = 0;
      let interrupted = '';
      for (const [mediaKey] of entries) {
        const [type,id] = mediaKey.split(':');
        let response;
        try {
          response = await chrome.runtime.sendMessage({
            action:'getMovieRating',payload:{type,id}
          });
        } catch (error) {
          interrupted = 'Ошибка связи с Кинопоиском: ' + error.message;
          break;
        }
        if (!response?.ok) {
          interrupted = 'Не удалось загрузить оценки; повтори попытку позднее.';
          break;
        }
        if (!response.authorized) {
          interrupted = 'Для импорта оценок войди в свой аккаунт Кинопоиска.';
          break;
        }
        processed++;
        scanned[mediaKey] = Date.now();
        const rating = Number(response.rating);
        if (Number.isInteger(rating) && rating >= 1 && rating <= 10) {
          await recordConfirmedRating({type,id,rating});
          verified++;
        } else {
          withoutVote++;
        }
        status.textContent = 'Проверено: ' + processed + ' / ' + entries.length +
          ' · оценок найдено: ' + verified;
      }
      scans[account] = scanned;
      await chrome.storage.local.set({kinoStatsRatingScanV1:scans});
      status.textContent = (processed ? 'Проверено ' + processed +
        ' фильмов/сериалов; найдено оценок: ' + verified +
        (withoutVote ? ', без оценки: ' + withoutVote : '') + '. ' : '') +
        (interrupted || 'Для остальных произведений нажми кнопку ещё раз.');
      await reload();
    } catch (error) {
      status.textContent = 'Синхронизация не удалась: ' + error.message;
    } finally {
      ratingsSyncActive = false;
      button.disabled = false;
      button.textContent = '↻ Обновить оценки известных фильмов';
    }
  }

  async function setProfile() {
    const raw = els('statsProfileInput').value;
    if (!raw.trim()) {
      await chrome.storage.local.set({kinoStatsProfileId:''});
      els('statsStatus').textContent = 'Профиль отвязан. Локальная статистика просмотров сохранена.';
      await reload();
      return;
    }
    const id = core.validateProfile(raw);
    if (!id) {
      els('statsStatus').textContent =
        'Укажи ссылку вида https://www.kinopoisk.ru/user/12345/ или числовой ID.';
      return;
    }
    await chrome.storage.local.set({kinoStatsProfileId:id});
    els('statsStatus').textContent =
      'Профиль сохранён. Оценки учитываются отдельно для каждого указанного ID. Загрузка полного архива оценок пока не реализована.';
    await reload();
  }

  function toggle(show) {
    currentlyOpen = show;
    document.body.classList.toggle('stats-open',show);
    button.classList.toggle('active',show);
    button.setAttribute('aria-pressed',String(show));
    button.dataset.tooltip = show ? 'Вернуться на главную' : 'Статистика';
    button.setAttribute('aria-label',button.dataset.tooltip);
    if (show) {
      document.body.classList.remove('settings-open');
      const settings = els('settingsButton');
      if (settings) {
        settings.classList.remove('active');
        settings.dataset.tooltip='Открыть настройки';
        settings.setAttribute('aria-label','Открыть настройки');
        settings.setAttribute('aria-pressed','false');
      }
      void reload();
    }
  }

  button.addEventListener('click',()=>toggle(!currentlyOpen));
  back.addEventListener('click',()=>toggle(false));
  els('statsProfileSave').addEventListener('click',()=>void setProfile());
  els('statsRatingsSync').addEventListener('click',()=>void syncKnownRatings());
  els('statsProfileInput').addEventListener('keydown',e=>{
    if(e.key === 'Enter') void setProfile();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !currentlyOpen) return;
    if (KEYS.some(key => changes[key])) void reload();
  });
  window.addEventListener('focus',()=>{
    if (currentlyOpen) void reload();
  });
  window.KinoStats = {
    open:()=>toggle(true),
    close:()=>toggle(false),
    isOpen:()=>currentlyOpen,
    recordConfirmedRating
  };
})();
