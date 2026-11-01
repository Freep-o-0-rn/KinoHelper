const KINOPOISK_BASE = "https://www.kinopoisk.ru";
const WATCH_BASE = "https://www.kinokino.vip";
const FALLBACK_WATCH_BASE = "https://flcksbr.top";
const KINOPOISK_GRAPHQL = "https://graphql.kinopoisk.ru/graphql/";
const RATING_ORIGIN_RULE_ID = 1516;
const WATCH_ORIGINS_KEY = "kinoWatchOrigins";
const MAX_WATCH_ORIGINS = 20;

const MOVIE_PREVIEW_CARD_QUERY = `
  query MoviePreviewCard($movieId: Long!, $actorsLimit: Int!, $withUserData: Boolean = false) {
    movie(id: $movieId) {
      id
      contentId
      title { russian original __typename }
      ... on Film {
        productionYear
        isShortFilm
        ratingLists { top250 { movieListSlug position __typename } __typename }
        __typename
      }
      ... on TvSeries { releaseYears { start end __typename } __typename }
      ... on MiniSeries { releaseYears { start end __typename } __typename }
      ... on TvShow { releaseYears { start end __typename } __typename }
      ... on Video { productionYear __typename }
      ticketOption { purchasable __typename }
      viewOption {
        buttonText
        originalButtonText
        isAvailableOnline: isWatchable(filter: { anyDevice: false, anyRegion: false })
        purchasabilityStatus
        promotionIcons { avatarsUrl fallbackUrl __typename }
        type
        rightholderLogoUrlForPoster
        __typename
      }
      actors: members(limit: $actorsLimit, role: [ACTOR, CAMEO, UNCREDITED]) {
        items { person { id name originalName __typename } __typename }
        total
        __typename
      }
      directors: members(role: DIRECTOR, limit: 4) {
        items { person { id name originalName __typename } __typename }
        __typename
      }
      rating { kinopoisk { value isActive count __typename } __typename }
      poster { avatarsUrl fallbackUrl __typename }
      ...MoviePreviewUserData @include(if: $withUserData)
      __typename
    }
  }

  fragment MoviePreviewUserData on Movie {
    userData {
      voting { value votedAt __typename }
      isPlannedToWatch
      __typename
    }
    __typename
  }
`;

// Оценки используют проверенную схему v1.527 без полей постеров.
// Расширенные поля применяются только при загрузке карточек поиска.
const MOVIE_SEARCH_METADATA_QUERY = MOVIE_PREVIEW_CARD_QUERY.replace(
  "      ...MoviePreviewUserData @include(if: $withUserData)",
  `      gallery {
        posters {
          kpVertical: vertical { avatarsUrl fallbackUrl }
          hdVertical: vertical(override: OTT_WHEN_EXISTS) { avatarsUrl fallbackUrl }
        }
      }
      ...MoviePreviewUserData @include(if: $withUserData)`
);

// Запрос подсказок Кинопоиска возвращает несколько фильмов вместе с
// корректными постерами, годом и рейтингом без поиска ссылок в DOM.
const TITLE_SUGGEST_QUERY = `
  query SuggestSearch($keyword: String!, $yandexCityId: Int, $limit: Int, $withUserData: Boolean!) {
    suggest(keyword: $keyword) {
      top(yandexCityId: $yandexCityId, limit: $limit) {
        topResult { global { ...SuggestMovieItem __typename } }
        movies { movie { ...SuggestMovieItem __typename } }
      }
    }
  }
  fragment SuggestMovieItem on Movie {
    id
    __typename
    title { russian original }
    rating { kinopoisk { value } }
    gallery {
      posters {
        kpVertical: vertical { avatarsUrl fallbackUrl }
        hdVertical: vertical(override: OTT_WHEN_EXISTS) { avatarsUrl fallbackUrl }
      }
    }
    userData @include(if: $withUserData) { isPlannedToWatch }
    ... on Film { productionYear }
    ... on TvSeries { releaseYears { start end } }
    ... on MiniSeries { releaseYears { start end } }
    ... on TvShow { releaseYears { start end } }
  }
`;

const MOVIE_SET_VOTE_QUERY = `
  mutation MovieSetVote($movieId: Long!, $rate: Int!) {
    movie {
      vote {
        set(input: { movieId: $movieId, rate: $rate }) {
          error {
            message
            __typename
          }
          status
          __typename
        }
        __typename
      }
      __typename
    }
  }
`;

const SESSION_PREFIX = "kinoWatchSession:";
const REDIRECT_WINDOW_MS = 15000;

function sessionKey(tabId) {
  return `${SESSION_PREFIX}${tabId}`;
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isKinopoiskUrl(url) {
  return getOrigin(url) === KINOPOISK_BASE;
}

function hasWatchMarker(url) {
  try {
    return new URL(url).searchParams.has("socialAlias");
  } catch {
    return false;
  }
}

async function getRememberedWatchOrigins() {
  const data = await chrome.storage.local.get(WATCH_ORIGINS_KEY);
  return Array.isArray(data[WATCH_ORIGINS_KEY]) ? data[WATCH_ORIGINS_KEY] : [];
}

async function rememberWatchOrigin(url) {
  const origin = getOrigin(url);
  if (!origin || origin === KINOPOISK_BASE) return;

  const current = await getRememberedWatchOrigins();
  const next = [origin, ...current.filter(item => item !== origin)].slice(0, MAX_WATCH_ORIGINS);
  await chrome.storage.local.set({ [WATCH_ORIGINS_KEY]: next });
}

async function isRecoverableWatchUrl(url) {
  const media = parseMedia(url);
  if (!media || isKinopoiskUrl(url)) return false;

  const origin = getOrigin(url);
  const builtInOrigins = [getOrigin(WATCH_BASE), getOrigin(FALLBACK_WATCH_BASE)];
  if (builtInOrigins.includes(origin) || hasWatchMarker(url)) return true;

  const rememberedOrigins = await getRememberedWatchOrigins();
  return rememberedOrigins.includes(origin);
}

function parseMedia(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/(film|series)\/(\d+)(?:\/|$)/);
    if (!match) return null;
    return { type: match[1], id: match[2] };
  } catch {
    return null;
  }
}

function sameMedia(session, url) {
  const media = parseMedia(url);
  return Boolean(media && media.type === session.type && media.id === session.id);
}

function normalizeMediaPayload(payload) {
  const id = Number(payload?.id);
  const type = payload?.type;
  if (!Number.isSafeInteger(id) || id <= 0 || !["film", "series"].includes(type)) {
    throw new Error("Некорректные данные фильма");
  }
  return { id, type };
}

function ratingGraphqlUrl(operationName) {
  return `${KINOPOISK_GRAPHQL}?operationName=${encodeURIComponent(operationName)}`;
}

function ratingRequestOptions(operationName, variables, query) {
  return {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "service-id": "25",
      "source-id": "1",
      "x-preferred-language": "ru"
    },
    body: JSON.stringify({ operationName, variables, query })
  };
}

async function installRatingOriginRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RATING_ORIGIN_RULE_ID],
    addRules: [{
      id: RATING_ORIGIN_RULE_ID,
      priority: 100,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "set", value: KINOPOISK_BASE },
          { header: "Referer", operation: "set", value: `${KINOPOISK_BASE}/` }
        ]
      },
      condition: {
        regexFilter: "^https://graphql\\.kinopoisk\\.ru/graphql/\\?operationName=(?:MoviePreviewCard|MovieSetVote|SuggestSearch)$",
        requestMethods: ["post"],
        resourceTypes: ["xmlhttprequest"],
        tabIds: [chrome.tabs.TAB_ID_NONE]
      }
    }]
  });
}

async function removeRatingOriginRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RATING_ORIGIN_RULE_ID]
    });
  } catch {}
}

let ratingRequestQueue = Promise.resolve();

function queueRatingRequest(task) {
  const pending = ratingRequestQueue.then(task, task);
  ratingRequestQueue = pending.catch(() => {});
  return pending;
}

async function runRatingRequest(task) {
  return queueRatingRequest(async () => {
    await installRatingOriginRule();
    try {
      return await task();
    } finally {
      await removeRatingOriginRule();
    }
  });
}

function getMoviePreviewMeta(movie) {
  const rawTitle = String(movie?.title?.russian || movie?.title?.original || '')
    .replace(/\s+/g, ' ')
    .trim();

  const rawYear = movie?.productionYear ?? movie?.releaseYears?.start;
  const numericYear = Number(rawYear);
  const year = Number.isInteger(numericYear) && numericYear > 1800 && numericYear < 2200
    ? numericYear
    : null;

  const rawMovieRating = movie?.rating?.kinopoisk?.value;
  const movieRating = typeof rawMovieRating === "number" &&
    Number.isFinite(rawMovieRating) && rawMovieRating > 0
    ? rawMovieRating
    : null;

  return {
    movieRating,
    movieTitle: rawTitle ? (year ? `${rawTitle} (${year})` : rawTitle) : ''
  };
}

// Публичные данные для карточек поиска. Берём по ID из того же GraphQL,
// который уже используется для оценки, а не из ссылок «Актеры» поисковой выдачи.
// Кэш результатов поиска — не хранит личных данных или историю.
const titleSuggestCache = new Map();
const TITLE_SUGGEST_TTL = 2 * 60 * 1000;
const TITLE_SUGGEST_MAX_CACHE = 30;
const TITLE_SEARCH_MAX = 30;
let suggestApiUnavailable = false;

