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
    'kinoStatsProfileId', 'kinoStatsProfileImportV1', 'kinoStatsImportJobV2',
    'kinoStatsWatchedV1'];
  const palette = { film: '#f36a35', series: '#8a6aea', other: '#a9b0bb' };
  const els = id => document.getElementById(id);
  const versionNode = els('appVersion');
  if (versionNode) {
    const version = chrome.runtime.getManifest?.().version;
    versionNode.textContent = version ? 'v' + version : '';
  }
  let currentlyOpen = false;
  let lastData = null;
  let loadingId = 0;
  let importState = null;
  let verifiedAccountId = '';
  let authState = 'checking';
  let authReadSequence = 0;
  let lastAccountCheck = 0;

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

  function createSvgChart(host, entries, label, {
    big = false, center = '', sub = '', separateSegments = false
  } = {}) {
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
    const visibleSegments = entries.filter(item =>
      Number.isFinite(item.value) && item.value > 0).length;
    let offset = 0;
    const segments = [];
    const resetSelection = () => {
      strong.textContent = center || '—';
      small.textContent = sub;
      wrap.classList.remove('stats-tip-visible');
      for (const piece of segments) {
        piece.setAttribute('stroke-width','13');
        piece.setAttribute('opacity','1');
      }
    };
    const selectRow = row => {
      if (!row) return resetSelection();
      const index = entries.indexOf(row);
      if (index < 0) return;
      strong.textContent = row.valueLabel || '—';
      small.textContent = row.name;
      tooltip.textContent = row.tooltipLabel || (row.name + ': ' + row.valueLabel);
      wrap.classList.add('stats-tip-visible');
      segments.forEach((piece,i) => {
        piece.setAttribute('stroke-width',i === index?'16':'13');
        piece.setAttribute('opacity',i === index?'1':'0.4');
      });
    };
    const makeCircle = (color, portion, start, description, interactive, gapPx = 0) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
      circle.setAttribute('cx','50'); circle.setAttribute('cy','50');
      circle.setAttribute('r','39'); circle.setAttribute('fill','none');
      circle.setAttribute('stroke',color);
      circle.setAttribute('stroke-width','13');
      circle.setAttribute('transform','rotate(-90 50 50)');
      // Small unpainted gaps reveal the background and visually distinguish
      // neighboring ratings; proportions and tooltip values remain unchanged.
      const arcLength = Math.max(0, portion * circumference - gapPx);
      circle.setAttribute('stroke-dasharray',
        arcLength + ' ' + circumference);
      circle.setAttribute('stroke-dashoffset',
        String(-(start * circumference + gapPx / 2)));
      if (interactive) {
        segments.push(circle);
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
        // The gap is capped for tiny categories, preserving narrow slices.
        const gapPx = separateSegments && visibleSegments > 1
          ? Math.min(1.9, portion * circumference * 0.24) : 0;
        makeCircle(row.color, portion, offset,
          row.tooltipLabel || (row.name + ': ' + row.valueLabel + ' (' + pct + '%)'),
          true, gapPx);
        offset += portion;
      }
    }
    wrap.append(svg,centerNode,tooltip);
    host.appendChild(wrap);
    return { select: selectRow, reset: resetSelection };
  }

  function makeLegend(container, data, { showZeros = false,
    onSelect = null, onClear = null } = {}) {
    const previousScroll = container.scrollTop;
    container.replaceChildren();
    for (const row of data) {
      if (!row.value && !showZeros) continue;
      const line = document.createElement('div');
      line.className = 'stats-legend-row';
      if (typeof onSelect === 'function') {
        line.classList.add('stats-genre-selectable');
        line.setAttribute('role','button');
        line.setAttribute('tabindex','0');
        line.setAttribute('aria-label',row.tooltipLabel ||
          row.name+': '+row.valueLabel);
        line.addEventListener('mouseenter',()=>onSelect(row));
        line.addEventListener('focus',()=>onSelect(row));
        line.addEventListener('click',()=>onSelect(row));
        line.addEventListener('mouseleave',()=>onClear?.());
        line.addEventListener('blur',()=>onClear?.());
        line.addEventListener('keydown',event=>{
          if(event.key==='Enter'||event.key===' '){
            event.preventDefault();
            onSelect(row);
          }
        });
      }
      const dot = document.createElement('span');
      dot.className = 'stats-legend-dot';
      dot.style.background = row.color;
      const text = document.createElement('span');
      text.textContent = row.name;
      text.title = row.tooltipLabel || row.name;
      const value = document.createElement('b');
      value.textContent = row.valueLabel;
      line.append(dot,text,value);
      container.appendChild(line);
    }
    // Avoid jumping back to the first genre during background sync updates.
    if (Number.isFinite(previousScroll)) container.scrollTop = previousScroll;
  }

  function genreRows(model) {
    const total = model.genreRows.reduce((n,r)=>n+r.count,0);
    return model.genreRows.map(row => {
      const percent = total ? row.count / total * 100 : 0;
      // Keep uncommon genres visible instead of rounding their share to 0%.
      const share = !total ? '—' : percent < 0.1 ? '<0,1%'
        : percent >= 10 ? Math.round(percent) + '%'
        : percent.toFixed(1).replace('.', ',') + '%';
      return {
        value:row.count, name:row.name, color:row.color,
        valueLabel:share,
        tooltipLabel:row.name + ': ' + row.count +
          ' произведений (' + share + ')'
      };
    });
  }
  function render(model) {
    const films = [
      {name:'Просмотрено', value:model.finishedFilms,
        valueLabel:count(model.finishedFilms),color:palette.film},
      {name:'В процессе', value:model.unfinishedFilms,
        valueLabel:count(model.unfinishedFilms),color:palette.other}
    ];
    const seriesEpisodes = [
      {name:'Просмотрено (Кинопоиск)', value:model.completedSeries,
        valueLabel:count(model.completedSeries),color:palette.series},
      {name:'В просмотре',value:Math.max(0,
        model.startedSeries-model.completedSeries),
        valueLabel:count(model.startedSeries-model.completedSeries),
        color:palette.other}
    ];
    createSvgChart(els('statsFilmChart'), films, 'Статистика фильмов',
      {center:count(model.finishedFilms),sub:'из '+
        count(model.finishedFilms+model.unfinishedFilms)});
    makeLegend(els('statsFilmLegend'),films);
    els('statsFilmLegend').title='Источник отметок: Кинопоиск — '+
      model.kpFilmCount+', KinoHelper — '+model.localFilmCount+
      '. Пересечений: '+model.filmOverlap+'.';

    // Series watched status comes from Kinopoisk; KinoHelper contributes
    // started series and tracked episodes, but cannot infer series completion.
    createSvgChart(els('statsSeriesChart'), seriesEpisodes,
      'Прогресс серий', {center:count(model.startedSeries),sub:'сериалов'});
    makeLegend(els('statsSeriesLegend'),seriesEpisodes);
    els('statsSeriesLegend').title='Кинопоиск: '+model.kpSeriesCount+
      ' просмотрено. KinoHelper: '+model.localSeriesCount+' начато.';
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
      ? 'Время воспроизведения с момента включения статистики.'
      : 'Время появится после начала просмотра.';

    const genres = genreRows(model);
    const genreChart = createSvgChart(els('statsGenresChart'), genres,'Любимые жанры',
      {big:true,center:genres[0]?.valueLabel || '—',
        sub:genres[0]?.name || 'Нет данных',separateSegments:true});
    makeLegend(els('statsGenresLegend'),genres,{
      onSelect: genreChart.select,
      onClear: genreChart.reset
    });
    const n=genres.length;
    const word=n%100>=11&&n%100<=14 ? 'жанров'
      : n%10===1 ? 'жанр' : [2,3,4].includes(n%10) ? 'жанра' : 'жанров';
    els('statsGenresNote').textContent = model.taggedTitles
      ? 'Жанры ' + model.taggedTitles + ' произведений · ' +
        n + ' ' + word + '. Проценты — доля от всех жанровых отметок.'
      : 'Жанры появятся после загрузки фильмов.';

    const ratings = model.buckets.map(x=>({
      name:x.name,value:x.count,color:x.color,
      valueLabel:count(x.count)
    }));
    createSvgChart(els('statsRatingsChart'),ratings,'Мои оценки',
      {big:true,center:model.meanRating === null ? '—' :
        model.meanRating.toFixed(1),sub:'средняя',separateSegments:true});
    makeLegend(els('statsRatingsLegend'),ratings,{showZeros:true});
    els('statsRatingsNote').textContent = model.ratingsCount
      ? 'Всего оценок: ' + model.ratingsCount
      : 'Оценки появятся после синхронизации.';

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
      // Never display a previously saved account as the *current* login.
      const profileId = authState === 'logged-in' ? verifiedAccountId : '';
      const scopes = safeObject(values.kinoStatsRatingsV1);
      const ratings = safeObject(scopes[profileId || '__local__']);
      const watched=safeObject(
        safeObject(values.kinoStatsWatchedV1)[profileId || '__local__']);
      importState = profileId
        ? safeObject(values.kinoStatsProfileImportV1)[profileId] || null : null;
      lastData = core.summarize({
        films:values.kinoPlaybackProgressV1,
        episodes:values.kinoSeriesEpisodeProgressV1,
        library:values.kinoStatsLibraryV1,
        watchTime:values.kinoStatsWatchTimeV1,
        genres:values.kinoStatsGenresV1,
        ratings,watched,profileId
      });
      render(lastData);
      updateImportProgress(values.kinoStatsImportJobV2);

    } catch (error) {
      els('statsStatus').textContent = 'Не удалось прочитать данные статистики: '+
        error.message;
    }
  }

  async function recordConfirmedRating({type,id,rating,expectedAccountId=''}) {
    const n = Number(rating);
    const media = type + ':' + String(id);
    if (!/^(?:film|series):[1-9]\d{0,12}$/.test(media) ||
        !Number.isInteger(n) || n < 1 || n > 10) return;
    // A confirmed movie vote alone does not identify the current user.
    // Verify the *own* profile before associating the rating with an account.
    // A rating write must be attributed to a freshly verified account.
    const detected = await window.KinoStatsAccount?.detect(
      undefined,{force:true});
    // Do not write a vote to another profile if the user switched accounts
    // while an explicit batch sync was running.
    if (expectedAccountId && (detected?.status !== 'logged-in' ||
        detected.id !== expectedAccountId)) return;
    const scope = detected?.status === 'logged-in' ? detected.id : '__local__';
    const stored = await chrome.storage.local.get('kinoStatsRatingsV1');
    const all = {...safeObject(stored.kinoStatsRatingsV1)};
    const previous = safeObject(safeObject(all[scope])[media]);
    // A newly confirmed rating must not erase genres imported earlier.
    all[scope] = {...safeObject(all[scope]),
      [media]: {...previous,rating:n,updatedAt:Date.now()}};
    await chrome.storage.local.set({kinoStatsRatingsV1:all});
  }


  function updateImportProgress(job) {
    const indicator=els('statsImportProgress');
    const title=els('statsImportCount');
    const label=els('statsImportStatus');
    if (!job || job.profileId !== verifiedAccountId) {
      indicator.value=0;
      indicator.max=100;
      title.textContent='—';
      label.textContent='Ожидаем подтверждения входа на Кинопоиск.';
      return;
    }
    const total=Number(job.totalPages);
    const done=Math.max(0,Number(job.pagesDone)||0);
    const known=Number.isSafeInteger(total)&&total>=1;
    title.textContent=known ? Math.min(done,total)+' / '+total+' стр.'
      : done+' стр. · всего неизвестно';
    indicator.max=known ? total : 100;
    if (known) indicator.value=Math.min(done,total);
    else indicator.removeAttribute('value'); // native indeterminate progress
    const knownVotes=Number(job.importedVotes)||0;
    const phase=job.state==='completed'?'Импорт завершён. Проверяем изменения в фоне примерно раз в минуту.'
      : job.state==='paused'?'Кинопоиск ограничил доступ. Попробуем позже.'
      : job.state==='retry'?'Ошибка соединения. Повторим позже.'
      : 'Загружаем оценки и просмотры в фоне. Панель можно закрыть.';
    const knownWatched=Number(job.importedWatched)||0;
    label.textContent=phase+' Оценок: '+knownVotes+
      ', отметок «Просмотрено»: '+knownWatched+'.';
  }

  // Resolving /mykp/ never requires the user to enter a profile URL.
  async function checkAccount(force = false) {
    const now = Date.now();
    if (!force && now - lastAccountCheck < 45000) return;
    lastAccountCheck = now;
    const seq = ++authReadSequence;
    const previousProfileId=verifiedAccountId;
    // Retain already rendered statistics while a background cache lookup
    // runs; opening this screen must not blank the verified profile.
    const preserveCurrent=!force&&authState==='logged-in'&&
      Boolean(previousProfileId);
    const status = els('statsAccountStatus');
    const refresh = els('statsAccountRefresh');
    if(!preserveCurrent){
      authState='checking';
      verifiedAccountId='';
      status.textContent='Проверяем авторизацию на Кинопоиске…';
      await reload();
    }
    refresh.disabled = true;
    try {
      const response = await window.KinoStatsAccount.detect(
        undefined,{force});
      if (seq !== authReadSequence) return;
      if (response.status === 'logged-in') {
        verifiedAccountId = response.id;
        authState = 'logged-in';
        status.textContent = '✓ Вход выполнен · профиль №' + response.id;
        // Compatibility with existing saved per-profile ratings and imports.
        // Do not copy unscope'd votes or any data from an unrelated account.
        if(previousProfileId!==response.id)
          await chrome.storage.local.set({kinoStatsProfileId:response.id});
        await reload();
        // The background worker owns all page requests and resumes using
        // chrome.alarms even after this window has been closed.
        if (currentlyOpen) {
          const reply = await chrome.runtime.sendMessage({
            action:'statsImportEnsure',profileId:response.id
          }).catch(error=>({ok:false,error:error.message}));
          if(!reply?.ok) els('statsImportStatus').textContent =
            'Не удалось запустить фоновый импорт: ' +
            (reply?.error||'неизвестная ошибка');
          else await reload();
        }
      } else if (response.status === 'logged-out') {
        verifiedAccountId = '';
        authState = 'logged-out';
        status.textContent = 'Вход не найден. Открой Кинопоиск и авторизуйся.';
        await chrome.storage.local.set({kinoStatsProfileId:''});
        await reload();
      } else {
        authState = 'unavailable';
        verifiedAccountId = '';
        status.textContent = 'Профиль не удалось подтвердить: ' +
          (response.reason || 'проверь доступ к Кинопоиску');
        // No automatic sync from old cached ID when verification fails.
        await reload();
      }
    }catch(error){
      if (seq !== authReadSequence) return;
      authState = 'unavailable';
      verifiedAccountId = '';
      status.textContent = 'Проверка входа не удалась: ' +
        String(error?.message||error).slice(0,140);
      await reload();
    }finally{
      if (seq === authReadSequence) refresh.disabled=false;
    }
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
      void checkAccount(false);
    }
  }

  button.addEventListener('click',()=>toggle(!currentlyOpen));
  back.addEventListener('click',()=>toggle(false));
  els('statsAccountRefresh').addEventListener('click',()=>void checkAccount(true));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !currentlyOpen) return;
    // The import cursor changes more often than the actual statistics.
    // Updating the progress label must not rebuild every donut and legend.
    const dataChanged=KEYS.some(key=>
      key!=='kinoStatsImportJobV2' && changes[key]);
    if(dataChanged)void reload();
    else if(changes.kinoStatsImportJobV2)
      updateImportProgress(changes.kinoStatsImportJobV2.newValue);
  });
  window.addEventListener('focus',()=>{
    if (currentlyOpen) void checkAccount(false);
  });
  window.KinoStats = {
    open:()=>toggle(true),
    close:()=>toggle(false),
    isOpen:()=>currentlyOpen,
    recordConfirmedRating
  };
})();
