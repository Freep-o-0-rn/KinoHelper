// Локальный список «Буду смотреть». Независим от истории и оценок.
(() => {
    'use strict';

    const STORAGE_KEY = 'kinoHelperWatchlistV1';
    const COLLAPSED_KEY = 'kinoHelperWatchlistCollapsed';
    const SORT_KEY = 'kinoHelperWatchlistSortV1';
    let sortOrder = localStorage.getItem(SORT_KEY)==='oldest'?'oldest':'newest';
    const MAX_ITEMS = 1000;
    const PROFILE_STORE = 'kinoWatchlistProfilesV1';
    const SYNC_JOB = 'kinoWatchlistImportJobV1';
    const AUTO_REMOVE = 'kinoWatchlistAutoRemoveV1';
    let activeProfileId = '';
    let profileItems = [];
    let authCheckId = 0;
    let lastAuthCheck = 0;
    const savingRemote = new Set();
    const KINOPOISK_ORIGIN = 'https://www.kinopoisk.ru';
    const WATCH_ORIGIN = 'https://www.kinokino.vip';
    const posterCache = new Map();
    const hydrationStarted = new Set();
    const pendingHydration = [];
    let hydrationActive = 0;
    let listObserver = null;
    const MAX_PARALLEL = 2;

    function validPoster(raw) {
        if (typeof raw !== 'string' || !raw.trim()) return '';
        try {
            const url = new URL(raw);
            if (url.protocol !== 'https:') return '';
            const host = url.hostname.toLowerCase();
            // Тот же белый список, который проверяет background.loadSearchPoster.
            return ['avatars.mds.yandex.net', 'st.kp.yandex.net'].includes(host)
                ? url.href : '';
        } catch {
            return '';
        }
    }

    function cleanGenres(value) {
        const input = Array.isArray(value) ? value :
            typeof value === 'string' ? value.split(',') : [];
        return [...new Set(input.map(entry =>
            String(typeof entry === 'string' ? entry : entry?.name || '')
                .replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru'))
            .filter(item => item.length >= 3 && item.length <= 32 &&
                /^[\p{L}][\p{L}\s-]*$/u.test(item)))].slice(0, 8);
    }

    function normalize(movie) {
        if (!movie || !['film', 'series'].includes(movie.type)) return null;
        const id = String(movie.id ?? '');
        if (!/^[1-9]\d{0,12}$/.test(id)) return null;
        const type = movie.type;
        const year = Number(movie.year);
        const posterUrl = validPoster(movie.posterUrl) ||
            validPoster(movie.poster) || validPoster(movie.posterFallback);

        return {
            id, type,
            title: String(movie.title || (type === 'series' ? 'Сериал №' : 'Фильм №') + id)
                .replace(/\s+/g, ' ').trim().slice(0, 200),
            year: Number.isInteger(year) && year >= 1888 && year <= 2200 ? year : null,
            posterUrl,
            genres: cleanGenres(movie.genres),
            // Older imported entries can have no verified date. Do not
            // manufacture a fresh timestamp on every re-render.
            addedAt: Number.isFinite(Number(movie.addedAt)) &&
                Number(movie.addedAt)>0?Number(movie.addedAt):0
        };
    }

    function keyOf(movie) {
        // Identity checks run for every search result, poster and list row.
        // Do not sanitize titles, genre arrays and poster URLs to get a key.
        if(!movie || !['film','series'].includes(movie.type))return null;
        const id=String(movie.id??'');
        return /^[1-9]\d{0,12}$/.test(id)?movie.type+':'+id:null;
    }

    // Keep sorted/normalized entries and membership together. Previously each
    // contains() parsed/sorted the entire list and scanned it (O(n²) over a
    // rendered list). The raw JSON fingerprint detects external local changes.
    let cachedItems=null;
    let cachedIndex=new Set();
    let cachedRaw=null;
    let cachedProfile='';
    let cachedProfileItems=null;
    let notificationQueued=false;

    function notifyChanged(defer=false){
        if(!defer){
            window.dispatchEvent(new Event('kino-watchlist-updated'));
            return;
        }
        if(notificationQueued)return;
        notificationQueued=true;
        Promise.resolve().then(()=>{
            notificationQueued=false;
            window.dispatchEvent(new Event('kino-watchlist-updated'));
        });
    }

    function getAll() {
        if(activeProfileId){
            if(cachedItems && cachedProfile===activeProfileId &&
               cachedProfileItems===profileItems)return cachedItems;
            const items=profileItems.map(normalize).filter(Boolean)
                .sort((a,b)=>b.addedAt-a.addedAt);
            cachedItems=items;
            cachedIndex=new Set(items.map(item=>item.type+':'+item.id));
            cachedProfile=activeProfileId;
            cachedProfileItems=profileItems;
            cachedRaw=null;
            return items;
        }
        const rawText=localStorage.getItem(STORAGE_KEY)||'[]';
        if(cachedItems && cachedProfile==='' && cachedRaw===rawText)
            return cachedItems;
        let raw;
        try {raw=JSON.parse(rawText);}catch {raw=[];}
        const unique=new Map();
        if(Array.isArray(raw)){
            for(const input of raw.slice(0,MAX_ITEMS)){
                const item=normalize(input);
                if(!item)continue;
                const key=item.type+':'+item.id;
                if(!unique.has(key))unique.set(key,item);
            }
        }
        const items=[...unique.values()].sort((a,b)=>b.addedAt-a.addedAt);
        cachedItems=items;
        cachedIndex=new Set(items.map(item=>item.type+':'+item.id));
        cachedRaw=rawText;
        cachedProfile='';
        cachedProfileItems=null;
        return items;
    }

    function contains(movie) {
        const key=keyOf(movie);
        if(!key)return false;
        getAll();
        return cachedIndex.has(key);
    }

    function save(items,deferNotification=false) {
        if (activeProfileId) {
            // Metadata updates may improve the visible list. Only verified
            // site writes or the background profile importer own persistence.
            profileItems = items;
            notifyChanged(deferNotification);
            return true;
        }
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        } catch (error) {
            console.warn('[KinoHelper] Не удалось сохранить «Буду смотреть»:', error);
            const status = document.getElementById('watchlistStatus');
            if (status) {
                status.textContent = 'Не удалось сохранить список. Проверьте место в хранилище.';
                status.hidden = false;
            }
            return false;
        }
        notifyChanged(deferNotification);
        return true;
    }

    // All profile-backed changes use the same server-confirmed operation.
    // Never interpret the X as a toggle: its intent is always removal.
    async function setRemote(movie,desired,expectedProfile=activeProfileId) {
        const next=normalize(movie);
        if(!next || typeof desired!=='boolean' ||
            !expectedProfile || expectedProfile!==activeProfileId)return false;
        const key=next.type+':'+next.id;
        if(savingRemote.has(key))return false;
        savingRemote.add(key);
        refresh();
        showStatus(desired
            ? 'Добавляем в «Буду смотреть» на Кинопоиске…'
            : 'Убираем из «Буду смотреть» на Кинопоиске…','info');
        try {
            const response=await chrome.runtime.sendMessage({
                action:'kinoWatchlistSet',
                payload:{movie:next,desired,profileId:expectedProfile}
            });
            if(!response?.ok || response.planned!==desired) {
                if(activeProfileId===expectedProfile)
                    showStatus(response?.error||
                        'Кинопоиск не подтвердил изменение. Список не изменён.','error');
                return false;
            }
            if(expectedProfile!==activeProfileId)return false;
            await loadProfileItems(expectedProfile);
            showStatus(desired?'Добавлено на Кинопоиске':
                'Удалено из «Буду смотреть» на Кинопоиске','success');
            return true;
        }catch(error){
            if(expectedProfile===activeProfileId)
                showStatus('Ошибка синхронизации: '+
                    String(error?.message||error),'error');
            return false;
        }finally{
            savingRemote.delete(key);
            refresh();
        }
    }

    function toggleRemote(movie) {
        const next=normalize(movie);
        if(!next||!activeProfileId)return Promise.resolve(false);
        return setRemote(next,!contains(next),activeProfileId);
    }

    function removeFromList(movie,expectedProfile=activeProfileId) {
        const next=normalize(movie);
        if(!next)return Promise.resolve(false);
        if(expectedProfile) {
            if(expectedProfile!==activeProfileId)return Promise.resolve(false);
            return setRemote(next,false,expectedProfile);
        }
        // Preserve standalone/local list behavior when no Kinopoisk profile
        // has been verified. This branch does not claim remote synchronization.
        return Promise.resolve(contains(next) ? toggle(next) : true);
    }

    function toggle(movie) {
        const next = normalize({...movie,
            addedAt:Number(movie?.addedAt)>0?Number(movie.addedAt):Date.now()});
        if (!next) return false;
        if (activeProfileId) { void toggleRemote(next); return true; }
        const old = getAll();
        const key = keyOf(next);
        const existing = old.find(item => keyOf(item) === key);
        const items = existing ? old.filter(item => keyOf(item) !== key) : [next, ...old];
        if (!existing && items.length > MAX_ITEMS) return false;
        const ok = save(items);
        if (ok && !existing) {
            if (movie.posterDataUrl) adoptPoster(next, movie.posterDataUrl);
            enqueueHydration(next);
        }
        return ok;
    }

    // Обогащение уже сохранённой записи не меняет порядок и не создаёт дубль.
    function updateMetadata(movie, metadata = movie) {
        const key = keyOf(movie);
        if (!key) return false;
        const old = getAll();
        const index = old.findIndex(item => keyOf(item) === key);
        if (index < 0) return false;

        const previous = old[index];
        const incoming = normalize({ ...previous, ...metadata,
            id: previous.id, type: previous.type, addedAt: previous.addedAt });
        if (!incoming) return false;

        // Не стираем уже полученные значения пустыми результатами.
        const goodTitle = incoming.title && !/^(фильм|сериал) №\d+$/i.test(incoming.title);
        const merged = {
            ...previous,
            title: goodTitle ? incoming.title : previous.title,
            year: incoming.year || previous.year,
            genres: incoming.genres.length ? incoming.genres : previous.genres,
            posterUrl: incoming.posterUrl || previous.posterUrl
        };
        if (JSON.stringify(previous) === JSON.stringify(merged)) return false;
        old[index] = merged;
        return save(old,true);
    }

    function adoptPoster(movie, dataUrl) {
        const key = keyOf(movie);
        if (!key || !contains(movie) || typeof dataUrl !== 'string' ||
            !/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(dataUrl)) return;
        if (posterCache.get(key) === dataUrl) return;
        posterCache.set(key, dataUrl);
        if (posterCache.size > 30) posterCache.delete(posterCache.keys().next().value);
        // A poster arrival changes only its image, not every row and button.
        const box=document.getElementById('watchlistItems');
        if(!box)return;
        for(const row of box.children){
            if(keyOf(row._kinoMovie)!==key)continue;
            const holder=row.children?.[0];
            if(!holder)break;
            const image=document.createElement('img');
            image.alt='';
            image.src=dataUrl;
            holder.replaceChildren(image);
            break;
        }
    }

    function makeButton(label, className, action, title) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.title = title;
        button.addEventListener('click', action);
        return button;
    }

    function syncSearchButton(button, movie) {
        if (!button || !normalize(movie)) return;
        button._kinoMovie = movie;
        const saved = contains(movie);
        const busy = savingRemote.has(keyOf(movie));
        button.disabled = busy;
        button.textContent = busy ? '↻ Сохраняем…'
            : saved ? '✓ В списке' : '☆ Буду смотреть';
        button.setAttribute('aria-pressed', String(saved));
        button.title = saved ? 'Убрать из «Буду смотреть»' : 'Добавить в «Буду смотреть»';
        button.classList.toggle('saved', saved);
    }

    function createSearchButton(movie) {
        const button = makeButton('', 'title-search-action watchlist-bookmark',
            () => toggle(button._kinoMovie), 'Буду смотреть');
        syncSearchButton(button, movie);
        return button;
    }

    let current = null;

    function setCurrent(movie) {
        current = normalize(movie);
        const button = document.getElementById('watchlistCurrentAction');
        if (!button) return;
        button.hidden = !current;
        if (!current) return;
        const saved = contains(current);
        const busy = savingRemote.has(keyOf(current));
        button.disabled = busy;
        // Preserve the icon SVG: only the accessible label and state change.
        const label = busy ? 'Сохраняем…'
            : saved ? 'Убрать из «Буду смотреть»' : 'Добавить в «Буду смотреть»';
        button.setAttribute('aria-pressed', String(saved));
        button.setAttribute('aria-label', label);
        button.title = label;
        button.classList.toggle('saved', saved);
        button.classList.toggle('busy', busy);
    }

    async function openWatch(item) {
        const url = WATCH_ORIGIN + '/' + item.type + '/' + item.id + '/';
        const kpUrl = KINOPOISK_ORIGIN + '/' + item.type + '/' + item.id + '/';
        try {
            if (typeof window.openTrackedWatchTab === 'function') {
                await window.openTrackedWatchTab(url, kpUrl, item.title);
            } else {
                await chrome.tabs.create({ url });
            }
            // Открытие по «Смотреть» учитывается в существующей истории.
            // При этом закладка НЕ удаляется и статус просмотра НЕ меняется.
            if (typeof window.addToHistory === 'function') {
                window.addToHistory(item.title, url);
            }
        } catch (error) {
            console.warn('[KinoHelper] Не удалось открыть сохранённый фильм:', error);
            showStatus('Не удалось открыть фильм');
        }
    }

    async function loadProfileItems(profileId) {
        const store=(await chrome.storage.local.get(PROFILE_STORE))[PROFILE_STORE];
        if(profileId!==activeProfileId)return;
        const data=store&&typeof store==='object'&&!Array.isArray(store)
            ?store[profileId]:null;
        const previous=new Map(profileItems.map(item=>
            [item.type+':'+item.id,item]));
        const items=data&&typeof data==='object'&&!Array.isArray(data)
            ?Object.values(data).map(normalize).filter(Boolean):[];
        const merged=items.map(item=>{
            const old=previous.get(item.type+':'+item.id);
            if(!old)return item;
            return {...item,
                year:item.year||old.year,
                genres:item.genres.length?item.genres:old.genres,
                posterUrl:item.posterUrl||old.posterUrl};
        });
        const sorted=items=>items.sort((a,b)=>b.addedAt-a.addedAt);
        sorted(merged);
        const now=sorted([...profileItems]);
        // Background minute checks may rewrite the same snapshot. Avoid
        // recreating every button/poster when no visible details changed.
        if(JSON.stringify(now)===JSON.stringify(merged))return;
        profileItems=merged;
        refresh();
    }

    async function showSyncJob() {
        if(!activeProfileId)return;
        try {
            const snapshot=await chrome.storage.local.get([SYNC_JOB,AUTO_REMOVE]);
            const waiting=snapshot[AUTO_REMOVE]?.[activeProfileId];
            const pending=waiting&&typeof waiting==='object'
                ? Object.values(waiting):[];
            const failed=pending.find(item=>item?.state==='failed');
            if(failed){
                showStatus('Не удалось автоматически убрать просмотренный фильм: '+
                    (failed.error||'Кинопоиск не подтвердил изменение')+
                    '. Удалите фильм вручную.','error');
                return;
            }
            if(pending.length){
                showStatus('Синхронизируем просмотренный фильм с Кинопоиском…','info');
                return;
            }
            const job=snapshot[SYNC_JOB];
            if(!job||job.profileId!==activeProfileId)return;
            const count=Number(job.count)||0;
            const state=job.state;
            const kind=['retry','paused','partial'].includes(state)?'error'
                :state==='completed'?'success':'info';
            const message=state==='completed'
                ? '✓ Кинопоиск: '+count+' в списке «Буду смотреть» · синхронизация раз в минуту'
                :state==='loading'
                    ? '↻ Синхронизация Кинопоиска: '+count+
                      (job.done?' · стр. '+job.done:'')
                    : 'Синхронизация: '+String(job.message||'ошибка')+
                      '. Нажмите ↻ для повторной попытки.';
            showStatus(message,kind);
        }catch(error){
            showStatus('Не удалось прочитать состояние загрузки','error');
        }
    }

    async function refreshProfile(force=false) {
        if(!window.KinoStatsAccount?.detect || !chrome.storage?.local)return;
        if(!force && Date.now()-lastAuthCheck<45000)return;
        lastAuthCheck=Date.now();
        const sequence=++authCheckId;
        let result;
        try {result=await window.KinoStatsAccount.detect(
            undefined,{force});}
        catch {result=null;}
        if(sequence!==authCheckId)return;
        const newId=result?.status==='logged-in'?String(result.id):'';
        if(newId!==activeProfileId) {
            activeProfileId=newId;
            profileItems=[];
            refresh();
        }
        if(!newId){
            showStatus(result?.status==='logged-out'
                ? 'Локальный список. Войдите в Кинопоиск для синхронизации.'
                : 'Профиль Кинопоиска не подтверждён. Список пока локальный.');
        } else {
            showStatus('');
            try {
                await loadProfileItems(newId);
                const response=await chrome.runtime.sendMessage({
                    action:'kinoWatchlistEnsure',profileId:newId
                });
                if(!response?.ok)showStatus(response?.error||
                    'Не удалось запустить синхронизацию','error');
                else await showSyncJob();
            }catch(error){
                showStatus('Автозагрузка недоступна: '+String(error?.message||error));
            }
        }
    }

    function showStatus(message,kind='error') {
        const status = document.getElementById('watchlistStatus');
        if (!status) return;
        status.textContent = message;
        status.dataset.kind=kind;
        status.hidden = !message;
    }

    function posterSources(item) {
        const sources = [];
        const append = raw => {
            const valid = validPoster(raw);
            if (!valid) return;
            const url = new URL(valid);
            const pathname = url.pathname.replace(/\/+$/, '');
            const avatar = url.hostname === 'avatars.mds.yandex.net' &&
                /^\/get-kinopoisk-image\/[^/]+\/[^/]+/.test(pathname);
            if (avatar) {
                const base = pathname.replace(/\/(?:orig|\d+x\d+)$/i, '');
                for (const size of ['280x420', '300x450', 'orig']) {
                    const candidate = url.origin + base + '/' + size;
                    if (!sources.includes(candidate)) sources.push(candidate);
                }
            } else if (!sources.includes(valid)) sources.push(valid);
        };
        append(item.posterUrl);
        // Старый путь иногда работает как резерв, как и в обычном поиске.
        append('https://st.kp.yandex.net/images/film_iphone/iphone360_' + item.id + '.jpg');
        append('https://st.kp.yandex.net/images/film_big/' + item.id + '.jpg');
        return sources.slice(0, 6);
    }

    async function requestPoster(item) {
        const key = keyOf(item);
        if (posterCache.has(key)) return;

        const tried = new Set();
        const trySources = async urls => {
            for (const url of urls) {
                if (!contains(item)) return false;
                if (tried.has(url)) continue;
                tried.add(url);
                try {
                    const result = await chrome.runtime.sendMessage({
                        action: 'loadSearchPoster', payload: { url }
                    });
                    if (result?.ok && result.dataUrl && contains(item)) {
                        adoptPoster(item, result.dataUrl);
                        return true;
                    }
                } catch { /* Следующий источник постера. */ }
            }
            return false;
        };

        // Сначала проверяем уже известные адреса.
        if (await trySources(posterSources(item))) return;

        // Старые записи могут содержать неработающую ссылку.
        // Ищем свежий официальный URL на странице фильма.
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'findPosterOnMoviePage',
                payload: { id: item.id, type: item.type }
            });
            const fresh = validPoster(response?.poster);
            if (response?.ok && fresh) {
                updateMetadata(item, { posterUrl: fresh });
                await trySources(posterSources({ ...item, posterUrl: fresh }));
            }
        } catch { /* Отсутствие изображения не мешает остальным данным. */ }
    }

    async function hydrate(item) {
        if (!contains(item)) return;
        const current = getAll().find(entry => keyOf(entry) === keyOf(item));
        if (!current) return;

        // Из GraphQL получаем год и исходный URL постера. Жанр —
        // из уже существующего парсера страницы Кинопоиска.
        const tasks = [];
        if (!current.year || !current.posterUrl) {
            tasks.push((async () => {
                try {
                    const reply = await chrome.runtime.sendMessage({
                        action: 'getSearchMovieMetadata',
                        payload: { id: current.id, type: current.type }
                    });
                    if (reply?.ok && reply.metadata) {
                        const m = reply.metadata;
                        updateMetadata(current, {
                            year: m.year,
                            title: m.title,
                            posterUrl: validPoster(m.poster) || validPoster(m.posterFallback)
                        });
                    }
                } catch { /* Отсутствие метаданных не блокирует закладку. */ }
            })());
        }
        if (!current.genres.length && window.KinoMovieDetails?.get) {
            tasks.push((async () => {
                try {
                    const details = await window.KinoMovieDetails.get(current);
                    if (details?.genres?.length) updateMetadata(current, { genres: details.genres });
                } catch { /* Кинопоиск может не предоставить жанр. */ }
            })());
        }
        // Готовый URL постера можно загрузить сразу, не ожидая жанры.
        const startedPoster = Boolean(current.posterUrl && !posterCache.has(keyOf(item)));
        if (startedPoster) tasks.push(requestPoster(current));
        await Promise.allSettled(tasks);
        if (!startedPoster && !posterCache.has(keyOf(item))) {
            const latest = getAll().find(entry => keyOf(entry) === keyOf(item));
            if (latest) await requestPoster(latest);
        }
    }

    function pumpHydration() {
        while (hydrationActive < MAX_PARALLEL && pendingHydration.length) {
            const item = pendingHydration.shift();
            hydrationActive++;
            Promise.resolve().then(() => hydrate(item)).catch(error => {
                console.warn('[KinoHelper] Ошибка загрузки данных закладки:', error);
            }).finally(() => {
                hydrationActive--;
                pumpHydration();
            });
        }
    }

    function enqueueHydration(item) {
        const key = keyOf(item);
        if (!key || hydrationStarted.has(key)) return;
        hydrationStarted.add(key);
        pendingHydration.push(item);
        pumpHydration();
    }

    const renderedRows = new Map();
    function sortedForDisplay(items){
        const direction=sortOrder==='oldest'?1:-1;
        return [...items].sort((a,b)=>{
            const aDate=Number(a.addedAt)||0,bDate=Number(b.addedAt)||0;
            if(!aDate)return bDate?1:0;
            if(!bDate)return -1;
            return direction*(aDate-bDate);
        });
    }
    function renderSignature(item) {
        return JSON.stringify([item.type,item.id,item.title,item.year,
            item.genres,item.posterUrl,Boolean(posterCache.get(keyOf(item))),
            savingRemote.has(keyOf(item)),activeProfileId]);
    }

    function renderList() {
        const itemsBox = document.getElementById('watchlistItems');
        const count = document.getElementById('watchlistCount');
        const empty = document.getElementById('watchlistEmpty');
        if (!itemsBox || !count || !empty) return;

        const items = sortedForDisplay(getAll());
        count.textContent = String(items.length);
        empty.hidden = items.length !== 0;
        const previous= new Map(renderedRows);
        renderedRows.clear();
        const nodes = items.map(item => {
            const key=keyOf(item);
            const signature=renderSignature(item);
            const existing=previous.get(key);
            if(existing?.signature===signature){
                renderedRows.set(key,existing);
                return existing.row;
            }
            const row = document.createElement('div');
            row.className = 'watchlist-item';
            row._kinoMovie = item;

            const poster = document.createElement('div');
            poster.className = 'watchlist-poster';
            poster.textContent = item.type === 'series' ? '📺' : '🎬';
            const loadedPoster = posterCache.get(keyOf(item));
            if (loadedPoster) {
                const image = document.createElement('img');
                image.alt = '';
                image.src = loadedPoster;
                poster.replaceChildren(image);
            }

            const info = document.createElement('div');
            info.className = 'watchlist-info';
            const name = document.createElement('div');
            name.className = 'watchlist-name';
            name.textContent = item.title;
            name.title = item.title;
            const meta = document.createElement('div');
            meta.className = 'watchlist-meta';
            meta.textContent = (item.type === 'series' ? 'Сериал' : 'Фильм') +
                (item.year ? ' · ' + item.year : '');
            info.append(name, meta);
            if (item.genres.length) {
                const genres = document.createElement('div');
                genres.className = 'watchlist-genres';
                genres.textContent = 'Жанр: ' + item.genres.join(', ');
                genres.title = genres.textContent;
                info.appendChild(genres);
            }

            const actions = document.createElement('div');
            actions.className = 'watchlist-actions';
            const watch = makeButton('▶', 'watchlist-item-action watch',
                () => void openWatch(item), 'Смотреть');
            watch.setAttribute('aria-label', 'Смотреть: ' + item.title);
            const kp = makeButton('КП', 'watchlist-item-action',
                () => void chrome.tabs.create({
                    url: KINOPOISK_ORIGIN + '/' + item.type + '/' + item.id + '/'
                }), 'Открыть Кинопоиск');
            kp.setAttribute('aria-label', 'Кинопоиск: ' + item.title);
            const profileAtRender=activeProfileId;
            const busy=savingRemote.has(keyOf(item));
            const remove = makeButton(busy?'…':'✕', 'watchlist-item-action',
                () => void removeFromList(item,profileAtRender),
                'Убрать из «Буду смотреть» на Кинопоиске');
            remove.disabled=busy;
            remove.setAttribute('aria-label', 'Удалить из списка: ' + item.title);
            if (busy) remove.setAttribute('aria-busy','true');
            actions.append(watch, kp, remove);
            row.append(poster, info, actions);
            renderedRows.set(key,{row,signature});
            return row;
        });
        const previousNodes=[...itemsBox.children];
        const changed=nodes.length!==previousNodes.length ||
            nodes.some((node,i)=>node!==previousNodes[i]);
        if(!changed)return;
        if (listObserver) listObserver.disconnect();
        itemsBox.replaceChildren(...nodes);
        if (listObserver) {
            for (const row of nodes) listObserver.observe(row);
        } else {
            for (const item of items.slice(0, 8)) enqueueHydration(item);
        }
    }

    function refresh() {
        renderList();
        setCurrent(current);
        for (const button of document.querySelectorAll('.watchlist-bookmark')) {
            syncSearchButton(button, button._kinoMovie);
        }
    }

    function init() {
        const section = document.getElementById('watchlist');
        const toggleButton = document.getElementById('watchlistToggle');
        const itemsBox = document.getElementById('watchlistBody');
        const currentButton = document.getElementById('watchlistCurrentAction');
        const syncButton = document.getElementById('watchlistSync');
        const sortSelect = document.getElementById('watchlistSort');
        if (!section || !toggleButton || !itemsBox) return;
        if(sortSelect){
            sortSelect.value=sortOrder;
            sortSelect.addEventListener('change',()=>{
                sortOrder=sortSelect.value==='oldest'?'oldest':'newest';
                localStorage.setItem(SORT_KEY,sortOrder);
                refresh();
            });
        }
        const collapsed = localStorage.getItem(COLLAPSED_KEY) === 'true';

        function setCollapsed(value) {
            section.classList.toggle('collapsed', value);
            itemsBox.hidden = value;
            toggleButton.textContent = value ? '▶ Показать' : '▼ Скрыть';
            toggleButton.setAttribute('aria-expanded', String(!value));
            localStorage.setItem(COLLAPSED_KEY, String(value));
        }

        if (typeof IntersectionObserver !== 'undefined') {
            listObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        listObserver.unobserve(entry.target);
                        enqueueHydration(entry.target._kinoMovie);
                    }
                }
            }, { root: document.getElementById('watchlistItems'),
                 rootMargin: '100px 0px' });
        }

        // Первое состояние из localStorage применяем, не затрагивая историю.
        setCollapsed(collapsed);
        toggleButton.addEventListener('click',
            () => setCollapsed(!section.classList.contains('collapsed')));
        // This compact bookmark appears only on Kinopoisk detail pages.
        currentButton?.addEventListener('click', () => {
            if (current) toggle(current);
        });
        syncButton?.addEventListener('click',async()=>{
            if(syncButton.disabled)return;
            syncButton.disabled=true;
            try{
                await refreshProfile(true);
                if(!activeProfileId){
                    showStatus('Войдите в Кинопоиск, чтобы загрузить список','error');
                    return;
                }
                showStatus('Обновляем список с Кинопоиска…','info');
                const response=await chrome.runtime.sendMessage({
                    action:'kinoWatchlistRefresh',profileId:activeProfileId
                });
                if(!response?.ok)showStatus(response?.error||
                    'Синхронизация недоступна','error');
                else await showSyncJob();
            }catch(error){
                showStatus('Ошибка синхронизации: '+String(error?.message||error));
            }finally{syncButton.disabled=false;}
        });
        window.addEventListener('kino-watchlist-updated', refresh);
        if(chrome.storage?.onChanged)chrome.storage.onChanged.addListener(
            (changes,area)=>{
                if(area!=='local'||!activeProfileId)return;
                if(changes[PROFILE_STORE])void loadProfileItems(activeProfileId);
                if(changes[SYNC_JOB]||changes[AUTO_REMOVE])
                    void showSyncJob();
            });
        void refreshProfile(false);
        // Вторая открытая панель/окно использует то же хранилище расширения.
        window.addEventListener('storage', event => {
            if (event.key === STORAGE_KEY) refresh();
            if (event.key === SORT_KEY) {
                sortOrder=event.newValue==='oldest'?'oldest':'newest';
                if(sortSelect)sortSelect.value=sortOrder;
                refresh();
            }
            if (event.key === COLLAPSED_KEY && event.newValue !== null) {
                setCollapsed(event.newValue === 'true');
            }
        });
        window.addEventListener('focus', () => {
            refresh();
            void refreshProfile(false);
        });
        refresh();
    }

    window.KinoWatchlist = { getAll, contains, toggle, setCurrent,
        createSearchButton, syncSearchButton, updateMetadata, adoptPoster,
        refreshProfile, removeFromList };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