async function findPosterOnMoviePage(payload) {
  const media = normalizeMediaPayload(payload);
  const address = KINOPOISK_BASE + '/' + media.type + '/' + media.id + '/';
  const response = await fetch(address, {
    credentials: 'include',
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error('Страница фильма: HTTP ' + response.status);
  const html = await response.text();

  function verified(raw) {
    try {
      let value = String(raw || '')
        .replace(/\\u002[fF]/g, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/&#x2F;|&#47;/gi, '/')
        .replace(/&quot;/g, '"')
        .trim();
      if (value.startsWith('//')) value = 'https:' + value;
      const src = new URL(value, address);
      if (src.protocol !== 'https:') return null;
      if (!['avatars.mds.yandex.net', 'st.kp.yandex.net'].includes(src.hostname)) return null;
      if (!(/\/get-kinopoisk-image\//.test(src.pathname) ||
            /\/images\/film_(?:iphone|big)\//.test(src.pathname))) return null;
      return src.href;
    } catch {
      return null;
    }
  }

  // Сначала специальные метатеги, затем изображение с классом постера.
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const attrs = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
      attrs[match[1].toLowerCase()] = match[3];
    }
    if (['og:image', 'twitter:image'].includes(attrs.property || attrs.name)) {
      const image = verified(attrs.content);
      if (image) return { poster: image, origin: 'meta' };
    }
  }

  // В SSR постер может храниться как <img class="film-poster">.
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/film-poster|poster|постер/i.test(tag)) continue;
    const links = [
      ...tag.matchAll(/\b(?:src|data-src|srcset)\s*=\s*(["'])(.*?)\1/gi)
    ];
    for (const link of links) {
      const image = verified(link[2].split(/\s+\d+[wx](?:,|$)/)[0]);
      if (image) return { poster: image, origin: 'poster-img' };
    }
  }

  // Наконец, ищем картинки внутри сериализованного JSON SSR.
  const unescaped = html
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/');
  const patterns = [
    /(?:kpVertical|hdVertical|poster|posters)[\s\S]{0,550}?(?:https?:)?\/\/avatars\.mds\.yandex\.net\/get-kinopoisk-image\/[\w/.-]+/gi,
    /(?:https?:)?\/\/avatars\.mds\.yandex\.net\/get-kinopoisk-image\/[\w/.-]+/gi
  ];
  for (const pattern of patterns) {
    const matches = unescaped.match(pattern) || [];
    for (const candidate of matches.slice(0, 20)) {
      const url = candidate.match(/(?:https?:)?\/\/avatars\.mds\.yandex\.net\/get-kinopoisk-image\/[\w/.-]+/i)?.[0];
      const image = verified(url);
      if (image) return { poster: image, origin: 'ssr' };
    }
  }
  return { poster: null, origin: 'not-found' };
}

const imageDataCache = new Map();
const IMAGE_CACHE_MAX = 40;
async function loadSearchPoster(payload) {
  const raw = String(payload?.url || '').trim();
  const address = new URL(raw);
  const host = address.hostname.toLowerCase();
  if (address.protocol !== 'https:' ||
      !['avatars.mds.yandex.net', 'st.kp.yandex.net'].includes(host)) {
    throw new Error('Недопустимый источник постера');
  }
  if (imageDataCache.has(address.href)) return imageDataCache.get(address.href);
  const result = await fetch(address.href, {
    credentials: 'omit',
    cache: 'force-cache',
    signal: AbortSignal.timeout(6500)
  });
  if (!result.ok) throw new Error('Постер: HTTP ' + result.status);
  const mime = (result.headers.get('content-type') || '').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    throw new Error('Постер: неожиданный тип ' + (mime || 'unknown'));
  }
  const bytes = new Uint8Array(await result.arrayBuffer());
  if (!bytes.length || bytes.length > 1800000) {
    throw new Error('Недопустимый размер изображения');
  }
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  const dataUrl = 'data:' + mime + ';base64,' + btoa(binary);
  imageDataCache.set(address.href, dataUrl);
  if (imageDataCache.size > IMAGE_CACHE_MAX) {
    imageDataCache.delete(imageDataCache.keys().next().value);
  }
  return dataUrl;
}

function convertSuggestedMovie(movie) {
  const id = Number(movie?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const title = String(movie.title?.russian || movie.title?.original || '')
    .replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const type = ['TvSeries', 'MiniSeries', 'TvShow'].includes(movie.__typename)
    ? 'series' : 'film';
  const yearValue = Number(movie.productionYear ?? movie.releaseYears?.start);
  const ratingValue = Number(movie.rating?.kinopoisk?.value);
  const posters = movie.gallery?.posters;

  return {
    id: String(id),
    type,
    kpUrl: KINOPOISK_BASE + '/' + type + '/' + id + '/',
    watchUrl: WATCH_BASE + '/' + type + '/' + id + '/',
    title,
    year: Number.isInteger(yearValue) && yearValue >= 1880 && yearValue <= 2200
      ? yearValue : null,
    rating: Number.isFinite(ratingValue) && ratingValue > 0 && ratingValue <= 10
      ? ratingValue : null,
    poster: posters?.kpVertical?.avatarsUrl ||
      posters?.hdVertical?.avatarsUrl || null,
    posterFallback: posters?.kpVertical?.fallbackUrl ||
      posters?.hdVertical?.fallbackUrl || null
  };
}

async function fetchTitleSuggestions(keyword) {
  {
    const response = await fetch(
      ratingGraphqlUrl('SuggestSearch'),
      {
        ...ratingRequestOptions(
          'SuggestSearch',
          { keyword, limit: TITLE_SEARCH_MAX, yandexCityId: 6, withUserData: false },
          TITLE_SUGGEST_QUERY
        ),
        headers: {
          ...ratingRequestOptions('SuggestSearch', {}, '').headers,
          'x-search-request-id': String(Date.now()) + String(Math.floor(Math.random() * 1000000)),
          'x-request-id': String(Date.now()) + '-' + String(Math.floor(Math.random() * 1000000)),
          'x-kp-testids': '414549,436857,436979,1615440',
          'Accept': '*/*'
        },
        signal: AbortSignal.timeout(7000)
      }
    );
    if (!response.ok) {
      if (response.status === 400) suggestApiUnavailable = true;
      throw new Error('Поиск Кинопоиска: HTTP ' + response.status);
    }
    const result = await response.json();
    const top = result?.data?.suggest?.top;
    if (!top || result?.errors?.length) {
      const explanation = result?.errors?.map(e => e.message).filter(Boolean).join('; ');
      throw new Error(explanation || 'Кинопоиск не вернул список подсказок');
    }
    const entries = [...(top.movies || []).map(item => item?.movie)];
    if (top.topResult?.global?.id) entries.unshift(top.topResult.global);
    return entries.map(convertSuggestedMovie).filter(Boolean);
  }
}

function suggestRank(item, query) {
  const norm = text => String(text || '').toLocaleLowerCase('ru')
    .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const title = norm(item.title);
  const needle = norm(query);
  if (!needle || !title) return 0;
  if (title === needle) return 1000;
  if (title.startsWith(needle + ' ')) {
    const ending = title.slice(needle.length).trim();
    const number = /^\d{1,2}$/.test(ending) ? Number(ending) : null;
    return number !== null ? 900 - number : 850;
  }
  if (title.startsWith(needle)) return 800;
  if (title.includes(needle)) return 600;
  const tokens = needle.split(' ').filter(word => word.length > 1);
  const matched = tokens.filter(word => title.includes(word)).length;
  return tokens.length ? Math.round(matched / tokens.length * 400) : 100;
}

async function searchMovieTitles(payload) {
  if (suggestApiUnavailable) throw new Error('SuggestSearch: HTTP 400 (недоступен в этой сессии)');
  const query = String(payload?.query || '').replace(/\s+/g, ' ').trim();
  if (query.length < 2 || query.length > 100) {
    throw new Error('Название должно содержать от 2 до 100 символов');
  }
  const key = query.toLocaleLowerCase('ru');
  const cached = titleSuggestCache.get(key);
  if (cached && Date.now() - cached.time < TITLE_SUGGEST_TTL) return cached.items;

  // Общее правило заголовков устанавливается один раз для всей пачки
  // параллельных запросов, а не для каждого фильма по отдельности.
  return runRatingRequest(async () => {
    const all = new Map();
    const errors = [];
    async function mergeMatches(keyword) {
      try {
        const movies = await fetchTitleSuggestions(keyword);
        movies.forEach(movie => {
          const id = movie.type + ':' + movie.id;
          const old = all.get(id);
          if (!old) {
            all.set(id, movie);
          } else {
            all.set(id, {
              ...old, poster: old.poster || movie.poster,
              posterFallback: old.posterFallback || movie.posterFallback,
              rating: old.rating ?? movie.rating,
              year: old.year || movie.year
            });
          }
        });
      } catch (error) {
        errors.push(keyword + ': ' + error.message);
      }
    }

    await mergeMatches(query);
    const words = query.split(/\s+/);
    if (words.length >= 3 && all.size < 12) {
      const variations = [
        words.slice(0, -1).join(' '),
        words.slice(1).join(' ')
      ].filter(term => term.length >= 4 && term.toLowerCase() !== key);
      if (!/\d\s*$/.test(query)) {
        for (const n of [2, 3, 4, 5, 6]) variations.push(query + ' ' + n);
      }
      // Не перегружаем API: максимум семь дополнительных запросов,
      // три одновременно, только при недостаточной исходной выдаче.
      const unique = [...new Set(variations)].slice(0, 7);
      for (let i = 0; i < unique.length; i += 3) {
        await Promise.all(unique.slice(i, i + 3).map(mergeMatches));
        if (all.size >= TITLE_SEARCH_MAX) break;
      }
    }

    if (!all.size && errors.length) throw new Error(errors[0]);
    const items = [...all.values()]
      .sort((a, b) => suggestRank(b, query) - suggestRank(a, query) ||
        ((b.rating || 0) - (a.rating || 0)))
      .slice(0, TITLE_SEARCH_MAX);

    titleSuggestCache.set(key, { items, time: Date.now() });
    if (titleSuggestCache.size > TITLE_SUGGEST_MAX_CACHE) {
      titleSuggestCache.delete(titleSuggestCache.keys().next().value);
    }
    return items;
  });
}

const searchMetadataCache = new Map();
const SEARCH_META_TTL_MS = 30 * 60 * 1000;
const SEARCH_META_MAX_CACHE = 100;

async function getSearchMovieMetadata(payload) {
  const media = normalizeMediaPayload(payload);
  const key = media.type + ':' + media.id;
  const cached = searchMetadataCache.get(key);
  if (cached && Date.now() - cached.time < SEARCH_META_TTL_MS) {
    return cached.data;
  }

  const data = await runRatingRequest(async () => {
    const fetchMetadata = async query => {
      const response = await fetch(
        ratingGraphqlUrl("MoviePreviewCard"),
        {
          ...ratingRequestOptions(
            "MoviePreviewCard",
            { movieId: media.id, actorsLimit: 0, withUserData: false },
            query
          ),
          signal: AbortSignal.timeout(12000)
        }
      );
      if (!response.ok) throw new Error("Кинопоиск вернул HTTP " + response.status);
      const result = await response.json();
      if (result?.errors?.length) {
        throw new Error(result.errors.map(error => error.message).filter(Boolean).join("; ") || "Ошибка GraphQL");
      }
      return result?.data?.movie;
    };

    // Если расширенные поля gallery недоступны, используем базовый запрос.
    let movie;
    try {
      movie = await fetchMetadata(MOVIE_SEARCH_METADATA_QUERY);
    } catch (error) {
      console.warn("[KinoHelper] Дополнительные поля постера недоступны:", error.message);
      movie = await fetchMetadata(MOVIE_PREVIEW_CARD_QUERY);
    }
    if (!movie) throw new Error("Не удалось получить карточку фильма");

    const title = String(movie.title?.russian || movie.title?.original || "")
      .replace(/\s+/g, " ").trim();

    const yearValue = Number(movie.productionYear ?? movie.releaseYears?.start);
    const year = Number.isInteger(yearValue) && yearValue >= 1880 && yearValue <= 2200
      ? yearValue : null;
    const ratingValue = Number(movie.rating?.kinopoisk?.value);
    const rating = Number.isFinite(ratingValue) && ratingValue > 0 && ratingValue <= 10
      ? ratingValue : null;

    return {
      title: title || null,
      year,
      rating,
      // Поля уже присутствуют в MOVIE_PREVIEW_CARD_QUERY.
      poster: movie.gallery?.posters?.kpVertical?.avatarsUrl ||
        movie.gallery?.posters?.hdVertical?.avatarsUrl ||
        movie.poster?.avatarsUrl || movie.poster?.fallbackUrl || null,
      posterFallback: movie.gallery?.posters?.kpVertical?.fallbackUrl ||
        movie.gallery?.posters?.hdVertical?.fallbackUrl ||
        movie.poster?.fallbackUrl || null
    };
  });

  if (data.title || data.poster) {
    searchMetadataCache.set(key, { data, time: Date.now() });
    if (searchMetadataCache.size > SEARCH_META_MAX_CACHE) {
      searchMetadataCache.delete(searchMetadataCache.keys().next().value);
    }
  }
  return data;
}

async function getMovieRating(payload) {
  const media = normalizeMediaPayload(payload);

  return runRatingRequest(async () => {
    const response = await fetch(
      ratingGraphqlUrl("MoviePreviewCard"),
      ratingRequestOptions(
        "MoviePreviewCard",
        { movieId: media.id, actorsLimit: 0, withUserData: true },
        MOVIE_PREVIEW_CARD_QUERY
      )
    );

    if (response.status === 401 || response.status === 403) {
      const publicResponse = await fetch(
        ratingGraphqlUrl("MoviePreviewCard"),
        ratingRequestOptions(
          "MoviePreviewCard",
          { movieId: media.id, actorsLimit: 0, withUserData: false },
          MOVIE_PREVIEW_CARD_QUERY
        )
      );

      if (!publicResponse.ok) {
        return { authorized: false, rating: null, movieRating: null, movieTitle: '' };
      }

      const publicResult = await publicResponse.json();
      const publicMovie = publicResult?.data?.movie;
      return {
        authorized: false,
        rating: null,
        ...getMoviePreviewMeta(publicMovie)
      };
    }

    if (!response.ok) {
      throw new Error(`Кинопоиск вернул ошибку ${response.status}`);
    }

    const result = await response.json();
    const movie = result?.data?.movie;
    const previewMeta = getMoviePreviewMeta(movie);
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    const details = errors.map(error => error?.message).filter(Boolean).join(" ");
    const authRequired = errors.some(error =>
      error?.extensions?.classification === "AuthenticationError" ||
      /auth|authoriz|login|unauthor|forbidden|войд|авториз/i.test(error?.message || "")
    );

    if (authRequired) {
      return { authorized: false, rating: null, ...previewMeta };
    }
    if (errors.length) throw new Error(details || "Не удалось получить оценку Кинопоиска");

    const userData = movie?.userData;
    if (!userData) return { authorized: false, rating: null, ...previewMeta };

    const rating = Number(userData.voting?.value);
    return {
      authorized: true,
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : null,
      planned: typeof userData.isPlannedToWatch === 'boolean'
        ? userData.isPlannedToWatch : null,
      ...previewMeta
    };
  });
}

async function setMovieRating(payload) {
  const media = normalizeMediaPayload(payload);
  const rating = Number(payload?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    throw new Error("Оценка должна быть от 1 до 10");
  }

  return runRatingRequest(async () => {
    const response = await fetch(
      ratingGraphqlUrl("MovieSetVote"),
      ratingRequestOptions(
        "MovieSetVote",
        { movieId: media.id, rate: rating },
        MOVIE_SET_VOTE_QUERY
      )
    );

    if (response.status === 401 || response.status === 403) {
      return { ok: false, authRequired: true };
    }
    if (!response.ok) {
      throw new Error(`Кинопоиск вернул ошибку ${response.status}`);
    }

    const result = await response.json();
    const vote = result?.data?.movie?.vote?.set;
    if (vote?.status === "SUCCESS") {
      return { ok: true, rating };
    }

    const details = [
      vote?.error?.message,
      ...(Array.isArray(result?.errors) ? result.errors.map(error => error?.message) : [])
    ].filter(Boolean).join(" ");
    const authRequired = /auth|authoriz|login|unauthor|forbidden|войд|авториз/i.test(details);

    return {
      ok: false,
      authRequired,
      error: details || "Кинопоиск не подтвердил сохранение оценки"
    };
  });
}

function notifyWatchSessionChanged(tabId) {
  // Сеанс уже сохранён в storage.session; UI перечитает актуальное состояние.
  chrome.runtime.sendMessage({ action: 'kinoWatchSessionChanged', tabId })
    .catch(() => {}); // Если popup/панель закрыты, это нормально.
}

async function getSession(tabId) {
  const key = sessionKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function saveSession(tabId, session) {
  await chrome.storage.session.set({ [sessionKey(tabId)]: session });
}

async function clearSession(tabId) {
  await chrome.storage.session.remove(sessionKey(tabId));
  notifyWatchSessionChanged(tabId);
}

async function startSession({ tabId, returnUrl, watchUrl, type, id, title = '' }) {
  if (!Number.isInteger(tabId) || !returnUrl || !watchUrl || !type || !id) {
    throw new Error("Недостаточно данных для запуска просмотра");
  }

  const recognizedOrigins = [
    getOrigin(watchUrl),
    getOrigin(WATCH_BASE),
    getOrigin(FALLBACK_WATCH_BASE)
  ].filter(Boolean);

  const now = Date.now();
  const session = {
    tabId,
    returnUrl,
    watchUrl,
    type,
    id,
    title: String(title || '').replace(/\s+/g, ' ').trim(),
    startedAt: now,
    lastNavigationAt: now,
    currentUrl: watchUrl,
    recognizedOrigins: [...new Set(recognizedOrigins)]
  };

  await saveSession(tabId, session);
  await rememberWatchOrigin(watchUrl);
  notifyWatchSessionChanged(tabId);
  return session;
}

async function getOrRecoverSession(tabId) {
  const session = await getSession(tabId);
  if (session) return session;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }

  if (!tab?.url || !(await isRecoverableWatchUrl(tab.url))) return null;

  const media = parseMedia(tab.url);
  return startSession({
    tabId,
    returnUrl: `${KINOPOISK_BASE}/${media.type}/${media.id}/`,
    watchUrl: tab.url,
    type: media.type,
    id: media.id,
    title: tab.title || ''
  });
}

function isRedirectNavigation(details) {
  const qualifiers = details.transitionQualifiers || [];
  return qualifiers.includes("server_redirect") || qualifiers.includes("client_redirect");
}

function isKnownWatchOrigin(session, url) {
  const origin = getOrigin(url);
  return Boolean(origin && session.recognizedOrigins.includes(origin));
}

async function handleCommittedNavigation(details) {
  if (details.frameId !== 0) return;

  const session = await getSession(details.tabId);
  if (!session) return;

  const { url } = details;
  const now = Date.now();
  const withinRedirectWindow = now - session.startedAt <= REDIRECT_WINDOW_MS;

  // Новая вкладка для Случайного/истории сначала создаётся как about:blank,
  // чтобы успеть сохранить контекст до её активации.
  if (url === "about:blank" && withinRedirectWindow) return;

  // Возврат на Кинопоиск завершает сессию просмотра.
  if (url.startsWith(KINOPOISK_BASE)) {
    await clearSession(details.tabId);
    return;
  }

  const knownOrigin = isKnownWatchOrigin(session, url);
  const matchingMediaDuringRedirect = withinRedirectWindow && sameMedia(session, url);
  const redirectDuringWindow = withinRedirectWindow && isRedirectNavigation(details);

  // Принимаем только URL, который является частью уже известной цепочки,
  // подтвержденным redirect-событием сразу после запуска или содержит
  // ожидаемый film/series ID во время короткого окна перехода.
  if (!knownOrigin && !matchingMediaDuringRedirect && !redirectDuringWindow) {
    await clearSession(details.tabId);
    return;
  }

  const nextOrigins = new Set(session.recognizedOrigins);
  const origin = getOrigin(url);
  if (origin && (knownOrigin || matchingMediaDuringRedirect || redirectDuringWindow)) {
    nextOrigins.add(origin);
    await rememberWatchOrigin(url);
  }

  await saveSession(details.tabId, {
    ...session,
    currentUrl: url,
    lastNavigationAt: now,
    recognizedOrigins: [...nextOrigins]
  });
  notifyWatchSessionChanged(details.tabId);
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("КиноПомощник: service worker установлен");
});

chrome.webNavigation.onCommitted.addListener(details => {
  handleCommittedNavigation(details).catch(error => {
    console.warn("КиноПомощник: ошибка отслеживания навигации", error);
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  clearSession(tabId).catch(() => {});
});


function comparableFilterUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.searchParams.delete('page');
    url.searchParams.delete('ysclid');
    [...url.searchParams.keys()].forEach(key => {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    });
    const entries = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
      ak.localeCompare(bk) || av.localeCompare(bv)
    );
    url.search = '';
    entries.forEach(([key, value]) => url.searchParams.append(key, value));
    return url.href;
  } catch {
    return String(rawUrl || '');
  }
}

async function waitForFilterTab(tabId, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && /\/lists\/movies\//.test(tab.url || '')) {
      await new Promise(resolve => setTimeout(resolve, 700));
      return tab;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Служебная вкладка Кинопоиска не успела загрузиться');
}

async function scrapeFilterPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

      const targets = [
        { key: 'country', title: 'Страны', resetLabel: 'Все страны' },
        { key: 'genre', title: 'Жанры', resetLabel: 'Все жанры' },
        { key: 'year', title: 'Годы', resetLabel: 'Все годы' }
      ];

      const resetUrlFor = key => {
        const url = new URL(location.href);
        const parts = url.pathname
          .slice('/lists/movies/'.length)
          .split('/')
          .filter(Boolean)
          .filter(segment => !segment.startsWith(`${key}--`));
        url.pathname = `/lists/movies/${parts.length ? `${parts.join('/')}/` : ''}`;
        url.searchParams.delete('page');
        url.hash = '';
        return url.href;
      };

      const buildUrlFromValue = (target, value) => {
        if (value == null || value === '') return null;
        const raw = String(value).trim();
        if (!raw || raw.length > 80) return null;

        if (target.key === 'country' && !/^\d+$/.test(raw)) return null;
        if (target.key === 'genre' && !/^[a-z0-9_-]+$/i.test(raw)) return null;
        if (target.key === 'year' && !/^\d{4}(?:[-_]\d{4})?$/.test(raw)) return null;

        const url = new URL(resetUrlFor(target.key));
        const segments = url.pathname
          .slice('/lists/movies/'.length)
          .split('/')
          .filter(Boolean)
          .filter(segment => !segment.startsWith(`${target.key}--`));
        segments.push(`${target.key}--${raw}`);
        url.pathname = `/lists/movies/${segments.join('/')}/`;
        return url.href;
      };

      const readSsrFilterGroups = () => {
        const groups = {};
        const marker = 'window.Ya.__ssr_initial_data = ';

        for (const script of document.scripts) {
          const text = script.textContent || '';
          const markerIndex = text.indexOf(marker);
          if (markerIndex < 0) continue;

          const rawJson = text
            .slice(markerIndex + marker.length)
            .trim()
            .replace(/;\s*$/, '');

          let initialData;
          try {
            initialData = JSON.parse(rawJson);
          } catch {
            continue;
          }

          const apolloState = initialData?.apolloState;
          if (!apolloState || typeof apolloState !== 'object') continue;

          for (const target of targets) {
            const filter = apolloState[`SingleSelectFilter:${target.key}`];
            if (!filter || typeof filter !== 'object') continue;

            const lists = Object.entries(filter)
              .filter(([key, value]) =>
                key.startsWith('values(') && Array.isArray(value?.items)
              )
              .map(([, value]) => value.items)
              .sort((left, right) => right.length - left.length);

            const items = lists[0] || [];
            const optionMap = new Map();

            for (const item of items) {
              if (!item || item.selectable === false) continue;

              const label = clean(
                item.name?.russian ||
                item.label ||
                item.title ||
                item.text
              );
              const url = buildUrlFromValue(target, item.value);

              if (!label || label.length > 80 || !url) continue;
              optionMap.set(String(item.value), { label, url });
            }

            if (!optionMap.size) continue;

            groups[target.key] = {
              key: `path:${target.key}`,
              title: clean(filter.name?.russian) || target.title,
              resetLabel: clean(filter.hint?.russian) || target.resetLabel,
              resetUrl: resetUrlFor(target.key),
              options: [...optionMap.values()]
            };
          }
        }

        return groups;
      };

      const normalizeFilterUrl = (raw, target) => {
        if (typeof raw !== 'string' || !raw) return null;
        const cleaned = raw
          .replace(/\\u002F/gi, '/')
          .replace(/\\\//g, '/')
          .replace(/&amp;/g, '&');
        try {
          const url = new URL(cleaned, location.href);
          if (!/^(?:www\.)?kinopoisk\.ru$/i.test(url.hostname)) return null;
          if (!url.pathname.startsWith('/lists/movies/')) return null;
          if (!url.pathname.includes(`${target.key}--`)) return null;
          url.protocol = 'https:';
          url.hostname = 'www.kinopoisk.ru';
          url.hash = '';
          url.searchParams.delete('page');
          return url.href;
        } catch {
          return null;
        }
      };

      const reactRoots = (...nodes) => {
        const roots = [];
        const seen = new Set();
        for (const node of nodes.filter(Boolean)) {
          let current = node;
          for (let up = 0; current && up < 3; up += 1, current = current.parentElement) {
            for (const propName of Object.getOwnPropertyNames(current)) {
              if (!propName.startsWith('__reactProps$') && !propName.startsWith('__reactFiber$')) continue;
              let value;
              try { value = current[propName]; } catch { continue; }
              if (value && !seen.has(value)) {
                seen.add(value);
                roots.push(value);
              }
            }
          }
        }
        return roots;
      };

      const findDirectUrl = (root, target, maxDepth = 9) => {
        const seen = new Set();
        let visited = 0;
        const walk = (value, depth) => {
          if (value == null || depth > maxDepth || visited > 30000) return null;
          visited += 1;
          if (typeof value === 'string') return normalizeFilterUrl(value, target);
          if (typeof value !== 'object' && typeof value !== 'function') return null;
          if (seen.has(value)) return null;
          seen.add(value);
          let keys;
          try { keys = Object.keys(value).slice(0, 120); } catch { return null; }
          for (const key of keys) {
            let child;
            try { child = value[key]; } catch { continue; }
            const found = walk(child, depth + 1);
            if (found) return found;
          }
          return null;
        };
        return walk(root, 0);
      };

      const valueScore = (key, value, target) => {
        const name = String(key || '').toLowerCase();
        const raw = String(value ?? '').trim();
        if (!raw) return -1;

        if (target.key === 'country') {
          if (!/^\d+$/.test(raw)) return -1;
          if (name === 'countryid' || name === 'country_id') return 120;
          if (name === 'value') return 110;
          if (name === 'id') return 90;
          if (name.includes('country')) return 80;
          return -1;
        }

        if (target.key === 'genre') {
          if (!/^[a-z0-9_-]+$/i.test(raw)) return -1;
          if (name === 'slug') return 120;
          if (name === 'value') return 110;
          if (name === 'genre') return 105;
          if (name === 'genreid' || name === 'genre_id') return 100;
          if (name === 'code') return 90;
          return -1;
        }

        if (target.key === 'year') {
          if (!/^\d{4}(?:[-_]\d{4})?$/.test(raw)) return -1;
          if (name === 'year') return 120;
          if (name === 'value') return 110;
          if (name === 'id') return 80;
          return -1;
        }
        return -1;
      };

      const findValueNearLabel = (roots, label, target) => {
        let best = null;
        const seen = new Set();
        let visited = 0;

        const walk = (value, depth) => {
          if (value == null || depth > 10 || visited > 50000) return;
          visited += 1;
          if (typeof value !== 'object' && typeof value !== 'function') return;
          if (seen.has(value)) return;
          seen.add(value);

          let keys;
          try { keys = Object.keys(value).slice(0, 140); } catch { return; }
          const entries = [];
          for (const key of keys) {
            let child;
            try { child = value[key]; } catch { continue; }
            entries.push([key, child]);
          }

          const hasLabel = entries.some(([, child]) =>
            typeof child === 'string' && clean(child) === label
          );

          if (hasLabel) {
            for (const [key, child] of entries) {
              if (typeof child !== 'string' && typeof child !== 'number') continue;
              const score = valueScore(key, child, target);
              if (score >= 0 && (!best || score > best.score)) {
                best = { score, value: String(child) };
              }
            }
            const direct = findDirectUrl(value, target, 4);
            if (direct) best = { score: 1000, url: direct };
          }

          for (const [, child] of entries) {
            if (child && (typeof child === 'object' || typeof child === 'function')) {
              walk(child, depth + 1);
            }
          }
        };

        roots.forEach(root => walk(root, 0));
        return best;
      };

      const resolveOptionUrl = (option, menu, trigger, target, label) => {
        if (label === target.resetLabel) return resetUrlFor(target.key);

        const roots = reactRoots(option, menu, trigger);
        for (const root of roots) {
          const direct = findDirectUrl(root, target);
          if (direct) return direct;
        }

        const matched = findValueNearLabel(roots, label, target);
        if (matched?.url) return matched.url;
        if (matched?.value) return buildUrlFromValue(target, matched.value);
        return null;
      };

      const waitForListbox = async trigger => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const controlledId = trigger.getAttribute('aria-controls');
          const byId = controlledId ? document.getElementById(controlledId) : null;
          const byLabel = document.querySelector(
            `[role="listbox"][aria-label="${CSS.escape(trigger.getAttribute('aria-label') || '')}"]`
          );
          const listbox = byId || byLabel;
          if (listbox && listbox.querySelector('[role="option"]')) return listbox;
          await delay(100);
        }
        return null;
      };

      // Кинопоиск хранит полный каталог закрытых dropdown в SSR Apollo cache.
      // Он формируется отдельно для текущего URL (?b=films / ?b=series),
      // поэтому не смешиваем варианты фильмов и сериалов. DOM-разбор ниже
      // остаётся резервом на случай изменения структуры initial data.
      const groups = readSsrFilterGroups();
      const diagnostics = {};

      for (const target of targets) {
        if (groups[target.key]?.options?.length) {
          diagnostics[target.key] = {
            source: 'ssr',
            resolved: groups[target.key].options.length
          };
          continue;
        }

        const trigger = document.querySelector(
          `button[role="combobox"][aria-label="${CSS.escape(target.title)}"]`
        );

        if (!trigger) {
          diagnostics[target.key] = { error: 'combobox not found' };
          continue;
        }

        let openedByUs = false;
        try {
          if (trigger.getAttribute('aria-expanded') !== 'true') {
            trigger.click();
            openedByUs = true;
          }

          const listbox = await waitForListbox(trigger);
          if (!listbox) {
            diagnostics[target.key] = { error: 'listbox not found' };
            continue;
          }

          const optionNodes = [...listbox.querySelectorAll('[role="option"]')];
          const options = [];
          const unresolved = [];

          for (const option of optionNodes) {
            const label = clean(option.getAttribute('aria-label') || option.textContent);
            if (!label || label.length > 80) continue;
            const url = resolveOptionUrl(option, listbox, trigger, target, label);
            if (!url) {
              unresolved.push(label);
              continue;
            }
            options.push({
              label,
              url,
              selected: option.getAttribute('aria-selected') === 'true'
            });
          }

          diagnostics[target.key] = {
            source: 'dom',
            total: optionNodes.length,
            resolved: options.length,
            unresolved: unresolved.slice(0, 12)
          };

          if (options.length) {
            groups[target.key] = {
              key: `path:${target.key}`,
              title: target.title,
              resetLabel: target.resetLabel,
              resetUrl: resetUrlFor(target.key),
              options: options.filter(option => option.label !== target.resetLabel)
            };
          }
        } finally {
          if (openedByUs && trigger.getAttribute('aria-expanded') === 'true') {
            try { trigger.click(); } catch {}
            await delay(80);
          }
        }
      }

      return {
        html: document.documentElement.outerHTML,
        url: location.href,
        groups,
        diagnostics
      };
    }
  });

  const page = results?.[0]?.result;
  if (!page?.html || !page?.url) throw new Error('Не удалось прочитать DOM Кинопоиска');
  console.log('[KinoHelper filters] listbox scrape:', page.diagnostics || {});
  return page;
}

