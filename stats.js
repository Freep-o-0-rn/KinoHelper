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
    'kinoStatsProfileId', 'kinoStatsProfileImportV1'];
  const palette = { film: '#f36a35', series: '#8a6aea', other: '#a9b0bb' };
  const els = id => document.getElementById(id);
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
    const source = importState?.pages ? ' (в том числе из выбранного профиля)' : '';
    els('statsRatingsNote').textContent = model.ratingsCount
      ? model.ratingsCount + ' учтённых личных оценок' + source + '. ' +
        'Полнота архива зависит от числа успешно загруженных страниц.'
      : 'Оценок пока нет. Открой фильм или импортируй оценки из профиля.';

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
      importState = profileId
        ? safeObject(values.kinoStatsProfileImportV1)[profileId] || null : null;
      lastData = core.summarize({
        films:values.kinoPlaybackProgressV1,
        episodes:values.kinoSeriesEpisodeProgressV1,
        library:values.kinoStatsLibraryV1,
        watchTime:values.kinoStatsWatchTimeV1,
        genres:values.kinoStatsGenresV1,
        ratings,profileId
      });
      render(lastData);
      if (!importing) els('statsImportStatus').textContent =
        importState?.pages
          ? 'Из профиля загружено страниц: ' + importState.pages +
            ' · уникальных оценок: ' + (importState.votes || 0) +
            (importState.lastPage ? ' · доступный пагинатор: ' + importState.lastPage : '')
          : '';

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
    // A confirmed movie vote alone does not identify the current user.
    // Verify the *own* profile before associating the rating with an account.
    const detected = await window.KinoStatsAccount?.detect();
    const scope = detected?.status === 'logged-in' ? detected.id : '__local__';
    const stored = await chrome.storage.local.get('kinoStatsRatingsV1');
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
    if (authState !== 'logged-in' || !verifiedAccountId) {
      els('statsStatus').textContent = 'Сначала необходимо подтвердить вход на Кинопоиск.';
      return;
    }
    const verifiedId = verifiedAccountId;
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
      const account = verifiedId;
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
        if (authState !== 'logged-in' || verifiedAccountId !== verifiedId) {
          interrupted = 'Аккаунт изменился во время синхронизации.';
          break;
        }
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


  let importing = false;
  async function importProfileVotes({ automatic = false } = {}) {
    if (importing) return;
    const parser = window.KinoProfileVotes;
    if (!parser) return;
    const display = els('statsImportStatus');
    const button = els('statsProfileImport');
    const id = authState === 'logged-in' ? verifiedAccountId : '';
    if (!id) {
      display.textContent = 'Сначала нужно подтвердить вход на Кинопоиск.';
      return;
    }
    // Limit automatic refreshes. Manual "continue" always works immediately.
    if (automatic) {
      const field = 'kinoStatsAutoImportAtV1';
      const dates = safeObject((await chrome.storage.local.get(field))[field]);
      if (Date.now() - Number(dates[id] || 0) < 60 * 60 * 1000) return;
      await chrome.storage.local.set({ [field]: {
        ...dates, [id]: Date.now()
      } });
    }
    importing = true;
    button.disabled = true;
    button.textContent = 'Загружаем оценки…';
    const KEY = 'kinoStatsProfileImportV1';
    let pagesDone = 0, votesFound = 0, failure = '';
    try {
      const existing = await chrome.storage.local.get(KEY);
      const states = safeObject(existing[KEY]);
      const current = safeObject(states[id]);
      // A fresh button press after reaching the listed final page refreshes
      // from page 1; normal interrupted batches resume from the next page.
      let page = current.lastPage && current.nextPage > current.lastPage
        ? 1 : (Number.isInteger(current.nextPage) &&
          current.nextPage >= 1 && current.nextPage <= 500 ? current.nextPage : 1);
      let totalPages = Number.isInteger(current.lastPage) ? current.lastPage : null;
      for (let attempt=0; attempt<5 && page<=500; attempt++,page++) {
        if (authState !== 'logged-in' || verifiedAccountId !== id)
          throw Error('Аккаунт изменился. Импорт остановлен.');
        display.textContent = 'Загрузка страницы ' + page +
          (totalPages ? ' из ' + totalPages : '') + '…';
        const url = 'https://www.kinopoisk.ru/user/' + id +
          '/movies/voted-watched/?page=' + page;
        const reply = await fetch(url, {
          method:'GET', credentials:'include', cache:'no-store',
          signal:AbortSignal.timeout(18000)
        });
        if(!reply.ok) throw Error('HTTP ' + reply.status);
        const actual = new URL(reply.url);
        if(!['www.kinopoisk.ru','kinopoisk.ru'].includes(actual.hostname) ||
            !actual.pathname.startsWith('/user/' + id + '/movies/voted-watched'))
          throw Error('Кинопоиск перенаправил на другую страницу');
        const html = await reply.text();
        const parsed = parser.parsePage(html,page);
        if (!parsed.votes.length && !parsed.recognized) {
          throw Error('Не удалось распознать записи профиля на странице ' +
            page + '. Возможно, Кинопоиск изменил формат или ограничил доступ');
        }
        if (Number.isInteger(parsed.lastPage))
          totalPages = Math.max(totalPages || 0,parsed.lastPage);

        const snapshot = await chrome.storage.local.get(['kinoStatsRatingsV1',KEY]);
        const all = {...safeObject(snapshot.kinoStatsRatingsV1)};
        const scope = {...safeObject(all[id])};
        const importedAt = Date.now();
        for(const item of parsed.votes) {
          const mediaKey = item.type + ':' + item.id;
          if(!/^(?:film|series):[1-9]\d{0,12}$/.test(mediaKey))continue;
          scope[mediaKey] = {rating:item.rating,updatedAt:importedAt,
            source:'kinopoisk-profile'};
        }
        all[id] = scope;
        const allStates = {...safeObject(snapshot[KEY])};
        const prev = safeObject(allStates[id]);
        const visitedPages = [...new Set([
          ...(Array.isArray(prev.visitedPages) ? prev.visitedPages : []),page
        ])].filter(n=>Number.isInteger(n)&&n>=1&&n<=500).sort((a,b)=>a-b);
        allStates[id] = {
          pages: visitedPages.length,
          visitedPages,
          nextPage:page+1,
          lastPage:totalPages,
          votes:Object.values(scope).filter(v=>v?.source==='kinopoisk-profile' &&
            Number.isInteger(v.rating) && v.rating>=1 && v.rating<=10).length,
          updatedAt:importedAt
        };
        // Individual pages are committed independently. A later block or
        // tab close cannot erase earlier successfully verified ratings.
        await chrome.storage.local.set({
          kinoStatsRatingsV1: all,
          [KEY]: allStates
        });
        pagesDone++;
        votesFound+=parsed.votes.length;
        display.textContent = 'Проверено страниц: ' + pagesDone +
          ' · найдено оценок на страницах: ' + votesFound;
        if (totalPages && page>=totalPages) break;
      }
    } catch(error) {
      failure = String(error?.message||error);
    } finally {
      importing = false;
      button.disabled = false;
      button.textContent = '↓ Продолжить импорт оценок';
      const suffix = failure ? ' Остановлено: ' + failure :
        ' Данные сохранены. При необходимости повтори импорт.';
      const message = (pagesDone
        ? 'За этот запуск: ' + pagesDone + ' стр., ' + votesFound +
          ' оценок на страницах.' : 'Новые оценки не импортированы.') + suffix;
      await reload();
      display.textContent = message;
    }
  }

  // Resolving /mykp/ never requires the user to enter a profile URL.
  async function checkAccount(force = false) {
    const now = Date.now();
    if (!force && now - lastAccountCheck < 45000) return;
    lastAccountCheck = now;
    const seq = ++authReadSequence;
    authState = 'checking';
    verifiedAccountId = '';
    const status = els('statsAccountStatus');
    const refresh = els('statsAccountRefresh');
    status.textContent = 'Проверяем авторизацию на Кинопоиске…';
    refresh.disabled = true;
    await reload();
    try {
      const response = await window.KinoStatsAccount.detect();
      if (seq !== authReadSequence) return;
      if (response.status === 'logged-in') {
        verifiedAccountId = response.id;
        authState = 'logged-in';
        status.textContent = '✓ Вход выполнен · профиль №' + response.id;
        // Compatibility with existing saved per-profile ratings and imports.
        // Do not copy unscope'd votes or any data from an unrelated account.
        await chrome.storage.local.set({kinoStatsProfileId:response.id});
        await reload();
        if (currentlyOpen) void importProfileVotes({automatic:true});
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
      void checkAccount(true);
    }
  }

  button.addEventListener('click',()=>toggle(!currentlyOpen));
  back.addEventListener('click',()=>toggle(false));
  els('statsAccountRefresh').addEventListener('click',()=>void checkAccount(true));
  els('statsRatingsSync').addEventListener('click',()=>void syncKnownRatings());
  els('statsProfileImport').addEventListener('click',()=>void importProfileVotes());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !currentlyOpen) return;
    if (KEYS.some(key => changes[key])) void reload();
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