async function fetchFilterPage(url) {
  const requestedUrl = String(url || '');
  if (!requestedUrl.startsWith('https://www.kinopoisk.ru/lists/movies/')) {
    throw new Error('Недопустимый URL фильтров');
  }

  const existing = await chrome.tabs.query({
    url: ['https://www.kinopoisk.ru/lists/movies/*', 'https://kinopoisk.ru/lists/movies/*']
  });
  const matching = existing.find(tab => Number.isInteger(tab.id) && !tab.discarded && tab.url &&
    comparableFilterUrl(tab.url) === comparableFilterUrl(requestedUrl));

  let tabId = matching?.id ?? null;
  let created = false;
  try {
    if (!Number.isInteger(tabId)) {
      const tab = await chrome.tabs.create({ url: requestedUrl, active: false });
      tabId = tab.id;
      created = true;
    }
    if (!Number.isInteger(tabId)) throw new Error('Не удалось создать служебную вкладку');
    await waitForFilterTab(tabId);
    return await scrapeFilterPage(tabId);
  } finally {
    if (created && Number.isInteger(tabId)) {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
  }
}

// Если HTML-ответ поиска пустой (SPA/ограничения fetch), читаем страницу в фоновой вкладке.
async function fetchTitleSearchPage(rawUrl) {
  const url = new URL(String(rawUrl || ''));
  if (url.origin !== 'https://www.kinopoisk.ru' ||
      url.pathname !== '/index.php' ||
      !url.searchParams.has('kp_query') ||
      (url.searchParams.get('kp_query') || '').trim().length < 2 ||
      (url.searchParams.get('kp_query') || '').length > 100) {
    throw new Error('Недопустимый поисковый запрос');
  }

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: url.href, active: false });
    tabId = tab.id;
    if (!Number.isInteger(tabId)) throw new Error('Не удалось создать вкладку поиска');

    const startedAt = Date.now();
    let loaded = false;
    while (Date.now() - startedAt < 12000) {
      const currentTab = await chrome.tabs.get(tabId);
      if (currentTab.status === 'complete') {
        loaded = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!loaded) throw new Error('Кинопоиск не ответил вовремя');
    await new Promise(resolve => setTimeout(resolve, 500));

    const script = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        html: document.documentElement.outerHTML
      })
    });
    const page = script?.[0]?.result;
    if (!page?.html) throw new Error('Не удалось прочитать страницу поиска');
    return page;
  } finally {
    if (Number.isInteger(tabId)) {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.action === "fetchTitleSearchPage") {
    fetchTitleSearchPage(message.payload?.url)
      .then(page => sendResponse({ ok: true, page }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "fetchFilterPage") {
    fetchFilterPage(message.payload?.url)
      .then(page => sendResponse({ ok: true, page }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "startWatchSession") {
    startSession(message.payload)
      .then(session => sendResponse({ ok: true, session }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "getWatchSession") {
    getOrRecoverSession(message.tabId)
      .then(session => sendResponse({ ok: true, session }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "endWatchSession") {
    clearSession(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "findPosterOnMoviePage") {
    findPosterOnMoviePage(message.payload)
      .then(details => sendResponse({ ok: true, ...details }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "loadSearchPoster") {
    loadSearchPoster(message.payload)
      .then(dataUrl => sendResponse({ ok: true, dataUrl }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "searchMovieTitles") {
    searchMovieTitles(message.payload)
      .then(movies => sendResponse({ ok: true, movies }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "getSearchMovieMetadata") {
    getSearchMovieMetadata(message.payload)
      .then(metadata => sendResponse({ ok: true, metadata }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "getMovieRating") {
    getMovieRating(message.payload)
      .then(rating => sendResponse({ ok: true, ...rating }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action === "setMovieRating") {
    setMovieRating(message.payload)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});


// Переключение способа открытия расширения: popup / боковая панель.
// Не затрагивает поиск, историю, темы и правила фильтров.
const DISPLAY_MODE_STORAGE_KEY = 'kinoHelperDisplayMode';
const normalizeDisplayMode = value => value === 'sidepanel' ? 'sidepanel' : 'popup';

async function applyDisplayMode(mode) {
  if (mode === 'sidepanel') {
    await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
    // В Chrome popup имеет приоритет над открытием Side Panel по значку.
    await chrome.action.setPopup({ popup: '' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } else {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    await chrome.action.setPopup({ popup: 'popup.html' });
  }
}

// Последовательное применение защищает от гонки при старте service worker
// и при быстром переключении режима в настройках.
let displayModeChange = chrome.storage.local.get(DISPLAY_MODE_STORAGE_KEY)
  .then(data => applyDisplayMode(
    normalizeDisplayMode(data[DISPLAY_MODE_STORAGE_KEY])
  ))
  .catch(error => console.warn('[KinoHelper] Восстановление режима:', error));

function changeDisplayMode(mode) {
  displayModeChange = displayModeChange.catch(() => {}).then(async () => {
    await applyDisplayMode(mode);
    await chrome.storage.local.set({ [DISPLAY_MODE_STORAGE_KEY]: mode });
    return mode;
  });
  return displayModeChange;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action !== 'setKinoHelperDisplayMode') return false;
  const mode = normalizeDisplayMode(message?.mode);
  changeDisplayMode(mode)
    .then(() => sendResponse({ ok: true, mode }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});


// -------------------------
// Resume playback: passive, manifest-scoped film autosave.
// No player control or seek. Series deliberately excluded until episode identity
// is independently verified, to prevent restoring an unrelated episode.
// -------------------------
const RESUME_STORAGE_KEY = 'kinoPlaybackProgressV1';
const RESUME_PLAYER_ORIGIN = 'https://theatre.stravers.live/*';
const RESUME_PLAYER_HOST = 'theatre.stravers.live';
const RESUME_MAX_ENTRIES = 120;
const PENDING_RESUME_PREFIX = 'kinoResumePending:';
const PENDING_RESUME_TTL = 120000;
function pendingResumeKey(tabId) {
  return PENDING_RESUME_PREFIX + tabId;
}
let resumeWriteQueue = Promise.resolve();

function resumeOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

function resumeSourceIsTrusted(sender) {
  return sender?.id === chrome.runtime.id &&
    Number.isInteger(sender?.tab?.id) &&
    resumeOrigin(sender.url) === 'https://' + RESUME_PLAYER_HOST;
}

async function resumeIdentifyFilm(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) return null;
  const origin = resumeOrigin(tab.url);
  // Recovered session may have no longer existed after redirect. A stable
  // /film/<id> path on the known parent site is an independent identity.
  const direct = parseMedia(tab.url);
  // An explicit series URL must NEVER inherit an old film watch session.
  if (direct && direct.type !== 'film') return null;
  if (direct?.type === 'film' &&
      [resumeOrigin(WATCH_BASE), resumeOrigin(FALLBACK_WATCH_BASE),
        'https://brogiro.cfd'].includes(origin)) {
    const session = await getSession(tabId);
    // Series players sometimes use /film/<id>. A verified series session or
    // a still-valid player episode selection overrides that route.
    if (session?.type === 'series' && session.currentUrl === tab.url)
      return null;
    const evidence = (await chrome.storage.session.get(episodeKey(tabId)))
      [episodeKey(tabId)];
    if (resolvedEpisode(evidence, direct.id)) return null;
    // An existing session for another movie must never attach its title.
    const title = session?.type === 'film' && String(session.id) === direct.id
      ? session.title : '';
    return { id: direct.id, title: title || tab.title || '' };
  }

  const session = await getSession(tabId);
  if (session?.type !== 'film' || !/^\d+$/.test(String(session.id))) return null;
  // The active top-level page must be a known step in the tracked watch chain.
  if (!Array.isArray(session.recognizedOrigins) ||
      !session.recognizedOrigins.includes(origin) ||
      session.currentUrl !== tab.url ||
      origin === KINOPOISK_BASE) return null;
  return { id: String(session.id), title: session.title || tab.title || '' };
}

function validatePlaybackEvent(data) {
  if (!data || typeof data !== 'object') return null;
  const position = Number(data.currentTime);
  const duration = Number(data.duration);
  const played = Number(data.playedSeconds);
  const event = data.event;
  if (!Number.isFinite(position) || !Number.isFinite(duration) ||
      !Number.isFinite(played) || played < 2 ||
      duration < 60 || duration > 8 * 3600 ||
      position < 1 || position > duration + 2 ||
      !['playing', 'pause', 'seeked', 'hidden', 'pagehide', 'ended'].includes(event)) return null;
  return { position: Math.min(Math.floor(position), Math.floor(duration)),
    duration: Math.floor(duration), played, event };
}


async function armResumeForTab(tabId, filmId, sender) {
  if (sender?.id !== chrome.runtime.id ||
      !sender?.url?.startsWith(chrome.runtime.getURL('')) ||
      !Number.isInteger(tabId) || tabId < 0 ||
      !/^[1-9]\d{0,12}$/.test(String(filmId))) {
    return { ok: false, reason: 'untrusted request' };
  }

  const session = await getSession(tabId);
  if (session?.type !== 'film' || String(session.id) !== String(filmId) ||
      Date.now() - session.startedAt > 60000) {
    return { ok: false, reason: 'watch session mismatch' };
  }
  const raw = (await chrome.storage.local.get(RESUME_STORAGE_KEY))[RESUME_STORAGE_KEY];
  const entry = raw?.['film:' + filmId];
  if (!entry || entry.completed || entry.type !== 'film' ||
      String(entry.id) !== String(filmId) ||
      !Number.isFinite(entry.duration) || entry.duration < 60 ||
      !Number.isFinite(entry.position) || entry.position < 10 ||
      entry.position > entry.duration - 25) {
    return { ok: false, reason: 'no resumable progress' };
  }
  await chrome.storage.session.set({
    [pendingResumeKey(tabId)]: {
      filmId: String(filmId), position: entry.position,
      duration: entry.duration, createdAt: Date.now()
    }
  });
  return { ok: true, position: entry.position };
}

async function readPendingResume(sender) {
  if (!resumeSourceIsTrusted(sender)) return null;
  const tabId = sender.tab.id;
  const key = pendingResumeKey(tabId);
  const raw = (await chrome.storage.session.get(key))[key];
  if (!raw) return null;
  if (!Number.isFinite(raw.createdAt) ||
      Date.now() - raw.createdAt > PENDING_RESUME_TTL) {
    await chrome.storage.session.remove(key);
    return null;
  }
  const film = await resumeIdentifyFilm(tabId);
  if (!film || String(film.id) !== raw.filmId) return null;
  return { filmId: raw.filmId, position: raw.position, duration: raw.duration };
}

async function acknowledgeResume(sender, position) {
  const raw = await readPendingResume(sender);
  if (!raw || !Number.isFinite(position) || Math.abs(position - raw.position) > 4)
    return { ok: false };
  await chrome.storage.session.remove(pendingResumeKey(sender.tab.id));
  return { ok: true };
}

async function saveResumeProgress(payload, sender) {
  const item = validatePlaybackEvent(payload);
  if (!item || !resumeSourceIsTrusted(sender)) {
    return { ok: false, skipped: 'invalid source or progress' };
  }
  // A still-open content script must stop writing immediately after the user
  // revokes host permission, even before that page is reloaded.
  const allowed = await chrome.permissions.contains({
    origins: [RESUME_PLAYER_ORIGIN]
  });
  if (!allowed) return { ok: false, skipped: 'player access revoked' };
  // A series may use a film-looking URL. An armed series restoration
  // prevents any film progress from contaminating the same media ID.
  const seriesPending = (await chrome.storage.session.get(seriesPendingKey(sender.tab.id)))
    [seriesPendingKey(sender.tab.id)];
  if (seriesPending && Date.now() - seriesPending.createdAt < SERIES_PENDING_TTL_MS)
    return {ok:false,skipped:'series restoration active'};
  const film = await resumeIdentifyFilm(sender.tab.id);
  if (!film) return { ok: false, skipped: 'movie identification unavailable' };
  const pending = (await chrome.storage.session.get(pendingResumeKey(sender.tab.id)))
    [pendingResumeKey(sender.tab.id)];
  // During restoration, don't replace the checkpoint with the new video's 0:00.
  if (pending && Date.now() - pending.createdAt < PENDING_RESUME_TTL &&
      pending.filmId === String(film.id)) {
    return { ok: false, skipped: 'restoring saved position' };
  }
  const key = 'film:' + film.id;
  const safeTitle = String(film.title || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (key.length > 40) return { ok: false, skipped: 'invalid movie id' };

  // Serialize writes to prevent a racing old storage snapshot from overwriting
  // another tab's progress. No storage API calls from the iframe itself.
  const write = async () => {
    const store = await chrome.storage.local.get(RESUME_STORAGE_KEY);
    const entries = store[RESUME_STORAGE_KEY] &&
      typeof store[RESUME_STORAGE_KEY] === 'object' &&
      !Array.isArray(store[RESUME_STORAGE_KEY])
      ? { ...store[RESUME_STORAGE_KEY] } : {};
    const older = entries[key];
    const coverage = await rememberPlaybackCoverage(key,item,payload);
    const completed = playbackCompletionStatus(item, older, coverage);

    // If playback restarted from the beginning after completion, a new
    // verified session creates a fresh unfinished entry.
    entries[key] = {
      type: 'film',
      id: film.id,
      title: safeTitle || older?.title || 'Фильм №' + film.id,
      position: item.position,
      duration: item.duration,
      updatedAt: Date.now(),
      completed,
      source: RESUME_PLAYER_HOST
    };

    const kept = Object.entries(entries)
      .filter(([id, value]) => /^film:\d+$/.test(id) &&
        value && Number.isFinite(value.updatedAt))
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, RESUME_MAX_ENTRIES);
    await chrome.storage.local.set({
      [RESUME_STORAGE_KEY]: Object.fromEntries(kept)
    });
    return { ok: true, key, position: item.position, completed,
      newlyCompleted: completed && !Boolean(older?.completed) };
  };
  const result = resumeWriteQueue.then(write, write);
  resumeWriteQueue = result.catch(error => {
    console.warn('[KinoHelper] Не удалось сохранить таймкод:', error);
  });
  return result;
}

// The tracker now loads declaratively from manifest.content_scripts.
// On extension update, inject once into already-open matching iframe documents.
// The script has a global guard against double initialization.
async function injectResumeIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      const ids = (frames || []).filter(frame =>
        resumeOrigin(frame.url) === 'https://' + RESUME_PLAYER_HOST)
        .map(frame => frame.frameId);
      if (ids.length) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: ids },
          files: ['playback-tracker.js', 'playback-resume.js',
            'series-progress-tracker.js', 'series-playback-resume.js'],
          world: 'ISOLATED'
        });
      }
      const episodeFrames = (frames || []).filter(frame =>
        ['https://brogiro.cfd', 'https://theatre.stravers.live']
          .includes(resumeOrigin(frame.url)))
        .map(frame => frame.frameId);
      if (episodeFrames.length) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: episodeFrames },
          files: ['episode-detector.js'],
          world: 'ISOLATED'
        });
      }
    } catch {
      // Tab may close or its iframe may navigate during extension update.
    }
  }
}

async function migrateLegacyResumeRegistration() {
  // 1.545/1.546 registered this script dynamically. 1.547 uses the manifest.
  // Remove the old registration to avoid extra work or duplicate injections.
  const legacyId = 'kino-playback-tracker-v1';
  try {
    const old = await chrome.scripting.getRegisteredContentScripts({ ids: [legacyId] });
    if (old.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [legacyId] });
    }
  } catch (error) {
    console.warn('[KinoHelper] Не удалось удалить старую регистрацию:', error);
  }
}

async function prepareResumeTracking() {
  await migrateLegacyResumeRegistration();
  await injectResumeIntoOpenTabs();
}

chrome.runtime.onInstalled.addListener(() => {
  void prepareResumeTracking().catch(error =>
    console.warn('[KinoHelper] Не удалось подключить отслеживание после обновления:', error));
});
chrome.runtime.onStartup.addListener(() => {
  void prepareResumeTracking().catch(error =>
    console.warn('[KinoHelper] Не удалось подключить отслеживание после запуска:', error));
});

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(pendingResumeKey(tabId)).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'kinoResumeArm') {
    armResumeForTab(message.tabId, message.filmId, sender)
      .then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.action === 'kinoResumeGetPending') {
    readPendingResume(sender)
      .then(value => sendResponse({ ok: Boolean(value), pending: value }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.action === 'kinoResumeAcknowledge') {
    acknowledgeResume(sender, Number(message.position))
      .then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.action !== 'kinoPlaybackProgress') return false;
  saveResumeProgress(message.payload, sender)
    .then(async result => {
      // Count only playback samples already accepted as verified film progress.
      if (result?.ok) {
        await statsRememberCompletion(result.key, result.completed)
          .catch(error => console.warn('[KinoHelper stats] Film catalog:', error));
        if (result.newlyCompleted &&
            typeof self !== 'undefined' &&
            self.KinoWatchlistAutoComplete?.onFilmCompleted) {
          await self.KinoWatchlistAutoComplete.onFilmCompleted(result.key)
            .catch(error => console.warn('[KinoHelper] Auto watchlist transfer:',error));
        }
        await statsRecordVerifiedTime(result.key, message.payload)
          .catch(error => console.warn('[KinoHelper stats] Film time:', error));
      }
      sendResponse(result);
    })
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});


// 1.550: season/episode recognition is read-only and kept in session memory.
// A series timecode is NOT saved or restored until real player selection is
// verified: wrong episodes can have identical durations.
const EPISODE_KEY_PREFIX = 'kinoEpisodeSelection:';
const EPISODE_TTL_MS = 20000;
const episodeKey = tabId => EPISODE_KEY_PREFIX + tabId;

function originOfEpisodeSender(sender) {
  return resumeOrigin(sender?.url);
}

async function trustedSeriesTab(tabId, { playerConfirmed = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) return null;
  const origin = resumeOrigin(tab.url);
  if (!['https://brogiro.cfd', resumeOrigin(WATCH_BASE),
    resumeOrigin(FALLBACK_WATCH_BASE)].includes(origin)) return null;
  const direct = parseMedia(tab.url);
  const session = await getSession(tabId);

  if (direct?.type === 'series') {
    if (session && (session.type !== 'series' ||
        String(session.id) !== String(direct.id))) return null;
    return { id: String(direct.id), title: session?.title || tab.title || '' };
  }

  if (direct?.type === 'film') {
    // The provider uses /film/<id> even for confirmed series. Never infer
    // a series merely from its URL/title. Require a fresh episode selection
    // from the trusted player iframe (or its existing verified observation).
    if (session?.currentUrl === tab.url && session.id != null &&
        String(session.id) !== String(direct.id)) return null;
    const observed = (await chrome.storage.session.get(episodeKey(tabId)))
      [episodeKey(tabId)];
    if (!playerConfirmed && !resolvedEpisode(observed, direct.id)) return null;
    return { id: String(direct.id), title: session?.title || tab.title || '' };
  }

  if (session?.type !== 'series' || !/^[1-9]\d{0,12}$/.test(String(session.id)) ||
      !Array.isArray(session.recognizedOrigins) ||
      !session.recognizedOrigins.includes(origin) ||
      session.currentUrl !== tab.url) return null;
  return { id: String(session.id), title: session.title || tab.title || '' };
}

function resolvedEpisode(entry, seriesId, at = Date.now()) {
  if (!entry || entry.seriesId !== seriesId ||
      !entry.sources || typeof entry.sources !== 'object') return null;
  const values = Object.values(entry.sources).filter(source =>
    source && Number.isInteger(source.season) && Number.isInteger(source.episode) &&
    source.season >= 1 && source.season <= 250 &&
    source.episode >= 1 && source.episode <= 250 &&
    Number.isFinite(source.at) && at - source.at >= 0 &&
    at - source.at <= EPISODE_TTL_MS);
  if (!values.length) return null;
  const identities = new Set(values.map(value => value.season + ':' + value.episode));
  if (identities.size !== 1) return null;
  return { season: values[0].season, episode: values[0].episode };
}

async function saveEpisodeObservation(payload, sender) {
  if (sender?.id !== chrome.runtime.id ||
      !Number.isInteger(sender.tab?.id) ||
      !Number.isInteger(sender.frameId) ||
      !['https://brogiro.cfd', 'https://theatre.stravers.live']
        .includes(originOfEpisodeSender(sender))) return { ok: false };
  const clearing = payload?.clear === true;
  const season = clearing ? null : Number(payload?.season);
  const episode = clearing ? null : Number(payload?.episode);
  if (!clearing && (!Number.isInteger(season) || season < 1 || season > 250 ||
      !Number.isInteger(episode) || episode < 1 || episode > 250)) {
    return { ok: false };
  }

  const tabId = sender.tab.id;
  // The iframe's own selected season and episode are sufficient evidence
  // to classify a /film/<id> route as a series for this particular tab.
  const series = await trustedSeriesTab(tabId, {
    playerConfirmed: !clearing &&
      originOfEpisodeSender(sender) === 'https://theatre.stravers.live'
  });
  if (!series) return { ok: false };
  const key = episodeKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  const before = resolvedEpisode(stored, series.id);
  const at = Date.now();
  const sources = stored?.seriesId === series.id && stored?.sources
    ? { ...stored.sources } : {};
  for (const [frame, data] of Object.entries(sources)) {
    if (!data || at - data.at > EPISODE_TTL_MS || at < data.at) delete sources[frame];
  }
  if (clearing) delete sources[String(sender.frameId)];
  else sources[String(sender.frameId)] = { season, episode, at };
  const next = { seriesId: series.id, sources };
  if (!Object.keys(sources).length) await chrome.storage.session.remove(key);
  else await chrome.storage.session.set({ [key]: next });
  const after = resolvedEpisode(next, series.id);
  if (before?.season !== after?.season || before?.episode !== after?.episode) {
    chrome.runtime.sendMessage({ action: 'kinoEpisodeSelectionChanged', tabId })
      .catch(() => {});
  }
  return { ok: true, confirmed: Boolean(after) };
}

async function getEpisodeIdentity(tabId, sender) {
  if (sender?.id !== chrome.runtime.id ||
      !sender?.url?.startsWith(chrome.runtime.getURL('')) ||
      !Number.isInteger(tabId)) return null;
  const series = await trustedSeriesTab(tabId);
  if (!series) return null;
  const value = (await chrome.storage.session.get(episodeKey(tabId)))
    [episodeKey(tabId)];
  const selection = resolvedEpisode(value, series.id);
  return selection ? { seriesId: series.id, ...selection } : null;
}

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(episodeKey(tabId)).catch(() => {});
});
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId === 0) {
    void chrome.storage.session.remove(episodeKey(details.tabId)).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'kinoSeriesEpisodeObserved') {
    saveEpisodeObservation(message.payload, sender)
      .then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.action === 'kinoGetEpisodeIdentity') {
    getEpisodeIdentity(message.tabId, sender)
      .then(value => sendResponse({ ok: Boolean(value), identity: value }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});


// 1.555 — one-shot episode restoration, distinct from film checkpoints.
// The extension UI arms a specific stored episode BEFORE navigating a new tab.
// The iframe must select and verify that episode before touching currentTime.
const SERIES_PENDING_PREFIX = 'kinoSeriesResumePending:';
const SERIES_PENDING_TTL_MS = 120000;
const seriesPendingKey = tabId => SERIES_PENDING_PREFIX + tabId;

function episodeRecord(seriesId, season, episode, source) {
  const key = 'series:' + seriesId + ':' + season + ':' + episode;
  const item = source?.[key];
  if (!item || item.type !== 'series' || item.completed ||
      String(item.id) !== String(seriesId) ||
      item.season !== season || item.episode !== episode ||
      !Number.isFinite(item.position) || item.position < 10 ||
      !Number.isFinite(item.duration) || item.duration < 60 ||
      item.duration > 8 * 3600 || item.position > item.duration - 25)
    return null;
  return { key, position: item.position, duration: item.duration };
}

async function armSeriesResume(tabId, seriesId, season, episode, sender) {
  if (sender?.id !== chrome.runtime.id ||
      !sender?.url?.startsWith(chrome.runtime.getURL('')) ||
      !Number.isInteger(tabId) || tabId < 0 ||
      !/^[1-9]\d{0,12}$/.test(String(seriesId)) ||
      !Number.isInteger(season) || season < 1 || season > 250 ||
      !Number.isInteger(episode) || episode < 1 || episode > 250)
    return { ok: false, reason: 'invalid resume request' };

  const session = await getSession(tabId);
  if (!session || String(session.id) !== String(seriesId) ||
      Date.now() - session.startedAt > 60000 ||
      !session.watchUrl || !['film','series'].includes(session.type)) {
    return { ok: false, reason: 'watch session does not match series' };
  }
  const urlId = parseMedia(session.watchUrl);
  if (!urlId || urlId.id !== String(seriesId)) {
    return { ok: false, reason: 'watch address does not match series' };
  }
  const items = (await chrome.storage.local.get(SERIES_PROGRESS_KEY))[SERIES_PROGRESS_KEY];
  const checkpoint = episodeRecord(seriesId, season, episode, items);
  if (!checkpoint) return { ok: false, reason: 'no resumable episode checkpoint' };
  await chrome.storage.session.set({
    [seriesPendingKey(tabId)]: {
      seriesId: String(seriesId), season, episode,
      position: checkpoint.position, duration: checkpoint.duration,
      createdAt: Date.now()
    }
  });
  return { ok: true, position: checkpoint.position };
}

async function seriesPendingForFrame(sender) {
  if (!resumeSourceIsTrusted(sender)) return null;
  const tabId = sender.tab.id;
  const key = seriesPendingKey(tabId);
  const data = (await chrome.storage.session.get(key))[key];
  if (!data) return null;
  if (!Number.isFinite(data.createdAt) ||
      Date.now() - data.createdAt >= SERIES_PENDING_TTL_MS) {
    await chrome.storage.session.remove(key);
    return null;
  }
  const tab = await chrome.tabs.get(tabId);
  const route = parseMedia(tab?.url || '');
  const session = await getSession(tabId);
  // /film/ and /series/ are both used for series by this provider.
  if (!route || route.id !== data.seriesId ||
      !session || String(session.id) !== data.seriesId)
    return null;
  return data;
}

async function confirmSeriesSeek(sender, payload) {
  const target = await seriesPendingForFrame(sender);
  if (!target || Number(payload?.season) !== target.season ||
      Number(payload?.episode) !== target.episode ||
      !Number.isFinite(payload?.position) ||
      Math.abs(payload.position - target.position) > 3 ||
      !Number.isFinite(payload?.duration) ||
      Math.abs(payload.duration - target.duration) >
        Math.max(15, target.duration * 0.015)) return {ok:false};

  // The independent episode detector must also confirm the *same* iframe
  // is showing the intended season/episode.
  if (!await episodeSourceMatches(sender.tab.id, sender.frameId,
      target.seriesId, target.season, target.episode)) return {ok:false};

  await chrome.storage.session.remove(seriesPendingKey(sender.tab.id));
  return {ok:true};
}

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(seriesPendingKey(tabId)).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action === 'kinoSeriesResumeArm') {
    armSeriesResume(message.tabId, String(message.seriesId),
      Number(message.season), Number(message.episode), sender)
      .then(respond).catch(error => respond({ok:false,error:error.message}));
    return true;
  }
  if (message?.action === 'kinoSeriesResumeGetPending') {
    seriesPendingForFrame(sender)
      .then(pending => respond({ok:Boolean(pending),pending}))
      .catch(() => respond({ok:false}));
    return true;
  }
  if (message?.action === 'kinoSeriesResumeAcknowledge') {
    confirmSeriesSeek(sender, message.payload)
      .then(respond).catch(() => respond({ok:false}));
    return true;
  }
  return false;
});

// 1.553: Episode checkpoints are isolated from film progress. We write only
// when the iframe's own confirmed selector AND the parent series ID agree.
// No automatic series seeking/selecting in this stage.

// v1.569: only unique *observed* sections count towards 85% eligibility.
// Position alone (including a video "ended" after a seek) never counts.
const PLAYBACK_COVERAGE_KEY = 'kinoPlaybackCoverageV1';
const PLAYBACK_COVERAGE_MAX_RANGES = 512;
const PLAYBACK_COVERAGE_MAX_TITLES = 600;
let playbackCoverageQueue = Promise.resolve();

function unionPlaybackRanges(ranges) {
  const ordered = ranges
    .filter(pair => Array.isArray(pair) && pair.length === 2 &&
      Number.isFinite(pair[0]) && Number.isFinite(pair[1]) &&
      pair[1] > pair[0])
    .sort((a,b) => a[0] - b[0] || a[1] - b[1]);
  const result = [];
  for(const item of ordered) {
    const end = result[result.length - 1];
    if(end && item[0] <= end[1] + 0.05) {
      end[1] = Math.max(end[1],item[1]);
    } else {
      result.push([item[0],item[1]]);
    }
  }
  return result;
}

function playbackCoverageSeconds(ranges) {
  return ranges.reduce((sum,[from,to]) => sum + (to-from),0);
}

function validateObservedRanges(payload, duration) {
  if (!Array.isArray(payload?.watchedRanges) ||
      payload.watchedRanges.length > 64) return [];
  return payload.watchedRanges.filter(pair =>
    Array.isArray(pair) && pair.length === 2 &&
    Number.isFinite(pair[0]) && Number.isFinite(pair[1]) &&
    pair[0] >= 0 && pair[1] <= duration + 0.1 &&
    pair[1] - pair[0] >= 0.05 && pair[1] - pair[0] <= 20
  ).map(([start,end]) => [Math.max(0,start),Math.min(end,duration)]);
}

// Called only after verifying tab identity, permissions, and the active
// film or individual series episode. Serialize writes across tabs/sessions.
function rememberPlaybackCoverage(mediaKey, item, payload) {
  const task = async () => {
    if (!/^(?:film:[1-9]\d{0,12}|series:[1-9]\d{0,12}:\d{1,3}:\d{1,3})$/
      .test(mediaKey)) return {completed:false,seconds:0};
    const fresh = validateObservedRanges(payload,item.duration);
    const stored = (await chrome.storage.local.get(PLAYBACK_COVERAGE_KEY))
      [PLAYBACK_COVERAGE_KEY];
    const all = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? {...stored} : {};
    const old = all[mediaKey];
    const sameDuration = Number.isFinite(old?.duration) &&
      Math.abs(old.duration - item.duration) <=
        Math.max(10,item.duration * 0.015);
    const oldRanges = sameDuration && Array.isArray(old.ranges) ?
      old.ranges.filter(x => Array.isArray(x) && x.length===2 &&
        Number.isFinite(x[0]) && Number.isFinite(x[1]) &&
        x[0]>=0 && x[1]<=item.duration && x[1]>x[0]) : [];
    const ranges = unionPlaybackRanges([...oldRanges,...fresh]);
    // For excessively fragmented histories, retain a conservative bounded
    // subset. Dropping intervals can delay completion, but never invent it.
    const bounded = ranges.length > PLAYBACK_COVERAGE_MAX_RANGES
      ? ranges.slice(-PLAYBACK_COVERAGE_MAX_RANGES) : ranges;
    const seconds = playbackCoverageSeconds(bounded);
    if(fresh.length || !sameDuration) {
      all[mediaKey]={duration:item.duration,ranges:bounded,updatedAt:Date.now()};
      const keys = Object.keys(all);
      if(keys.length > PLAYBACK_COVERAGE_MAX_TITLES) {
        keys.sort((a,b)=>Number(all[b]?.updatedAt||0)-
          Number(all[a]?.updatedAt||0));
        for(const key of keys.slice(PLAYBACK_COVERAGE_MAX_TITLES))delete all[key];
      }
      await chrome.storage.local.set({[PLAYBACK_COVERAGE_KEY]:all});
    }
    // 85% coverage only unlocks a confirmation. It never auto-completes
    // a film that may still have its ending ahead.
    return {seconds,eligible:seconds >= item.duration*0.85};
  };
  const result = playbackCoverageQueue.then(task,task);
  playbackCoverageQueue = result.catch(error => console.warn(
    '[KinoHelper] Coverage save failed:',error));
  return result;
}

function playbackCompletionStatus(item, previous, coverage) {
  // No automatic completion at 85%: the story can still be in progress.
  // An actual player ended event is accepted only after 85% verified unique
  // coverage. The viewer can separately confirm after 85% (UI action).
  const verifiedEnd = item.event === 'ended' && Boolean(coverage?.eligible) &&
    item.position >= item.duration - 5;
  return verifiedEnd || Boolean(previous?.completed &&
    item.position >= item.duration * 0.1);
}
const SERIES_PROGRESS_KEY = 'kinoSeriesEpisodeProgressV1';
const SERIES_PROGRESS_LIMIT = 300;
let seriesProgressQueue = Promise.resolve();

function validateEpisodeProgress(payload) {
  const base = validatePlaybackEvent(payload);
  const season = Number(payload?.season);
  const episode = Number(payload?.episode);
  if (!base || !Number.isInteger(season) || !Number.isInteger(episode) ||
      season < 1 || season > 250 || episode < 1 || episode > 250) return null;
  return { ...base, season, episode };
}

async function episodeSourceMatches(tabId, frameId, seriesId, season, episode) {
  const key = episodeKey(tabId);
  const entry = (await chrome.storage.session.get(key))[key];
  const confirmed = resolvedEpisode(entry, String(seriesId));
  if (!confirmed || confirmed.season !== season || confirmed.episode !== episode)
    return false;
  const source = entry?.sources?.[String(frameId)];
  const at = Date.now();
  return Boolean(source && source.season === season && source.episode === episode &&
    Number.isFinite(source.at) && at >= source.at && at - source.at <= EPISODE_TTL_MS);
}

async function saveSeriesEpisodeProgress(payload, sender) {
  const item = validateEpisodeProgress(payload);
  if (!item || !resumeSourceIsTrusted(sender) || !Number.isInteger(sender.frameId))
    return { ok: false, skipped: 'invalid source or episode' };
  const granted = await chrome.permissions.contains({
    origins: [RESUME_PLAYER_ORIGIN]
  });
  if (!granted) return { ok: false, skipped: 'player permission revoked' };

  const pending = (await chrome.storage.session.get(seriesPendingKey(sender.tab.id)))
    [seriesPendingKey(sender.tab.id)];
  // While selecting an episode / seeking, never replace its saved checkpoint
  // with initial playback from the provider's default episode.
  if (pending && Number.isFinite(pending.createdAt) &&
      Date.now() - pending.createdAt < SERIES_PENDING_TTL_MS) {
    return {ok:false, skipped:'restoring episode selection'};
  }
  const series = await trustedSeriesTab(sender.tab.id);
  if (!series) return { ok: false, skipped: 'not a known series tab' };
  if (!await episodeSourceMatches(sender.tab.id, sender.frameId,
    series.id, item.season, item.episode))
    return { ok: false, skipped: 'unconfirmed selection' };

  const key = 'series:' + series.id + ':' + item.season + ':' + item.episode;
  const write = async () => {
    // Recheck immediately before writing: a queued checkpoint from the
    // previous episode must not be written after the user has switched.
    const current = await trustedSeriesTab(sender.tab.id);
    if (!current || current.id !== series.id ||
        !await episodeSourceMatches(sender.tab.id, sender.frameId,
          series.id, item.season, item.episode))
      return { ok: false, skipped: 'episode changed while queued' };

    const data = (await chrome.storage.local.get(SERIES_PROGRESS_KEY))[SERIES_PROGRESS_KEY];
    const entries = data && typeof data === 'object' && !Array.isArray(data)
      ? { ...data } : {};
    const older = entries[key];
    const coverage = await rememberPlaybackCoverage(key,item,payload);
    const completed = playbackCompletionStatus(item, older, coverage);
    const cleanTitle = String(current.title || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    entries[key] = {
      type: 'series', id: series.id,
      season: item.season, episode: item.episode,
      title: cleanTitle || older?.title || 'Сериал №' + series.id,
      position: item.position, duration: item.duration,
      completed, updatedAt: Date.now()
    };
    const kept = Object.entries(entries)
      .filter(([entryKey, value]) =>
        /^series:[1-9]\d{0,12}:\d{1,3}:\d{1,3}$/.test(entryKey) &&
        value && Number.isFinite(value.updatedAt))
      .sort((a,b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, SERIES_PROGRESS_LIMIT);
    await chrome.storage.local.set({
      [SERIES_PROGRESS_KEY]: Object.fromEntries(kept)
    });
    return { ok: true, key, position: item.position, completed };
  };
  const result = seriesProgressQueue.then(write, write);
  seriesProgressQueue = result.catch(error =>
    console.warn('[KinoHelper] Ошибка сохранения прогресса серии:', error));
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action !== 'kinoSeriesEpisodeProgress') return false;
  saveSeriesEpisodeProgress(message.payload, sender)
    .then(async result => {
      // The episode was verified against the actual player selection.
      if (result?.ok) {
        await statsRememberCompletion(result.key, result.completed)
          .catch(error => console.warn('[KinoHelper stats] Episode catalog:', error));
        await statsRecordVerifiedTime(
          'series:' + String(result.key).split(':')[1], message.payload
        ).catch(error => console.warn('[KinoHelper stats] Series time:', error));
      }
      sendResponse(result);
    })
    .catch(error => sendResponse({ ok:false, error: error.message }));
  return true;
});


// KinoHelper 1.558: wall-clock time actually observed while playing.
// Counters come from trusted content scripts and are accepted ONLY after
// existing film/episode identity and authorization checks have succeeded.
// A seek changes currentTime, but never these cumulative playback counters.
const STATS_TIME_KEY = 'kinoStatsWatchTimeV1';
const STATS_COUNTER_PREFIX = 'kinoStatsCounterV1:';
let statsTimeQueue = Promise.resolve();

function statsRecordVerifiedTime(mediaKey, payload) {
  const task = async () => {
    if (!/^(?:film|series):[1-9]\d{0,12}$/.test(mediaKey)) return;
    const token = String(payload?.statsTrackingId || '');
    const total = Number(payload?.playedSeconds);
    if (!/^[\w-]{20,80}$/.test(token) ||
        !Number.isFinite(total) || total < 2 || total > 1e7) return;

    // Token created on each video/episode change; protects against duplicate
    // asynchronous messages and distinguishes independent playback sessions.
    const counterKey = STATS_COUNTER_PREFIX + token;
    const counter = (await chrome.storage.session.get(counterKey))[counterKey];
    if (counter && counter.mediaKey !== mediaKey) return;
    const before = counter && Number.isFinite(counter.total) ? counter.total : 0;
    if (total <= before) return;
    // Cap unexpectedly large gaps rather than inventing hours on resume,
    // service-worker restarts, or stalled/background tabs.
    const delta = Math.min(total - before, 15);
    const stored = (await chrome.storage.local.get(STATS_TIME_KEY))[STATS_TIME_KEY];
    const items = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? { ...stored } : {};
    const older = items[mediaKey];
    const seconds = Number.isFinite(older?.seconds) && older.seconds >= 0
      ? older.seconds : 0;
    items[mediaKey] = {
      seconds: Math.round((seconds + delta) * 10) / 10,
      updatedAt: Date.now()
    };
    // Local storage is the durable source of truth. Update the dedup counter
    // only after the accumulation was successfully committed.
    await chrome.storage.local.set({ [STATS_TIME_KEY]: items });
    await chrome.storage.session.set({
      [counterKey]: { mediaKey, total, updatedAt: Date.now() }
    });
  };
  const result = statsTimeQueue.then(task, task);
  statsTimeQueue = result.catch(() => {});
  return result;
}


// Keep an unpruned index of verified films and individual series episodes.
// The resume progress stores have intentional 120/300-entry limits; those
// limits must not silently erase lifetime statistics.
const STATS_CATALOG_KEY = 'kinoStatsLibraryV1';
let statsCatalogQueue = Promise.resolve();
function statsRememberCompletion(key, completed) {
  const task = async () => {
    if (!/^(?:film:[1-9]\d{0,12}|series:[1-9]\d{0,12}:\d{1,3}:\d{1,3})$/.test(key))
      return;
    const raw = (await chrome.storage.local.get(STATS_CATALOG_KEY))[STATS_CATALOG_KEY];
    const catalog = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...raw } : {};
    const previous = catalog[key];
    const everCompleted = Boolean(previous?.completed || completed);
    if (previous && Boolean(previous.completed) === everCompleted) return;
    catalog[key] = { completed: everCompleted, updatedAt: Date.now() };
    await chrome.storage.local.set({ [STATS_CATALOG_KEY]: catalog });
  };
  const result = statsCatalogQueue.then(task, task);
  statsCatalogQueue = result.catch(() => {});
  return result;
}




// A deliberate action in History can finish a title once at least 85%
// distinct playable content has been observed. Never trust the UI's percent.
async function confirmCoveredPlayback(mediaKey, sender) {
  if(sender?.id !== chrome.runtime.id || sender?.tab ||
      !String(sender?.url||'').startsWith(chrome.runtime.getURL('')))
    return {ok:false,error:'Недоверенный запрос'};
  const key=String(mediaKey||'');
  const isFilm=/^film:[1-9]\d{0,12}$/.test(key);
  const isEpisode=/^series:[1-9]\d{0,12}:\d{1,3}:\d{1,3}$/.test(key);
  if(!isFilm && !isEpisode)return {ok:false,error:'Неверная запись'};
  const progressKey=isFilm?RESUME_STORAGE_KEY:SERIES_PROGRESS_KEY;
  const work=async()=>{
    const [raw,coverageRaw]=await Promise.all([
      chrome.storage.local.get(progressKey),
      chrome.storage.local.get(PLAYBACK_COVERAGE_KEY)
    ]);
    const records=raw[progressKey]&&typeof raw[progressKey]==='object'
      ?{...raw[progressKey]}:{};
    const entry=records[key];
    const coverage=coverageRaw[PLAYBACK_COVERAGE_KEY]?.[key];
    if(!entry || !Number.isFinite(entry.duration) ||
       entry.duration<60 || entry.duration>28800)
      return {ok:false,error:'Нет сохранённого прогресса просмотра'};
    const validCoverage=coverage &&
      Number.isFinite(coverage.duration) &&
      Math.abs(entry.duration-coverage.duration)<=
        Math.max(10,entry.duration*0.015);
    const ranges=unionPlaybackRanges(
      validCoverage&&Array.isArray(coverage.ranges)?coverage.ranges.filter(range=>
        Array.isArray(range)&&range.length===2&&
        range.every(Number.isFinite)&&range[0]>=0&&
        range[1]<=entry.duration&&range[1]>range[0]):[]
    );
    const seconds=playbackCoverageSeconds(ranges);
    // A legacy checkpoint from a pre-coverage build cannot prove viewing.
    // The viewer may explicitly attest that the story has ended when the
    // saved timeline position is at least 85%. Never apply this automatically.
    const legacyManual=entry.position>=entry.duration*0.85;
    if(seconds<entry.duration*0.85 && !legacyManual)
      return {ok:false,error:'Для подтверждения требуется 85% просмотра или сохранённого таймкода'};
    const newlyCompleted=!Boolean(entry.completed);
    records[key]={...entry,completed:true,
      completedBy:'user',updatedAt:Date.now()};
    await chrome.storage.local.set({[progressKey]:records});
    await statsRememberCompletion(key,true);
    if(isFilm && newlyCompleted &&
       typeof self !== 'undefined' &&
       self.KinoWatchlistAutoComplete?.onFilmCompleted) {
      await self.KinoWatchlistAutoComplete.onFilmCompleted(key)
        .catch(error=>console.warn('[KinoHelper] Watchlist transfer:',error));
    }
    return {ok:true,key,coverage:Math.round(seconds/entry.duration*100)};
  };
  // Use the same serial write queues as the player to prevent an older
  // checkpoint from overwriting the user's explicit confirmation.
  if(isFilm){
    const result=resumeWriteQueue.then(work,work);
    resumeWriteQueue=result.catch(()=>{});
    return result;
  }
  const result=seriesProgressQueue.then(work,work);
  seriesProgressQueue=result.catch(()=>{});
  return result;
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.action!=='kinoConfirmCoveredPlayback')return false;
  confirmCoveredPlayback(message.key,sender)
    .then(respond).catch(error=>respond({ok:false,error:error.message}));
  return true;
});

// Alarm-driven profile sync, isolated from the movie playback logic.
importScripts('stats-account.js','stats-import-worker.js','watchlist-sync-worker.js','profile-minute-sync-worker.js');
